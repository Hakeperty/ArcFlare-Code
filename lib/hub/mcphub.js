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
//
//   An owner can add a server from the phone, but only one of the store's
//   catalogue (lib/store.js), by its id: the command comes from the catalogue,
//   never from the phone, and the one argument a server may take (a folder)
//   is checked like a catalogue argument. It is added off. Only servers the
//   store wrote can be removed from the phone; a hand-written one, or one of
//   ArcFlare's own, is left to the computer.

const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ERROR = 200;
const CHANGES_PER_MINUTE = 10;   // installs and removes from the phone
// Tool calls from the AI on the phone: each one was allowed by the person, so this only stops a runaway loop.
const CALLS_PER_MINUTE = 20;
const CALL_TIMEOUT_MS = 120000;  // ask_phone and call_phone wait for the person
const MAX_RESULT = 4000;         // characters: the phone's model has a 2048-token window
const RETRY_MS = 60000;           // a server that failed to connect is tried again from the phone's tool list at most this often

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

// A name from an MCP server as the phone shows and indexes it: no control, invisible or direction-changing characters, at most n.
function plainName(v, n) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "").trim().slice(0, n);
}

function shortError(e) {
  let s = String((e && e.message) || e || "failed").replace(/\s+/g, " ").trim().slice(0, 2000);   // capped first: the patterns below are slow on very long server text
  // A stdio spawn error names the command, an fs error the file (mcp.json, quoted, maybe with spaces): keep the reason, not the path.
  s = s.replace(/\bspawn\s.*\s(E[A-Z]+)\b/g, "spawn … $1");   // the command is unquoted and may have spaces: keep only the code
  s = s.replace(/(['"])(?=[^'"]*[\\/]).*\1/g, "…");           // to the last quote, so an apostrophe in the path (O'Brien) is dropped too
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
   * @param {string}   [o.home]      where the computer's mcp.json is (default ~/.arcflare)
   * @param {function} [o.catalog]   async () => store.load() result: the store's catalogue
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(0);
    this.file = path.join(o.dir, "mcp.json");
    this.home = o.home || homeDir();
    this.load = o.load || (() => loadHomeConfig({ home: this.home }));
    this.catalogLoad = o.catalog || (() => require("../store").load({}));
    this._cat = null;          // the last catalogue loaded (its MCP entries, checked)
    this._changes = [];        // times of recent installs and removes
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
    // No prototype: a name like "constructor" must not look like a configured server.
    const servers = Object.assign(Object.create(null), this.builtins);
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
        store: cfg.builtin !== true && this._fromStore(name, cfg),
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

  /**
   * The tools of every switched-on server, for the AI on the phone: server, tool, the first line of its
   * description and its parameters (name, type, required). Connects switched-on servers that are not yet, but tries
   * one that failed at most once a minute in this list (a direct call still connects): each try spawns its command,
   * and the phone asks for this list often.
   */
  async phoneTools() {
    const servers = this._config();
    const now = Date.now();
    await Promise.all([...this.enabled].filter((n) => {
      const st = this.state.get(n);
      return servers[n] && !(st && st.status === "error" && now - st.at < RETRY_MS);
    }).map((n) => this._connect(n, servers[n])));
    const out = [];
    for (const server of [...this.enabled].sort()) {
      const s = this.reg.servers.get(server);
      for (const t of (s && s.tools) || []) {
        const sch = (t.inputSchema && typeof t.inputSchema === "object") ? t.inputSchema : {};
        const props = sch.properties && typeof sch.properties === "object" ? sch.properties : {};
        const req = Array.isArray(sch.required) ? sch.required : [];
        if (this._real(s, plainName(t.name, 80)) !== t) continue;   // callTool would refuse it
        out.push({
          server, name: plainName(t.name, 80),
          description: plainName(String(t.description || "").split(/\n/)[0], 160),
          params: Object.keys(props).slice(0, 12).map((k) => ({ name: k, type: String((props[k] && props[k].type) || "string"), required: req.includes(k) })),
        });
      }
    }
    return out;
  }

  /**
   * One tool call the person allowed on the phone. Only a switched-on server's own tools. Returns
   * { text, isError, truncated }: the result as text, cut to MAX_RESULT characters, never the server's command or env.
   */
  async callTool(server, tool, args) {
    const servers = this._config();
    if (!NAME_RE.test(String(server)) || !servers[server] || !this.enabled.has(server)) {
      throw Object.assign(new Error("No switched-on MCP server called " + String(server).slice(0, 64)), { status: 404 });
    }
    // Counted before connecting: a refused call never starts a server.
    const now = Date.now();
    this._calls = (this._calls || []).filter((t) => now - t < 60000);
    if (this._calls.length >= CALLS_PER_MINUTE) throw Object.assign(new Error("Too many tool calls. Try again in a minute."), { status: 429 });
    this._calls.push(now);
    await this._connect(server, servers[server]);
    const s = this.reg.servers.get(server);
    if (!s) throw Object.assign(new Error(server + " is not connected"), { status: 503 });
    const real = this._real(s, tool);
    if (!real) throw Object.assign(new Error(server + " has no tool called " + plainName(tool, 64)), { status: 404 });
    let res;
    try { res = await s.call(real.name, args, CALL_TIMEOUT_MS); } catch (e) { throw Object.assign(new Error(shortError(e)), { status: 502 }); }
    let text = require("../agent/mcp").resultToText(res);
    const truncated = text.length > MAX_RESULT;
    if (truncated) text = text.slice(0, MAX_RESULT) + "\n(cut off: the result was " + text.length + " characters)";
    return { text, isError: !!(res && res.isError), truncated };
  }

  /**
   * The one tool of a connected server whose name, as phoneTools() shows it, is `shown`; null when none or several, or
   * when its parameter names are not plain (the phone would show them differently from the ones it sends).
   */
  _real(s, shown) {
    const hits = ((s && s.tools) || []).filter((t) => typeof shown === "string" && shown && plainName(t.name, 80) === shown);
    const sch = hits.length === 1 && hits[0].inputSchema;
    const props = sch && typeof sch === "object" && sch.properties && typeof sch.properties === "object" ? sch.properties : {};
    return hits.length === 1 && Object.keys(props).every((k) => plainName(k, 40) === k) ? hits[0] : null;
  }

  _set(name, status, error) {
    this.state.set(name, { status, error: error ? shortError(error) : null, at: Date.now() });
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

  // ---- the store, from the phone ----

  _entries() {
    if (!this._cat) this._cat = clean(require("../store").bundled().mcp);
    return this._cat;
  }

  _fromStore(name, cfg) {
    return require("../store").isStoreSpec(this._entries().find((e) => e.id === name), cfg);
  }

  _rate() {
    const now = Date.now();
    this._changes = this._changes.filter((t) => now - t < 60000);
    if (this._changes.length >= CHANGES_PER_MINUTE) throw Object.assign(new Error("Too many changes. Try again in a minute."), { status: 429 });
    this._changes.push(now);
  }

  /** The store's MCP servers that can be added from the phone (not ArcFlare's own: those are already here). */
  async catalog() {
    let r;
    try { r = await this.catalogLoad(); } catch { r = null; }
    if (r && r.data && Array.isArray(r.data.mcp)) this._cat = clean(r.data.mcp);
    const servers = this._config();
    return {
      source: (r && r.source) || "bundled",
      servers: this._entries().map((e) => ({
        id: e.id, name: e.name, about: e.description, by: e.by, homepage: e.homepage || null,
        command: shown(e),
        argument: e.argument ? { name: e.argument.name, about: e.argument.about, required: e.argument.required } : null,
        installed: !!servers[e.id],
        removable: !!servers[e.id] && this._fromStore(e.id, servers[e.id]),
      })),
    };
  }

  /**
   * Add one catalogue server to the computer's mcp.json, switched off. The command is the catalogue's;
   * `command` is the line the owner was shown, and must still be what the catalogue says.
   */
  async install(id, argument, command) {
    const store = require("../store");
    await this.catalog();
    const e = this._entries().find((x) => x.id === id);
    if (!e) throw Object.assign(new Error("No such server in the store"), { status: 404 });
    if (command !== shown(e)) throw Object.assign(new Error("The store entry changed; reload the list"), { status: 409 });
    let extra = [];
    if (argument !== undefined && argument !== null && argument !== "") {
      if (!e.argument) throw Object.assign(new Error(e.name + " takes no argument"), { status: 400 });
      // The CLI's rules: one word of the characters a catalogue argument may use, and never an option.
      if (typeof argument !== "string" || !store.ARG.test(argument) || argument.startsWith("-")) {
        throw Object.assign(new Error("That " + e.argument.name + " cannot be used: letters, digits and / . _ : @ = + - only, no spaces"), { status: 400 });
      }
      extra = [argument];
    } else if (e.argument && e.argument.required) {
      throw Object.assign(new Error(e.name + " needs " + e.argument.name + ": " + e.argument.about), { status: 400 });
    }
    if (this._config()[e.id] || store.mcpState(e, { home: this.home }).installed) {
      throw Object.assign(new Error(e.name + " is already on this computer"), { status: 409 });
    }
    this._rate();
    try { store.addMcp(e, { home: this.home, extra }); } catch (err) { throw Object.assign(new Error(shortError(err)), { status: 500 }); }
    return this.list().find((s) => s.name === e.id) || null;
  }

  /** Remove a server the store added: switched off first. Hand-written and ArcFlare's own are not the phone's to remove. */
  async remove(name) {
    const servers = this._config();
    if (!NAME_RE.test(String(name)) || !servers[name]) throw Object.assign(new Error("No such MCP server"), { status: 404 });
    if (servers[name].builtin === true) throw Object.assign(new Error("ArcFlare's own servers cannot be removed; switch it off instead"), { status: 403 });
    if (!this._fromStore(name, servers[name])) {
      throw Object.assign(new Error("This server was not added from the store, so it is left as it is. Remove it on the computer."), { status: 409 });
    }
    this._rate();
    if (this.pending.has(name)) {
      await this.pending.get(name);
      // mcp.json may have been edited while it connected: check again before anything is switched off or removed.
      const now = this._config()[name];
      if (!now) throw Object.assign(new Error("No such MCP server"), { status: 404 });
      if (!this._fromStore(name, now)) throw Object.assign(new Error("This server was not added from the store, so it is left as it is. Remove it on the computer."), { status: 409 });
    }
    if (this.enabled.delete(name)) this._saveSwitches();
    this._drop(name);
    this.state.delete(name);
    if (!require("../store").removeMcp(name, { home: this.home })) throw Object.assign(new Error("No such MCP server"), { status: 404 });
    return { removed: name };
  }

  stopAll() {
    for (const name of [...this.reg.servers.keys()]) this._drop(name);
    for (const name of this.state.keys()) this.state.set(name, { status: "off", error: null });
  }
}

/** The command line the phone shows for a catalogue entry, with its argument as a placeholder. */
function shown(e) {
  return [e.command, ...e.args, ...(e.argument ? ["<" + e.argument.name + ">"] : [])].join(" ");
}

/** Catalogue entries that can be added from the phone: checked like a remote entry, and not ArcFlare's own. */
function clean(list) {
  const { cleanMcp } = require("../store");
  return (list || []).map(cleanMcp).filter((e) => e && !e.ours);
}

module.exports = { McpHub, loadHomeConfig, builtinServers, shortError, NAME_RE, MAX_RESULT };
