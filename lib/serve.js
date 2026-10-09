// Loading a model to chat with: settings, memory, context, the server, warmup.
//
// This used to live in bin/arcflare.js, wrapped around spinners and
// process.exit. It is here so anything can drive it — the CLI wraps it in
// spinners, the desktop app in progress bars — and so there is one copy of the
// logic that decides how much context a model gets. Nothing in this file
// prints or exits: progress goes to `onProgress`, failures are thrown or
// returned.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const gguf = require("./gguf");
const models = require("./models");
const engine = require("./engine");

const HOME = models.HOME;
const CONFIG = path.join(HOME, "config.json");
const PRESET = path.join(HOME, "models.ini");
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

// Physical batch size (llama.cpp -ub). See writePresetFor for the measurements.
// MIN_UBATCH is llama.cpp's own default, and the value we fall back to when a
// model would otherwise not fit — batch is cheap to give up, context is not.
const DEFAULT_UBATCH = 2048;
const MIN_UBATCH = 512;
const UBATCH_SIZES = [512, 1024, 2048, 4096];

const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- settings --

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}

function ubatchFor(cfg) {
  const n = Number(cfg && cfg.ubatch);
  return Number.isFinite(n) && n >= 64 ? Math.floor(n) : DEFAULT_UBATCH;
}

// ------------------------------------------------------------------- vram --

/**
 * Device memory we can actually plan against.
 *
 * llama.cpp's own "N MiB free" is a static heap budget and does not fall when
 * another process loads a model, so we cross-check it against what the OS says
 * is in use. Getting this wrong is the difference between "max context" working
 * and a bare ErrorOutOfDeviceMemory at first request.
 */
function deviceMemory(cfg = {}) {
  const backend = require("./backend");
  const surveyed = backend.survey(path.join(HOME, "backends.json"));
  const active = backend.choose(surveyed, cfg.backend);
  const mem = backend.deviceMemory(active);
  if (mem.freeBytes == null) return { freeBytes: os.freemem(), totalBytes: null, usedBytes: null };
  return mem;
}

function freeDeviceBytes(cfg = {}) {
  return deviceMemory(cfg).freeBytes;
}

/**
 * Free memory to plan a *new* model load against.
 *
 * Our own server may already hold the model we are about to reload, and
 * counting that as unavailable makes ArcFlare pick a tiny context for a model
 * that would comfortably fit. Every caller of this restarts the server anyway,
 * so stop it first and measure the real floor. (The stop is the side effect:
 * callers should know they are about to reload.)
 */
async function planningBudget(cfg = {}) {
  const st = await engine.status(cfg.port || DEFAULT_PORT);
  if (st.running) {
    engine.stop();
    await sleep(1200);
  }
  const backend = require("./backend");
  return backend.deviceMemory(
    backend.choose(backend.survey(path.join(HOME, "backends.json")), cfg.backend),
    { fresh: true },
  ).freeBytes || os.freemem();
}

// ---------------------------------------------------------------- context --

/**
 * The context sizes worth offering for a model, largest first, each marked
 * fits / does not fit against `budget` bytes. `best` is the first that fits.
 * `fmt` formats labels (the CLI passes its own; the default is plain text).
 */
function contextChoices(m, budget, fmt = {}) {
  const tokens = fmt.tokens || ((n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)));
  const bytes = fmt.bytes || ((n) => `${(n / 1e9).toFixed(1)} GB`);
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
      label: `${tokens(ctx)} tokens`,
      hint: cacheType === "q8_0" ? "q8_0 cache" : "f16 cache",
      note: need ? `~${bytes(need)} KV${fits ? "" : "  (too big)"}` : "",
      value: { ctx, cacheType },
      kvBytes: need,
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

// ----------------------------------------------------------------- server --

/**
 * Make sure llama-server is up. Throws if there is no engine or it never
 * becomes ready (with the log tail on the error as `.log`).
 * onProgress: { stage: "server-starting", ms }
 */
async function ensureServer(cfg = {}, opts = {}) {
  const onProgress = opts.onProgress || noop;
  const port = opts.port || cfg.port || DEFAULT_PORT;
  const exe = engine.findServer(cfg.llamaServer, cfg.backend);
  if (!exe) {
    const e = new Error("llama.cpp isn't installed. Run `arcflare engine install` to download it for this machine, " +
      "or `arcflare set-engine <path>` if you already have llama-server");
    e.code = "NO_ENGINE";
    throw e;
  }

  const st = await engine.status(port);
  if (st.running && !opts.restart) return { port, exe, already: true };
  if (st.running && opts.restart) { engine.stop(); await sleep(800); }

  // Point the router at wherever the models actually are.
  const cacheRoot = process.env.LLAMA_CACHE || cfg.modelsRoot || models.roots()[0];
  const env = {};
  if (cacheRoot) env.LLAMA_CACHE = cacheRoot;

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

  onProgress({ stage: "server-starting", ms: 0 });
  const ok = await engine.waitReady(port, opts.timeout || 600000, (ms) => {
    onProgress({ stage: "server-starting", ms });
  });
  if (!ok) {
    const e = new Error("llama-server did not come up");
    e.code = "SERVER_DOWN";
    e.log = engine.tailLog(25);
    throw e;
  }
  onProgress({ stage: "server-ready", port });
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

// ----------------------------------------------------------------- preset --

/**
 * The router keys a preset section by name, and asking it for a model it has
 * no section for creates a phantom entry that sits in "loading" forever.
 * Naming the section ourselves also gives stable, Ollama-shaped ids.
 */
function presetIdFor(model) {
  return model.id;
}

function writePresetFor(model, ctx, cacheType, ubatch = DEFAULT_UBATCH) {
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
    // Physical batch, measured at the full 262144 context people actually run.
    // Short prompts gain a lot and long ones lose, and how much they lose is
    // model-dependent: on a 35B-A3B at Q5, 2048 buys +39% at 1.4k tokens and
    // costs 10.7% at 8k; on the same architecture at Q6, +47% and -25%. Agent
    // turns skew short - a cached session re-prefills only what changed - so
    // the default takes the gain, and `arcflare batch 512` reverses it for
    // long-prompt work. It also costs VRAM, which is why prepareModel gives
    // this up before it gives up context.
    ub: ubatch,
    b: Math.max(2048, ubatch),
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

/**
 * Bring the server up with this model's preset and load it, stepping down if
 * the device cannot take what was asked.
 *
 * Reported free memory is a budget, not a promise — and a model is only truly
 * loadable once it has loaded — so this verifies rather than predicts. A large
 * physical batch also costs VRAM and is worth far less than context, so the
 * first retry shrinks the batch and keeps the context; only then is the
 * context halved.
 *
 * onProgress: {stage:"loading", ctx, attempt} · {stage:"retry", reason:"batch"|"context", ctx}
 *             {stage:"loaded", ctx, reducedFrom} · {stage:"failed", error, log}
 * Returns { port, servedId, ctx, failed?, error?, log? }.
 */
async function prepareModel(cfg, model, ctx, cacheType, opts = {}) {
  const onProgress = opts.onProgress || noop;
  let servedId = presetIdFor(model);
  let tryCtx = ctx;
  let tryUb = ubatchFor(cfg);
  let port = cfg.port || DEFAULT_PORT;
  const floor = 8192;
  for (let attempt = 0; attempt < 7; attempt++) {
    writePresetFor(model, tryCtx, cacheType, tryUb);
    ({ port } = await ensureServer(cfg, { restart: true, onProgress }));
    // Ask the router what it decided to call this file.
    servedId = (await engine.servedIdForFile(port, model.file)) || servedId;
    onProgress({ stage: "loading", ctx: tryCtx, attempt, model: model.id });
    const r = await warmup(port, servedId);
    if (r.ok) {
      onProgress({ stage: "loaded", ctx: tryCtx, reducedFrom: tryCtx < ctx ? ctx : null });
      return { port, servedId, ctx: tryCtx };
    }
    const oom = /out of device memory|outofdevice|failed to load|alloc/i.test(r.error || "");
    if (!oom || tryCtx <= floor) {
      const log = engine.tailLog(12);
      onProgress({ stage: "failed", error: r.error || "model failed to load", log });
      return { port, servedId, ctx: tryCtx, failed: true, error: r.error || "model failed to load", log };
    }
    if (tryUb > MIN_UBATCH) {
      tryUb = MIN_UBATCH;
      onProgress({ stage: "retry", reason: "batch", ctx: tryCtx });
      continue;
    }
    tryCtx = Math.max(floor, Math.floor(tryCtx / 2 / 1024) * 1024);
    onProgress({ stage: "retry", reason: "context", ctx: tryCtx });
  }
  return { port, servedId, ctx: tryCtx, failed: true, error: "could not fit the model" };
}

/**
 * One call for a GUI: plan the context for a model and load it.
 * `ctx` overrides the planned size; otherwise the largest that fits is used.
 */
async function loadModel(cfg, model, opts = {}) {
  if (!model.meta) models.loadMeta(model);
  const budget = await planningBudget(cfg);
  const plan = contextChoices(model, budget);
  const want = opts.ctx ? { ctx: opts.ctx, cacheType: opts.cacheType || "f16" } : plan.best;
  const r = await prepareModel(cfg, model, want.ctx, want.cacheType, opts);
  return { ...r, planned: want, budget, choices: plan.items };
}

module.exports = {
  HOME, CONFIG, PRESET, DEFAULT_PORT, MEMORY_PROFILES, DEFAULT_PROFILE,
  DEFAULT_UBATCH, MIN_UBATCH, UBATCH_SIZES,
  loadConfig, saveConfig, ubatchFor,
  deviceMemory, freeDeviceBytes, planningBudget,
  contextChoices, ensureServer, servedIdFor, presetIdFor, writePresetFor, warmup,
  prepareModel, loadModel,
};
