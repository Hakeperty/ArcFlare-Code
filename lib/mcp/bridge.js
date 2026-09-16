// Bridging: one connection that carries every other MCP server you have.
//
// Two problems this solves, and they are the same problem at different scales.
// A harness that can only hold one server connection cannot reach Blender and
// the desktop and a hosted service at once. And a harness that can hold ten
// pays for all of them in context: every tool's schema sits in the prompt from
// the first token, which on the local models ArcFlare exists to run is the
// whole budget.
//
// So the bridge connects the servers itself and exposes three tools instead of
// three hundred: list what is there, search it, call one. Schemas arrive as
// results, when something has decided it wants them — the same trick the agent
// already plays, moved one layer down so any client gets it.

const { McpRegistry, loadMcpConfig, resultToText } = require("../agent/mcp");

// Never bridge ourselves: a server that bridges its own name connects to a
// second copy of itself, which bridges a third.
const SELF = "arcflare";

class Bridge {
  /**
   * @param {object} o
   * @param {string[]} [o.include]  only these servers (default: all configured)
   * @param {string}   [o.cwd]      where to look for config
   */
  constructor(o = {}) {
    this.cwd = o.cwd || process.cwd();
    this.include = (o.include || []).filter(Boolean);
    this.registry = new McpRegistry();
    this.state = new Map();   // name -> { status, tools, error, kind }
    this.connecting = null;
    this.loaded = null;
  }

  config() {
    if (!this.loaded) this.loaded = loadMcpConfig(this.cwd);
    return this.loaded;
  }

  /** Servers we are willing to bridge, from config, minus ourselves. */
  planned() {
    const { servers } = this.config();
    const out = {};
    for (const [name, cfg] of Object.entries(servers || {})) {
      if (name === SELF) continue;
      if (this.include.length && !this.include.includes(name)) continue;
      out[name] = cfg;
    }
    return out;
  }

  /**
   * Connect everything, once.
   *
   * Failures are recorded rather than thrown: Blender not being open is a fact
   * about the machine, not a reason for the other five servers to be
   * unreachable. Connections run in parallel because a cold Python server can
   * take seconds and there is no reason to pay for that serially.
   */
  connect(timeoutMs = 30000) {
    if (this.connecting) return this.connecting;
    const plan = this.planned();
    this.connecting = Promise.all(Object.entries(plan).map(async ([name, cfg]) => {
      const kind = cfg && cfg.url ? "http" : "stdio";
      const started = Date.now();
      const r = await this.registry.add(name, cfg, { timeoutMs });
      this.state.set(name, r.ok
        ? { status: "connected", tools: r.tools, kind, ms: Date.now() - started }
        : { status: "failed", error: r.error, kind, ms: Date.now() - started });
      return r;
    }));
    return this.connecting;
  }

  /** What is configured and what happened to it. */
  status() {
    const plan = this.planned();
    return Object.keys(plan).map((name) => ({
      name,
      kind: plan[name] && plan[name].url ? "http" : "stdio",
      target: plan[name].url || [plan[name].command, ...(plan[name].args || [])].join(" "),
      ...(this.state.get(name) || { status: "not connected" }),
    }));
  }

  async search(query, limit = 8) {
    await this.connect();
    return this.registry.search(query, limit);
  }

  async list() {
    await this.connect();
    return this.registry.all();
  }

  async call(tool, args, timeoutMs) {
    await this.connect();
    const found = this.registry.find(tool);
    if (!found) {
      // A wrong name is the common failure, and the useful answer is the near
      // miss rather than the word "unknown".
      const near = this.registry.search(String(tool).replace(/__/g, " "), 5)
        .map((t) => t.id);
      throw new Error(`no bridged tool "${tool}"` +
        (near.length ? `. Did you mean: ${near.join(", ")}?` : ". Call bridge_search first."));
    }
    const server = this.registry.servers.get(found.server);
    const res = await server.call(found.name, args || {}, timeoutMs || 300000);
    return { text: resultToText(res), raw: res };
  }

  stopAll() {
    this.registry.stopAll();
    this.connecting = null;
    this.state.clear();
  }
}

module.exports = { Bridge, SELF };
