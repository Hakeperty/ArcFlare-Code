// Wiring: load MCP config and skills, build the agent, render its events.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const ui = require("../ui");
const { Agent } = require("./agent");
const { McpRegistry } = require("./mcp");
const skillsmod = require("./skills");
const ctxmod = require("./context");

const { c } = ui;
const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");

/**
 * MCP server config, in the shape everything else already uses:
 *   { "mcpServers": { "name": { "command": "...", "args": [...] } } }
 * We read ArcFlare's own file first, then fall back to a Claude config so an
 * existing setup works without being copied.
 */
function loadMcpConfig(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, ".arcflare", "mcp.json"),
    path.join(cwd, ".mcp.json"),
    path.join(HOME, "mcp.json"),
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
  const mcpCfg = loadMcpConfig(cwd);
  const skills = skillsmod.discover(cwd);

  console.log("");
  if (skills.length) {
    console.log(`  ${c.green("✓")} ${skills.length} skill${skills.length === 1 ? "" : "s"} ` +
      c.dim(skills.map((s) => s.name).slice(0, 6).join(", ")));
  }
  const { reg } = await connectMcp(mcpCfg, (l) => console.log(l));
  const mcpTools = reg.all().length;

  const agent = new Agent({
    port: opts.port,
    model: opts.model,
    cwd,
    mcp: mcpTools ? reg : null,
    skills,
    nCtx: opts.nCtx,
    maxSteps: opts.maxSteps || 40,
    approve: makeApprover(opts.approve || "ask"),
    onEvent: (ev) => renderEvent(ev, state),
  });

  const state = { thinkingShown: false, contentStarted: false };

  const overhead = agent.overhead();
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((r) => rl.question(`${c.accent("❯")} `, r));
  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
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
    state.thinkingShown = false;
    state.contentStarted = false;
    await agent.send(line);
  }
  rl.close();
  reg.stopAll();
}

module.exports = { start, loadMcpConfig, connectMcp };
