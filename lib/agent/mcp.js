// Minimal MCP client: stdio transport, JSON-RPC 2.0, zero dependencies.
//
// The design constraint here is token budget, not protocol coverage. A handful
// of MCP servers can expose several hundred tools; injecting every schema into
// a local model's context costs tens of thousands of tokens before it has read
// a single line of the user's actual problem. So this client keeps the full
// schemas on our side and hands the model a one-line index, loading a real
// schema only when the model asks for it.

const { spawn } = require("child_process");
const path = require("path");

class McpServer {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.tools = [];
    this.ready = false;
    this.error = null;
  }

  async start(timeoutMs = 30000) {
    const { command, args = [], env = {}, cwd } = this.cfg;
    if (!command) throw new Error(`mcp server "${this.name}" has no command`);

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

    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "arcflare", version: "1.0.0" },
    }, timeoutMs);

    this.notify("notifications/initialized", {});
    this.serverInfo = init && init.serverInfo;
    this.instructions = (init && init.instructions) || null;
    this.ready = true;
    await this.listTools(timeoutMs);
    return this;
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

  request(method, params, timeoutMs = 120000) {
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
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    this.proc = null;
    this.ready = false;
  }
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
      return { ok: true, name, tools: s.tools.length };
    } catch (e) {
      s.stop();
      return { ok: false, name, error: e.message };
    }
  }

  /** Every tool, namespaced. */
  all() {
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
    return out;
  }

  find(id) {
    return this.all().find((t) => t.id === id) || null;
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

  /** Keyword search over the index, for the model's tool_search call. */
  search(query, limit = 8) {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.all().map((t) => {
      const hay = (t.id + " " + t.description).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (t.id.toLowerCase().includes(term)) score += 3;
        if (hay.includes(term)) score += 1;
      }
      return { t, score };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.t);
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

module.exports = { McpServer, McpRegistry, resultToText };
