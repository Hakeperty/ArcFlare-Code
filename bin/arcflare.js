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

// llama-server's stock defaults assume a machine with RAM to spare: an 8192 MiB
// host prompt cache and up to 4 models resident. On a box whose RAM is mostly
// carved out for VRAM that is the biggest avoidable cost, so we set it.
const MEMORY_PROFILES = {
  lean:     { cacheRamMiB: 512,  modelsMax: 1, sleepIdleSeconds: 300 },
  balanced: { cacheRamMiB: 2048, modelsMax: 1, sleepIdleSeconds: 900 },
  max:      { cacheRamMiB: 8192, modelsMax: 4, sleepIdleSeconds: -1 },
};
const DEFAULT_PROFILE = "balanced";

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

/**
 * Device memory we can actually plan against.
 *
 * llama.cpp's own "N MiB free" is a static heap budget and does not fall when
 * another process loads a model, so we cross-check it against what the OS says
 * is in use. Getting this wrong is the difference between "max context" working
 * and a bare ErrorOutOfDeviceMemory at first request.
 */
function deviceMemory(cfg) {
  const backend = require("../lib/backend");
  const surveyed = backend.survey(path.join(HOME, "backends.json"));
  const active = backend.choose(surveyed, cfg.backend);
  const mem = backend.deviceMemory(active);
  if (mem.freeBytes == null) return { freeBytes: os.freemem(), totalBytes: null, usedBytes: null };
  return mem;
}

function freeDeviceBytes(cfg) {
  return deviceMemory(cfg).freeBytes;
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

  // Max context first — it is the headline ask, and it is nearly free: measured
  // at 262144 vs 4096 the cost is about 5% of throughput and 0.7 GB of VRAM.
  //
  // f16 is offered ahead of q8_0 because a quantised KV cache measured *slower*
  // here (55.4 vs 53.0 tok/s) — dequantising it costs more than the bandwidth
  // it saves. q8_0 remains the fallback for when f16 will not fit.
  add(trained, "f16", "max");
  add(trained, "q8_0", "max-q8");
  for (const ctx of [131072, 65536, 32768, 16384]) {
    if (ctx < trained) add(ctx, "f16");
  }
  const usable = items.filter((i) => !i.disabled);
  return { items, best: usable.length ? usable[0].value : { ctx: 16384, cacheType: "f16" } };
}

// ---------------------------------------------------------------- server ----

async function ensureServer(cfg, opts = {}) {
  const port = opts.port || cfg.port || DEFAULT_PORT;
  const exe = engine.findServer(cfg.llamaServer, cfg.backend);
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
  const profile = MEMORY_PROFILES[cfg.memoryProfile || DEFAULT_PROFILE] ||
    MEMORY_PROFILES[DEFAULT_PROFILE];
  const info = await engine.start({
    exe,
    port,
    preset: fs.existsSync(PRESET) ? PRESET : undefined,
    modelsDir: opts.modelsDir,
    memory: profile,
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
  const base = model.id.split(":")[0];
  const quant = (model.id.split(":")[1] || "").replace(/^ud-/, "");

  for (const cand of [model.id, stem]) {
    const hit = served.find((s) => s.toLowerCase() === cand);
    if (hit) return hit;
  }
  // Score: the base name must match, and the quant must match too — otherwise
  // Q5_K_XL and Q6_K_XL of the same model are indistinguishable.
  let best = null;
  let bestScore = 0;
  for (const s of served) {
    const t = s.toLowerCase();
    let score = 0;
    if (t.includes(base)) score += 2;
    if (quant && t.includes(quant)) score += 3;
    if (stem.includes(t.split("/").pop().split(":")[0])) score += 1;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 2 ? best : served[0];
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
  saveConfig({ ...cfg, lastHarness: hid, lastModel: mid, port: cfg.port || DEFAULT_PORT });

  // 4. server, keyed preset, restart
  const { port, servedId } = await prepareModel(cfg, model, ctx, cacheType);

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

/**
 * Write a router preset section for one model.
 *
 * The section name becomes the model id the router advertises, and the `model`
 * key makes the section self-sufficient. Both matter: a section named after
 * something the router does not already know about creates a phantom entry with
 * no --model argument, which sits in "loading" forever instead of failing.
 * Naming the section ourselves also gives stable, Ollama-shaped ids.
 */
function presetIdFor(model) {
  return model.id;
}

function writePresetFor(model, ctx, cacheType) {
  const opts = {
    model: model.file,
    c: ctx,
    "cache-type-k": cacheType,
    "cache-type-v": cacheType,
    "n-gpu-layers": 99,
    "flash-attn": "on",
    // One slot. Four parallel slots cost about 7% of generation throughput and
    // buy nothing for a single interactive user.
    "parallel": 1,
    jinja: true,
  };
  if (model.mmproj) opts.mmproj = model.mmproj;
  if (model.mtp) {
    opts["model-draft"] = model.mtp;
    opts["spec-type"] = "draft-mtp";
  }
  const per = {};
  per[presetIdFor(model)] = opts;
  engine.writePreset(PRESET, { "n-gpu-layers": 99, "flash-attn": "on" }, per);
  return presetIdFor(model);
}

/**
 * Bring the server up, learn the id the router gave this model, write a preset
 * keyed to it, and restart so the preset takes effect. Router startup does not
 * load any weights, so the extra round trip costs about a second.
 */
async function prepareModel(cfg, model, ctx, cacheType) {
  let servedId = presetIdFor(model);

  // Try the requested context, and step down if the device cannot actually
  // take it. Reported free memory is a budget, not a promise — and a model is
  // only truly loadable once it has loaded — so we verify rather than predict.
  let tryCtx = ctx;
  let port = cfg.port || DEFAULT_PORT;
  const floor = 8192;
  for (let attempt = 0; attempt < 6; attempt++) {
    writePresetFor(model, tryCtx, cacheType);
    ({ port } = await ensureServer(cfg, { restart: true }));
    // Ask the router what it decided to call this file.
    servedId = (await engine.servedIdForFile(port, model.file)) || servedId;
    const spin = ui.spinner(
      `loading ${displayName(model)} @ ${ui.fmtTokens(tryCtx)} ctx…`);
    const r = await warmup(port, servedId);
    if (r.ok) {
      spin.stop(`${c.green("✓")} loaded at ${c.accent(ui.fmtTokens(tryCtx))} context` +
        (tryCtx < ctx ? c.dim(`  (reduced from ${ui.fmtTokens(ctx)} — device could not fit it)`) : ""));
      return { port, servedId, ctx: tryCtx };
    }
    const oom = /out of device memory|outofdevice|failed to load|alloc/i.test(r.error || "");
    if (!oom || tryCtx <= floor) {
      spin.stop(`${c.red("✗")} ${String(r.error || "model failed to load").slice(0, 120)}`);
      console.log(c.dim(engine.tailLog(12)));
      return { port, servedId, ctx: tryCtx, failed: true };
    }
    tryCtx = Math.max(floor, Math.floor(tryCtx / 2 / 1024) * 1024);
    spin.stop(`${c.dim("·")} did not fit — retrying at ${ui.fmtTokens(tryCtx)}`);
  }
  return { port, servedId, ctx: tryCtx, failed: true };
}

/** Force the router to actually load a model, so failures surface here. */
function warmup(port, modelId, timeoutMs = 900000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    const req = http.request({
      host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => {
        if (res.statusCode < 400) return resolve({ ok: true });
        let msg = out.slice(0, 300);
        try { msg = JSON.parse(out).error.message; } catch {}
        // The router reports "failed to load"; the reason is in the server log.
        const log = engine.tailLog(60);
        const m = /(ErrorOutOfDeviceMemory|out of device memory|failed to allocate[^\n]*)/i.exec(log);
        resolve({ ok: false, error: m ? `${msg} (${m[1]})` : msg });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "load timed out" }); });
    req.end(body);
  });
}

// ------------------------------------------------------------------ cmds -----

const HELP = `
  ${c.bold("arcflare")} ${c.dim("— local models, any harness")}

  ${c.accent("arcflare")}                    open the menu (harness → model → context)
  ${c.accent("arcflare ls")}                 list discovered GGUF models
  ${c.accent("arcflare pull")} <repo>[:Q]     download a GGUF from Hugging Face
  ${c.accent("arcflare run")} <model>        start the server and chat
  ${c.accent("arcflare agent")} [model]       coding agent: tools, MCP, skills
  ${c.accent("arcflare use")} <harness> [m]  configure + launch a harness
  ${c.accent("arcflare serve")} [--port N]   start the server only
  ${c.accent("arcflare ps")}                 server status and loaded models
  ${c.accent("arcflare stop")}               stop the server
  ${c.accent("arcflare logs")} [-n N]        tail the server log
  ${c.accent("arcflare backend")} [kind]     list or select a llama.cpp backend
  ${c.accent("arcflare memory")} [profile]    lean | balanced | max
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
      const { port, servedId: id } = await prepareModel(cfg, m, best.ctx, best.cacheType);
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
      const { port, servedId: id } = await prepareModel(cfg, m, best.ctx, best.cacheType);
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
        console.log(`  ${c.green("✓")} backend set to ${c.accent(pick.id)} ${c.dim(pick.server)}`);
        return;
      }

      const active = backend.choose(surveyed, cfg.backend);
      for (const b of surveyed) {
        const mark = b.ok ? c.green("✓") : c.red("✗");
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

    case "memory": {
      const want = argv[1];
      if (want) {
        if (!MEMORY_PROFILES[want]) {
          die(`unknown profile "${want}". Try: ${Object.keys(MEMORY_PROFILES).join(", ")}`);
        }
        saveConfig({ ...cfg, memoryProfile: want });
        console.log(`  ${c.green("✓")} memory profile set to ${c.accent(want)} ` +
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
      const all = models.discover({ meta: true });
      const wanted = argv.slice(1).find((a) => !a.startsWith("-"));
      const m = models.resolve(all, wanted || cfg.lastModel) || all[0];
      if (!m) die("no models found");
      const budget = freeDeviceBytes(cfg);
      const { best } = contextChoices(m, budget);
      const prep = await prepareModel(cfg, m, best.ctx, best.cacheType);
      if (prep.failed) die("could not load the model");
      saveConfig({ ...cfg, lastModel: m.id });
      const pIdx = argv.indexOf("-p");
      const prompt = pIdx > 0 ? argv.slice(pIdx + 1).join(" ") : null;
      await require("../lib/agent/run").start({
        port: prep.port,
        model: prep.servedId,
        nCtx: prep.ctx,
        cwd: process.cwd(),
        prompt,
        approve: argv.includes("--yolo") ? "yolo" : "ask",
      });
      return;
    }

    case "logs": {
      const i = argv.indexOf("-n");
      console.log(engine.tailLog(i >= 0 ? Number(argv[i + 1]) : 40));
      return;
    }

    case "doctor": {
      const backend = require("../lib/backend");
      const surveyed = backend.survey(path.join(HOME, "backends.json"));
      const active = backend.choose(surveyed, cfg.backend);
      const exe = engine.findServer(cfg.llamaServer, cfg.backend);
      console.log(`  ${exe ? c.green("✓") : c.red("✗")} llama-server  ${c.dim(exe || "not found")}`);
      for (const b of surveyed) {
        const mark = b.ok ? c.green("✓") : c.dim("·");
        const tag = active && b.id === active.id ? c.accent(" (active)") : "";
        console.log(`  ${mark} backend       ${c.dim(b.kind.padEnd(8))}` +
          `${b.ok ? c.dim(b.devices.map((d) => d.name).join(", ")) : c.dim(b.note || "no devices")}${tag}`);
      }
      console.log(`  ${c.green("✓")} memory        ${c.dim((cfg.memoryProfile || DEFAULT_PROFILE) + " profile")}`);
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
