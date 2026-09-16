// Minimal MCP client: stdio and HTTP transports, JSON-RPC 2.0, zero
// dependencies.
//
// The design constraint here is token budget, not protocol coverage. A handful
// of MCP servers can expose several hundred tools; injecting every schema into
// a local model's context costs tens of thousands of tokens before it has read
// a single line of the user's actual problem. So this client keeps the full
// schemas on our side and hands the model a one-line index, loading a real
// schema only when the model asks for it.
//
// Two transports, because the servers people actually have are split between
// them: local ones are processes on stdio, hosted ones are URLs. A hosted
// server answers a POST either with one JSON object or with an SSE stream
// carrying the same reply, and both shapes are legal for the same endpoint —
// so the client reads whichever arrived rather than assuming.

const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PROTOCOL_VERSION = "2025-06-18";

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Pull the JSON-RPC messages out of an SSE body. */
function parseSse(text) {
  const out = [];
  for (const frame of String(text).split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const j = safeJson(data);
    if (j) out.push(j);
  }
  return out;
}

/**
 * MCP server config, in the shape everything else already uses:
 *   { "mcpServers": { "name": { "command": "...", "args": [...] } } }
 * or, for a hosted server: { "name": { "type": "http", "url": "https://…" } }
 *
 * ArcFlare's own file is read first, then a Claude config, so an existing setup
 * works without being copied anywhere.
 */
function loadMcpConfig(cwd = process.cwd()) {
  const fs = require("fs");
  const os = require("os");
  const home = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
  const candidates = [
    path.join(cwd, ".arcflare", "mcp.json"),
    path.join(cwd, ".mcp.json"),
    path.join(home, "mcp.json"),
    path.join(os.homedir(), ".claude.json"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const servers = j.mcpServers || j.servers;
      if (servers && Object.keys(servers).length) return { file: f, servers };
    } catch { /* try the next one */ }
  }
  return { file: null, servers: {} };
}

/** Expand ${VAR} and $VAR against the environment, for tokens kept in env. */
function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, a, b) => process.env[a || b] ?? m);
}

class McpServer {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg || {};
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.tools = [];
    this.ready = false;
    this.error = null;
    // A config with a url is a hosted server however it labels its type.
    this.kind = this.cfg.url ? "http" : "stdio";
    this.sessionId = null;
  }

  async start(timeoutMs = 30000) {
    if (this.kind === "http") await this._startHttp();
    else await this._startStdio();

    const init = await this.request("initialize", {
      protocolVersion: this.kind === "http" ? PROTOCOL_VERSION : "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "arcflare", version: "1.0.0" },
    }, timeoutMs);

    this.protocolVersion = (init && init.protocolVersion) || null;
    this.notify("notifications/initialized", {});
    this.serverInfo = init && init.serverInfo;
    this.instructions = (init && init.instructions) || null;
    this.ready = true;
    await this.listTools(timeoutMs);
    return this;
  }

  async _startHttp() {
    const url = expandEnv(this.cfg.url);
    try { this.url = new URL(url); }
    catch (e) { throw new Error(`mcp server "${this.name}" has a bad url: ${e.message}`); }
    this.headers = {};
    for (const [k, v] of Object.entries(this.cfg.headers || {})) this.headers[k] = expandEnv(v);
    // A bearer token is the common case and is worth not making people spell
    // out as a header; it never goes anywhere but this server's own origin.
    const token = expandEnv(this.cfg.token || this.cfg.bearer || "");
    if (token && !this.headers.Authorization) this.headers.Authorization = `Bearer ${token}`;

    // Nothing configured? A token from a previous `arcflare mcp login` is the
    // normal case for a hosted server, and it is stored per server name.
    if (!this.headers.Authorization) {
      const stored = await require("./oauth").accessToken(this.name).catch(() => null);
      if (stored) this.headers.Authorization = `Bearer ${stored}`;
    }
  }

  /**
   * A 401 mid-session means the access token aged out, which is expected: they
   * are short-lived by design. Refresh once and repeat the request, and only
   * bother the user when there is no refresh token left to try.
   */
  async _reauthorize() {
    const oauth = require("./oauth");
    const fresh = await oauth.refresh(this.name).catch(() => null);
    if (!fresh) return false;
    this.headers.Authorization = `Bearer ${fresh.accessToken}`;
    return true;
  }

  async _startStdio() {
    const { command, args = [], env = {}, cwd } = this.cfg;
    if (!command) throw new Error(`mcp server "${this.name}" has no command or url`);

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      cwd: cwd || process.cwd(),
      windowsHide: true,
      shell: process.platform === "win32" && !path.isAbsolute(command),
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => { /* servers chatter; ignore */ });
    this.proc.on("exit", (code) => {
      this.ready = false;
      const err = new Error(`mcp server "${this.name}" exited (${code})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
    this.proc.on("error", (e) => { this.error = e.message; });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "mcp error"));
        else p.resolve(msg.result);
      }
    }
  }

  /**
   * One POST, one reply.
   *
   * The reply comes back as `application/json` or as an SSE stream containing
   * the same JSON-RPC message, at the server's discretion, so both are read.
   * A notification is answered with 202 and no body, and that is not an error.
   */
  _httpSend(message, timeoutMs = 120000) {
    const payload = JSON.stringify(message);
    const mod = this.url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request({
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        port: this.url.port || (this.url.protocol === "https:" ? 443 : 80),
        path: this.url.pathname + this.url.search,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "arcflare-mcp-client",
          ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          ...this.headers,
        },
      }, (res) => {
        // The session id is handed out on initialize and required afterwards.
        const sid = res.headers["mcp-session-id"];
        if (sid) this.sessionId = sid;

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode === 202 || (!body.trim() && res.statusCode < 300)) return resolve(null);
          if (res.statusCode >= 400) {
            if (res.statusCode === 401) this.wwwAuthenticate = res.headers["www-authenticate"] || null;
            const hint = res.statusCode === 401 || res.statusCode === 403
              ? ` — this server wants authentication: run \`arcflare mcp login ${this.name}\``
              : "";
            return reject(new Error(
              `mcp "${this.name}" HTTP ${res.statusCode}${hint}: ${body.slice(0, 300).replace(/\s+/g, " ")}`));
          }
          const ct = String(res.headers["content-type"] || "");
          const msgs = ct.includes("text/event-stream") ? parseSse(body) : [safeJson(body)];
          const answer = msgs.filter(Boolean).find((m) => m.id != null && m.id === message.id)
            || msgs.filter(Boolean).find((m) => m.result !== undefined || m.error);
          if (!answer) return reject(new Error(`mcp "${this.name}" sent no answer to ${message.method}`));
          if (answer.error) return reject(new Error(answer.error.message || "mcp error"));
          resolve(answer.result);
        });
      });
      req.on("error", (e) => reject(new Error(`mcp "${this.name}" ${e.code || e.message}`)));
      req.on("timeout", () => { req.destroy(); reject(new Error(`mcp "${this.name}" ${message.method} timed out`)); });
      req.end(payload);
    });
  }

  async request(method, params, timeoutMs = 120000) {
    if (this.kind === "http") {
      const message = { jsonrpc: "2.0", id: this.nextId++, method, params };
      try {
        return await this._httpSend(message, timeoutMs);
      } catch (e) {
        if (!/HTTP 401/.test(e.message) || !(await this._reauthorize())) throw e;
        return this._httpSend({ ...message, id: this.nextId++ }, timeoutMs);
      }
    }
    if (!this.proc || this.proc.exitCode !== null) {
      return Promise.reject(new Error(`mcp server "${this.name}" is not running`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.name}" ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params) {
    if (this.kind === "http") {
      // Nothing waits on a notification, and a server that dislikes it must not
      // take the session down with it.
      this._httpSend({ jsonrpc: "2.0", method, params }, 15000).catch(() => {});
      return;
    }
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools(timeoutMs = 30000) {
    const out = [];
    let cursor;
    do {
      const res = await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      for (const t of (res && res.tools) || []) out.push(t);
      cursor = res && res.nextCursor;
    } while (cursor);
    this.tools = out;
    return out;
  }

  async call(toolName, args, timeoutMs = 300000) {
    const res = await this.request("tools/call",
      { name: toolName, arguments: args || {} }, timeoutMs);
    return res;
  }

  stop() {
    this.ready = false;
    if (this.kind === "http") {
      // Politely release the session; there is nothing to wait for.
      if (this.sessionId) {
        try {
          const mod = this.url.protocol === "https:" ? https : http;
          const req = mod.request({
            protocol: this.url.protocol, hostname: this.url.hostname,
            port: this.url.port || (this.url.protocol === "https:" ? 443 : 80),
            path: this.url.pathname + this.url.search, method: "DELETE",
            headers: { "Mcp-Session-Id": this.sessionId, ...this.headers },
            timeout: 3000,
          });
          req.on("error", () => {});
          req.end();
        } catch {}
      }
      this.sessionId = null;
      return;
    }
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }
}

// --------------------------------------------------------------- schemas ----
//
// What a tool's arguments cost to describe.
//
// A search result is the expensive half of tool discovery: it lands in the
// conversation and stays there. Raw JSON Schema is a bad way to spend that —
// a Pydantic-generated one is mostly `"title"` and `anyOf: [T, null]`, which
// says "optional T" in 40 characters instead of one `?`. So schemas are
// rendered as a signature: the same information a function header carries,
// at roughly a fifth of the tokens.

/** A short type name for one property. Returns null for "anything". */
function typeOf(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 4) return null;
  if (Array.isArray(s.enum) && s.enum.length) {
    const shown = s.enum.slice(0, 5).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    return shown.join("|") + (s.enum.length > 5 ? "|…" : "");
  }
  // anyOf/oneOf is how "optional" and "one of several" both arrive. A null
  // branch is the optionality, which the `?` on the name already carries.
  const alts = s.anyOf || s.oneOf;
  if (Array.isArray(alts)) {
    const names = alts.filter((a) => a && a.type !== "null")
      .map((a) => typeOf(a, depth + 1)).filter(Boolean);
    return names.length ? [...new Set(names)].join("|") : null;
  }
  if (Array.isArray(s.type)) {
    const t = s.type.filter((x) => x !== "null");
    return t.length ? t.join("|") : null;
  }
  if (s.type === "array") {
    const it = typeOf(s.items, depth + 1);
    return it ? `${it}[]` : "array";
  }
  return typeof s.type === "string" ? s.type : null;
}

/** The first sentence of a description, trimmed to `max`. */
function firstClause(text, max = 72) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const stop = s.search(/\.\s|\.$/);
  const one = stop > 0 ? s.slice(0, stop) : s;
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

/**
 * A tool's arguments as a signature line.
 *
 * Required arguments are bare, optional ones carry `?`, and a default is shown
 * where the server declares one — because the useful question about an optional
 * argument is almost always "what happens if I leave it out".
 */
function signature(schema, { maxArgs = 20 } = {}) {
  const props = schema && typeof schema === "object" ? schema.properties : null;
  if (!props || typeof props !== "object") return "()";
  const names = Object.keys(props);
  if (!names.length) return "()";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  // Required arguments first: they are the ones a caller must get right.
  const ordered = [...names].sort((a, b) =>
    (required.has(b) ? 1 : 0) - (required.has(a) ? 1 : 0));
  const shown = ordered.slice(0, maxArgs);
  const parts = shown.map((n) => {
    const p = props[n] || {};
    let out = required.has(n) ? n : n + "?";
    const t = typeOf(p);
    if (t) out += ": " + t;
    if (p.default !== undefined && p.default !== null) out += "=" + JSON.stringify(p.default);
    return out;
  });
  const more = ordered.length - shown.length;
  return `(${parts.join(", ")}${more > 0 ? `, +${more} more` : ""})`;
}

/**
 * Trim prose to `max` characters, preferring the last sentence that fits.
 *
 * A description cut mid-clause spends the tokens and loses the point: these
 * servers put their real warnings in the last sentence ("…use it for the final
 * check, not for iteration"), and half of that reads as advice to do the
 * opposite. A whole sentence less is cheaper than a misleading one.
 */
function trimSentences(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("— "), head.lastIndexOf("; "));
  // Only honour a boundary that leaves most of the budget used; otherwise a
  // description whose first sentence is two words would collapse to nothing.
  if (cut > max * 0.5) return head.slice(0, cut + 1).replace(/[\s—;,]+$/, "").trim();
  return head.slice(0, max - 1).trimEnd() + "…";
}

/**
 * One tool, rendered for a search result: what it is, how to call it, and the
 * per-argument notes that the signature cannot carry.
 */
function describeTool(t, { descChars = 320, argNotes = 6 } = {}) {
  const lines = [`## ${t.id}`];
  const desc = trimSentences(t.description, descChars);
  if (desc) lines.push(desc);
  lines.push(signature(t.schema));

  // Some servers put the real documentation on the arguments rather than the
  // tool. Dropping that would trade tokens for a wrong call, which costs a
  // whole round trip on a model generating at tens of tokens a second.
  const props = (t.schema && t.schema.properties) || {};
  const notes = Object.keys(props)
    .map((n) => [n, firstClause(props[n] && props[n].description)])
    .filter(([, d]) => d)
    .slice(0, argNotes)
    .map(([n, d]) => `  ${n} — ${d}`);
  if (notes.length) lines.push(notes.join("\n"));
  return lines.join("\n");
}

// --------------------------------------------------------------- ranking ----
//
// Why finding a tool is worth more than a one-line `includes`.
//
// A model that misses pays twice: once for the search result it reads, and
// again for the turn it spends searching differently — which on a local model
// is seconds of prefill and generation, not milliseconds. So the ranking is
// part of the token budget, not a nicety.
//
// The version this replaces scored `(id + description).includes(term)`, so
// "the" in "render the scene" scored against nearly every tool of the 299 a
// real config exposes, and ties fell to whichever server was registered first
// — the one with the most tools. `blender__screenshot_render`, whose own
// description begins "Run a real render and return the image", did not make
// the top five. Three things fix it: drop the words that match everything,
// score whole words in the tool's *name* far above prose in its description,
// and rank by how much of the query a tool actually covers.

// Function words only. Verbs stay: "get", "run", "add", "list" and "set" are
// how tools are named, so dropping them would blind the search to half the
// names it has to match.
const STOP = new Set(("a an and are as at be been by for from had has have how i in into " +
  "is it its me my of on or please that the their them then there these this to was " +
  "what when where which will with would you your").split(" "));

function words(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Query words worth scoring. Falls back to the raw words if all were stop words. */
function queryTerms(query) {
  const raw = words(query);
  const kept = raw.filter((w) => !STOP.has(w) && w.length > 1);
  return kept.length ? kept : raw;
}

/** Per-tool word sets, computed once and kept with the tool. */
function indexTool(t) {
  const nameWords = new Set(words(t.name));
  const serverWords = new Set(words(t.server));
  const descText = String(t.description || "").toLowerCase();
  return { nameWords, serverWords, descWords: new Set(words(descText)), descText };
}

/**
 * Score one tool against one query term.
 *
 * The ladder matters more than the numbers: a whole word in the tool's own
 * name is strong evidence, the same word buried in prose is weak evidence, and
 * the gap between them has to be wide enough that no amount of prose outranks
 * a name.
 */
function scoreTerm(ix, term) {
  if (ix.nameWords.has(term)) return 10;
  if (ix.serverWords.has(term)) return 6;
  if (term.length >= 4) {
    for (const w of ix.nameWords) {
      if (w.startsWith(term) || term.startsWith(w)) return 5;
      if (w.includes(term)) return 3;
    }
  }
  if (ix.descWords.has(term)) return 2;
  if (term.length >= 4 && ix.descText.includes(term)) return 1;
  return 0;
}

/**
 * Rank tools for a query.
 *
 * Coverage is the multiplier rather than another additive term: a tool that
 * answers every word of "blender render" should beat one that answers "render"
 * twice as loudly, and only a multiplier expresses that.
 */
function rank(tools, query, limit = 8) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const want = words(query).join("_");

  const scored = [];
  for (const t of tools) {
    const ix = t._ix || (t._ix = indexTool(t));
    let sum = 0;
    let covered = 0;
    for (const term of terms) {
      const s = scoreTerm(ix, term);
      if (s) { sum += s; covered++; }
    }
    if (!covered) continue;
    let score = sum * (covered / terms.length);
    // An exact name is not a ranking question.
    if (t.name.toLowerCase() === want || t.id.toLowerCase() === want) score += 100;
    scored.push({ t, score });
  }

  // Ties are broken deterministically, and towards the shorter name: between
  // `screenshot` and `screenshot_wireframe_overlay` for the word "screenshot",
  // the plain one is what was asked for.
  scored.sort((a, b) =>
    b.score - a.score ||
    a.t.id.length - b.t.id.length ||
    (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0));
  return scored.slice(0, limit).map((x) => x.t);
}

/**
 * A registry across several MCP servers.
 *
 * Tools are namespaced `server__tool` so two servers can both expose `search`
 * without colliding, and the model sees a compact index rather than hundreds of
 * JSON schemas.
 */
class McpRegistry {
  constructor() {
    this.servers = new Map();
  }

  async add(name, cfg, opts = {}) {
    const s = new McpServer(name, cfg);
    try {
      await s.start(opts.timeoutMs || 30000);
      this.servers.set(name, s);
      this._all = null;
      return { ok: true, name, tools: s.tools.length };
    } catch (e) {
      s.stop();
      return { ok: false, name, error: e.message };
    }
  }

  /**
   * Every tool, namespaced — built once and kept.
   *
   * The ranker hangs a word index off each entry, and rebuilding the array on
   * every search would throw that away along with the objects. The cache is
   * dropped when the set of servers changes, which is the only thing that can
   * change it.
   */
  all() {
    // `servers` is a public Map and callers do reach into it, so the cache
    // validates itself against what is actually there rather than trusting
    // that every mutation came through add(). Counting a handful of servers is
    // free; serving a stale tool list is not.
    let stamp = `${this.servers.size}`;
    for (const [name, s] of this.servers) stamp += `:${name}/${(s.tools || []).length}`;
    if (this._all && this._stamp === stamp) return this._all;
    this._stamp = stamp;
    const out = [];
    for (const [name, s] of this.servers) {
      for (const t of s.tools) {
        out.push({
          id: `${name}__${t.name}`,
          server: name,
          name: t.name,
          description: t.description || "",
          schema: t.inputSchema || { type: "object", properties: {} },
        });
      }
    }
    this._all = out;
    this._byId = new Map(out.map((t) => [t.id, t]));
    return out;
  }

  find(id) {
    this.all();
    return this._byId.get(id) || null;
  }

  /**
   * One line per tool: what the model sees by default.
   * A full JSON schema averages 200-400 tokens; this is under 20.
   */
  index() {
    return this.all().map((t) => {
      const first = String(t.description).split(/[.\n]/)[0].trim();
      return `${t.id}: ${first.slice(0, 110)}`;
    });
  }

  /** Ranked search over every connected tool. What tool_search returns. */
  search(query, limit = 8) {
    return rank(this.all(), query, limit);
  }

  /** One search hit rendered for the model: what it is and how to call it. */
  describe(tool, opts) {
    return describeTool(tool, opts);
  }

  async call(id, args) {
    const t = this.find(id);
    if (!t) throw new Error(`unknown tool "${id}"`);
    const s = this.servers.get(t.server);
    if (!s) throw new Error(`server "${t.server}" is gone`);
    return s.call(t.name, args);
  }

  stopAll() {
    for (const [, s] of this.servers) s.stop();
    this.servers.clear();
    this._all = null;
  }
}

/** Flatten an MCP tool result into text the model can read. */
function resultToText(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  const parts = [];
  for (const c of res.content || []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") parts.push(`[image ${c.mimeType || ""}]`);
    else if (c.type === "resource" && c.resource) {
      parts.push(c.resource.text || `[resource ${c.resource.uri || ""}]`);
    } else parts.push(`[${c.type}]`);
  }
  let text = parts.join("\n").trim();
  if (res.isError) text = "ERROR: " + text;
  return text || JSON.stringify(res).slice(0, 2000);
}

module.exports = {
  McpServer, McpRegistry, resultToText, loadMcpConfig, parseSse, expandEnv,
  signature, describeTool, typeOf, firstClause, trimSentences, rank, queryTerms, STOP,
};
