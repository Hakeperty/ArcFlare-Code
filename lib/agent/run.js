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
const notesmod = require("./notes");
const sessions = require("./sessions");
const { Checkpoints } = require("./checkpoints");
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
    case "interrupted":
      process.stdout.write(`\n  ${c.dim("⏹ interrupted")}\n`);
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

const INIT_PROMPT = (file) => `Write an AGENTS.md for this repository at ${file}, for coding agents (and people) working in it.

Explore first with your tools: the README, the package or build files, the test setup, and the main source folders. Then write the file with write_file. Keep it under about 60 lines of Markdown, and only state things you checked:

- what the project is, in one or two sentences
- how to install, build, run and test it (exact commands)
- the layout: which folders hold what
- conventions worth following (style, naming, how tests are written, things to avoid)

No filler, no guesses. Reply with one line when it's written.`;

/**
 * Resolve `--resume [id]` and `--continue` before a model is picked: a resumed
 * session should come back on the model it used. Returns the argv with those
 * flags removed, and the session document (or null).
 */
async function resolveResume(argv, cwd) {
  const out = [];
  let want = null; // "pick" | "latest" | id
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--continue") { want = "latest"; continue; }
    if (a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && sessions.find(next)) { want = next; i++; }
      else want = "pick";
      continue;
    }
    out.push(a);
  }
  if (!want) return { argv: out, session: null };
  const here = sessions.list({ cwd });
  if (want === "latest") return { argv: out, session: here.length ? sessions.load(here[0].id) : null, none: !here.length };
  if (want !== "pick") return { argv: out, session: sessions.find(want) };
  if (!here.length) return { argv: out, session: null, none: true };
  const id = await pickSession(here, "Resume which session?");
  return { argv: out, session: id ? sessions.load(id) : null, cancelled: !id };
}

async function pickSession(list, title) {
  if (!process.stdin.isTTY) return list[0] ? list[0].id : null;
  return ui.select(title, list.slice(0, 12).map((s) => ({
    label: s.title,
    value: s.id,
    hint: `${sessions.ago(s.updated)} · ${s.turns} turn${s.turns === 1 ? "" : "s"}`,
  })));
}

function contextBar(u, width = 32) {
  const parts = [
    ["system", u.system, c.grey],
    ["notes", u.notes, c.accent],
    ["skills+mcp", u.skills + u.mcp, c.dim],
    ["tools", u.tools, c.grey],
    ["conversation", u.conversation, c.green],
  ];
  const used = parts.reduce((s, p) => s + p[1], 0);
  let bar = "";
  for (const [, n, paint] of parts) {
    const cells = Math.round((n / u.window) * width);
    if (cells) bar += paint("█".repeat(cells));
  }
  const filled = Math.min(width, Math.round((used / u.window) * width));
  bar += c.dim("░".repeat(Math.max(0, width - filled)));
  const lines = [`  ${bar}  ${ui.fmtTokens(used)} / ${ui.fmtTokens(u.window)} (${Math.round((used / u.window) * 100)}%)`];
  for (const [name, n] of parts) {
    if (!n) continue;
    lines.push(`  ${c.dim(name.padEnd(13))} ${String(ui.fmtTokens(n)).padStart(6)}`);
  }
  return lines.join("\n");
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const a = await ui.select(question, [{ label: "Yes", value: "y" }, { label: "No", value: "n" }]);
  return a === "y";
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
  let notes = notesmod.load(cwd);
  if (notes.files.length) console.log(`  ${c.green("✓")} ${c.dim("project notes:")} ${c.dim(notesmod.describe(notes.files))}`);
  // Said out loud rather than logged quietly: the servers a repo asked for not
  // starting is exactly the kind of difference someone would otherwise spend
  // an hour debugging.
  const withheld = trust.explain(gate);
  if (withheld) console.log(`  ${c.red("!")} ${withheld}`);
  const { reg } = await connectMcp(mcpCfg, (l) => console.log(l));
  const mcpTools = reg.all().length;

  // The session: a fresh one, or the one --resume / --continue picked.
  let session = opts.session
    ? { id: opts.session.id, created: opts.session.created }
    : { id: sessions.newId(), created: new Date().toISOString() };
  const checkpointsFor = (id) => Checkpoints.load(path.join(sessions.folderFor(id), "checkpoints.json"));

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
    projectNotes: notes.text,
    checkpoints: checkpointsFor(session.id),
    onEvent: (ev) => { renderEvent(ev, state); forward(ev); },
  });

  const state = { thinkingShown: false, contentStarted: false };

  const saveSession = () => {
    try {
      sessions.save({
        id: session.id, cwd, model: opts.model, modelRef: opts.modelRef || null,
        created: session.created, messages: agent.conversation(),
      });
    } catch { /* a full disk shouldn't end the session */ }
  };
  try { sessions.prune(); } catch {}

  function showResumed(doc) {
    const conv = (doc.messages || []);
    const turns = conv.filter((m) => m.role === "user").length;
    console.log(`  ${c.accent("↺")} resumed ${c.bold(doc.title || doc.id)} ${c.dim(`· ${turns} turn${turns === 1 ? "" : "s"} · ${sessions.ago(doc.updated)}`)}`);
    if (doc.model && opts.model && doc.model !== opts.model) {
      console.log(`  ${c.dim(`  (it ran on ${doc.model}; now on ${opts.model})`)}`);
    }
    const lastReply = [...conv].reverse().find((m) => m.role === "assistant" && m.content);
    if (lastReply) console.log(c.dim(`  last reply: ${String(lastReply.content).replace(/\s+/g, " ").slice(0, 140)}`));
  }
  if (opts.session) {
    agent.loadConversation(opts.session.messages);
    showResumed(opts.session);
  }

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
    if (agent.checkpoints) agent.checkpoints.begin(text);
    try {
      await agent.send(text);
    } finally {
      turnFrom = "terminal";
      if (agent.checkpoints) agent.checkpoints.end();
      saveSession();
      if (remote && remote.active) remote.emit({ type: "turn_end" });
    }
  }

  // Ctrl+C: stop the turn in progress; at the prompt, twice in a row to leave.
  // Readline reports it while it owns the terminal (raw mode); between prompts
  // — e.g. after an approval menu handed the terminal back — it arrives as a
  // process signal, so both are wired to the same thing.
  let lastInterrupt = 0;
  let rl = null;
  const onInterrupt = () => {
    if (agent.busy) {
      agent.abort();
      lastInterrupt = 0;
      return;
    }
    const now = Date.now();
    if (now - lastInterrupt < 1500) {
      if (rl) rl.close();
      else process.exit(130);
      return;
    }
    lastInterrupt = now;
    process.stdout.write(`\n  ${c.dim("(Ctrl+C again to exit, or /bye)")}\n`);
    if (rl) { rl.write(null, { ctrl: true, name: "u" }); rl.prompt(true); }
  };
  process.on("SIGINT", onInterrupt);

  const overhead = agent.overhead();
  const upd = require("../update").notice();
  if (upd) console.log(`  ${c.accent("↑")} ${upd.text} ${c.dim("· /update")}`);
  console.log(`  ${c.dim(`prefix ${overhead} tok · window ${ui.fmtTokens(opts.nCtx)} · ` +
    `${mcpTools} mcp tools indexed (schemas on demand)`)}\n`);

  // One-shot mode
  if (opts.prompt) {
    state.thinkingShown = false; state.contentStarted = false;
    if (agent.checkpoints) agent.checkpoints.begin(opts.prompt);
    await agent.send(opts.prompt);
    if (agent.checkpoints) agent.checkpoints.end();
    saveSession();
    const tps = agent.stats.tps.length
      ? agent.stats.tps.reduce((a, b) => a + b, 0) / agent.stats.tps.length : 0;
    console.log(c.dim(`\n  ${agent.stats.steps} steps · ${agent.stats.toolCalls} tool calls · ` +
      `${tps.toFixed(1)} tok/s`));
    process.removeListener("SIGINT", onInterrupt);
    reg.stopAll();
    return;
  }

  // Interactive
  if (opts.rc) remote = await rc.command("/rc", null, { cfg: opts.cfg || {}, info: rcInfo() });

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", onInterrupt);
  const input = new rc.InputMux(rl, `${c.accent("❯")} `);

  /** Switch the agent to another session (or a fresh one when `doc` is null). */
  function switchTo(doc) {
    saveSession();
    notes = notesmod.load(cwd); // the one moment the prefix may change
    session = doc ? { id: doc.id, created: doc.created } : { id: sessions.newId(), created: new Date().toISOString() };
    agent.checkpoints = checkpointsFor(session.id);
    agent.reset({ projectNotes: notes.text });
    if (doc) agent.loadConversation(doc.messages);
  }

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
      await require("../update").slash(line, c);
      continue;
    }
    if (line === "/report" || line.startsWith("/report ")) {
      const text = line.replace(/^\/report\s*/, "").trim();
      const rep = require("../report");
      const v = rep.validate({ kind: "bug", where: "cli", title: text.slice(0, 120), body: text, version: require("../../package.json").version });
      if (v.error) console.log(`  ${c.dim("usage: /report <what went wrong> (" + v.error + ")")}`);
      else {
        const r = await rep.send(v.payload);
        console.log(`  ${rep.outcome(r, c)}`);
      }
      continue;
    }
    if (line === "/help") {
      console.log(c.dim(
        "  /clear new conversation · /resume · /sessions · /undo [n] · /context · /init write AGENTS.md\n" +
        "  /rc remote control · /update · /report · /stats · /tools · /skills · /bye\n" +
        "  Ctrl+C stops the current turn; twice at the prompt exits"));
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
    if (line === "/context") {
      console.log(contextBar(agent.usage()));
      if (notes.files.length) console.log(c.dim(`  notes: ${notesmod.describe(notes.files)}`));
      continue;
    }
    if (line === "/clear") {
      const had = agent.conversation().some((m) => m.role === "user");
      const old = session.id;
      switchTo(null);
      console.log(`  ${c.green("✓")} new conversation` + (had ? c.dim(` · the last one is saved (/resume ${old})`) : ""));
      continue;
    }
    if (line === "/sessions") {
      const list = sessions.list({ cwd });
      if (!list.length) { console.log(c.dim("  no saved sessions for this folder yet")); continue; }
      for (const s of list.slice(0, 15)) {
        const mark = s.id === session.id ? c.accent("❯") : " ";
        console.log(`  ${mark} ${c.dim(s.id)}  ${s.title.slice(0, 60)} ${c.dim(`· ${s.turns} · ${sessions.ago(s.updated)}`)}`);
      }
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const arg = line.slice(7).trim();
      let doc = arg ? sessions.find(arg) : null;
      if (arg && !doc) { console.log(`  ${c.red("✗")} no session matching "${arg}" ${c.dim("· /sessions lists them")}`); continue; }
      if (!doc) {
        const list = sessions.list({ cwd }).filter((s) => s.id !== session.id);
        if (!list.length) { console.log(c.dim("  no other saved sessions for this folder")); continue; }
        const id = await pickSession(list, "Resume which session?");
        if (!id) continue;
        doc = sessions.load(id);
      }
      switchTo(doc);
      showResumed(doc);
      continue;
    }
    if (line === "/undo" || line.startsWith("/undo ")) {
      const cp = agent.checkpoints;
      const n = Math.max(1, parseInt(line.slice(5).trim(), 10) || 1);
      if (!cp || !cp.count) {
        console.log(c.dim("  nothing to undo · only edits made with write_file and edit_file are tracked, not shell commands"));
        continue;
      }
      const turns = cp.preview(Math.min(n, cp.count));
      const files = [...new Map(turns.flatMap((t) => t.files).map((f) => [f.path, f])).values()];
      console.log(`  ${c.bold(`Undo the last ${turns.length} turn${turns.length === 1 ? "" : "s"}`)} ${c.dim("— these files go back to how they were:")}`);
      for (const f of files) {
        const rel = path.relative(cwd, f.path) || f.path;
        console.log(`    ${f.existed ? c.accent("↺") : c.red("✗")} ${rel}${f.existed ? "" : c.dim("  (new — will be deleted)")}${f.skipped ? c.dim("  (too big to restore)") : ""}`);
      }
      if (!(await confirm("Undo these changes?"))) { console.log(c.dim("  left as they are")); continue; }
      const r = cp.undo(turns.length);
      const changed = [...r.restored, ...r.removed].map((p) => path.relative(cwd, p) || p);
      console.log(`  ${c.green("✓")} undone: ${r.restored.length} restored, ${r.removed.length} removed` +
        (r.skipped.length ? c.dim(` · ${r.skipped.length} couldn't be restored`) : ""));
      // The model still believes its edits are there; tell it with the next message.
      if (changed.length) {
        agent.pendingNote = `[Note: the user undid your file changes from the last ${r.turns} turn${r.turns === 1 ? "" : "s"}. ` +
          `These files are back to how they were before: ${changed.join(", ")}. Read them again before editing.]`;
      }
      saveSession();
      continue;
    }
    if (line === "/init") {
      const file = path.join(cwd, "AGENTS.md");
      if (fs.existsSync(file) && !(await confirm("AGENTS.md exists. Replace it?"))) { console.log(c.dim("  kept the existing AGENTS.md")); continue; }
      await runTurn(INIT_PROMPT(file), "terminal");
      if (fs.existsSync(file)) {
        console.log(`  ${c.green("✓")} AGENTS.md ${c.dim("· read at the start of every session; /clear loads it now")}`);
      }
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
  process.removeListener("SIGINT", onInterrupt);
  saveSession();
  if (agent.conversation().some((m) => m.role === "user")) {
    console.log(c.dim(`  saved · arcflare agent --resume ${session.id}`));
  }
  if (remote) await remote.close();
  reg.stopAll();
}

module.exports = {
  start, loadMcpConfig, connectMcp, withBuiltinServer, builtinMcpServer,
  resolveMcpConfig, resolveResume, contextBar, INIT_PROMPT,
};
