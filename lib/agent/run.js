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

/** A short, readable diff for an edit: up to `max` lines removed and added. */
function miniDiff(oldText, newText, max = 6) {
  const lines = (t) => String(t || "").replace(/\s+$/, "").split("\n");
  const o = lines(oldText), n = lines(newText);
  // Drop the lines both sides share at the start and end: the change is what
  // matters, and edits usually carry a line or two of context.
  let head = 0;
  while (head < o.length - 1 && head < n.length - 1 && o[head] === n[head]) head++;
  let tail = 0;
  while (tail < o.length - head - 1 && tail < n.length - head - 1 && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++;
  const del = o.slice(head, o.length - tail), add = n.slice(head, n.length - tail);
  const w = ui.cols() - 10;
  const show = (arr, sign, paint) => {
    const out = arr.slice(0, max).map((l) => `      ${paint(`${sign} ${ui.trunc(l, w)}`)}`);
    if (arr.length > max) out.push(`      ${c.dim(`${ui.sym.dot}${ui.sym.dot}${ui.sym.dot} ${arr.length - max} more`)}`);
    return out;
  };
  return [...show(del, "-", c.red), ...show(add, "+", c.green)].join("\n");
}

/** What a tool call is about, in one short phrase. */
function toolDetail(a) {
  let d = a.path || a.pattern || a.command || a.name || a.query || a.tool || "";
  if (typeof d !== "string") d = JSON.stringify(d);
  return String(d).replace(/\s+/g, " ");
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
      // The reply sits on the same 2-space margin as everything else.
      if (!state.contentStarted) {
        // After a tool line we're already on a fresh line; after "thinking…" we aren't.
        process.stdout.write(state.afterTool ? "\n  " : state.thinkingShown ? "\n\n  " : "  ");
        state.contentStarted = true;
        state.afterTool = false;
      }
      process.stdout.write(String(ev.text).replace(/\n/g, "\n  "));
      return;
    case "tool": {
      const a = ev.args || {};
      state.toolStart = Date.now();
      state.toolName = ev.name;
      // The next reply after a tool starts on a fresh line again.
      state.contentStarted = false;
      state.afterTool = true;
      process.stdout.write(`\n  ${c.accent("›")} ${c.bold(ev.name)} ${c.dim(ui.trunc(toolDetail(a), ui.cols() - ev.name.length - 8))}\n`);
      if (ev.name === "edit_file" && typeof a.old_string === "string") {
        process.stdout.write(miniDiff(a.old_string, a.new_string) + "\n");
      } else if (ev.name === "write_file" && typeof a.content === "string") {
        const n = a.content.split("\n").length;
        process.stdout.write(`      ${c.green(`+ ${n} line${n === 1 ? "" : "s"}`)}\n`);
      }
      return;
    }
    case "tool_result": {
      const out = String(ev.out || "");
      const lines = out.replace(/\s+$/, "").split("\n");
      const bad = out.startsWith("ERROR");
      // A command that ran but exited non-zero is a warning, not a pass.
      const failedExit = !bad && /\bexit (?:code )?[1-9]\d*\b/.test(lines[0] || "");
      const took = state.toolStart ? ui.fmtMs(Date.now() - state.toolStart) : "";
      state.toolStart = 0;
      const first = ui.trunc(String(lines[0] || "(no output)").replace(/\t/g, " "), ui.cols() - 24);
      const meta = [lines.length > 1 ? `${lines.length} lines` : "", took].filter(Boolean).join(` ${ui.sym.dot} `);
      process.stdout.write(
        `    ${bad ? c.red(ui.sym.fail) : failedExit ? c.accent(ui.sym.warn) : c.green(ui.sym.ok)} ${bad ? c.red(first) : c.dim(first)}` +
        (meta ? c.dim(`  ${meta}`) : "") + "\n");
      return;
    }
    case "compact":
      process.stdout.write(c.dim(`\n  ${ui.sym.dot} context compacted (${ev.actions.length} change${ev.actions.length === 1 ? "" : "s"}) to stay in the window\n`));
      return;
    case "error":
      process.stdout.write(`\n  ${c.red(ui.sym.fail)} ${ev.text}\n`);
      return;
    case "interrupted":
      process.stdout.write(`\n  ${c.accent(ui.sym.warn)} ${c.dim("interrupted")}\n`);
      return;
    case "done":
      process.stdout.write("\n");
      return;
  }
}

/**
 * The line under each turn: what it took. Counts are this turn's own, worked
 * out from the agent's running totals before and after.
 */
function turnSummary(before, after, ms) {
  const steps = after.steps - before.steps;
  const tools = after.toolCalls - before.toolCalls;
  const rates = after.tps.slice(before.tps.length);
  const tps = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const bits = [
    `${steps} step${steps === 1 ? "" : "s"}`,
    `${tools} tool${tools === 1 ? "" : "s"}`,
    tps ? `${tps.toFixed(1)} tok/s` : "",
    ui.fmtMs(ms),
  ].filter(Boolean);
  const text = ` ${bits.join(` ${ui.sym.dot} `)} `;
  const fill = Math.max(2, ui.cols() - 4 - ui.width(text) - 2);
  return c.dim(`  ${ui.sym.bar.repeat(2)}${text}${ui.sym.bar.repeat(fill)}`);
}

const snapStats = (st) => ({ steps: st.steps, toolCalls: st.toolCalls, tps: st.tps.slice() });

async function connectMcp(cfg, onLine) {
  const reg = new McpRegistry();
  const names = Object.keys(cfg.servers || {});
  if (!names.length) return { reg, results: [] };
  const results = await Promise.all(
    names.map((n) => reg.add(n, cfg.servers[n], { timeoutMs: 30000 })));
  for (const r of results) {
    if (onLine) {
      onLine(r.ok
        ? `  ${c.green(ui.sym.ok)} mcp ${c.bold(r.name)} ${c.dim(r.tools + " tools")}`
        : `  ${c.dim(ui.sym.dot)} mcp ${r.name} ${c.dim(r.error)}`);
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
    const w = ui.cols() - 8;
    const shown = String(detail).split("\n").slice(0, 6).map((l) => `  ${c.accent(ui.sym.vbar)} ${c.dim(ui.trunc(l, w))}`);
    process.stdout.write(`\n  ${c.accent(ui.sym.warn)} ${c.bold(`approve ${kind}`)}\n${shown.join("\n")}\n`);
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
  console.log(ui.section("agent", path.basename(cwd)));
  if (skills.length) {
    console.log(`  ${c.green(ui.sym.ok)} ${skills.length} skill${skills.length === 1 ? "" : "s"} ` +
      c.dim(skills.map((s) => s.name).slice(0, 6).join(", ")));
  }
  let notes = notesmod.load(cwd);
  if (notes.files.length) console.log(`  ${c.green(ui.sym.ok)} ${c.dim("project notes:")} ${c.dim(notesmod.describe(notes.files))}`);
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
    const before = snapStats(agent.stats), t0 = Date.now();
    try {
      await agent.send(text);
    } finally {
      turnFrom = "terminal";
      if (agent.checkpoints) agent.checkpoints.end();
      saveSession();
      console.log(turnSummary(before, agent.stats, Date.now() - t0) + "\n");
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
  if (upd) console.log(`  ${c.accent(ui.sym.up)} ${upd.text} ${c.dim(`${ui.sym.dot} /update`)}`);
  // The session at a glance, aligned, then a rule before the conversation.
  const approveLabel = { yolo: c.red("auto mode: runs without asking"), auto: "auto when not interactive", ask: "asks before commands" };
  console.log("");
  console.log(ui.kv([
    ["model", c.accent(opts.model || "?")],
    ["folder", c.dim(cwd)],
    ["window", `${ui.fmtTokens(opts.nCtx)} ${c.dim(`${ui.sym.dot} prefix ${overhead} tok`)}`],
    ["tools", `${require("./tools").SCHEMAS.length} built in ${c.dim(`${ui.sym.dot} ${mcpTools} mcp, schemas on demand`)}`],
    ["approvals", approveLabel[opts.approve || "ask"] || (opts.approve || "ask")],
  ]));
  console.log(ui.rule());
  if (!opts.prompt) console.log(c.dim(`  /help for commands ${ui.sym.dot} Ctrl+C stops a turn\n`));

  // One-shot mode
  if (opts.prompt) {
    state.thinkingShown = false; state.contentStarted = false;
    if (agent.checkpoints) agent.checkpoints.begin(opts.prompt);
    const before = snapStats(agent.stats), t0 = Date.now();
    await agent.send(opts.prompt);
    if (agent.checkpoints) agent.checkpoints.end();
    saveSession();
    console.log("\n" + turnSummary(before, agent.stats, Date.now() - t0));
    process.removeListener("SIGINT", onInterrupt);
    reg.stopAll();
    return;
  }

  // Interactive
  if (opts.rc) remote = await rc.command("/rc", null, { cfg: opts.cfg || {}, info: rcInfo() });

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", onInterrupt);
  const input = new rc.InputMux(rl, `${c.accent(ui.sym.prompt)} `);

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
      console.log(`  ${c.green(ui.sym.ok)} new conversation` + (had ? c.dim(` · the last one is saved (/resume ${old})`) : ""));
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
      if (arg && !doc) { console.log(`  ${c.red(ui.sym.fail)} no session matching "${arg}" ${c.dim("· /sessions lists them")}`); continue; }
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
        console.log(`    ${f.existed ? c.accent("↺") : c.red(ui.sym.fail)} ${rel}${f.existed ? "" : c.dim("  (new — will be deleted)")}${f.skipped ? c.dim("  (too big to restore)") : ""}`);
      }
      if (!(await confirm("Undo these changes?"))) { console.log(c.dim("  left as they are")); continue; }
      const r = cp.undo(turns.length);
      const changed = [...r.restored, ...r.removed].map((p) => path.relative(cwd, p) || p);
      console.log(`  ${c.green(ui.sym.ok)} undone: ${r.restored.length} restored, ${r.removed.length} removed` +
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
        console.log(`  ${c.green(ui.sym.ok)} AGENTS.md ${c.dim("· read at the start of every session; /clear loads it now")}`);
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
