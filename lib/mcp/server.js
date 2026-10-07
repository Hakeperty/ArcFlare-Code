// A minimal MCP *server*: stdio transport, JSON-RPC 2.0, zero dependencies.
//
// The mirror image of lib/agent/mcp.js, which is the client. Same wire format
// (newline-delimited JSON on stdin/stdout), opposite end of the pipe.
//
// Two rules govern everything here. First: stdout carries protocol and nothing
// else — a stray console.log corrupts the stream and the client sees a parse
// error instead of a result, so diagnostics go to stderr. Second: a tool that
// throws is a *result* with isError, not a JSON-RPC error; protocol errors are
// for malformed requests, tool failures are something the model should read and
// react to.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = PROTOCOL_VERSIONS[0];

const MAX_TEXT = 60000;

function clip(text, limit = MAX_TEXT) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.floor(limit * 0.6));
  const tail = s.slice(-Math.floor(limit * 0.35));
  return `${head}\n… [${s.length - head.length - tail.length} characters cut from the middle]\n${tail}`;
}

/** Normalise whatever a handler returned into an MCP tool result. */
function toResult(out) {
  if (out && typeof out === "object" && Array.isArray(out.content)) return out;
  if (out && typeof out === "object" && typeof out.text === "string") {
    return { content: [{ type: "text", text: clip(out.text) }], isError: !!out.isError };
  }
  if (typeof out === "string") return { content: [{ type: "text", text: clip(out) }] };
  return { content: [{ type: "text", text: clip(JSON.stringify(out, null, 2)) }] };
}

// ------------------------------------------------------------- validation ----

// Until this existed the inputSchemas were decoration: a tool could declare
// `enum: ["png","jpeg"]` and a client could still send any string, which the
// handler then interpolated into a PowerShell command. Checking here fixes that
// once for every tool instead of in each handler, and it is the only place that
// sees both the schema and the arguments.
//
// Coercion is deliberate where intent is unambiguous — the string "20" for an
// integer is a wire-format difference, not a mistake worth a round trip — but a
// value that cannot be coerced is an error, not something to guess at.

function typeOk(v, t) {
  switch (t) {
    case "string":  return typeof v === "string";
    case "number":  return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array":   return Array.isArray(v);
    case "object":  return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null":    return v === null;
    default:        return true;
  }
}

/** Nudge a wire value into the declared type, or return undefined. */
function coerce(v, t) {
  if (typeOk(v, t)) return v;
  if (typeof v === "string") {
    if (t === "number" || t === "integer") {
      const n = Number(v.trim());
      if (v.trim() !== "" && Number.isFinite(n) && (t === "number" || Number.isInteger(n))) return n;
    }
    if (t === "boolean") {
      if (/^(true|1|yes)$/i.test(v.trim())) return true;
      if (/^(false|0|no)$/i.test(v.trim())) return false;
    }
  }
  if (typeof v === "number" && t === "string") return String(v);
  return undefined;
}

/**
 * Validate one value against one schema node. Pushes messages onto `errors`
 * and returns the value to use.
 */
function checkValue(v, spec, where, errors) {
  if (!spec || typeof spec !== "object") return v;

  const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
  if (types.length && !types.some((t) => typeOk(v, t))) {
    const fixed = coerce(v, types[0]);
    if (fixed === undefined) {
      errors.push(`${where} must be ${types.join(" or ")}, got ${Array.isArray(v) ? "array" : typeof v}`);
      return v;
    }
    v = fixed;
  }

  // The check the screenshot tool needed: a declared enum is a closed set.
  if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.includes(v)) {
    errors.push(`${where} must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return v;
  }

  if (typeof v === "number") {
    if (typeof spec.minimum === "number" && v < spec.minimum) errors.push(`${where} must be >= ${spec.minimum}`);
    if (typeof spec.maximum === "number" && v > spec.maximum) errors.push(`${where} must be <= ${spec.maximum}`);
  }

  if (Array.isArray(v) && spec.items) {
    return v.map((item, i) => checkValue(item, spec.items, `${where}[${i}]`, errors));
  }

  if (v !== null && typeof v === "object" && !Array.isArray(v) && spec.properties) {
    return checkObject(v, spec, where, errors);
  }

  return v;
}

function checkObject(args, schema, where, errors) {
  const out = { ...args };
  const props = schema.properties || {};

  for (const key of schema.required || []) {
    if (out[key] === undefined || out[key] === null) {
      errors.push(`missing required argument ${where ? where + "." : ""}${key}`);
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (out[key] === undefined || out[key] === null) continue;
    out[key] = checkValue(out[key], spec, where ? `${where}.${key}` : key, errors);
  }
  return out;
}

/**
 * Check a tool call's arguments. Returns the arguments to pass on, plus any
 * problems — unknown properties are left alone, since a client sending an
 * extra field is harmless and refusing it only breaks working setups.
 */
function validateArgs(schema, args) {
  const errors = [];
  if (!schema || typeof schema !== "object" || args === null || typeof args !== "object") {
    return { ok: !errors.length, args: args || {}, errors };
  }
  const checked = checkObject(args, schema, "", errors);
  return { ok: errors.length === 0, args: checked, errors };
}

class Server {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {string} o.version
   * @param {string} [o.instructions]  shown to the model once, at connect time
   */
  constructor(o = {}) {
    this.name = o.name || "arcflare";
    this.version = o.version || "0.0.0";
    this.instructions = o.instructions || null;
    this.tools = new Map();
    this.onClose = o.onClose || (() => {});
    this.initialized = false;
  }

  /** Register a tool. `handler(args)` may return a string, {text,isError}, or a value. */
  tool(name, description, inputSchema, handler) {
    this.tools.set(name, {
      name,
      description,
      inputSchema: inputSchema || { type: "object", properties: {} },
      handler,
    });
    return this;
  }

  list() {
    return [...this.tools.values()].map(({ name, description, inputSchema }) =>
      ({ name, description, inputSchema }));
  }

  /**
   * Handle one parsed message. Returns a response object, or null for
   * notifications (which by definition get no reply).
   */
  async handle(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg && msg.id != null
        ? this._err(msg.id, -32600, "invalid request")
        : null;
    }
    const { id, method, params } = msg;
    const isNotification = id == null;

    try {
      switch (method) {
        case "initialize": {
          const asked = params && params.protocolVersion;
          this.initialized = true;
          return this._ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.name, version: this.version },
            ...(this.instructions ? { instructions: this.instructions } : {}),
          });
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return this._ok(id, {});

        case "tools/list":
          return this._ok(id, { tools: this.list() });

        case "tools/call": {
          const name = params && params.name;
          const t = this.tools.get(name);
          if (!t) return this._err(id, -32602, `unknown tool "${name}"`);

          // A bad argument is something the model should read and correct, so
          // it comes back as an isError result rather than a protocol error —
          // and it never reaches the handler, which is the point: handlers
          // interpolate these values into shells and scripts.
          const v = validateArgs(t.inputSchema, params.arguments || {});
          if (!v.ok) {
            return this._ok(id, {
              content: [{ type: "text", text: `invalid arguments for "${name}": ${v.errors.join("; ")}` }],
              isError: true,
            });
          }

          let out;
          try {
            out = await t.handler(v.args);
          } catch (e) {
            // A tool that fails is information, not a broken request: hand the
            // message back so the model can fix its own call. The isError flag
            // is what marks it — clients prefix their own label, and adding one
            // here just produces "ERROR: ERROR: ...".
            return this._ok(id, {
              content: [{ type: "text", text: e && e.message ? e.message : String(e) }],
              isError: true,
            });
          }
          return this._ok(id, toResult(out));
        }

        // We advertise only tools, but some clients probe anyway. An empty list
        // is quieter than a method-not-found error in their logs.
        case "resources/list":   return this._ok(id, { resources: [] });
        case "resources/templates/list": return this._ok(id, { resourceTemplates: [] });
        case "prompts/list":     return this._ok(id, { prompts: [] });

        default:
          return isNotification ? null : this._err(id, -32601, `unknown method "${method}"`);
      }
    } catch (e) {
      return isNotification ? null : this._err(id, -32603, e.message || String(e));
    }
  }

  _ok(id, result) { return { jsonrpc: "2.0", id, result }; }
  _err(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

  /** Read newline-delimited JSON from `input`, write responses to `output`. */
  listen(input = process.stdin, output = process.stdout) {
    let buffer = "";
    input.setEncoding("utf8");

    const send = (res) => {
      if (res) output.write(JSON.stringify(res) + "\n");
    };

    input.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send(this._err(null, -32700, "parse error"));
          continue;
        }
        // Requests are handled concurrently: a build that takes two minutes
        // must not block a `logs` call that would show why.
        Promise.resolve(this.handle(msg)).then(send, (e) =>
          send(this._err(msg.id ?? null, -32603, e.message || String(e))));
      }
    });

    const close = () => { try { this.onClose(); } catch {} };
    input.on("end", () => { close(); process.exit(0); });
    process.on("SIGINT", () => { close(); process.exit(0); });
    process.on("SIGTERM", () => { close(); process.exit(0); });
    process.on("exit", close);
    return this;
  }
}

module.exports = {
  Server, toResult, clip, validateArgs, PROTOCOL_VERSIONS, LATEST,
};
