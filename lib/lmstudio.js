// LM Studio as an engine: ArcFlare picks the model and the context, LM Studio
// runs it.
//
// The default engine is a llama-server ArcFlare starts itself. Some machines
// are better served by LM Studio. It ships its own llama.cpp runtimes (Vulkan,
// ROCm, CUDA, CPU), keeps them updated, and on an AMD APU such as Strix Halo
// its Vulkan runtime is the easiest way to get every compute unit working.
// Everything downstream of the engine (the harnesses, the agent, `fit`) only
// needs an OpenAI-compatible port, so switching engines changes how a model
// gets loaded and nothing after that.
//
// LM Studio is driven through its `lms` CLI rather than the REST load
// endpoint, because only the CLI takes `--identifier`. Loading a model under
// ArcFlare's own id means the served name is the one ArcFlare already shows,
// with nothing to work out afterwards.
//
// ArcFlare's models usually live in the llama.cpp/Hugging Face cache, outside
// LM Studio's models folder. LM Studio only loads what is in its folder, so a
// model from elsewhere is linked in first: a hard link (no copy, no extra
// disk), or a symbolic link across drives. ArcFlare makes the link itself
// rather than calling `lms import`, which moves files by default (quietly
// taking the model away from llama.cpp) and, given a Hugging Face snapshot,
// would name the file after its blob hash.
//
// `lms load` takes LM Studio's model key, not a path. `lms ls --json` maps
// each file's path to its key, so that is where the key comes from.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const DEFAULT_PORT = 1234; // LM Studio's own default, so its other clients keep working
const EXE = process.platform === "win32" ? ".exe" : "";
const IMPORT_REPO = "arcflare";

const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ finding --

/** Where LM Studio keeps models by default, newest layout first. */
function modelDirs(extra = []) {
  const home = os.homedir();
  const out = [];
  const add = (p) => {
    if (!p) return;
    const r = path.resolve(p);
    if (!out.includes(r) && fs.existsSync(r)) out.push(r);
  };
  extra.forEach(add);
  add(process.env.LMSTUDIO_MODELS);
  // LM Studio records a custom folder (set under My Models) in its settings.
  for (const f of [path.join(home, ".lmstudio", "settings.json"),
    path.join(home, ".cache", "lm-studio", "settings.json")]) {
    try {
      const s = JSON.parse(fs.readFileSync(f, "utf8"));
      add(s.downloadsFolder || s.modelsFolder);
    } catch { /* no settings, or not ours to understand */ }
  }
  add(path.join(home, ".lmstudio", "models"));
  add(path.join(home, ".cache", "lm-studio", "models"));
  return out;
}

/** The `lms` CLI: an explicit setting, then PATH, then where LM Studio installs it. */
function findLms(configured) {
  const cands = [];
  if (configured) cands.push(configured);
  if (process.env.ARCFLARE_LMS) cands.push(process.env.ARCFLARE_LMS);
  for (const c of cands) {
    const p = path.resolve(c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    const q = path.join(p, "lms" + EXE);
    if (fs.existsSync(q)) return q;
  }
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["lms"], { encoding: "utf8" });
  if (r.status === 0) {
    const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (first && fs.existsSync(first.trim())) return first.trim();
  }
  // ~/.lmstudio/bin appears once the app has been opened. The copy inside the
  // app works from then on too.
  const home = os.homedir();
  const inApp = (base) => (base ? path.join(base, "LM Studio", "resources", "app", ".webpack") : null);
  const dirs = [path.join(home, ".lmstudio", "bin"), path.join(home, ".cache", "lm-studio", "bin")];
  if (process.platform === "win32") {
    dirs.push(inApp(path.join(process.env.LOCALAPPDATA || "", "Programs")), inApp(process.env.ProgramFiles));
  }
  for (const d of dirs.filter(Boolean)) {
    const q = path.join(d, "lms" + EXE);
    if (fs.existsSync(q)) return q;
  }
  return null;
}

/** Run `lms` and capture it. Never throws; tests swap this out. */
function runLms(exe, args, opts = {}) {
  const r = spawnSync(exe, args, {
    encoding: "utf8",
    timeout: opts.timeout || 120000,
    windowsHide: true,
    input: "",
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: ((r.stdout || "") + (r.stderr || "")).trim(),
    error: r.error ? r.error.message : null,
  };
}

// --------------------------------------------------------------------- http --

function request(port, method, route, body, timeout = 4000) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path: route, method, timeout, agent: false,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, json, text: out });
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(data || undefined);
  });
}

/** Is LM Studio's server answering on this port? */
async function health(port = DEFAULT_PORT) {
  const r = await request(port, "GET", "/v1/models", null, 1500);
  return Boolean(r && r.status < 400 && r.json && Array.isArray(r.json.data));
}

/**
 * Everything LM Studio knows about, with what is loaded.
 * The v1 REST list carries loaded instances; older builds only have v0.
 */
async function listModels(port = DEFAULT_PORT) {
  const v1 = await request(port, "GET", "/api/v1/models");
  if (v1 && v1.status < 400 && v1.json && Array.isArray(v1.json.models)) {
    return v1.json.models.map((m) => ({
      key: m.key,
      name: m.display_name || m.key,
      maxCtx: m.max_context_length || null,
      loaded: (m.loaded_instances || []).map((i) => ({
        id: i.id, ctx: (i.config && i.config.context_length) || null,
      })),
    }));
  }
  const v0 = await request(port, "GET", "/api/v0/models");
  if (v0 && v0.status < 400 && v0.json && Array.isArray(v0.json.data)) {
    return v0.json.data.map((m) => ({
      key: m.id,
      name: m.id,
      maxCtx: m.max_context_length || null,
      loaded: m.state === "loaded" ? [{ id: m.id, ctx: m.loaded_context_length || null }] : [],
    }));
  }
  return [];
}

/** The ids LM Studio is serving right now. */
async function listLoaded(port = DEFAULT_PORT) {
  const all = await listModels(port);
  return all.flatMap((m) => m.loaded.map((l) => l.id));
}

// ------------------------------------------------------------------- server --

/**
 * Make sure LM Studio's server is up. Starts it with `lms server start` if not.
 * Throws NO_LMSTUDIO when there is no `lms`, SERVER_DOWN when it never answers.
 */
async function ensureServer(cfg = {}, opts = {}) {
  const onProgress = opts.onProgress || noop;
  const port = opts.port || cfg.lmstudioPort || DEFAULT_PORT;
  if (await health(port)) return { port, already: true };

  const lms = (opts.findLms || findLms)(cfg.lmsPath);
  if (!lms) {
    const e = new Error("LM Studio isn't installed, or its `lms` command can't be found. Install LM Studio " +
      "(https://lmstudio.ai), open it once so it sets up `lms`, or run `arcflare engine lmstudio --lms <path>`. " +
      "`arcflare engine llamacpp` switches back.");
    e.code = "NO_LMSTUDIO";
    throw e;
  }
  const run = opts.run || runLms;
  onProgress({ stage: "server-starting", ms: 0 });
  const r = run(lms, ["server", "start", "--port", String(port)], { timeout: 60000 });
  const t0 = Date.now();
  const timeout = opts.timeout || 60000;
  while (Date.now() - t0 < timeout) {
    if (await health(port)) {
      onProgress({ stage: "server-ready", port });
      return { port, lms };
    }
    onProgress({ stage: "server-starting", ms: Date.now() - t0 });
    await sleep(opts.pollMs || 500);
  }
  const e = new Error(`LM Studio's server did not come up on port ${port}`);
  e.code = "SERVER_DOWN";
  e.log = r.out || r.error || "";
  throw e;
}

// ------------------------------------------------------------------- models --

/** LM Studio's own spelling of a path: relative to its models folder, forward slashes. */
function relativeTo(dir, file) {
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** A folder name LM Studio will accept for an imported model. */
function repoNameFor(model) {
  return String(model.id).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "model";
}

/** Every file a model is made of: all shards, plus a vision projector next to it. */
function filesOf(model) {
  const files = [];
  const shard = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(model.file);
  if (shard) {
    const total = parseInt(shard[2], 10);
    for (let i = 1; i <= total; i++) {
      files.push(model.file.replace(/-\d{5}-of-\d{5}\.gguf$/i,
        `-${String(i).padStart(5, "0")}-of-${shard[2]}.gguf`));
    }
  } else {
    files.push(model.file);
  }
  if (model.mmproj && path.dirname(model.mmproj) === path.dirname(model.file)) files.push(model.mmproj);
  return files;
}

/**
 * LM Studio's path for a model (relative to its folder, as `lms ls` reports
 * it), linking the model in first if it lives somewhere else.
 * Returns { ref, imported }.
 */
function placeModel(model, opts = {}) {
  const dirs = opts.dirs || modelDirs();
  for (const d of dirs) {
    const rel = relativeTo(d, model.file);
    if (rel) return { ref: rel, imported: false };
  }
  const home = dirs[0] || path.join(os.homedir(), ".lmstudio", "models");
  const repo = repoNameFor(model);
  const ref = `${IMPORT_REPO}/${repo}/${path.basename(model.file)}`;
  if (fs.existsSync(path.join(home, IMPORT_REPO, repo, path.basename(model.file)))) {
    return { ref, imported: false };
  }
  for (const file of filesOf(model)) {
    const dest = path.join(home, IMPORT_REPO, repo, path.basename(file));
    if (!fs.existsSync(dest)) (opts.link || linkFile)(file, dest);
  }
  return { ref, imported: true };
}

/**
 * Link `src` to `dest` without copying: a hard link (no admin rights needed on
 * Windows, no second copy), or a symbolic link when the two are on different
 * drives. Resolves `src` first, because a hard link to a Hugging Face snapshot
 * symlink would be a link to a relative path that means nothing elsewhere.
 */
function linkFile(src, dest) {
  const real = fs.realpathSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(real, dest); return "hard"; } catch (e1) {
    try { fs.symlinkSync(real, dest, "file"); return "symbolic"; } catch (e2) {
      const e = new Error(`could not link ${path.basename(src)} into LM Studio's folder without copying it ` +
        `(hard link: ${e1.code || e1.message}; symbolic link: ${e2.code || e2.message}). Keep the model on ` +
        "the same drive as LM Studio's models folder, turn on Windows Developer Mode for symbolic links, " +
        "or download the model from inside LM Studio.");
      e.code = "LINK_FAILED";
      throw e;
    }
  }
}

/**
 * LM Studio's key for the file at `ref`, from `lms ls --json`. `lms load` takes
 * only keys, and the key is LM Studio's to choose: usually the model's name, or
 * the folder's when two files would share one. A file just linked in can take
 * a moment to be indexed, so this asks again for a little while.
 */
async function keyFor(lms, ref, opts = {}) {
  const run = opts.run || runLms;
  const want = ref.toLowerCase();
  const deadline = Date.now() + (opts.waitMs ?? 20000);
  for (;;) {
    const r = run(lms, ["ls", "--json"], { timeout: 30000 });
    let list = [];
    try { list = JSON.parse((r.out || "").slice((r.out || "").indexOf("["))); } catch {}
    const hit = Array.isArray(list) && list.find((m) =>
      String(m.path || m.indexedModelIdentifier || "").split("\\").join("/").toLowerCase() === want);
    if (hit && hit.modelKey) return hit.modelKey;
    if (Date.now() >= deadline) return null;
    await sleep(opts.pollMs || 1000);
  }
}

function chatOnce(port, modelId, timeoutMs = 900000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
    const req = http.request({
      // A fresh connection: `lms load` blocks for seconds, long enough for LM
      // Studio to close a kept-alive socket that Node would then reuse (ECONNRESET).
      host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", timeout: timeoutMs, agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => {
        if (res.statusCode < 400) return resolve({ ok: true });
        let msg = out.slice(0, 300);
        try { msg = JSON.parse(out).error.message || JSON.parse(out).error; } catch {}
        resolve({ ok: false, error: String(msg) });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "load timed out" }); });
    req.end(body);
  });
}

/**
 * Load `model` in LM Studio at `ctx` tokens, halving the context if it will not
 * fit. Same contract as serve.prepareModel, so every caller works unchanged:
 * returns { port, servedId, ctx, failed?, error?, log? }.
 *
 * GPU offload is `max`: LM Studio's own default keeps layers on the CPU when it
 * is unsure, and a Strix Halo-class APU has the memory to hold all of them.
 * Which runtime runs them (Vulkan, ROCm, CUDA) is LM Studio's choice, made
 * with `arcflare engine runtime` or in its app.
 */
async function prepareModel(cfg, model, ctx, opts = {}) {
  const onProgress = opts.onProgress || noop;
  const run = opts.run || runLms;
  const { port, lms: found } = await ensureServer(cfg, opts);
  const lms = found || (opts.findLms || findLms)(cfg.lmsPath);
  const servedId = model.id;
  const fail = (error, log = "") => {
    onProgress({ stage: "failed", error, log });
    return { port, servedId, ctx, failed: true, error, log };
  };
  if (!lms) return fail("LM Studio's `lms` command was not found");

  let key;
  try {
    const { ref } = placeModel(model, { dirs: opts.dirs, link: opts.link });
    key = await keyFor(lms, ref, { run, waitMs: opts.waitMs, pollMs: opts.pollMs });
    if (!key) return fail(`LM Studio does not list ${ref} (lms ls --json); is its models folder somewhere else?`);
  } catch (e) {
    return fail(e.message);
  }

  // One model at a time, like ArcFlare's own server: a second resident model
  // is memory the one in use cannot have.
  run(lms, ["unload", "--all"], { timeout: 60000 });

  const floor = 8192;
  let tryCtx = ctx;
  for (let attempt = 0; attempt < 6; attempt++) {
    onProgress({ stage: "loading", ctx: tryCtx, attempt, model: model.id });
    const r = run(lms, ["load", key, "--identifier", servedId, "--context-length", String(tryCtx),
      "--gpu", "max", "--yes"], { timeout: 900000 });
    const ready = r.ok ? await chatOnce(port, servedId) : { ok: false, error: r.out || r.error || "load failed" };
    if (ready.ok) {
      onProgress({ stage: "loaded", ctx: tryCtx, reducedFrom: tryCtx < ctx ? ctx : null });
      return { port, servedId, ctx: tryCtx };
    }
    const tail = cleanOutput(ready.error).split("\n").slice(-12).join("\n");
    const oom = /memory|alloc|too large|insufficient|resources/i.test(ready.error || "");
    if (!oom || tryCtx <= floor) return { ...fail(tail.split("\n").pop() || "model failed to load", tail), ctx: tryCtx };
    run(lms, ["unload", "--all"], { timeout: 60000 });
    tryCtx = Math.max(floor, Math.floor(tryCtx / 2 / 1024) * 1024);
    onProgress({ stage: "retry", reason: "context", ctx: tryCtx });
  }
  return fail("could not fit the model");
}

/** Unload everything. LM Studio's server is left running: it is not ours to stop. */
function stop(cfg = {}, opts = {}) {
  const lms = (opts.findLms || findLms)(cfg.lmsPath);
  if (!lms) return false;
  return (opts.run || runLms)(lms, ["unload", "--all"], { timeout: 60000 }).ok;
}

/** `lms` output without its progress bar: escape codes and "Loading x 42%" frames. */
function cleanOutput(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/Loading \S+ \d+% \S?/g, "\n")
    .split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).join("\n");
}

/** The selected llama.cpp runtime: the ticked row of `lms runtime ls`, or null. */
function runtime(cfg = {}, opts = {}) {
  const lms = (opts.findLms || findLms)(cfg.lmsPath);
  if (!lms) return null;
  const r = (opts.run || runLms)(lms, ["runtime", "ls"], { timeout: 20000 });
  if (!r.ok || !r.out) return null;
  const row = r.out.split(/\r?\n/).find((l) => /[✓✔]/.test(l) && /llama\.cpp/i.test(l));
  return row ? row.trim().split(/\s+/)[0] : null;
}

module.exports = {
  DEFAULT_PORT, IMPORT_REPO,
  modelDirs, findLms, runLms, health, listModels, listLoaded, ensureServer,
  relativeTo, repoNameFor, filesOf, placeModel, linkFile, keyFor, cleanOutput, prepareModel, stop, runtime,
};
