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
const models = require("../lib/models");
const engine = require("../lib/engine");
const harness = require("../lib/harness");

const { c } = ui;
const HOME = models.HOME;
const CONFIG = path.join(HOME, "config.json");
const PRESET = path.join(HOME, "models.ini");
const VERSION = require("../package.json").version;
const DEFAULT_PORT = 11434; // Ollama's port: existing harness configs just work

// --------------------------------------------------------------- settings --

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}

function die(msg, code = 1) {
  process.stderr.write(`  ${c.red("✗")} ${msg}\n`);
  process.exit(code);
}

// ------------------------------------------------------------------ vram ----

/** Free device memory in bytes, best effort. Falls back to free system RAM. */
function freeDeviceBytes(cfg) {
  const exe = engine.findServer(cfg.llamaServer);
  if (exe) {
    const { spawnSync } = require("child_process");
    const cli = exe.replace(/llama-server(\.exe)?$/i, (m) => m.replace("server", "cli"));
    const probe = fs.existsSync(cli) ? cli : exe;
    const r = spawnSync(probe, ["--list-devices"], {
      encoding: "utf8", cwd: path.dirname(exe), timeout: 20000,
    });
    const txt = (r.stdout || "") + (r.stderr || "");
    // "Vulkan0: AMD Radeon 8060S (48971 MiB, 46522 MiB free)"
    const m = /\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/i.exec(txt);
    if (m) return Number(m[2]) * 1024 * 1024;
  }
  return os.freemem();
}

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
  const w = Math.max(...all.map((m) => m.id.length));
  for (const m of all) {
    console.log(`  ${c.accent(m.id.padEnd(w))}  ${c.dim(modelLabel(m))}`);
  }
}

// --------------------------------------------------------------- context ----

function contextChoices(m, budget) {
  const meta = m.meta || {};
  const trained = meta.trainCtx || 32768;
  const perTokF16 = gguf.kvBytesPerToken(meta, "f16");
  const perTokQ8 = gguf.kvBytesPerToken(meta, "q8_0");

  // Leave the weights their room; the rest is available for cache.
  const spare = Math.max(0, budget - m.size - 1.5e9);
  const items = [];

  const add = (ctx, cacheType, tag) => {
    const per = cacheType === "q8_0" ? perTokQ8 : perTokF16;
    const need = per ? per * ctx : null;
    const fits = need == null ? true : need <= spare;
    items.push({
      label: `${ui.fmtTokens(ctx)} tokens`,
      hint: cacheType === "q8_0" ? "q8_0 cache" : "f16 cache",
      note: need ? `~${ui.fmtBytes(need)} KV${fits ? "" : "  (too big)"}` : "",
      value: { ctx, cacheType },
      disabled: !fits,
      tag,
    });
  };

  // Max first — this is the headline ask.
  add(trained, "q8_0", "max");
  if (perTokF16 && perTokF16 * trained <= spare) add(trained, "f16", "max-f16");
  for (const ctx of [131072, 65536, 32768, 16384]) {
    if (ctx < trained) add(ctx, "f16");
  }
  const usable = items.filter((i) => !i.disabled);
  return { items, best: usable.length ? usable[0].value : { ctx: 16384, cacheType: "f16" } };
}

// ---------------------------------------------------------------- server ----

async function ensureServer(cfg, opts = {}) {
  const port = opts.port || cfg.port || DEFAULT_PORT;
  const exe = engine.findServer(cfg.llamaServer);
  if (!exe) {
    die("llama-server not found.\n" +
      `      Install llama.cpp, then either put it on PATH or run:\n` +
      `      ${c.accent("arcflare set-engine <path-to-llama-server>")}`);
  }

  const st = await engine.status(port);
  if (st.running && !opts.restart) return { port, exe, already: true };
  if (st.running && opts.restart) { engine.stop(); await new Promise((r) => setTimeout(r, 800)); }

  // Point the router at wherever the models actually are.
  const cacheRoot = process.env.LLAMA_CACHE || cfg.modelsRoot || models.roots()[0];
  const env = {};
  if (cacheRoot) env.LLAMA_CACHE = cacheRoot;

  const extra = [];
  if (opts.modelsDir) extra.push();
  const info = await engine.start({
    exe,
    port,
    preset: fs.existsSync(PRESET) ? PRESET : undefined,
    modelsDir: opts.modelsDir,
    extraArgs: opts.extraArgs || [],
    env,
  });

  const spin = ui.spinner("starting llama-server…");
  const ok = await engine.waitReady(port, opts.timeout || 600000, (ms) => {
    spin.update(`starting llama-server… ${Math.round(ms / 1000)}s`);
  });
  if (!ok) {
    spin.stop(c.red("✗ server did not come up"));
    console.log(c.dim(engine.tailLog(25)));
    process.exit(1);
  }
  spin.stop(`${c.green("✓")} llama-server ready on ${c.accent("127.0.0.1:" + port)}`);
  return { port, exe, pid: info.pid };
}

/** Match our model id to whatever id the router actually advertises. */
async function servedIdFor(port, model) {
  const served = await engine.listServed(port);
  if (!served.length) return model.id;
  const stem = path.basename(model.file).replace(/\.gguf$/i, "").toLowerCase();
  const cands = [model.id, stem, model.id.split(":")[0]];
  for (const cand of cands) {
    const hit = served.find((s) => s.toLowerCase() === cand);
    if (hit) return hit;
  }
  const loose = served.find((s) => {
    const t = s.toLowerCase();
    return t.includes(model.id.split(":")[0]) || stem.includes(t);
  });
  return loose || served[0];
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

async function repl(port, modelId) {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];
  console.log(`  ${c.dim("chatting with")} ${c.accent(modelId)} ${c.dim("— /bye to exit")}\n`);
  const askOne = () =>
    new Promise((resolve) => rl.question(`${c.accent("❯")} `, resolve));
  for (;;) {
    const line = (await askOne()).trim();
    if (!line) continue;
    if (line === "/bye" || line === "/exit" || line === "/quit") break;
    history.push({ role: "user", content: line });
    process.stdout.write("\n");
    let out = "";
    try {
      out = await chatOnce(port, modelId, history, (p) => process.stdout.write(p));
    } catch (e) {
      console.log(c.red("  request failed: " + e.message));
      history.pop();
      continue;
    }
    history.push({ role: "assistant", content: out });
    process.stdout.write("\n\n");
  }
  rl.close();
}

// ------------------------------------------------------------------ flow -----

async function interactive(argv) {
  const cfg = loadConfig();
  console.log(ui.banner());

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
  const budget = freeDeviceBytes(cfg);
  const { items: cItems, best } = contextChoices(model, budget);
  const ctxPick = await ui.select("Context size", cItems, {
    subtitle: `${ui.fmtBytes(budget)} free on device · ${ui.fmtBytes(model.size)} of weights`,
  });
  if (!ctxPick) return;
  const { ctx, cacheType } = ctxPick;

  // Persist the choice as a router preset so the setting survives a reload.
  const label = displayName(model);
  writePresetFor(model, ctx, cacheType);

  saveConfig({ ...cfg, lastHarness: hid, lastModel: mid, port: cfg.port || DEFAULT_PORT });

  // 4. server
  const { port } = await ensureServer(cfg, { restart: true });
  const servedId = await servedIdFor(port, model);

  // 5. wire the harness up
  const target = { id: servedId, label, file: model.file };
  const res = chosen.configure({ port, model: target, ctx, apiKey: "arcflare", bin: det.bin });
  for (const n of res.notes || []) console.log(`  ${c.dim(n)}`);
  if (!res.ok) die("could not configure " + chosen.label);

  console.log(`  ${c.green("✓")} ${chosen.label} → ${c.accent(servedId)} @ ${ui.fmtTokens(ctx)} ctx\n`);

  // 6. go
  if (chosen.builtin) {
    await repl(port, servedId);
    return;
  }
  const child = chosen.launch({ bin: det.bin, model: target, port, args: argv.slice(1) });
  if (child) {
    child.on("exit", (code) => process.exit(code || 0));
    await new Promise(() => {});
  }
}

function writePresetFor(model, ctx, cacheType) {
  const stem = path.basename(model.file).replace(/\.gguf$/i, "");
  const opts = {
    c: ctx,
    "cache-type-k": cacheType,
    "cache-type-v": cacheType,
    "n-gpu-layers": 99,
    "flash-attn": "on",
    jinja: true,
  };
  if (model.mmproj) opts.mmproj = model.mmproj;
  // Section names are matched against the router's model ids; write both the
  // filename stem and our short id so whichever it uses picks the settings up.
  const per = {};
  per[stem] = opts;
  if (model.id !== stem) per[model.id] = opts;
  engine.writePreset(PRESET, { "n-gpu-layers": 99, "flash-attn": "on" }, per);
}

// ------------------------------------------------------------------ cmds -----

const HELP = `
  ${c.bold("arcflare")} ${c.dim("— local models, any harness")}

  ${c.accent("arcflare")}                    open the menu (harness → model → context)
  ${c.accent("arcflare ls")}                 list discovered GGUF models
  ${c.accent("arcflare pull")} <repo>[:Q]     download a GGUF from Hugging Face
  ${c.accent("arcflare run")} <model>        start the server and chat
  ${c.accent("arcflare use")} <harness> [m]  configure + launch a harness
  ${c.accent("arcflare serve")} [--port N]   start the server only
  ${c.accent("arcflare ps")}                 server status and loaded models
  ${c.accent("arcflare stop")}               stop the server
  ${c.accent("arcflare logs")} [-n N]        tail the server log
  ${c.accent("arcflare doctor")}             check engine, GPU and harnesses
  ${c.accent("arcflare set-engine")} <path>  remember where llama-server lives
  ${c.accent("arcflare path")}               print the ArcFlare home directory
  ${c.accent("arcflare version")}

  ${c.dim("Models are found in $ARCFLARE_MODELS, $LLAMA_CACHE, ~/.arcflare/models")}
  ${c.dim("and ~/llamacpp/models. The server speaks the OpenAI API on :11434.")}
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const cfg = loadConfig();

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
      for (const s of served) console.log(`    ${c.dim("·")} ${s}`);
      return;
    }

    case "stop":
      console.log(engine.stop() ? `  ${c.green("✓")} stopped` : `  ${c.dim("nothing to stop")}`);
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
      const m = models.resolve(all, argv[1]);
      if (!m) die(`no model matching "${argv[1] || ""}"`);
      const budget = freeDeviceBytes(cfg);
      const { best } = contextChoices(m, budget);
      writePresetFor(m, best.ctx, best.cacheType);
      const { port } = await ensureServer(cfg, { restart: true });
      const id = await servedIdFor(port, m);
      console.log(`  ${c.green("✓")} ${c.accent(id)} @ ${ui.fmtTokens(best.ctx)} ctx\n`);
      await repl(port, id);
      return;
    }

    case "use": {
      const h = harness.byId(argv[1]);
      if (!h) die(`unknown harness "${argv[1]}". Try: ` +
        harness.list().map((x) => x.id).join(", "));
      const det = h.detect();
      if (!det.installed) die(`${h.label} is not installed`);
      const all = models.discover({ meta: true });
      const m = models.resolve(all, argv[2] || cfg.lastModel) || all[0];
      if (!m) die("no models found");
      const budget = freeDeviceBytes(cfg);
      const { best } = contextChoices(m, budget);
      writePresetFor(m, best.ctx, best.cacheType);
      const { port } = await ensureServer(cfg, { restart: true });
      const id = await servedIdFor(port, m);
      const r = h.configure({ port, model: { id, label: displayName(m) }, ctx: best.ctx,
        apiKey: "arcflare", bin: det.bin });
      for (const n of r.notes || []) console.log(`  ${c.dim(n)}`);
      console.log(`  ${c.green("✓")} ${h.label} → ${c.accent(id)} @ ${ui.fmtTokens(best.ctx)} ctx`);
      saveConfig({ ...cfg, lastHarness: h.id, lastModel: m.id });
      if (h.builtin) { await repl(port, id); return; }
      const child = h.launch({ bin: det.bin, model: { id }, port, args: argv.slice(3) });
      if (child) child.on("exit", (code) => process.exit(code || 0));
      return;
    }

    case "pull": {
      const ref = argv[1];
      if (!ref) die('usage: arcflare pull <user>/<repo>[:QUANT]   e.g. unsloth/Qwen3.6-35B-A3B-GGUF:Q5_K_XL');
      const exe = engine.findServer(cfg.llamaServer);
      if (!exe) die("llama-server not found — run `arcflare set-engine <path>` first");
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
        if (code === 0) console.log(`  ${c.green("✓")} pulled — run ${c.accent("arcflare ls")}`);
        process.exit(code || 0);
      });
      await new Promise(() => {});
      return;
    }

    case "logs": {
      const i = argv.indexOf("-n");
      console.log(engine.tailLog(i >= 0 ? Number(argv[i + 1]) : 40));
      return;
    }

    case "doctor": {
      const exe = engine.findServer(cfg.llamaServer);
      console.log(`  ${exe ? c.green("✓") : c.red("✗")} llama-server  ${c.dim(exe || "not found")}`);
      const budget = freeDeviceBytes(cfg);
      console.log(`  ${c.green("✓")} device memory ${c.dim(ui.fmtBytes(budget) + " free")}`);
      const all = models.discover({ meta: true });
      console.log(`  ${all.length ? c.green("✓") : c.red("✗")} models        ${c.dim(all.length + " found")}`);
      for (const h of harness.list()) {
        console.log(`  ${h.installed ? c.green("✓") : c.dim("·")} ${h.label.padEnd(14)} ` +
          `${c.dim(h.builtin ? "built in" : h.bin || "not installed")}`);
      }
      const st = await engine.status(cfg.port || DEFAULT_PORT);
      console.log(`  ${st.running ? c.green("✓") : c.dim("·")} server        ` +
        c.dim(st.running ? "running" : "stopped"));
      return;
    }

    case "set-engine": {
      const p = argv[1];
      if (!p) die("usage: arcflare set-engine <path-to-llama-server>");
      const found = engine.findServer(p);
      if (!found) die(`no llama-server at ${p}`);
      saveConfig({ ...cfg, llamaServer: found });
      console.log(`  ${c.green("✓")} engine set to ${c.dim(found)}`);
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
      console.log(HELP);
      return;

    default:
      // `arcflare qwen3.8` is a friendly alias for `arcflare run qwen3.8`
      if (!cmd.startsWith("-")) {
        process.argv.splice(2, 0, "run");
        return main();
      }
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
