// Wiring: load MCP config and skills, build the agent, render its events.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const ui = require("../ui");
const { Agent } = require("./agent");
const { McpRegistry, loadMcpConfig } = require("./mcp");
const skillsmod = require("./skills");
const trust = require("./trust");
const ctxmod = require("./context");
const rc = require("../rc");

const { c } = ui;
const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");

/**
 * ArcFlare's own machine server, connected unless something says otherwise.
 *
 * It is spawned by absolute path through this same Node binary rather than by
 * the `arcflare` command, so a clone that was never `npm link`ed still gets it.
 * A server the user has configured under the same name wins — theirs is the
 * deliberate one.
 */
function builtinMcpServer() {
  return {
    command: process.execPath,
    args: [path.join(__dirname, "..", "..", "bin", "arcflare-mcp.js")],
  };
}

function withBuiltinServer(cfg, opts = {}) {
  if (opts.machine === false || process.env.ARCFLARE_NO_MACHINE === "1") return cfg;
  if (cfg.servers && cfg.servers.arcflare) return cfg;
  return {
    ...cfg,
    servers: { arcflare: builtinMcpServer(), ...(cfg.servers || {}) },
  };
}

/**
 * Apply the trust gate, then add our own server.
 *
 * Order matters: the builtin is generated here rather than read off disk, so
 * it is never what the gate is protecting against, and a repo whose config is
 * withheld should still get an agent that can do things.
 */
function resolveMcpConfig(cwd, opts = {}) {
  const loaded = loadMcpConfig(cwd);
  const g = trust.gate(loaded, { assume: opts.trust });
  const gated = { file: loaded.file, origin: loaded.origin, servers: g.servers };
  return { cfg: withBuiltinServer(gated, opts), gate: g };
}

function renderEvent(ev, state) {
  switch (ev.type) {
    case "reasoning":
      if (!state.thinkingShown) {
        process.stdout.write(c.dim("  thinking… "));
        state.thinkingShown = true;
      }
      return;
    case "content":
      if (state.thinkingShown && !state.contentStarted) {
        process.stdout.write("\n");
      }
      if (!state.contentStarted) { state.contentStarted = true; }
      process.stdout.write(ev.text);
      return;
    case "tool": {
      const a = ev.args || {};
      let detail = a.path || a.pattern || a.command || a.name || a.query || a.tool || "";
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      process.stdout.write(`\n  ${c.accent("⚙")} ${c.bold(ev.name)} ${c.dim(String(detail).slice(0, 90))}\n`);
      return;
    }
    case "tool_result": {
      const out = String(ev.out || "");
      const firstLine = out.split("\n")[0].slice(0, 100);
      const lines = out.split("\n").length;
      const bad = out.startsWith("ERROR");
      process.stdout.write(
        `  ${bad ? c.red("└") : c.dim("└")} ${c.dim(firstLine)}` +
        (lines > 1 ? c.dim(`  (${lines} lines)`) : "") + "\n");
      return;
    }
    case "compact":
      process.stdout.write(c.dim(`\n  [context compacted: ${ev.actions.length} change(s)]\n`));
      return;
    case "error":
      process.stdout.write(`\n  ${c.red("✗")} ${ev.text}\n`);
      return;
    case "done":
      process.stdout.write("\n");
      return;
  }
}

async function connectMcp(cfg, onLine) {
  const reg = new McpRegistry();
  const names = Object.keys(cfg.servers || {});
  if (!names.length) return { reg, results: [] };
  const results = await Promise.all(
    names.map((n) => reg.add(n, cfg.servers[n], { timeoutMs: 30000 })));
  for (const r of results) {
    if (onLine) {
      onLine(r.ok
        ? `  ${c.green("✓")} mcp ${c.bold(r.name)} ${c.dim(r.tools + " tools")}`
        : `  ${c.dim("·")} mcp ${r.name} ${c.dim(r.error)}`);
    }
  }
  return { reg, results };
}

/** Approval prompt for shell commands and MCP calls. */
function makeApprover(mode) {
  if (mode === "yolo") return null;
  let always = false;
  return async (kind, detail) => {
    if (always) return true;
    if (!process.stdin.isTTY) return mode === "auto";
    process.stdout.write(
      `\n  ${c.accent("?")} run ${c.bold(kind)}: ${c.dim(String(detail).slice(0, 160))}\n`);
    const answer = await ui.select("Allow this?", [
      { label: "Yes", value: "y" },
      { label: "Yes, and don't ask again this session", value: "a" },
      { label: "No", value: "n" },
    ]);
    if (answer === "a") { always = true; return true; }
    return answer === "y";
  };
}

async function start(opts) {
  const cwd = opts.cwd || process.cwd();
  const { cfg: mcpCfg, gate } = resolveMcpConfig(cwd, opts);
  const skills = skillsmod.discover(cwd);

  console.log("");
  if (skills.length) {
    console.log(`  ${c.green("✓")} ${skills.length} skill${skills.length === 1 ? "" : "s"} ` +
      c.dim(skills.map((s) => s.name).slice(0, 6).join(", ")));
  }
  // Said out loud rather than logged quietly: the servers a repo asked for not
  // starting is exactly the kind of difference someone would otherwise spend
  // an hour debugging.
  const withheld = trust.explain(gate);
  if (withheld) console.log(`  ${c.red("!")} ${withheld}`);
  const { reg } = await connectMcp(mcpCfg, (l) => console.log(l));
  const mcpTools = reg.all().length;

  const agent = new Agent({
    port: opts.port,
    model: opts.model,
    cwd,
    mcp: mcpTools ? reg : null,
    skills,
    nCtx: opts.nCtx,
    sampling: opts.sampling || null,
    maxSteps: opts.maxSteps || 40,
    approve: routeApproval(),
    onEvent: (ev) => { renderEvent(ev, state); forward(ev); },
  });

  const state = { thinkingShown: false, contentStarted: false };

  // Remote control (/rc). `turnFrom` is who asked for the turn in progress,
  // and it decides who approves that turn's tools: the person who asked is the
  // one watching. A browser user should not be stuck waiting on a prompt that
  // only appeared in a terminal across the room.
  let remote = null;
  let turnFrom = "terminal";
  function routeApproval() {
    const terminal = makeApprover(opts.approve || "ask");
    if (!terminal) return null;   // auto mode is auto mode wherever the turn came from
    return (kind, detail) => (turnFrom === "remote" && remote && remote.active)
      ? remote.askApproval(kind, detail)
      : terminal(kind, detail);
  }
  function forward(ev) {
    if (!remote || !remote.active) return;
    const msg = rc.toRemote(ev);
    if (msg) remote.emit(msg);
  }
  const rcInfo = () => ({
    kind: "agent", model: opts.model, host: os.hostname(), cwd,
    approve: opts.approve || "ask", ctx: opts.nCtx,
    version: require("../../package.json").version,
  });
  async function runTurn(text, from) {
    turnFrom = from;
    state.thinkingShown = false;
    state.contentStarted = false;
    if (remote && remote.active) remote.emit({ type: "user", text, from });
    try {
      await agent.send(text);
    } finally {
      turnFrom = "terminal";
      if (remote && remote.active) remote.emit({ type: "turn_end" });
    }
  }

  const overhead = agent.overhead();
  const upd = require("../update").notice();
  if (upd) console.log(`  ${c.accent("↑")} ${upd.text} ${c.dim("· /update")}`);
  console.log(`  ${c.dim(`prefix ${overhead} tok · window ${ui.fmtTokens(opts.nCtx)} · ` +
    `${mcpTools} mcp tools indexed (schemas on demand)`)}\n`);

  // One-shot mode
  if (opts.prompt) {
    state.thinkingShown = false; state.contentStarted = false;
    await agent.send(opts.prompt);
    const tps = agent.stats.tps.length
      ? agent.stats.tps.reduce((a, b) => a + b, 0) / agent.stats.tps.length : 0;
    console.log(c.dim(`\n  ${agent.stats.steps} steps · ${agent.stats.toolCalls} tool calls · ` +
      `${tps.toFixed(1)} tok/s`));
    reg.stopAll();
    return;
  }

  // Interactive
  if (opts.rc) remote = await rc.command("/rc", null, { cfg: opts.cfg || {}, info: rcInfo() });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = new rc.InputMux(rl, `${c.accent("❯")} `);
  for (;;) {
    const got = await input.next(remote);
    if (got.text === null) break;
    const line = got.text.trim();
    if (!line) continue;
    if (got.from === "remote") {
      console.log(`\n  ${c.accent("⇄")} ${c.dim("remote:")} ${line}`);
      await runTurn(line, "remote");
      continue;
    }
    if (line === "/rc" || line.startsWith("/rc ")) {
      remote = await rc.command(line, remote, { cfg: opts.cfg || {}, info: rcInfo() });
      continue;
    }
    if (line === "/update" || line.startsWith("/update ")) {
      const r = await require("../update").apply({ from: line.split(/\s+/).slice(1).join(" ") || undefined });
      console.log(r.ok
        ? `  ${c.green("✓")} ${r.message} ${c.dim("· restart arcflare to use it — this session keeps the old code")}`
        : `  ${c.red("✗")} ${r.message}${r.offlineHint ? c.dim(" · offline? /update <folder-or-.tgz>") : ""}`);
      continue;
    }
    if (line === "/help") {
      console.log(c.dim("  /rc remote control · /update · /stats · /tools · /skills · /bye"));
      continue;
    }
    if (["/bye", "/exit", "/quit"].includes(line)) break;
    if (line === "/stats") {
      const tps = agent.stats.tps.length
        ? agent.stats.tps.reduce((a, b) => a + b, 0) / agent.stats.tps.length : 0;
      console.log(c.dim(`  steps ${agent.stats.steps} · tools ${agent.stats.toolCalls} · ` +
        `${tps.toFixed(1)} tok/s · prompt ~${ctxmod.totalTokens(agent.messages)} tok`));
      continue;
    }
    if (line === "/tools") {
      console.log(c.dim("  built-in: " + require("./tools").SCHEMAS.map((t) => t.function.name).join(", ")));
      if (mcpTools) console.log(c.dim(`  mcp: ${mcpTools} tools across ${reg.servers.size} servers`));
      continue;
    }
    if (line === "/skills") {
      for (const s of skills) console.log(`  ${c.accent(s.name)} ${c.dim(s.description.slice(0, 80))}`);
      continue;
    }
    await runTurn(line, "terminal");
  }
  rl.close();
  if (remote) await remote.close();
  reg.stopAll();
}

module.exports = {
  start, loadMcpConfig, connectMcp, withBuiltinServer, builtinMcpServer,
  resolveMcpConfig,
};
