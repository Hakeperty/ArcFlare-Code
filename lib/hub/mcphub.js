"use strict";
// MCP servers for the hub's agents: the ones the phone starts.
//
// Agents run in-process, so instead of each one spawning its own copy of every
// server, the hub keeps one shared McpRegistry and hands it to every agent it
// boots. Which servers are in it is chosen from the phone, one switch per
// server, and remembered in <hub>/mcp.json.
//
// Decisions worth knowing:
//
//   Only this computer's own MCP config is read (~/.arcflare/mcp.json, else
//   ~/.claude.json): never a .mcp.json from the folder an agent works in. A
//   workspace config is a list of commands written by whoever wrote the repo,
//   and the phone has no trust prompt to show for it (lib/agent/trust.js).
//
//   Every server starts switched OFF. Turning one on spawns its command, so it
//   is something the owner decides, from a signed-in owner session.
//
//   Switching a server on does not let anything call it unasked: every MCP
//   tool call an agent makes still becomes an approval on the phone
//   (lib/hub/supervisor.js). A server's tools reach agents booted after it
//   connected; a running agent picks them up when it is next started.
//
//   Errors shown on the phone are cut short and never include the server's
//   command line or environment (which can hold tokens).

const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ERROR = 200;

function homeDir() {
  return process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
}

/** The computer's own MCP servers: ArcFlare's file first, then Claude's. Never a workspace file. */
function loadHomeConfig({ home = homeDir(), userHome = os.homedir() } = {}) {
  for (const file of [path.join(home, "mcp.json"), path.join(userHome, ".claude.json")]) {
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const servers = j && (j.mcpServers || j.servers);
    if (servers && typeof servers === "object" && Object.keys(servers).length) return { file, servers };
  }
  return { file: null, servers: {} };
}

/**
 * ArcFlare's own servers, offered on every hub without anyone editing a file:
 * the web (search and read pages), a headless browser, and desktop control
 * (screen, mouse and keyboard). They are parts of the machine server (lib/mcp/tools.js), started
 * through this same Node. Off until an owner switches them on, like any other.
 */
function builtinServers() {
  const bin = path.join(__dirname, "..", "..", "bin", "arcflare-mcp.js");
  return {
    "arcflare-web": { command: process.execPath, args: [bin, "web"], builtin: true, about: "Search the web and read pages. Public internet only." },
    "arcflare-browser": { command: process.execPath, args: [bin, "browser"], builtin: true, about: "A browser with no window: open pages, click and fill in forms." },
    "arcflare-desktop": { command: process.execPath, args: [bin, "desktop"], builtin: true, about: "See the computer's screen and use its mouse and keyboard." },
  };
}

function shortError(e) {
  let s = String((e && e.message) || e || "failed").replace(/\s+/g, " ").trim();
  // A stdio spawn error names the command; keep the reason, not the path.
  s = s.replace(/[A-Za-z]:\\[^\s"']+|\/(?:[^\s/"']+\/)+[^\s"']*/g, "…");
  return s.length > MAX_ERROR ? s.slice(0, MAX_ERROR - 1) + "…" : s;
}

class McpHub extends EventEmitter {
  /**
   * @param {object} o
   * @param {string}   o.dir         hub state folder (the switches go in <dir>/mcp.json)
   * @param {function} [o.load]      () => { file, servers }, default loadHomeConfig
   * @param {boolean}  [o.builtins]  also offer ArcFlare's own web and desktop servers
   * @param {function} [o.Registry]  McpRegistry class (tests inject a fake)
   * @param {number}   [o.timeoutMs] per-server connect timeout
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(0);
    this.file = path.join(o.dir, "mcp.json");
    this.load = o.load || loadHomeConfig;
    this.builtins = o.builtins === true ? builtinServers() : {};
    const Registry = o.Registry || require("../agent/mcp").McpRegistry;
    this.reg = new Registry();
    this.timeoutMs = o.timeoutMs || 30000;
    this.state = new Map();    // name -> { status: "off"|"connecting"|"on"|"error", error }
    this.pending = new Map();  // name -> promise of the connect in flight
    this.enabled = this._readSwitches();
  }

  _readSwitches() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return new Set(Object.keys((j && j.enabled) || {}).filter((n) => NAME_RE.test(n) && j.enabled[n] === true));
    } catch { return new Set(); }
  }

  _saveSwitches() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const enabled = {};
    for (const n of [...this.enabled].sort()) enabled[n] = true;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ enabled }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _config() {
    const c = this.load();
    // A server the owner configured under the same name wins: theirs is the deliberate one.
    const servers = { ...this.builtins };
    for (const [n, cfg] of Object.entries((c && c.servers) || {})) {
      if (NAME_RE.test(n) && cfg && typeof cfg === "object") servers[n] = cfg;
    }
    return servers;
  }

  /** Every configured server, with its switch and state. Safe to show on a phone: no commands, no env. */
  list() {
    const servers = this._config();
    return Object.keys(servers).sort().map((name) => {
      const cfg = servers[name];
      const st = this.state.get(name) || { status: "off" };
      const s = this.reg.servers.get(name);
      return {
        name,
        transport: cfg.url ? "http" : "stdio",
        builtin: cfg.builtin === true,
        about: cfg.builtin === true && typeof cfg.about === "string" ? cfg.about : null,
        enabled: this.enabled.has(name),
        status: st.status,
        error: st.error || null,
        tools: s && s.tools ? s.tools.length : 0,
      };
    });
  }

  /** One connected server's tools: name and the first line of its description. */
  tools(name) {
    if (!NAME_RE.test(String(name)) || !(name in this._config())) throw Object.assign(new Error("No such MCP server"), { status: 404 });
    const s = this.reg.servers.get(name);
    return ((s && s.tools) || []).map((t) => ({
      name: String(t.name),
      description: String(t.description || "").split(/\n/)[0].slice(0, 300),
    }));
  }

  _set(name, status, error) {
    this.state.set(name, { status, error: error ? shortError(error) : null });
    this.emit("change", { type: "mcp", name, status });
  }

  _connect(name, cfg) {
    if (this.pending.has(name)) return this.pending.get(name);
    if (this.reg.servers.has(name)) return Promise.resolve(true);
    this._set(name, "connecting");
    const p = this.reg.add(name, cfg, { timeoutMs: this.timeoutMs }).then((r) => {
      this.pending.delete(name);
      if (!this.enabled.has(name)) {          // switched off while connecting
        this._drop(name);
        return false;
      }
      if (r && r.ok) { this._set(name, "on"); return true; }
      this._set(name, "error", (r && r.error) || "could not connect");
      return false;
    }, (e) => {
      this.pending.delete(name);
      this._set(name, "error", e);
      return false;
    });
    this.pending.set(name, p);
    return p;
  }

  _drop(name) {
    const s = this.reg.servers.get(name);
    if (s) { try { s.stop(); } catch { /* already gone */ } }
    this.reg.servers.delete(name);
    this.reg._all = null;
  }

  /** Switch a server on (connect it) or off (stop it). Returns its list() entry. */
  async setEnabled(name, on) {
    const servers = this._config();
    if (!NAME_RE.test(String(name)) || !servers[name]) throw Object.assign(new Error("No such MCP server"), { status: 404 });
    if (on) {
      this.enabled.add(name);
      this._saveSwitches();
      await this._connect(name, servers[name]);
    } else {
      this.enabled.delete(name);
      this._saveSwitches();
      this._drop(name);
      this._set(name, "off");
    }
    return this.list().find((s) => s.name === name);
  }

  /** Reconnect one server (after its config changed, or it crashed). */
  async restart(name) {
    const servers = this._config();
    if (!NAME_RE.test(String(name)) || !servers[name]) throw Object.assign(new Error("No such MCP server"), { status: 404 });
    if (!this.enabled.has(name)) throw Object.assign(new Error("Turn the server on first"), { status: 409 });
    if (this.pending.has(name)) await this.pending.get(name);
    this._drop(name);
    await this._connect(name, servers[name]);
    return this.list().find((s) => s.name === name);
  }

  /**
   * The shared registry for an agent about to boot: every switched-on server
   * connected (or given up on), or null when none is on. A server that fails
   * to connect is left out; it does not stop the agent.
   */
  async registry() {
    const servers = this._config();
    const want = [...this.enabled].filter((n) => servers[n]);
    if (!want.length) return null;
    await Promise.all(want.map((n) => this._connect(n, servers[n])));
    return this.reg.servers.size ? this.reg : null;
  }

  stopAll() {
    for (const name of [...this.reg.servers.keys()]) this._drop(name);
    for (const name of this.state.keys()) this.state.set(name, { status: "off", error: null });
  }
}

module.exports = { McpHub, loadHomeConfig, builtinServers, shortError, NAME_RE };
