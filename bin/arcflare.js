#!/usr/bin/env node
// ArcFlare — run local GGUF models and point any coding harness at them.
//
// `arcflare` with no arguments opens a menu: pick a harness, pick a model,
// pick a context size. Everything else is a shortcut for part of that flow.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ui = require("../lib/ui");
const gguf = require("../lib/gguf");
const fit = require("../lib/fit");
const models = require("../lib/models");
const engine = require("../lib/engine");
const harness = require("../lib/harness");

const serve = require("../lib/serve");

const { c } = ui;
const HOME = models.HOME;
const VERSION = require("../package.json").version;
// Model loading lives in lib/serve.js so the desktop app shares it; these
// names are kept so the rest of this file reads as it did.
const {
  CONFIG, PRESET, DEFAULT_PORT, MEMORY_PROFILES, DEFAULT_PROFILE,
  DEFAULT_UBATCH, MIN_UBATCH, UBATCH_SIZES, ubatchFor, loadConfig, saveConfig,
  deviceMemory, freeDeviceBytes, planningBudget, servedIdFor, presetIdFor,
  writePresetFor, warmup,
} = serve;





// --------------------------------------------------------------- settings --




function die(msg, code = 1) {
  process.stderr.write(`  ${c.red(ui.sym.fail)} ${msg}\n`);
  process.exit(code);
}

// ------------------------------------------------------- the machine server --
//
// Everything else ArcFlare installs is a model and a server on loopback. The
// machine server is a different kind of thing: it runs commands, opens
// applications, reads the clipboard and photographs the screen. That is the
// point of it, and it is also a fair amount to hand to a model that fits in
// 8 GB — so it is a component you choose, asked once and remembered.
//
// Undecided is not the same as off. Someone who has never seen the question
// keeps what they had, and a pipe cannot answer one, so the default only
// applies where nobody could have been asked.

const MACHINE_NOTE = "runs commands · opens apps · reads the clipboard · sees the screen";

/** The stored answer, or null if it has never been asked. */
function machineSetting(cfg) {
  return typeof cfg.machine === "boolean" ? cfg.machine : null;
}

/**
 * Whether to wire the machine server up, asking once if it has never come up.
 * `assume` answers for a caller that already knows (a flag on the command line).
 */
async function wantMachine(cfg, { assume } = {}) {
  if (typeof assume === "boolean") {
    saveConfig({ ...loadConfig(), machine: assume });
    return assume;
  }
  const stored = machineSetting(cfg);
  if (stored !== null) return stored;
  if (!process.stdin.isTTY) return true;

  const pick = await ui.select("Machine control", [
    { label: "Yes, install it", hint: "screenshots, apps, builds and tests", value: "yes",
      note: MACHINE_NOTE },
    { label: "No, models only", hint: "the agent keeps files, search and the shell", value: "no" },
  ], {
    subtitle: "ArcFlare's machine server lets a model drive this computer",
    selected: "yes",
  });
  if (!pick) return machineSetting(cfg) ?? true;   // esc: decide nothing
  const on = pick === "yes";
  saveConfig({ ...loadConfig(), machine: on });
  return on;
}

// ------------------------------------------------------------------ vram ----







// ------------------------------------------------------------- model list --

function modelLabel(m) {
  const meta = m.meta;
  const bits = [];
  if (meta && meta.quant) bits.push(meta.quant);
  bits.push(ui.fmtBytes(m.size));
  if (meta && meta.trainCtx) bits.push(ui.fmtTokens(meta.trainCtx) + " ctx");
  if (meta && meta.expertCount) bits.push(`MoE ${meta.expertUsed}/${meta.expertCount}`);
  return bits.join(" · ");
}

function displayName(m) {
  return (m.meta && m.meta.name) || m.id.split(":")[0];
}

function listModels(all) {
  if (!all.length) {
    console.log(`  ${c.dim("no GGUF models found")}`);
    console.log(`  ${c.dim("searched:")} ${models.roots().join(", ") || "(nothing)"}`);
    console.log(`  ${c.dim("set ARCFLARE_MODELS or LLAMA_CACHE to point at your models")}`);
    return;
  }
  // Anything `arcflare fit --run` has measured is worth more than anything the
  // header can tell you, so it goes on the same line rather than in its own
  // command someone has to know to run.
  const measured = fit.load().rows;
  const total = all.reduce((n, m) => n + (m.size || 0), 0);
  console.log("");
  console.log(ui.section("models", `${all.length} found ${ui.sym.dot} ${ui.fmtBytes(total)}`));
  const head = ["model", "quant", "size", "context", "", "speed"].map((h) => c.dim(h));
  const rows = all.map((m) => {
    const meta = m.meta || {};
    const r = measured[m.id];
    const rate = r && r.gen && typeof r.gen.tokPerSec === "number" ? c.green(fit.fmtRate(r.gen.tokPerSec)) : c.dim("-");
    return [
      c.accent(m.id),
      meta.quant || c.dim("?"),
      ui.fmtBytes(m.size),
      meta.trainCtx ? ui.fmtTokens(meta.trainCtx) : c.dim("?"),
      meta.expertCount ? c.dim(`MoE ${meta.expertUsed}/${meta.expertCount}`) : "",
      rate,
    ];
  });
  // Narrower terminals lose the MoE column first, then get one entry per model.
  const fits = (t) => t.split("\n").every((l) => ui.width(l) <= ui.cols());
  const full = ui.table([head, ...rows]);
  const slim = ui.table([head, ...rows].map((r) => r.filter((_, i) => i !== 4)));
  if (fits(full)) console.log(full);
  else if (fits(slim)) console.log(slim);
  else for (const m of all) console.log(`  ${c.accent(m.id)}\n      ${c.dim(modelLabel(m))}`);
  console.log("");
}

// --------------------------------------------------------------- context ----

function contextChoices(m, budget) {
  return serve.contextChoices(m, budget, { tokens: ui.fmtTokens, bytes: ui.fmtBytes });
}

// ---------------------------------------------------------------- server ----

async function ensureServer(cfg, opts = {}) {
  let spin = null;
  try {
    const r = await serve.ensureServer(cfg, {
      ...opts,
      onProgress: (p) => {
        if (p.stage !== "server-starting") return;
        const text = `starting llama-server… ${Math.round(p.ms / 1000)}s`;
        if (!spin) spin = ui.spinner(text); else spin.update(text);
      },
    });
    if (spin) spin.stop(`${c.green(ui.sym.ok)} llama-server ready on ${c.accent("127.0.0.1:" + r.port)}`);
    return r;
  } catch (e) {
    if (spin) spin.stop(c.red("✗ server did not come up"));
    if (e.code === "NO_ENGINE") {
      die("llama-server not found.\n" +
        `      Install llama.cpp, then either put it on PATH or run:\n` +
        `      ${c.accent("arcflare set-engine <path-to-llama-server>")}`);
    }
    if (e.log) console.log(c.dim(e.log));
    process.exit(1);
  }
}



// ------------------------------------------------------------------ chat ----

function chatOnce(port, model, messages, onDelta) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, stream: true });
    const req = http.request(
      {
        host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let buf = "";
        let full = "";
        res.on("data", (d) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const d0 = j.choices && j.choices[0] && j.choices[0].delta;
              const piece = d0 && (d0.content || "");
              if (piece) { full += piece; onDelta(piece); }
            } catch {}
          }
        });
        res.on("end", () => resolve(full));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function repl(port, modelId, opts = {}) {
  const readline = require("readline");
  const rc = require("../lib/rc");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];
  console.log(`  ${c.dim("chatting with")} ${c.accent(modelId)} ${c.dim("— /rc remote control · /bye to exit")}\n`);
  updateBanner(loadConfig());
  // stdin can end under us — piped input running out, or Ctrl-D. readline
  // then never answers the question, and asking again throws
  // ERR_USE_AFTER_CLOSE. InputMux treats a close as an answer of null, and
  // also lets a browser connected with /rc type into the same conversation.
  const input = new rc.InputMux(rl, `${c.accent("❯")} `);
  const info = () => ({ kind: "chat", model: modelId, host: os.hostname(), cwd: process.cwd(), version: VERSION });
  let remote = opts.rc ? await rc.command("/rc", null, { cfg: loadConfig(), info: info() }) : null;
  for (;;) {
    const got = await input.next(remote);
    if (got.text === null) break;
    const line = got.text.trim();
    if (!line) continue;
    if (got.from === "terminal") {
      if (line === "/bye" || line === "/exit" || line === "/quit") break;
      if (line === "/rc" || line.startsWith("/rc ")) {
        remote = await rc.command(line, remote, { cfg: loadConfig(), info: info() });
        continue;
      }
      if (line === "/update" || line.startsWith("/update ")) { await slashUpdate(line); continue; }
      if (line === "/report" || line.startsWith("/report ")) { await slashReport(line); continue; }
      if (line === "/help") { console.log(c.dim("  /rc remote control · /update · /report · /bye")); continue; }
    } else {
      console.log(`\n  ${c.accent("⇄")} ${c.dim("remote:")} ${line}`);
    }
    const live = remote && remote.active ? remote : null;
    if (live) live.emit({ type: "user", text: line, from: got.from });
    history.push({ role: "user", content: line });
    process.stdout.write("\n");
    let out = "";
    try {
      out = await chatOnce(port, modelId, history, (p) => {
        process.stdout.write(p);
        if (live) live.emit({ type: "delta", kind: "content", text: p });
      });
    } catch (e) {
      console.log(c.red("  request failed: " + e.message));
      if (live) live.emit({ type: "error", text: "request failed: " + e.message });
      if (live) live.emit({ type: "turn_end" });
      history.pop();
      continue;
    }
    history.push({ role: "assistant", content: out });
    if (live) live.emit({ type: "turn_end" });
    process.stdout.write("\n\n");
  }
  rl.close();
  if (remote) await remote.close();
}

// ------------------------------------------------------------------ flow -----

async function interactive(argv) {
  const cfg = loadConfig();
  console.log(ui.banner());
  updateBanner(cfg);

  const all = models.discover({ meta: true });
  if (!all.length) {
    listModels(all);
    return;
  }

  // 1. harness
  const hs = harness.list();
  const hItems = hs.map((h) => ({
    label: h.label,
    hint: h.builtin ? "built in" : h.installed ? "" : c.dim("not installed"),
    note: h.installed && h.bin && !h.builtin ? "" : "",
    value: h.id,
    disabled: !h.installed,
  }));
  const hid = await ui.select("Choose a harness", hItems, {
    subtitle: "ArcFlare will point it at your local model",
    selected: cfg.lastHarness,
  });
  if (!hid) return;
  const chosen = harness.byId(hid);
  const det = chosen.detect();

  // 2. model
  const mItems = all.map((m) => ({
    label: displayName(m),
    hint: m.id.includes(":") ? m.id.split(":")[1] : "",
    note: modelLabel(m),
    value: m.id,
  }));
  const mid = await ui.select("Choose a model", mItems, { selected: cfg.lastModel });
  if (!mid) return;
  const model = all.find((m) => m.id === mid);

  // 3. context
  const budget = await planningBudget(cfg);
  const { items: cItems, best } = contextChoices(model, budget);
  const ctxPick = await ui.select("Context size", cItems, {
    subtitle: `${ui.fmtBytes(budget)} free on device · ${ui.fmtBytes(model.size)} of weights`,
  });
  if (!ctxPick) return;
  const { ctx, cacheType } = ctxPick;

  // 4. auto mode
  //
  // Every harness that runs tools is asked, because every one of them can be
  // started with its approvals off: opencode's --auto, Codex's bypass flag,
  // Hermes' --yolo, the agent's own mode. The plain chat is the one entry with
  // no tools to approve, so it is the one the question would be noise for. The
  // answer is remembered, because a person who wants auto mode wants it every
  // time — and left alone when we did not ask, so picking chat for one session
  // does not quietly turn the agent's auto mode off.
  let approve = "ask";
  if (chosen.auto) {
    const pick = await ui.select("Tool approval", [
      { label: "Ask first", hint: "confirm each command and tool call", value: "ask" },
      { label: "Auto mode", hint: "run tools without asking", value: "yolo",
        note: chosen.auto.note },
    ], {
      subtitle: chosen.builtin
        ? "the agent can edit files, run commands and test what it builds"
        : `ArcFlare starts ${chosen.label} with ${chosen.auto.label}`,
      selected: cfg.autoMode ? "yolo" : "ask",
    });
    if (!pick) return;
    approve = pick;
  }

  // 4b. the machine server, for the harness that would actually get one. Asked
  // after approval on purpose: the two answers are read together, and "run
  // tools without asking" means something different once one of the tools is
  // a camera pointed at the screen.
  const machine = chosen.id === "agent" ? await wantMachine(cfg) : machineSetting(cfg) !== false;

  // Persist the choice as a router preset so the setting survives a reload.
  const label = displayName(model);
  saveConfig({
    ...cfg, lastHarness: hid, lastModel: mid,
    autoMode: chosen.auto ? approve === "yolo" : cfg.autoMode,
    port: cfg.port || DEFAULT_PORT,
  });

  // 5. server, keyed preset, restart
  const { port, servedId, ctx: loadedCtx } = await prepareModel(cfg, model, ctx, cacheType);

  // 6. wire the harness up
  const target = { id: servedId, label, file: model.file };
  const res = chosen.configure({ port, model: target, ctx, apiKey: "arcflare", bin: det.bin });
  for (const n of res.notes || []) console.log(`  ${c.dim(n)}`);
  if (!res.ok) die("could not configure " + chosen.label);

  console.log(`  ${c.green(ui.sym.ok)} ${chosen.label} → ${c.accent(servedId)} @ ${ui.fmtTokens(ctx)} ctx` +
    (chosen.auto ? c.dim(`  ${approve === "yolo" ? "auto mode" : "approval: ask"}`) : "") + "\n");

  // 7. go
  if (chosen.id === "agent") {
    await require("../lib/agent/run").start({
      port,
      model: servedId,
      nCtx: loadedCtx || ctx,
      sampling: (models.loadMeta(model) || {}).sampling || null,
      cwd: process.cwd(),
      approve,
      machine,
    });
    return;
  }
  if (chosen.builtin) {
    await repl(port, servedId);
    return;
  }
  const child = chosen.launch({ bin: det.bin, model: target, port, args: argv.slice(1), approve });
  if (child) {
    child.on("exit", (code) => process.exit(code || 0));
    await new Promise(() => {});
  }
}





/**
 * Load a model, stepping down if it does not fit (see lib/serve.js), with the
 * CLI's spinners on top.
 */
async function prepareModel(cfg, model, ctx, cacheType) {
  let spin = null;
  const r = await serve.prepareModel(cfg, model, ctx, cacheType, {
    onProgress: (p) => {
      if (p.stage === "loading") {
        spin = ui.spinner(`loading ${displayName(model)} @ ${ui.fmtTokens(p.ctx)} ctx…`);
      } else if (p.stage === "loaded" && spin) {
        spin.stop(`${c.green(ui.sym.ok)} loaded at ${c.accent(ui.fmtTokens(p.ctx))} context` +
          (p.reducedFrom ? c.dim(`  (reduced from ${ui.fmtTokens(p.reducedFrom)} — device could not fit it)`) : ""));
      } else if (p.stage === "retry" && spin) {
        spin.stop(p.reason === "batch"
          ? `${c.dim(ui.sym.dot)} did not fit — retrying with a smaller batch, same context`
          : `${c.dim(ui.sym.dot)} did not fit — retrying at ${ui.fmtTokens(p.ctx)}`);
      } else if (p.stage === "failed" && spin) {
        spin.stop(`${c.red(ui.sym.fail)} ${String(p.error).slice(0, 120)}`);
        if (p.log) console.log(c.dim(p.log));
      }
    },
  }).catch((e) => {
    if (spin) spin.stop(c.red("✗ " + e.message));
    if (e.code === "NO_ENGINE") die(e.message);
    if (e.log) console.log(c.dim(e.log));
    process.exit(1);
  });
  return r;
}



// ------------------------------------------------------------------ cmds -----

// The help screen, grouped the way people look for things. Each row is
// [command, arguments, what it does]; columns are measured, so adding a
// command never breaks the alignment, and a narrow terminal gets the
// description on its own line instead of a wrapped mess.
const HELP_GROUPS = [
  ["get started", [
    ["arcflare", "", "open the menu: harness, model, context"],
    ["arcflare shop", "[search]", "browse the hub: what fits your GPU, what to get"],
    ["arcflare pull", "<repo>[:Q]", "download a GGUF from Hugging Face"],
    ["arcflare ls", "", "list the models on this machine"],
    ["arcflare run", "<model>", "start the server and chat"],
    ["arcflare fit", "[model]", "what fits; --run loads each one and times it"],
  ]],
  ["agent & harnesses", [
    ["arcflare agent", "[model]", "coding agent: tools, MCP, skills"],
    ["arcflare agent", "--resume", "pick up a saved session (--continue: the latest)"],
    ["arcflare use", "<harness> [m]", "configure + launch (--no-launch, --yolo, --ask)"],
    ["arcflare harness update", "[id]", "update Codex, OpenCode, Hermes, Claude Code"],
  ]],
  ["machine server (mcp)", [
    ["arcflare mcp", "[--install]", "run, open, build and test on this computer"],
    ["arcflare mcp", "enable|disable", "install the machine server, or leave it out"],
    ["arcflare mcp trust", "", "allow this folder's .mcp.json to start servers"],
    ["arcflare mcp login", "[server]", "sign in to a hosted MCP server"],
    ["arcflare mcp logout", "<s|--all>", "delete stored sign-in tokens"],
  ]],
  ["generate", [
    ["arcflare gen", "", "the 3D and speech models"],
    ["arcflare gen 3d", "<image>", "image to mesh (.glb); --prompt \"...\" for text"],
    ["arcflare gen tts", "\"text\"", "text to speech (.wav): Qwen3-TTS, Kitten TTS 2, Kokoro, ..."],
    ["arcflare gen voices", "", "saved voices to clone: add <name> <clip> --text \"...\" · rm"],
    ["arcflare gen setup", "[model]", "install a generator (--torch cuda|cpu)"],
  ]],
  ["remote control", [
    ["arcflare rc", "", "QR code, key and relay (/rc inside a session)"],
    ["arcflare rc qr", "", "just the QR code, to scan with your phone"],
    ["arcflare rc relay", "<url>", "the site that relays sessions"],
  ]],
  ["server", [
    ["arcflare serve", "[--port N]", "start the server only"],
    ["arcflare ps", "", "server status and loaded models"],
    ["arcflare stop", "", "stop the server"],
    ["arcflare logs", "[-n N]", "tail the server log"],
    ["arcflare backend", "[kind]", "list or pick a llama.cpp backend"],
    ["arcflare memory", "[profile]", "lean | balanced | max"],
    ["arcflare batch", "[size]", "physical batch (prefill speed vs VRAM)"],
    ["arcflare set-engine", "<path>", "remember where llama-server lives"],
    ["arcflare get-engine", "", "download llama.cpp (llama-server) for this machine"],
  ]],
  ["maintain", [
    ["arcflare doctor", "", "check engine, GPU and harnesses"],
    ["arcflare update", "", "install the latest (--check, --yes, --from, --pack)"],
    ["arcflare report", "", "send a bug, complaint or idea"],
    ["arcflare uninstall", "", "wipe ArcFlare (--dry-run to look, --models too)"],
    ["arcflare path", "", "print the ArcFlare home directory"],
    ["arcflare version", "", ""],
  ]],
];

function helpText() {
  const rows = HELP_GROUPS.flatMap(([, r]) => r);
  const cmdW = Math.max(...rows.map(([cmd, args]) => (cmd + (args ? " " + args : "")).length)) + 2;
  const narrow = ui.cols() - 4 < cmdW + 30;
  const out = [ui.banner()];
  for (const [title, list] of HELP_GROUPS) {
    out.push(ui.section(title));
    for (const [cmd, args, what] of list) {
      const left = `${c.accent(cmd)}${args ? " " + c.grey(args) : ""}`;
      if (narrow) {
        out.push(`  ${left}`);
        if (what) out.push(`      ${c.dim(what)}`);
      } else {
        out.push(`  ${ui.pad(left, cmdW)}${what}`);
      }
    }
    out.push("");
  }
  out.push(`  ${c.dim("Models are found in $ARCFLARE_MODELS, $LLAMA_CACHE, ~/.arcflare/models")}`);
  out.push(`  ${c.dim("and ~/llamacpp/models. The server speaks the OpenAI API on :11434.")}`);
  out.push("");
  return out.join("\n");
}

/**
 * Which model a command line asked for.
 *
 * Two things this has to get right, both of which were once wrong:
 * anything after the prompt flag is prose rather than a model name, and an
 * explicit name matching nothing is a typo — not licence to load whichever
 * model happens to sort first.
 */
function pickModel(all, argv, lastModel, promptFlag = "-p") {
  const i = argv.indexOf(promptFlag);
  const head = i > 0 ? argv.slice(1, i) : argv.slice(1);
  const wanted = head.find((a) => !a.startsWith("-"));
  const picked = wanted ? models.resolve(all, wanted) : null;
  if (wanted && !picked) return { error: `no model matching "${wanted}"` };
  return { model: picked || models.resolve(all, lastModel) || all[0] || null };
}

// ------------------------------------------------------------------- mcp ----

/** How another program should spawn our MCP server. */
function mcpSpawnSpec() {
  // `arcflare` on PATH is the readable form and survives the repo moving, but
  // a clone that was never linked has no such command — fall back to this file.
  const onPath = require("../lib/mcp/apps").onPath("arcflare");
  return onPath
    ? { command: "arcflare", args: ["mcp"] }
    : { command: process.execPath, args: [path.join(__dirname, "arcflare-mcp.js")] };
}

/** Register the machine server so harnesses pick it up without hand-editing JSON. */
async function installMcp(cfg, argv) {
  // Registering it *is* installing it, so this is the other place the question
  // belongs. `--yes` and `--no` answer it without a menu, for a script.
  const assume = argv.includes("--yes") ? true : argv.includes("--no") ? false : undefined;
  if (!(await wantMachine(cfg, { assume }))) {
    console.log(`  ${c.dim("machine server declined — nothing registered")}`);
    console.log(`  ${c.dim("change your mind with:")} arcflare mcp enable`);
    return;
  }

  const spec = mcpSpawnSpec();
  const file = argv.includes("--project")
    ? path.join(process.cwd(), ".arcflare", "mcp.json")
    : path.join(HOME, "mcp.json");

  let json = {};
  let seeded = null;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    // Creating this file makes it the one the agent reads, and the search stops
    // at the first file that has servers — so a new file holding only ourselves
    // would silently hide every server the user already had. Carry them over.
    //
    // Only from another file of your own, though. A config found in the working
    // directory belongs to whatever repo is checked out there, and copying it
    // here would move it from `workspace` origin to `home` origin — past the
    // trust gate, permanently, for every directory you ever run in. It cannot
    // be hidden by this write in any case: the search reaches the working
    // directory first, so a repo's servers still win wherever they apply.
    const existing = require("../lib/agent/run").loadMcpConfig(process.cwd());
    const inherit = existing.origin === "home" && file === path.join(HOME, "mcp.json");
    if (inherit && existing.file !== file && Object.keys(existing.servers).length) {
      json = { mcpServers: { ...existing.servers } };
      seeded = existing.file;
    }
  }
  json.mcpServers = json.mcpServers || {};
  json.mcpServers.arcflare = spec;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");

  console.log(`  ${c.green(ui.sym.ok)} registered in ${c.dim(file)}`);
  if (seeded) {
    console.log(`  ${c.dim(`carried over ${Object.keys(json.mcpServers).length - 1} server(s) from ${seeded}`)}`);
  }
  console.log(`  ${c.dim("command:")} ${spec.command} ${spec.args.join(" ")}`);
  console.log("");
  console.log(`  ${c.dim("for Claude Code:")} claude mcp add arcflare -- ${spec.command} ${spec.args.join(" ")}`);
  console.log(`  ${c.dim("for anything else, in mcp.json:")}`);
  console.log(c.dim(`    { "mcpServers": { "arcflare": ${JSON.stringify(spec)} } }`));
}

/**
 * `arcflare mcp trust | untrust | trusted` — decide whether this directory's
 * MCP config is allowed to start processes.
 *
 * Connecting to a stdio server means spawning it, so a `.mcp.json` in a repo is
 * a list of commands that will run on this machine. It stays inert until this
 * says otherwise, and what gets recorded is the exact content approved — so the
 * question comes back if the repo changes it.
 */
async function mcpTrust(argv) {
  const trust = require("../lib/agent/trust");
  const { loadMcpConfig } = require("../lib/agent/mcp");
  const action = argv[1];

  if (action === "trusted") {
    const rows = trust.list();
    if (!rows.length) return console.log(`  ${c.dim("no directory MCP config has been trusted")}`);
    for (const r of rows) {
      console.log(`  ${c.accent(r.file)}\n    ${c.dim(`${r.servers.join(", ")} · trusted ${r.at.slice(0, 10)}`)}`);
    }
    return;
  }

  const loaded = loadMcpConfig(process.cwd());
  if (!loaded.file) die("no MCP config found here");
  if (loaded.origin !== "workspace") {
    return console.log(`  ${c.dim(`${loaded.file} is your own config — it is not gated, nothing to ${action}`)}`);
  }

  if (action === "untrust") {
    return console.log(trust.revoke(loaded.file)
      ? `  ${c.green(ui.sym.ok)} ${loaded.file} is no longer trusted`
      : `  ${c.dim(`${loaded.file} was not trusted`)}`);
  }

  // Print what is being approved. Approving a file you have not read is the
  // failure this whole mechanism exists to prevent, so the commands go on
  // screen rather than just the file name.
  console.log(`\n  ${c.bold(loaded.file)} would allow:\n`);
  for (const d of trust.describe(loaded.servers)) {
    console.log(`  ${c.accent(d.name)} ${c.dim(`(${d.kind})`)}`);
    // Secrets leaving the machine are the line to notice, so they are not dim.
    for (const l of d.lines) console.log(`    ${/^(sends|hands it)/.test(l) ? c.accent(l) : c.dim(l)}`);
  }
  if (!argv.includes("--yes") && !argv.includes("-y")) {
    if (!process.stdin.isTTY) die("not a terminal — rerun with --yes once you have read the above");
    const a = await ui.ask("Trust this config? [y/N]", "n");
    if (!/^y(es)?$/i.test(a)) return console.log(`  ${c.dim("not trusted — nothing will start")}`);
  }
  const rec = trust.trust(loaded.file, loaded.servers);
  console.log(`\n  ${c.green(ui.sym.ok)} trusted ${c.dim(rec.fingerprint)}`);
  console.log(`  ${c.dim("if the file changes, it will need trusting again")}`);
}

/**
 * `arcflare mcp login [server]` — sign in to a hosted MCP server.
 *
 * Everything up to the consent screen is automatic: discovery, dynamic client
 * registration, PKCE. The consent itself is a person clicking approve, which is
 * the whole point of it, so the browser opens and this waits.
 */
async function mcpAuth(argv) {
  const oauth = require("../lib/agent/oauth");
  const { loadMcpConfig, McpServer } = require("../lib/agent/mcp");
  const { servers, file } = loadMcpConfig(process.cwd());
  const hosted = Object.entries(servers).filter(([, s]) => s && s.url);

  let name = argv[2];
  // Logging out never needs the server to still be configured: a token for a
  // server you removed is exactly the one you want gone.
  if (argv[1] === "logout" && (name === "--all" || (name && !servers[name]))) {
    if (name === "--all") {
      const gone = oauth.forgetAll();
      return console.log(gone.length
        ? `  ${c.green(ui.sym.ok)} forgot ${gone.length} sign-in(s): ${gone.join(", ")}`
        : `  ${c.dim("no stored sign-ins")}`);
    }
    return console.log(oauth.forget(name)
      ? `  ${c.green(ui.sym.ok)} forgot the credentials for ${c.accent(name)}`
      : `  ${c.dim(`nothing stored for ${name}`)}`);
  }
  if (!name) {
    if (!hosted.length) die("no hosted MCP servers in your config (they need a url)");
    if (hosted.length === 1) name = hosted[0][0];
    else {
      const pick = await ui.select("Which server?", hosted.map(([n, s]) => ({
        label: n, note: s.url, value: n,
      })));
      if (!pick) return;
      name = pick;
    }
  }
  const cfg = servers[name];
  if (!cfg || !cfg.url) die(`"${name}" is not a hosted server in ${file || "your config"}`);

  if (argv[1] === "logout") {
    console.log(oauth.forget(name)
      ? `  ${c.green(ui.sym.ok)} forgot the credentials for ${c.accent(name)}`
      : `  ${c.dim(`nothing stored for ${name}`)}`);
    return;
  }

  console.log(`\n  ${c.bold("Signing in to")} ${c.accent(name)} ${c.dim(cfg.url)}`);
  const rec = await oauth.login({
    name,
    url: cfg.url,
    onUrl: async (url) => {
      console.log(`  ${c.dim("opening your browser — approve there, then come back")}\n`);
      console.log(`  ${c.dim(url)}\n`);
      try { require("../lib/mcp/apps").openWith(url); }
      catch { console.log(`  ${c.dim("(could not open a browser; paste the link above)")}`); }
      process.stdout.write(`  ${c.dim("waiting…")}\n`);
    },
  }).catch((e) => die(e.message));

  console.log(`  ${c.green(ui.sym.ok)} signed in ${c.dim(`scope: ${rec.scope}`)}` +
    (rec.refreshToken ? c.dim("  (refresh token stored)") : ""));

  // A token that cannot list tools is not a working connection, so prove it.
  const probe = new McpServer(name, cfg);
  try {
    await probe.start(30000);
    console.log(`  ${c.green(ui.sym.ok)} ${probe.tools.length} tools from ` +
      `${c.accent((probe.serverInfo && probe.serverInfo.name) || name)}`);
    console.log(`  ${c.dim(probe.tools.slice(0, 8).map((t) => t.name).join(", "))}`);
  } catch (e) {
    die(`signed in, but the server still refused us: ${e.message}`);
  } finally {
    probe.stop();
  }
}

// --------------------------------------------------------------- generate ----

/**
 * Download llama.cpp, remember it as the engine and return the llama-server
 * path. Exits with a readable message when that isn't possible.
 */
async function getEngine(cfg) {
  const getllama = require("../lib/getllama");
  let r;
  try {
    r = await getllama.install({
      log: (line) => console.log(`  ${c.dim(line)}`),
      // Whole percentages on their own lines: the desktop app reads them as progress.
      onProgress: (pct) => { if (pct % 10 === 0) console.log(`  ${c.dim(`${pct}%`)}`); },
    });
  } catch (e) {
    die(`couldn't get llama.cpp: ${e.message}`);
  }
  saveConfig({ ...loadConfig(), llamaServer: r.server });
  console.log(`  ${c.green(ui.sym.ok)} engine ${c.accent("llama.cpp " + r.tag)} ${c.dim(r.server)}`);
  return r.server;
}

/** `--name value` from argv, or undefined. */
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const GEN_FLAGS_WITH_VALUES = ["--model", "-m", "--out", "-o", "--steps", "--seed", "--octree",
  "--faces", "--prompt", "-p", "--torch", "--torch-from", "--device",
  "--voice", "--ref", "--ref-text", "--lang", "--speed", "--instruct", "--file", "--clone", "--text"];

/** Positional arguments, skipping every flag and the value it takes. */
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (GEN_FLAGS_WITH_VALUES.includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith("-")) continue;
    out.push(argv[i]);
  }
  return out;
}

async function genCommand(cfg, argv) {
  const gen = require("../lib/gen");
  const sub = argv[1];

  // `arcflare gen python <path>` — use an environment that already works.
  if (sub === "python") {
    const p = argv[2];
    if (!p) {
      const py = gen.findPython(cfg);
      console.log(py ? `  ${py.path} ${c.dim("(" + py.source + ")")}` : `  ${c.dim("none — arcflare gen setup creates one")}`);
      return;
    }
    if (!fs.existsSync(p)) die(`no such file: ${p}`);
    saveConfig({ ...cfg, genPython: path.resolve(p) });
    console.log(`  ${c.green(ui.sym.ok)} generators will run with ${c.dim(path.resolve(p))}`);
    return;
  }

  if (sub === "setup" || sub === "install") {
    const m = gen.byId(positionals(argv.slice(2))[0]);
    if (!m) die(`unknown model. Known: ${gen.MODELS.map((x) => x.id).join(", ")}`);
    console.log(`\n  ${c.bold("Setting up")} ${c.accent(m.label)}\n`);
    let r;
    try {
      r = await gen.setup(cfg, m, {
        torch: flag(argv, "--torch"),
        torchFrom: flag(argv, "--torch-from"),
        texture: argv.includes("--texture"),
      });
    } catch (e) {
      die(e.message);
    }
    const ch = r.check;
    console.log("");
    console.log(`  ${c.green(ui.sym.ok)} python  ${c.dim(r.python.path)}`);
    if (ch.torch) {
      console.log(`  ${ch.device === "cpu" ? c.dim(ui.sym.dot) : c.green(ui.sym.ok)} torch   ${c.dim(`${ch.torch} · ${ch.device}` +
        (ch.device_name ? ` · ${ch.device_name}` : "") + (ch.vram_free_gb ? ` · ${ch.vram_free_gb} GB free` : ""))}`);
    }
    for (const p of ch.problems || []) console.log(`  ${c.red("!")} ${p}`);
    if (!ch.torch) {
      console.log(`\n  ${c.dim("torch is not installed. Pick the build for your GPU:")}`);
      console.log(`    arcflare gen setup ${m.id} --torch cuda   ${c.dim("NVIDIA")}`);
      console.log(`    arcflare gen setup ${m.id} --torch cpu    ${c.dim("no GPU (slow)")}`);
      console.log(`    arcflare gen setup ${m.id} --torch-from <python>  ${c.dim("borrow GPU torch from another env (AMD on Windows)")}`);
    }
    if (ch.ok) {
      const example = gen.kindOf(m) === "tts" ? `arcflare gen tts "hello there" -m ${m.id}` : `arcflare gen 3d photo.png -m ${m.id}`;
      console.log(`\n  ${c.green(ui.sym.ok)} ready — ${c.accent(example)}`);
    }
    return;
  }

  if (sub === "check" || sub === "doctor") {
    const m = gen.byId(positionals(argv.slice(2))[0]);
    if (!m) die("unknown model");
    const ch = await gen.check(cfg, m);
    console.log(JSON.stringify(ch, null, 2));
    return;
  }

  if (sub === "3d" || sub === "mesh") {
    const rest = argv.slice(2);
    const image = positionals(rest)[0];
    const prompt = flag(rest, "--prompt") || flag(rest, "-p");
    const model = flag(rest, "--model") || flag(rest, "-m") || cfg.genModel || gen.DEFAULT_MODEL;
    const m = gen.byId(model);
    if (!m) die(`unknown model "${model}". Known: ${gen.MODELS.map((x) => x.id).join(", ")}`);
    if (!gen.weightsPresent(m)) {
      console.log(`  ${c.dim(`${m.label} weights are not downloaded yet — the first run fetches them from ${m.hf}`)}`);
    }
    const spin = ui.spinner(`${m.label} · starting`);
    const t0 = Date.now();
    let r;
    try {
      r = await gen.generate(cfg, {
        model: m.id, image, prompt,
        out: flag(rest, "--out") || flag(rest, "-o"),
        steps: flag(rest, "--steps"), seed: flag(rest, "--seed"),
        octree: flag(rest, "--octree"), faces: flag(rest, "--faces"),
        device: flag(rest, "--device"),
        texture: rest.includes("--texture"),
        removeBackground: !rest.includes("--keep-background"),
        onEvent: (ev) => {
          if (ev.event === "stage") spin.update(`${m.label} · ${ev.stage} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
          if (ev.event === "info" && ev.device === "cpu") spin.update(`${m.label} · on the CPU — this will be slow`);
        },
      });
    } catch (e) {
      spin.stop(`${c.red(ui.sym.fail)} ${e.message}`);
      if (e.stderr) console.log(c.dim(e.stderr.split("\n").slice(-12).map((l) => "    " + l).join("\n")));
      process.exitCode = 1;
      return;
    }
    spin.stop(`${c.green(ui.sym.ok)} ${r.file}`);
    console.log(`  ${c.dim(`${r.faces != null ? r.faces.toLocaleString() + " faces · " : ""}` +
      `${ui.fmtBytes(r.bytes)} · ${(r.ms / 1000).toFixed(1)}s total` +
      (r.shape_seconds ? ` · ${r.shape_seconds}s shape` : "") + ` · ${r.device || ""}`)}`);
    return;
  }

  if (sub === "tts" || sub === "say" || sub === "speak") {
    const rest = argv.slice(2);
    const file = flag(rest, "--file");
    let text = positionals(rest).join(" ");
    if (file) {
      if (!fs.existsSync(file)) die(`no such file: ${file}`);
      text = fs.readFileSync(file, "utf8");
    }
    const model = flag(rest, "--model") || flag(rest, "-m") || cfg.ttsModel || gen.DEFAULT_TTS;
    const m = gen.byId(model, "tts");
    if (!m || gen.kindOf(m) !== "tts") {
      die(`unknown speech model "${model}". Known: ${gen.MODELS.filter((x) => gen.kindOf(x) === "tts").map((x) => x.id).join(", ")}`);
    }
    if (!gen.weightsPresent(m)) {
      console.log(`  ${c.dim(`${m.label} weights are not downloaded yet — the first run fetches them from ${m.hf}`)}`);
    }
    const spin = ui.spinner(`${m.label} · starting`);
    const t0 = Date.now();
    let r;
    try {
      r = await gen.speak(cfg, {
        model: m.id, text,
        out: flag(rest, "--out") || flag(rest, "-o"),
        voice: flag(rest, "--voice"),
        ref: flag(rest, "--ref"),
        refText: flag(rest, "--ref-text"),
        clone: flag(rest, "--clone"),
        lang: flag(rest, "--lang"),
        speed: flag(rest, "--speed"),
        instruct: flag(rest, "--instruct"),
        seed: flag(rest, "--seed"),
        device: flag(rest, "--device"),
        onEvent: (ev) => {
          if (ev.event === "stage") spin.update(`${m.label} · ${ev.stage} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
          if (ev.event === "info" && ev.device === "cpu") spin.update(`${m.label} · on the CPU`);
        },
      });
    } catch (e) {
      spin.stop(`${c.red(ui.sym.fail)} ${e.message}`);
      if (e.stderr) console.log(c.dim(e.stderr.split("\n").slice(-12).map((l) => "    " + l).join("\n")));
      process.exitCode = 1;
      return;
    }
    spin.stop(`${c.green(ui.sym.ok)} ${r.file}`);
    console.log(`  ${c.dim(`${r.seconds}s of audio · ${(r.sample_rate / 1000).toFixed(1)} kHz · ` +
      `${ui.fmtBytes(r.bytes)} · made in ${(r.ms / 1000).toFixed(1)}s · ${r.device || ""}`)}`);
    return;
  }

  // `arcflare gen voices [add <name> <clip> --text "…" | rm <name>]`
  if (sub === "voices" || sub === "voice") {
    const rest = argv.slice(2);
    const [action, name, clip] = positionals(rest);
    if (action === "add" || action === "save") {
      if (!name || !clip) die('usage: arcflare gen voices add <name> <clip.wav> --text "what the clip says" [--lang en]');
      let v;
      try {
        v = gen.voices.save({ name, clip, text: flag(rest, "--text") || "", lang: flag(rest, "--lang"), replace: rest.includes("--replace") });
      } catch (e) { die(e.message); }
      console.log(`  ${c.green(ui.sym.ok)} saved ${c.accent(v.id)}${v.seconds != null ? c.dim(` · ${v.seconds}s`) : ""}`);
      const tip = gen.voices.advice(v.seconds);
      if (tip) console.log(`  ${c.dim("note: " + tip)}`);
      if (!v.text) console.log(`  ${c.dim('no transcript: qwen3-tts-clone needs one (arcflare gen voices add ... --replace --text "...")')}`);
      console.log(`  ${c.dim("use it:")} arcflare gen tts "hello" -m kitten-tts-2 --clone ${v.id}`);
      return;
    }
    if (action === "rm" || action === "remove" || action === "delete") {
      if (!name) die("usage: arcflare gen voices rm <name>");
      if (!gen.voices.remove(name)) die(`no saved voice "${name}"`);
      console.log(`  ${c.green(ui.sym.ok)} removed ${name}`);
      return;
    }
    if (action) die(`unknown: arcflare gen voices ${action} (add, rm)`);
    const all = gen.voices.list();
    console.log(ui.section("voices", `${all.length} saved`));
    if (!all.length) console.log(`  ${c.dim('none yet: arcflare gen voices add me clip.wav --text "what it says"')}`);
    for (const v of all) {
      const meta = [v.seconds != null ? `${v.seconds}s` : null, v.lang, v.text ? `"${v.text.slice(0, 50)}${v.text.length > 50 ? "…" : ""}"` : "no transcript"].filter(Boolean);
      console.log(`  ${c.accent(v.id.padEnd(16))} ${c.dim(meta.join(" · "))}`);
    }
    console.log(`\n  ${c.dim("only clone voices you have permission to use · clips stay in")} ${c.dim(gen.voices.root())}\n`);
    return;
  }

  if (sub === "default") {
    const m = gen.byId(argv[2]);
    if (!m) die("unknown model");
    const tts = gen.kindOf(m) === "tts";
    saveConfig({ ...cfg, [tts ? "ttsModel" : "genModel"]: m.id });
    console.log(`  ${c.green(ui.sym.ok)} default ${tts ? "speech model" : "generator"} ${c.accent(m.id)}`);
    return;
  }

  // `arcflare gen` — the table, one section per kind.
  const rows = gen.status(cfg);
  const py = gen.findPython(cfg);
  const defs = { "3d": cfg.genModel || gen.DEFAULT_MODEL, tts: cfg.ttsModel || gen.DEFAULT_TTS };
  const w = Math.max(...rows.map((r) => r.id.length));
  const sections = [
    ["3d", "3D generation", "image → mesh", "arcflare gen 3d photo.png"],
    ["tts", "Speech", "text → .wav", 'arcflare gen tts "hello there"'],
  ];
  for (const [kind, title, what, example] of sections) {
    console.log(`\n  ${c.bold(title)} ${c.dim(what + ", on this machine")}\n`);
    for (const r of rows.filter((x) => x.kind === kind)) {
      const ready = r.repoPresent && r.python;
      const mark = ready ? (r.weights ? c.green(ui.sym.ok) : c.accent("·")) : c.dim(ui.sym.dot);
      const state = !ready ? "not installed" : r.weights ? "ready" : "installed · weights download on first run";
      const id = r.id.padEnd(w);
      const vram = `~${r.vram} GB` + (r.texture ? ` (${r.textureVram} textured)` : "") + (r.cloning ? " · clones" : "");
      console.log(`  ${mark} ${r.id === defs[kind] ? c.accent(id) : id}  ` +
        c.dim(`${r.params.padEnd(5)} ${vram.padEnd(20)} ${state}`));
      console.log(`    ${c.dim(r.note)}`);
    }
    console.log(`\n  ${c.dim("setup:")} arcflare gen setup ${defs[kind]}   ${c.dim("· run:")} ${example}`);
  }
  console.log(`\n  ${c.dim("python")} ${py ? c.dim(py.path) : c.dim("none yet")} ${c.dim("· speech models keep their own envs in ~/.arcflare/gen/envs")}\n`);
}

// ----------------------------------------------------------------- update ----

/** One line under a banner when there is something newer, like Claude Code does. */
function updateBanner(cfg) {
  const n = require("../lib/update").notice(cfg);
  if (n) console.log(`  ${c.accent("↑")} ${n.text} ${c.dim("· /update or arcflare update")}\n`);
}

/** `/update` inside a session: shows what is new; `/update --yes` installs it. */
async function slashUpdate(line) {
  await require("../lib/update").slash(line, c);
}

async function updateCommand(cfg, argv) {
  const upd = require("../lib/update");

  // The detached background check: no output, ever — nobody is reading it.
  if (argv.includes("--check-quiet")) {
    const rec = await upd.check();
    upd.writeCache(rec);
    return;
  }
  if (argv.includes("--off") || argv.includes("--on")) {
    const on = argv.includes("--on");
    saveConfig({ ...cfg, updateCheck: on });
    console.log(`  ${c.green(ui.sym.ok)} update checks ${on ? "on" : "off"}`);
    return;
  }
  if (argv.includes("--pack")) {
    const dir = flag(argv, "--pack") && !flag(argv, "--pack").startsWith("-") ? flag(argv, "--pack") : process.cwd();
    try {
      const file = await upd.pack(dir);
      console.log(`  ${c.green(ui.sym.ok)} ${file}`);
      console.log(`  ${c.dim("carry it to the offline machine and run:")} arcflare update --from "${path.basename(file)}"`);
    } catch (e) { die(e.message); }
    return;
  }
  if (argv.includes("--check")) {
    const spin = ui.spinner("checking for updates");
    const rec = await upd.check();
    upd.writeCache(rec);
    if (rec.offline) return spin.stop(`${c.dim(ui.sym.dot)} offline (${rec.error}) — you have ${VERSION}`);
    spin.stop(rec.available
      ? `${c.accent("↑")} update available: ${upd.compareVersions(rec.latest, VERSION) > 0 ? `${VERSION} → ${rec.latest}` : "new commits on main"} · arcflare update`
      : `${c.green(ui.sym.ok)} up to date (${VERSION})`);
    return;
  }

  const from = flag(argv, "--from");
  const source = flag(argv, "--source");
  const yes = argv.includes("--yes") || argv.includes("-y");
  console.log(`\n  ${c.bold("Updating ArcFlare")} ${c.dim(`${VERSION} · ${upd.installKind()} install`)}`);
  const r = await upd.apply({
    from, source, yes,
    // Show exactly what is about to run with your privileges, then ask.
    confirm: async (preview) => {
      for (const l of upd.describePreview(preview)) console.log(l);
      if (!process.stdin.isTTY) {
        console.log(`  ${c.dim("not a terminal — rerun with --yes to install")}`);
        return false;
      }
      return /^y(es)?$/i.test(await ui.ask("Install this update? [y/N]", "n"));
    },
  });
  if (r.cancelled) return console.log(`  ${c.dim(r.message)}`);
  if (!r.ok) {
    console.log(`  ${c.red(ui.sym.fail)} ${r.message}`);
    if (r.offlineHint) {
      console.log(`\n  ${c.dim("No network? Update from a copy instead:")}`);
      console.log(`    ${c.dim("on a connected machine:")}  arcflare update --pack`);
      console.log(`    ${c.dim("here:")}                    arcflare update --from <file.tgz | folder>`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`  ${c.green(ui.sym.ok)} ${r.message}\n`);
}

// ----------------------------------------------------------------- report ----

/**
 * `arcflare report` — send a bug, complaint or idea to arcflare.net/report.
 * Flags for scripts, prompts for people. Version and OS are filled in.
 */
async function reportCommand(argv) {
  const rep = require("../lib/report");
  const interactive = process.stdin.isTTY && !flag(argv, "--title");
  let kind = flag(argv, "--kind");
  let where = flag(argv, "--where");
  let title = flag(argv, "--title");
  let body = flag(argv, "--body");
  const contact = flag(argv, "--contact");
  if (interactive) {
    console.log(`\n  ${c.bold("Report a problem")} ${c.dim("· goes to the public list at arcflare.net — no keys or personal details")}\n`);
    kind = kind || await ui.select("What is it?", rep.KINDS.map((k) => ({ label: k, value: k })));
    if (!kind) return;
    where = where || await ui.select("Where?", rep.WHERES.map((w) => ({ label: w, value: w })));
    if (!where) return;
    title = title || await ui.ask("Title (one line)");
    body = body || await ui.ask("What happened? (expected vs. actual, error text)");
  }
  const v = rep.validate({ kind, where, title, body, contact, version: VERSION });
  if (v.error) die(`${v.error}${interactive ? "" : " — usage: arcflare report --title \"…\" --body \"…\" [--kind bug] [--where cli]"}`);
  const spin = ui.spinner("sending");
  const r = await rep.send(v.payload);
  spin.stop(rep.outcome(r, c));
  if (!r.ok && !r.issue) process.exitCode = 1;
}

/** `/report <what happened>` in a session: one line, sent as a CLI bug. */
async function slashReport(line) {
  const rep = require("../lib/report");
  const text = line.replace(/^\/report\s*/, "").trim();
  if (!text) return console.log(`  ${c.dim("usage: /report <what went wrong>  · or run")} arcflare report ${c.dim("for the full form")}`);
  const title = (text.split(/(?<=[.!?])\s/)[0] || text).slice(0, 120);
  const v = rep.validate({ kind: "bug", where: "cli", title, body: text, version: VERSION });
  if (v.error) return console.log(`  ${c.red(ui.sym.fail)} ${v.error}`);
  const r = await rep.send(v.payload);
  console.log(`  ${rep.outcome(r, c)}`);
}

// ---------------------------------------------------------------- harness ----

/** `arcflare harness update <id|all>` — update the coding agents themselves. */
async function harnessCommand(argv) {
  const hu = require("../lib/harness-update");
  if (argv[1] !== "update") {
    console.log(`  ${c.dim("usage:")} arcflare harness update <${hu.targets().map((t) => t.id).join("|")}|all> [--dry-run]`);
    return;
  }
  const dry = argv.includes("--dry-run") || argv.includes("-n");
  const want = argv.slice(2).find((a) => !a.startsWith("-")) || "all";
  const rows = hu.targets().filter((t) => want === "all" || t.id === want);
  if (!rows.length) die(`unknown harness "${want}"`);
  let failed = 0;
  for (const t of rows) {
    const p = hu.plan(t.id, t.bin);
    if (p.skip) {
      if (want !== "all" || p.skip !== "not installed") console.log(`  ${c.dim(ui.sym.dot)} ${t.label} ${c.dim(`— ${p.skip}`)}`);
      continue;
    }
    console.log(`\n  ${c.bold(t.label)} ${c.dim("→")} ${c.accent(p.show)}`);
    if (dry) continue;
    const r = await hu.runPlan(p);
    if (r.code === 0) console.log(`  ${c.green(ui.sym.ok)} ${t.label} updated`);
    else { failed++; console.log(`  ${c.red(ui.sym.fail)} ${t.label} ${c.dim(r.error || `exit ${r.code}`)}`); }
  }
  if (failed) process.exitCode = 1;
}

// -------------------------------------------------------------- uninstall ----

/**
 * `arcflare uninstall` (or `delete`): wipe ArcFlare off this machine.
 * Shows everything first; asks for the word "delete"; `--dry-run` only shows.
 */
async function uninstallCommand(cfg, argv) {
  const un = require("../lib/uninstall");
  const upd = require("../lib/update");
  const dry = argv.includes("--dry-run") || argv.includes("-n");
  const kind = upd.installKind();
  const plan = un.survey({
    withModels: argv.includes("--models"),
    modelRoots: models.roots(),
    harnesses: harness.list().map((h) => harness.byId(h.id)).filter(Boolean),
    install: { kind, root: upd.ROOT },
  });
  const keepCli = argv.includes("--keep-cli");

  console.log(`\n  ${c.bold(dry ? "Uninstall ArcFlare — dry run, nothing will change" : "Uninstall ArcFlare")}\n`);
  if (!plan.homeOk && plan.remove.length) {
    die(`${plan.home} does not look like an ArcFlare folder (ARCFLARE_HOME?) — refusing to touch it`);
  }

  const st = await engine.status(cfg.port || DEFAULT_PORT).catch(() => ({ running: false }));
  console.log(`  ${c.red("delete")}`);
  if (st.running) console.log(`    ${c.dim("stop")}  the running llama-server`);
  for (const i of plan.remove) {
    console.log(`    ${ui.fmtBytes(i.bytes).padStart(9)}  ${i.path} ${c.dim("· " + i.what)}`);
  }
  if (!keepCli) {
    console.log(`    ${"".padStart(9)}  the arcflare command ${c.dim(kind === "git"
      ? `(npm unlink; your clone at ${upd.ROOT} is left for you to delete)`
      : "(npm rm -g arcflare)")}`);
  }
  console.log(`    ${c.bold(ui.fmtBytes(plan.totalBytes).padStart(9))}  total`);

  if (plan.keep.length) {
    console.log(`\n  ${c.green("keep")}`);
    for (const k of plan.keep) console.log(`    ${ui.fmtBytes(k.bytes).padStart(9)}  ${k.path}\n               ${c.dim(k.why)}`);
  }
  if (plan.configs.length) {
    console.log(`\n  ${c.accent("left as they are")} ${c.dim("— other programs' settings that mention ArcFlare")}`);
    for (const h of plan.configs) {
      console.log(`    ${h.label.padEnd(10)} ${h.file}` + (h.backup ? `\n               ${c.dim(`backup from before ArcFlare: ${h.backup}`)}` : ""));
    }
    console.log(`    ${c.dim("Hermes keeps its own settings: `hermes config` to change its model provider")}`);
  }
  console.log(`    ${c.dim("Claude Code: if you added the machine server, `claude mcp remove arcflare`")}`);

  if (dry) { console.log(`\n  ${c.dim("dry run — run without --dry-run to delete")}\n`); return; }

  if (!argv.includes("--yes")) {
    if (!process.stdin.isTTY) die("not a terminal — pass --yes to confirm, or --dry-run to look");
    console.log("");
    const typed = await ui.ask(`Type ${c.red("delete")} to remove all of the above`);
    if (typed !== "delete") { console.log(`  ${c.dim("nothing changed")}\n`); return; }
  }

  if (st.running) engine.stop();
  const failed = un.execute(plan, {
    removeCli: !keepCli,
    npm: upd.npmCommand,
    log: (p) => process.stdout.write(`  ${c.dim("removing")} ${p}\n`),
  });
  if (failed.length) {
    console.log(`\n  ${c.red(ui.sym.fail)} ${failed.length} item(s) could not be removed:`);
    for (const f of failed) console.log(`    ${f.path} ${c.dim(f.error)}`);
    process.exitCode = 1;
  }
  console.log(`\n  ${c.green(ui.sym.ok)} ArcFlare is uninstalled` +
    (plan.keep.length ? c.dim(" · your models were kept") : "") +
    (!keepCli && process.platform === "win32" ? c.dim(" · the command disappears in a few seconds") : ""));
  if (kind === "git" && !keepCli) console.log(`  ${c.dim(`delete the source folder too if you like: ${upd.ROOT}`)}`);
  console.log("");
}

// ------------------------------------------------------------------- shop ----

const FIT_MARK = {
  fits: () => c.green("✓ fits"),
  tight: () => c.accent("~ tight"),
  no: () => c.dim("✗ too big"),
  unknown: () => c.dim(ui.sym.dot),
};

/** Run another arcflare command in the foreground, as if typed. */
function runSelf(args) {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [__filename, ...args], { stdio: "inherit" });
  return r.status === 0;
}

function shopLine(m, freeGb) {
  const f = require("../lib/hub").fit(m, freeGb);
  const nc = m.commercial === false ? c.red(" non-commercial") : "";
  return `${c.accent(m.name.padEnd(24))} ${c.dim(m.category.padEnd(10))} ${c.dim(m.defaultSize.padEnd(10))} ` +
    `${c.dim(m.vram.padEnd(9))} ${FIT_MARK[f]()}${nc}`;
}

function shopDetail(m, freeGb, url) {
  const hub = require("../lib/hub");
  const plan = hub.installPlan(m);
  const f = hub.fit(m, freeGb);
  console.log("");
  console.log(`  ${c.bold(m.name)} ${c.dim(`· ${m.author} · ${m.category}`)}`);
  console.log(`  ${m.description}`);
  console.log("");
  console.log(`  ${c.dim("size     ")} ${m.defaultSize}`);
  console.log(`  ${c.dim("vram     ")} ${m.vram}  ${FIT_MARK[f]()}${freeGb ? c.dim(` (${freeGb.toFixed(1)} GB free here)`) : ""}`);
  console.log(`  ${c.dim("licence  ")} ${m.license}${m.commercial === false ? c.red("  non-commercial") : m.commercial ? c.dim("  commercial use ok") : ""}`);
  if (m.versions && m.versions.length > 1) {
    console.log(`  ${c.dim("sizes    ")} ${m.versions.filter((v) => v.tag !== "latest").map((v) => `${v.tag} ${c.dim(v.size)}`).join(c.dim(" · "))}`);
  }
  console.log(`  ${c.dim("page     ")} ${m.url || `${url}/models/${m.slug}`}`);
  console.log("");
  if (plan.kind === "pull") console.log(`  ${c.dim("get it   ")} arcflare pull ${plan.ref}`);
  else if (plan.kind === "gen") console.log(`  ${c.dim("get it   ")} arcflare gen setup ${plan.id}   ${c.dim("then")} ${plan.use}`);
  else console.log(`  ${c.dim("get it   ")} ${c.dim("no install command in the hub yet — see the model page")}`);
  console.log("");
}

/**
 * `arcflare shop` — browse the model hub from the terminal.
 *
 *   arcflare shop                 the menu: category → model → install
 *   arcflare shop <words>         search, printed as a list
 *   arcflare shop show <model>    one model in full
 *   --cat <category> --fits --json --refresh · arcflare shop hub <url>
 */
async function shopCommand(cfg, argv) {
  const hub = require("../lib/hub");
  const rest = argv.slice(1);

  if (rest[0] === "hub") {
    if (!rest[1]) { console.log(`  ${hub.hubUrl(cfg)}`); return; }
    let u;
    try { u = new URL(rest[1]); } catch { die(`not a URL: ${rest[1]}`); }
    saveConfig({ ...cfg, hub: u.toString().replace(/\/+$/, "") });
    console.log(`  ${c.green(ui.sym.ok)} hub ${c.accent(u.toString().replace(/\/+$/, ""))}`);
    return;
  }

  const spin = process.stdout.isTTY && !rest.includes("--json") ? ui.spinner("loading the hub") : null;
  let loaded;
  try {
    loaded = await hub.load({ cfg, refresh: rest.includes("--refresh") });
  } catch (e) {
    if (spin) spin.stop();
    die(e.message);
  }
  if (spin) spin.stop();
  const { data, source, url, age } = loaded;
  const freeGb = (() => { try { return freeDeviceBytes(cfg) / 1e9; } catch { return 0; } })();

  let list = data.models;
  const cat = flag(rest, "--cat");
  if (cat) list = list.filter((m) => m.category.toLowerCase() === cat.toLowerCase());
  if (rest.includes("--fits")) list = list.filter((m) => hub.fit(m, freeGb) === "fits");
  const words = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "--cat" && a !== "show");

  if (rest.includes("--json")) {
    process.stdout.write(JSON.stringify(words.length ? hub.search(list, words.join(" ")) : list, null, 2) + "\n");
    return;
  }

  const from = source === "live" ? c.dim(`live from ${url.replace(/^https?:\/\//, "")}`)
    : source === "cache" ? c.accent(`offline · saved copy from ${hub.ageText(age)}`)
      : c.accent("offline · the copy that shipped with this version");

  if (rest[0] === "show") {
    const m = hub.bySlug(data.models, rest[1]);
    if (!m) die(`no model "${rest[1] || ""}" in the hub — try: arcflare shop ${rest[1] || ""}`);
    shopDetail(m, freeGb, url);
    return;
  }

  // Search, or a terminal that cannot show a menu: print the list.
  if (words.length || !process.stdin.isTTY || !process.stdout.isTTY) {
    const found = words.length ? hub.search(list, words.join(" ")) : list;
    console.log("");
    console.log(ui.section("hub", `${found.length} of ${data.models.length}`));
    console.log(`  ${c.dim(from)}\n`);
    if (found.length) {
      console.log(`  ${c.dim(`${"model".padEnd(24)} ${"category".padEnd(10)} ${"size".padEnd(10)} ${"vram".padEnd(9)} here`)}`);
    }
    for (const m of found) console.log(`  ${shopLine(m, freeGb)}`);
    if (!found.length) console.log(`  ${c.dim("nothing matched — try fewer words, or arcflare shop with no arguments")}`);
    console.log(`\n  ${c.dim("arcflare shop show <model> · --fits · --cat code · --refresh")}\n`);
    return;
  }

  // The menu.
  console.log(ui.banner());
  console.log(`  ${c.bold("Model hub")} ${c.dim(`· ${data.models.length} models ·`)} ${from}` +
    (freeGb ? c.dim(` · ${freeGb.toFixed(1)} GB free on this GPU`) : "") + "\n");
  for (;;) {
    const cats = [...new Set(list.map((m) => m.category))];
    const fitting = list.filter((m) => hub.fit(m, freeGb) === "fits");
    const view = await ui.select("Browse", [
      { label: "Featured", hint: `${list.filter((m) => m.featured).length}`, value: "featured" },
      ...(freeGb ? [{ label: "Fits my GPU", hint: `${fitting.length}`, value: "fits", note: `${freeGb.toFixed(0)} GB free` }] : []),
      { label: "Everything", hint: `${list.length}`, value: "all" },
      ...cats.map((cname) => ({ label: cname, hint: `${list.filter((m) => m.category === cname).length}`, value: `cat:${cname}` })),
      { label: "Search…", value: "search" },
    ], { subtitle: "pick a shelf" });
    if (!view) return;

    let shelf;
    if (view === "search") {
      const q = await ui.ask("search");
      if (!q) continue;
      shelf = hub.search(list, q);
    } else if (view === "featured") shelf = list.filter((m) => m.featured);
    else if (view === "fits") shelf = fitting;
    else if (view === "all") shelf = list;
    else shelf = list.filter((m) => m.category === view.slice(4));
    if (!shelf.length) { console.log(`  ${c.dim("nothing here")}\n`); continue; }

    // Smallest first: the shop's real question is "what can I run".
    shelf = [...shelf].sort((a, b) => (hub.vramGb(a.vram) ?? 1e9) - (hub.vramGb(b.vram) ?? 1e9));
    for (;;) {
      const slug = await ui.select("Models", shelf.map((m) => {
        const f = hub.fit(m, freeGb);
        return {
          label: m.name,
          hint: `${m.defaultSize} · ${m.vram}`,
          note: (f === "fits" ? "✓ fits" : f === "tight" ? "~ tight" : f === "no" ? "✗ too big" : "") +
            (m.commercial === false ? " · non-commercial" : ""),
          value: m.slug,
        };
      }), { subtitle: `${shelf.length} · smallest first · esc to go back` });
      if (!slug) break;
      const m = shelf.find((x) => x.slug === slug);
      shopDetail(m, freeGb, url);
      const plan = hub.installPlan(m);
      const action = await ui.select(m.name, [
        ...(plan.kind === "pull" ? [{ label: "Download it", hint: `arcflare pull ${plan.ref}`, value: "install" }] : []),
        ...(plan.kind === "gen" ? [{ label: "Set it up", hint: `arcflare gen setup ${plan.id}`, value: "install" }] : []),
        { label: "Open its page", hint: "in the browser", value: "open" },
        { label: "Back", value: "back" },
      ]);
      if (action === "install") {
        if (hub.fit(m, freeGb) === "no") {
          console.log(`  ${c.accent("!")} ${m.vram} is more than the ${freeGb.toFixed(1)} GB free here — it may not load on this GPU`);
        }
        runSelf(plan.argv);
        console.log("");
      } else if (action === "open") {
        const page = m.url || `${url}/models/${m.slug}`;
        try { require("../lib/mcp/apps").openWith(page); console.log(`  ${c.dim("opened")} ${page}\n`); }
        catch { console.log(`  ${page}\n`); }
      }
    }
  }
}

// ----------------------------------------------------------------- remote ----

function rcCommand(cfg, argv) {
  const rc = require("../lib/rc");
  const sub = argv[1];
  if (sub === "relay") {
    if (!argv[2]) { console.log(`  ${rc.relayUrl(cfg)}`); return; }
    try {
      console.log(`  ${c.green(ui.sym.ok)} relay ${c.accent(rc.setRelay(argv[2]))}`);
    } catch (e) { die(e.message); }
    return;
  }
  if (sub === "rotate" || sub === "new") {
    const key = rc.getKey({ rotate: true });
    console.log(`  ${c.green(ui.sym.ok)} new key ${c.accent(key)}`);
    console.log(`  ${c.dim("every device paired with the old key is cut off")}`);
    return;
  }
  const relay = rc.relayUrl(cfg);
  const key = rc.getKey();
  if (sub === "qr") {
    console.log("\n" + rc.qrBlock(rc.linkFor(relay, key)));
    console.log(`  ${c.dim("scan with your phone camera, then turn a session on with /rc")}\n`);
    return;
  }
  console.log(`\n  ${c.bold("Remote control")}\n`);
  if (!argv.includes("--no-qr")) {
    console.log(rc.qrBlock(rc.linkFor(relay, key)));
    console.log(`  ${c.dim("scan with your phone camera — the page connects once a session is on with /rc")}\n`);
  }
  console.log(`  ${c.dim("key")}    ${c.accent(key)}`);
  console.log(`  ${c.dim("relay")}  ${relay}`);
  console.log(`  ${c.dim("link")}   ${rc.linkFor(relay, key)}\n`);
  console.log(`  ${c.dim("Type")} /rc ${c.dim("inside")} arcflare agent ${c.dim("or")} arcflare run ${c.dim("to connect that session,")}`);
  console.log(`  ${c.dim("or start one connected:")} arcflare agent --rc\n`);
  console.log(`  ${c.dim("arcflare rc qr · arcflare rc relay <url> · arcflare rc rotate · --no-qr")}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const cfg = loadConfig();

  // Look for an update in the background — never for the MCP server, whose
  // stdout is a protocol, and never from inside the check itself.
  if (cmd !== "mcp" && cmd !== "update" && cmd !== "upgrade") require("../lib/update").refreshInBackground(cfg);

  if (!cmd) return interactive(argv);

  switch (cmd) {
    case "ls":
    case "list":
    case "models":
      listModels(models.discover({ meta: true }));
      return;

    case "ps":
    case "status": {
      const port = cfg.port || DEFAULT_PORT;
      const st = await engine.status(port);
      if (!st.running) { console.log(`  ${c.dim("not running")}`); return; }
      console.log(`  ${c.green("●")} llama-server on ${c.accent("127.0.0.1:" + port)}` +
        (st.pid ? c.dim(`  pid ${st.pid}`) : ""));
      const served = await engine.listServed(port);
      for (const s of served) console.log(`    ${c.dim(ui.sym.dot)} ${s}`);
      return;
    }

    case "stop":
      console.log(engine.stop() ? `  ${c.green(ui.sym.ok)} stopped` : `  ${c.dim("nothing to stop")}`);
      return;

    case "serve": {
      const i = argv.indexOf("--port");
      const port = i >= 0 ? Number(argv[i + 1]) : cfg.port || DEFAULT_PORT;
      await ensureServer(cfg, { port, restart: argv.includes("--restart") });
      console.log(`  ${c.dim("OpenAI endpoint:")} http://127.0.0.1:${port}/v1`);
      return;
    }

    case "run": {
      const all = models.discover({ meta: true });
      const want = argv.slice(1).find((x) => !x.startsWith("-"));
      const m = models.resolve(all, want);
      if (!m) die(`no model matching "${want || ""}"`);
      const budget = await planningBudget(cfg);
      const { best } = contextChoices(m, budget);
      const { port, servedId: id } = await prepareModel(cfg, m, best.ctx, best.cacheType);
      console.log(`  ${c.green(ui.sym.ok)} ${c.accent(id)} @ ${ui.fmtTokens(best.ctx)} ctx\n`);
      await repl(port, id, { rc: argv.includes("--rc") });
      return;
    }

    case "use": {
      // --no-launch wires the config and stops there. Setting a machine up
      // should not mean four editors opening on top of each other.
      const noLaunch = argv.includes("--no-launch");
      // Auto mode is remembered from the menu; --yolo and --ask win for one run.
      // Both are consumed here rather than passed on: --yolo is also Hermes' own
      // spelling of it, and every harness gets whichever flag it actually wants
      // from its auto descriptor.
      const wantAuto = argv.includes("--yolo") || (cfg.autoMode && !argv.includes("--ask"));
      const rest = argv.slice(1)
        .filter((a) => a !== "--no-launch" && a !== "--yolo" && a !== "--ask");
      const h = harness.byId(rest[0]);
      if (!h) die(`unknown harness "${rest[0] || ""}". Try: ` +
        harness.list().map((x) => x.id).join(", "));
      const det = h.detect();
      if (!det.installed) die(`${h.label} is not installed`);
      const all = models.discover({ meta: true });
      // The model is optional, so anything starting with a dash in its place is
      // an argument for the harness — `arcflare use codex -s read-only` means
      // the remembered model and Codex's own flag, not a model called "-s".
      const want = rest[1] && !rest[1].startsWith("-") ? rest[1] : null;
      const extra = rest.slice(want ? 2 : 1);
      const m = models.resolve(all, want || cfg.lastModel) || all[0];
      if (!m) die("no models found");
      const budget = await planningBudget(cfg);
      const { best } = contextChoices(m, budget);
      const { port, servedId: id, ctx: loadedCtx } =
        await prepareModel(cfg, m, best.ctx, best.cacheType);
      const r = h.configure({ port, model: { id, label: displayName(m) }, ctx: best.ctx,
        apiKey: "arcflare", bin: det.bin });
      for (const n of r.notes || []) console.log(`  ${c.dim(n)}`);
      const approve = h.auto && wantAuto ? "yolo" : "ask";
      console.log(`  ${c.green(ui.sym.ok)} ${h.label} → ${c.accent(id)} @ ${ui.fmtTokens(best.ctx)} ctx` +
        (h.auto ? c.dim(`  ${approve === "yolo" ? "auto mode" : "approval: ask"}`) : ""));
      saveConfig({ ...cfg, lastHarness: h.id, lastModel: m.id });
      if (noLaunch) return;
      // `use agent` means the agent, not the chat REPL that both builtins would
      // otherwise fall through to.
      if (h.id === "agent") {
        await require("../lib/agent/run").start({
          port, model: id, nCtx: loadedCtx || best.ctx,
          sampling: (models.loadMeta(m) || {}).sampling || null,
          cwd: process.cwd(), approve,
        });
        return;
      }
      if (h.builtin) { await repl(port, id); return; }
      const child = h.launch({ bin: det.bin, model: { id }, port, args: extra, approve });
      if (child) child.on("exit", (code) => process.exit(code || 0));
      return;
    }

    case "pull": {
      const ref = argv[1];
      if (!ref) die('usage: arcflare pull <user>/<repo>[:QUANT]   e.g. unsloth/Qwen3.6-35B-A3B-GGUF:Q5_K_XL');
      let exe = engine.findServer(cfg.llamaServer);
      // Downloads go through llama.cpp, so a machine without it gets it first
      // rather than a dead end (a fresh Mac, most of all).
      if (!exe) {
        console.log(`  ${c.dim("llama.cpp isn't installed yet — getting it first (arcflare get-engine)")}`);
        exe = await getEngine(cfg);
      }
      // The unified `llama` binary ships next to llama-server and owns downloads.
      const dl = path.join(path.dirname(exe), "llama" + (process.platform === "win32" ? ".exe" : ""));
      const cacheRoot = process.env.LLAMA_CACHE || cfg.modelsRoot || models.roots()[0] ||
        path.join(HOME, "models");
      const { spawn } = require("child_process");
      const useUnified = fs.existsSync(dl);
      const bin = useUnified ? dl : exe;
      const args = useUnified ? ["download", "-hf", ref] : ["-hf", ref, "--no-warmup"];
      console.log(`  ${c.dim("downloading")} ${c.accent(ref)} ${c.dim("→ " + cacheRoot)}`);
      const child = spawn(bin, args, {
        stdio: "inherit",
        env: { ...process.env, LLAMA_CACHE: cacheRoot },
      });
      child.on("exit", (code) => {
        if (code === 0) console.log(`  ${c.green(ui.sym.ok)} pulled — run ${c.accent("arcflare ls")}`);
        process.exit(code || 0);
      });
      await new Promise(() => {});
      return;
    }

    case "backend":
    case "backends": {
      const backend = require("../lib/backend");
      const cacheFile = path.join(HOME, "backends.json");
      const fresh = argv.includes("--probe") || argv.includes("--fresh");
      const want = argv.slice(1).find((a) => !a.startsWith("-"));
      const surveyed = backend.survey(cacheFile, { fresh });

      if (want) {
        const pick = backend.choose(surveyed, want);
        if (!pick) die(`no backend matching "${want}"`);
        if (!pick.ok) {
          console.log(`  ${c.red("!")} ${pick.id} sees no usable device — selecting it anyway`);
        }
        saveConfig({ ...cfg, backend: pick.id, llamaServer: undefined });
        console.log(`  ${c.green(ui.sym.ok)} backend set to ${c.accent(pick.id)} ${c.dim(pick.server)}`);
        return;
      }

      const active = backend.choose(surveyed, cfg.backend);
      for (const b of surveyed) {
        const mark = b.ok ? c.green(ui.sym.ok) : c.red(ui.sym.fail);
        const here = active && b.id === active.id ? c.accent(" ← active") : "";
        console.log(`  ${mark} ${b.id.padEnd(20)} ${c.dim(b.dir)}${here}`);
        if (b.ok) {
          for (const d of b.devices) {
            console.log(`      ${c.dim(d.handle + "  " + d.name)} ` +
              `${c.dim("(" + (d.totalMiB / 1024).toFixed(1) + " GB, " +
                (d.freeMiB / 1024).toFixed(1) + " GB free)")}`);
          }
        } else {
          console.log(`      ${c.dim(b.note || b.error || "no devices")}`);
          if (b.kind === "rocm") {
            const t = backend.hipTargets(b);
            if (t.length) {
              console.log(`      ${c.dim("kernels present: " + t.join(" "))}`);
              console.log(`      ${c.dim("the build is fine — the driver is not exposing the GPU to HIP.")}`);
              console.log(`      ${c.dim("update the AMD driver, or stay on Vulkan.")}`);
            }
          }
        }
      }
      console.log(`
  ${c.dim("arcflare backend <kind|id>   select    ·   --probe   re-probe")}`);
      return;
    }

    case "batch": {
      const want = argv[1];
      if (want) {
        const n = Number(want);
        if (!Number.isFinite(n) || n < 64 || n > 16384) {
          die(`batch size must be between 64 and 16384 (got "${want}")`);
        }
        saveConfig({ ...cfg, ubatch: Math.floor(n) });
        console.log(`  ${c.green(ui.sym.ok)} physical batch set to ${c.accent(String(Math.floor(n)))} ` +
          c.dim("(restart the server to apply)"));
        return;
      }
      const cur = ubatchFor(cfg);
      for (const n of UBATCH_SIZES) {
        const mark = n === cur ? c.accent("❯") : " ";
        const note = n === MIN_UBATCH
          ? "llama.cpp default · best on long prompts"
          : n === DEFAULT_UBATCH
            ? "ArcFlare default · ~39% faster on ~1k prompts, ~6% slower at 8k"
            : "";
        console.log(`  ${mark} ${String(n).padEnd(10)} ${c.dim(note)}`);
      }
      console.log(`\n  ${c.dim("Larger batches also cost VRAM. If a model will not fit,")}`);
      console.log(`  ${c.dim("ArcFlare drops the batch before it reduces context.")}`);
      return;
    }

    // Which model actually runs best here. Static fit is arithmetic and free;
    // measuring means loading every model in turn, so it only happens on --run.
    case "fit":
    case "bench": {
      if (argv.includes("--clear")) {
        console.log(fit.clear()
          ? `  ${c.green(ui.sym.ok)} forgot every measurement`
          : `  ${c.dim("nothing measured yet")}`);
        return;
      }
      const all = models.discover({ meta: true });
      if (!all.length) { listModels(all); return; }

      const wantJson = argv.includes("--json");
      const quick = argv.includes("--quick");
      const probes = !argv.includes("--no-probes");
      const run = argv.includes("--run") || argv.includes("-r");
      const db = fit.load();

      // A named model measures just that one. `arcflare fit qwen3.8` is a
      // reasonable thing to type when only one model has changed.
      const want = argv.slice(1).find((a) => !a.startsWith("-"));
      const one = want ? models.resolve(all, want) : null;
      if (want && !one) die(`no model matching "${want}"`);
      const targets = one ? [one] : all;

      if (!run) {
        // Report against memory as it is *now*, with our own server included in
        // whatever is using it — stopping someone's loaded model to print a
        // table would be a rude way to answer a question about arithmetic.
        const mem = deviceMemory(cfg);
        const fits = targets.map((m) => fit.staticFit(m, mem.freeBytes));
        const rows = fit.rowsFor(db, targets);
        if (wantJson) {
          console.log(JSON.stringify({ freeBytes: mem.freeBytes, fits, measured: rows }, null, 2));
          return;
        }
        console.log(ui.banner());
        const st = await engine.status(cfg.port || DEFAULT_PORT);
        for (const l of fit.renderStatic(fits, mem.freeBytes,
          st.running ? "server running — a model is holding some of it" : "")) console.log(l);
        for (const l of fit.renderMeasured(rows)) console.log(l);
        for (const l of fit.renderVerdict(rows)) console.log(l);
        console.log("");
        return;
      }

      console.log(ui.banner());
      console.log(`  ${c.dim(`measuring ${targets.length} model${targets.length > 1 ? "s" : ""} — ` +
        `each one is loaded for real, so this takes minutes, not seconds`)}\n`);

      for (const m of targets) {
        // Budget is re-measured per model with the server stopped: the model we
        // measured a minute ago is still resident until the next restart, and
        // counting its VRAM as unavailable would hand the next model a tiny
        // context and call the result a measurement.
        const budget = await planningBudget(cfg);
        const { best } = contextChoices(m, budget);
        const t0 = Date.now();
        const prep = await prepareModel(cfg, m, best.ctx, best.cacheType);
        const loadMs = Date.now() - t0;

        let row;
        if (prep.failed) {
          row = { id: m.id, error: "did not load" };
        } else {
          const spin = ui.spinner(`${displayName(m)} — measuring…`);
          try {
            row = await fit.measure({
              port: prep.port, id: prep.servedId, quick, probes,
              onStep: (s) => spin.update(`${displayName(m)} — ${s}`),
            });
            spin.stop(`  ${c.green(ui.sym.ok)} ${c.accent(m.id)} ${c.dim(
              `${fit.fmtRate(row.gen && row.gen.tokPerSec)} generate · ` +
              `${fit.fmtRate(row.prefill && row.prefill.tokPerSec)} prefill` +
              (row.probes ? ` · ${row.probes.passed}/${row.probes.total} probes` : ""))}`);
          } catch (e) {
            row = { id: m.id, error: e.message };
            spin.stop(`  ${c.red(ui.sym.fail)} ${m.id} ${c.dim(e.message.slice(0, 80))}`);
          }
        }
        Object.assign(row, {
          id: m.id, size: m.size, ctx: prep.ctx, loadMs, at: Date.now(),
        });
        // Saved after every model, not at the end: a twenty-minute run that is
        // interrupted at model four should keep the three it already paid for.
        fit.save(fit.record(db, row));
      }

      const rows = fit.rowsFor(db, all);
      if (wantJson) { console.log(JSON.stringify({ measured: rows }, null, 2)); return; }
      for (const l of fit.renderMeasured(rows)) console.log(l);
      for (const l of fit.renderVerdict(rows)) console.log(l);
      console.log("");
      return;
    }

    case "memory": {
      const want = argv[1];
      if (want) {
        if (!MEMORY_PROFILES[want]) {
          die(`unknown profile "${want}". Try: ${Object.keys(MEMORY_PROFILES).join(", ")}`);
        }
        saveConfig({ ...cfg, memoryProfile: want });
        console.log(`  ${c.green(ui.sym.ok)} memory profile set to ${c.accent(want)} ` +
          c.dim("(restart the server to apply)"));
        return;
      }
      const cur = cfg.memoryProfile || DEFAULT_PROFILE;
      for (const [name, p] of Object.entries(MEMORY_PROFILES)) {
        const mark = name === cur ? c.accent("❯") : " ";
        console.log(`  ${mark} ${name.padEnd(10)} ${c.dim(
          `prompt cache ${p.cacheRamMiB} MiB · ${p.modelsMax} model${p.modelsMax > 1 ? "s" : ""} resident · ` +
          (p.sleepIdleSeconds > 0 ? `sleeps after ${p.sleepIdleSeconds / 60} min idle` : "never sleeps"))}`);
      }
      return;
    }

    case "agent": {
      // --resume [id] / --continue: settled before the model, so a resumed
      // session comes back on the model it used unless one is named.
      const resumed = await require("../lib/agent/run").resolveResume(argv, process.cwd());
      if (resumed.cancelled) return;
      if (resumed.none) console.log(`  ${c.dim("no saved sessions for this folder · starting a new one")}`);
      argv.splice(0, argv.length, ...resumed.argv);
      const all = models.discover({ meta: true });
      const sel = pickModel(all, argv, (resumed.session && resumed.session.modelRef) || cfg.lastModel);
      if (sel.error) die(sel.error);
      const m = sel.model;
      if (!m) die("no models found");
      const pIdx = argv.indexOf("-p");
      const budget = await planningBudget(cfg);
      const { best } = contextChoices(m, budget);
      const prep = await prepareModel(cfg, m, best.ctx, best.cacheType);
      if (prep.failed) die("could not load the model");
      saveConfig({ ...cfg, lastModel: m.id });
      const prompt = pIdx > 0 ? argv.slice(pIdx + 1).join(" ") : null;
      // Auto mode is remembered from the menu; --yolo and --ask still win.
      const auto = argv.includes("--yolo") ||
        (cfg.autoMode && !argv.includes("--ask"));
      await require("../lib/agent/run").start({
        port: prep.port,
        model: prep.servedId,
        nCtx: prep.ctx,
        sampling: (models.loadMeta(m) || {}).sampling || null,
        cwd: process.cwd(),
        prompt,
        approve: auto ? "yolo" : "ask",
        rc: argv.includes("--rc"),
        cfg,
        session: resumed.session,
        modelRef: m.id,
        // --machine and --no-machine answer for this run and settle the
        // question; otherwise the stored answer stands, and an unasked one is
        // asked here rather than assumed.
        machine: argv.includes("--no-machine") ? false
          : await wantMachine(cfg, { assume: argv.includes("--machine") ? true : undefined }),
      });
      return;
    }

    // The machine server: a client spawns `arcflare mcp` and talks JSON-RPC on
    // stdio, so nothing here may print to stdout.
    case "mcp": {
      if (argv.includes("--install")) return installMcp(cfg, argv);
      if (argv[1] === "login" || argv[1] === "logout") return mcpAuth(argv);
      if (["trust", "untrust", "trusted"].includes(argv[1])) return mcpTrust(argv);
      if (argv[1] === "enable" || argv[1] === "disable") {
        const on = argv[1] === "enable";
        saveConfig({ ...cfg, machine: on });
        console.log(on
          ? `  ${c.green(ui.sym.ok)} machine server on ${c.dim(MACHINE_NOTE)}`
          : `  ${c.green(ui.sym.ok)} machine server off ${c.dim("the agent keeps files, search and the shell")}`);
        return;
      }
      require("./arcflare-mcp.js").main(argv.slice(1));
      return;
    }

    case "gen":
    case "generate":
      return genCommand(cfg, argv);

    case "update":
    case "upgrade":
      return updateCommand(cfg, argv);

    case "shop":
    case "hub":
      return shopCommand(cfg, argv);

    case "uninstall":
    case "delete":
    case "remove":
      return uninstallCommand(cfg, argv);

    case "rc":
    case "remote":
      return rcCommand(cfg, argv);
    case "report":
    case "bug":
      return reportCommand(argv);
    case "harness":
    case "harnesses":
      return harnessCommand(argv);

    case "logs": {
      const i = argv.indexOf("-n");
      console.log(engine.tailLog(i >= 0 ? Number(argv[i + 1]) : 40));
      return;
    }

    case "doctor": {
      // One table per area, a status mark on every row, and a closing tally,
      // so the one red line stands out instead of hiding in a list.
      const ok = (yes) => (yes ? c.green(ui.sym.ok) : c.red(ui.sym.fail));
      const idle = c.dim(ui.sym.dot);
      let problems = 0;
      const mark = (state) => { if (state === false) problems++; return state === null ? idle : ok(state); };
      const block = (title, rows) => {
        console.log(ui.section(title));
        console.log(ui.table(rows.map(([state, label, value]) => [mark(state), label, value])));
        console.log("");
      };

      const backend = require("../lib/backend");
      const surveyed = backend.survey(path.join(HOME, "backends.json"));
      const active = backend.choose(surveyed, cfg.backend);
      const exe = engine.findServer(cfg.llamaServer, cfg.backend);
      const budget = freeDeviceBytes(cfg);
      const all = models.discover({ meta: true });
      console.log(ui.banner(c.dim("doctor")));

      block("engine", [
        [!!exe, "llama-server", c.dim(exe || "not found: arcflare get-engine downloads it, or arcflare set-engine <path>")],
        ...surveyed.map((b) => [
          b.ok ? true : null,
          `backend ${b.kind}`,
          (b.ok ? c.dim(b.devices.map((d) => d.name).join(", ")) : c.dim(b.note || "no devices")) +
            (active && b.id === active.id ? ` ${c.accent("active")}` : ""),
        ]),
        [true, "memory", c.dim(`${cfg.memoryProfile || DEFAULT_PROFILE} profile`)],
        [true, "device memory", `${ui.fmtBytes(budget)} ${c.dim("free")}`],
        [all.length > 0, "models", all.length ? `${all.length} ${c.dim("found")}` : c.dim("none: arcflare shop")],
      ]);

      block("harnesses", harness.list().map((h) => [
        h.installed ? true : null,
        h.label,
        c.dim(h.builtin ? "built in" : h.bin || "not installed"),
      ]));

      const mcpTools = require("../lib/mcp/tools").createServer({}).list().length;
      // Blender is the one application ArcFlare knows about by name, because
      // the Blender MCP tools are unusable until a live one answers and the
      // failure otherwise reads as a broken server.
      const bl = require("../lib/mcp/blender");
      const install = bl.find();
      const toolRows = [[true, "mcp server", `${mcpTools} ${c.dim("tools · arcflare mcp")}`]];
      if (install) {
        const live = await bl.bridgeStatus({ timeoutMs: 1500 });
        toolRows.push([true, "blender", c.dim(install.path)]);
        toolRows.push([live.reachable ? true : null, "blender bridge", c.dim(live.reachable
          ? `answering on port ${live.port}`
          : `port ${live.port}: not running (headless still works)`)]);
      } else {
        toolRows.push([null, "blender", c.dim("not found")]);
      }
      block("tools", toolRows);

      const st = await engine.status(cfg.port || DEFAULT_PORT);
      block("server", [[st.running ? true : null, `port ${cfg.port || DEFAULT_PORT}`, st.running ? c.green("running") : c.dim("stopped")]]);

      console.log(problems
        ? `  ${c.red(ui.sym.fail)} ${problems} ${problems === 1 ? "problem" : "problems"} ${c.dim("above")}\n`
        : `  ${c.green(ui.sym.ok)} ${c.dim("all good")}\n`);
      return;
    }

    case "get-engine":
    case "install-engine": {
      await getEngine(cfg);
      return;
    }

    case "set-engine": {
      const p = argv[1];
      if (!p) die("usage: arcflare set-engine <path-to-llama-server>");
      const found = engine.findServer(p);
      if (!found) die(`no llama-server at ${p}`);
      saveConfig({ ...cfg, llamaServer: found });
      console.log(`  ${c.green(ui.sym.ok)} engine set to ${c.dim(found)}`);
      return;
    }

    case "path":
      console.log(HOME);
      return;

    case "version":
    case "--version":
    case "-v":
      console.log("arcflare " + VERSION);
      return;

    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      return;

    default:
      // `arcflare qwen3.8` is a friendly alias for `arcflare run qwen3.8`
      if (!cmd.startsWith("-")) {
        process.argv.splice(2, 0, "run");
        return main();
      }
      console.log(helpText());
      process.exitCode = 1;
  }
}

// Guarded so the tests can require this file for its pure helpers without
// the CLI running itself on import.
if (require.main === module) {
  main().catch((e) => die(e && e.stack ? e.stack : String(e)));
}

module.exports = { pickModel, ubatchFor, DEFAULT_UBATCH, MIN_UBATCH };
