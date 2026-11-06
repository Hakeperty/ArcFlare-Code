// LM Studio as an engine, against a fake LM Studio: an HTTP server that speaks
// the parts of its API ArcFlare uses, and a recorded `lms` that behaves the way
// the real one was measured to (LM Studio 0.4.28): `ls --json` maps paths to
// keys, `load` takes a key and nothing else, `runtime ls` ticks the selected
// runtime. The real thing is not needed to check what ArcFlare asks it to do.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const lmstudio = require("../lib/lmstudio");
const serve = require("../lib/serve");

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arcflare-" + name + "-"));
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
}

/** Every .gguf under `dir`, as `lms ls --json` lists them (keys as LM Studio derives them). */
function lsJson(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.gguf$/i.test(e.name) && !/^mmproj/i.test(e.name)) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        out.push({ type: "llm", modelKey: path.basename(path.dirname(full)).toLowerCase(), path: rel,
          indexedModelIdentifier: rel });
      }
    }
  };
  walk(dir);
  return out;
}

/** A fake LM Studio over `dir`. `maxCtx` is the most context that "fits". */
function fakeLmStudio({ dir, maxCtx = Infinity } = {}) {
  const state = { loaded: [], calls: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/models") return send(200, { object: "list", data: state.loaded.map((l) => ({ id: l.id })) });
      if (req.url === "/api/v1/models") {
        return send(200, { models: [{ key: "some-model", display_name: "Some", max_context_length: 32768,
          loaded_instances: state.loaded.map((l) => ({ id: l.id, config: { context_length: l.ctx } })) }] });
      }
      if (req.url === "/v1/chat/completions") {
        const j = JSON.parse(body);
        if (state.loaded.some((l) => l.id === j.model)) return send(200, { choices: [{ message: { content: "h" } }] });
        return send(404, { error: { message: `model ${j.model} not found` } });
      }
      send(404, {});
    });
  });
  const run = (exe, args) => {
    state.calls.push(args);
    if (args[0] === "unload") { state.loaded = []; return { ok: true, out: "" }; }
    if (args[0] === "ls") return { ok: true, out: JSON.stringify(dir ? lsJson(dir) : []) };
    if (args[0] === "load") {
      const known = dir ? lsJson(dir).map((m) => m.modelKey) : [];
      if (!known.includes(args[1])) return { ok: false, out: `Model not found\nNo model found that matches model key "${args[1]}".` };
      const ctx = Number(args[args.indexOf("--context-length") + 1]);
      if (ctx > maxCtx) {
        return { ok: false, out: "\x1b[?25lLoading m 0% ⠋\x1b[?25lLoading m 40% ⠙\nError: failed to allocate memory for the model" };
      }
      state.loaded.push({ id: args[args.indexOf("--identifier") + 1], ctx });
      return { ok: true, out: "Model loaded successfully in 2.00s." };
    }
    if (args[0] === "runtime") {
      return { ok: true, out: [
        "LLM ENGINE                                      SELECTED    MODEL FORMAT",
        "llama.cpp-win-x86_64-avx2@2.67.0                                GGUF",
        "llama.cpp-win-x86_64-vulkan-avx2@2.67.0            ✓            GGUF",
      ].join("\n") };
    }
    return { ok: false, out: "unknown" };
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, port: server.address().port, state, run })));
}

const quick = { findLms: () => "lms", waitMs: 0, pollMs: 10 };

test("lmstudio: a model inside LM Studio's folder loads by its key, under ArcFlare's id", async () => {
  const dir = tmpdir("lms-models");
  const file = touch(path.join(dir, "lmstudio-community", "Qwen-GGUF", "Qwen-Q4_K_M.gguf"));
  const fake = await fakeLmStudio({ dir });
  const steps = [];
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "qwen:q4_k_m", file }, 32768, {
      ...quick, run: fake.run, dirs: [dir], onProgress: (p) => steps.push(p.stage),
    });
    assert.deepStrictEqual(r, { port: fake.port, servedId: "qwen:q4_k_m", ctx: 32768 });
    const load = fake.state.calls.find((a) => a[0] === "load");
    assert.deepStrictEqual(load, ["load", "qwen-gguf", "--identifier", "qwen:q4_k_m",
      "--context-length", "32768", "--gpu", "max", "--yes"]);
    // Nothing to link: it is already there.
    assert.deepStrictEqual(fs.readdirSync(dir), ["lmstudio-community"]);
    // Whatever was loaded before goes first: one resident model.
    const verbs = fake.state.calls.map((a) => a[0]);
    assert.ok(verbs.indexOf("unload") >= 0 && verbs.indexOf("unload") < verbs.indexOf("load"), verbs.join(" "));
    assert.deepStrictEqual(steps, ["loading", "loaded"]);
    assert.deepStrictEqual(await lmstudio.listLoaded(fake.port), ["qwen:q4_k_m"]);
  } finally { fake.server.close(); }
});

test("lmstudio: a model from elsewhere is hard-linked in, every shard and its projector, never moved", async () => {
  const lmsDir = tmpdir("lms-home");
  const other = tmpdir("hf-cache");
  const file = touch(path.join(other, "Big-Q5_K_M-00001-of-00002.gguf"));
  touch(path.join(other, "Big-Q5_K_M-00002-of-00002.gguf"));
  const mmproj = touch(path.join(other, "mmproj-F16.gguf"));
  const fake = await fakeLmStudio({ dir: lmsDir });
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "big:q5_k_m", file, mmproj }, 16384,
      { ...quick, run: fake.run, dirs: [lmsDir] });
    assert.ok(!r.failed, r.error);
    const placed = path.join(lmsDir, "arcflare", "big-q5_k_m");
    assert.deepStrictEqual(fs.readdirSync(placed).sort(),
      ["Big-Q5_K_M-00001-of-00002.gguf", "Big-Q5_K_M-00002-of-00002.gguf", "mmproj-F16.gguf"]);
    // The originals are where they were, and the copies are the same files.
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.statSync(path.join(placed, path.basename(file))).ino, fs.statSync(file).ino);
    assert.strictEqual(fake.state.calls.find((a) => a[0] === "load")[1], "big-q5_k_m");

    // A second load finds the links already in place.
    const again = await lmstudio.placeModel({ id: "big:q5_k_m", file, mmproj }, { dirs: [lmsDir] });
    assert.strictEqual(again.imported, false);
  } finally { fake.server.close(); }
});

test("lmstudio: a link that cannot be made fails, rather than copy or move", async () => {
  const lmsDir = tmpdir("lms-home2");
  const file = touch(path.join(tmpdir("elsewhere"), "M-Q8_0.gguf"));
  const fake = await fakeLmStudio({ dir: lmsDir });
  const link = () => { const e = new Error("could not link M-Q8_0.gguf into LM Studio's folder without copying it"); e.code = "LINK_FAILED"; throw e; };
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "m:q8_0", file }, 8192,
      { ...quick, run: fake.run, dirs: [lmsDir], link });
    assert.strictEqual(r.failed, true);
    assert.match(r.error, /without copying/);
    assert.ok(!fake.state.calls.some((a) => a[0] === "load"));
    assert.ok(fs.existsSync(file));
  } finally { fake.server.close(); }
});

test("lmstudio: linkFile resolves symlinks first, so the link points at the real file", () => {
  const d = tmpdir("link");
  const real = touch(path.join(d, "blobs", "abc123"));
  const snap = path.join(d, "snapshots", "M-Q4_K_M.gguf");
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  try { fs.symlinkSync(path.relative(path.dirname(snap), real), snap, "file"); } catch { return; } // no symlink rights here
  const dest = path.join(d, "lms", "arcflare", "m", "M-Q4_K_M.gguf");
  const how = lmstudio.linkFile(snap, dest);
  assert.ok(how === "hard" || how === "symbolic");
  assert.strictEqual(fs.readFileSync(dest, "utf8"), "x");
  if (how === "hard") assert.strictEqual(fs.statSync(dest).ino, fs.statSync(real).ino);
});

test("lmstudio: a model LM Studio has not indexed is a clear failure", async () => {
  const lmsDir = tmpdir("lms-unindexed");
  const file = touch(path.join(lmsDir, "a", "b", "M-Q4_K_M.gguf"));
  const fake = await fakeLmStudio({ dir: null }); // lists nothing
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "m:q4_k_m", file }, 8192,
      { ...quick, run: fake.run, dirs: [lmsDir] });
    assert.strictEqual(r.failed, true);
    assert.match(r.error, /does not list a\/b\/M-Q4_K_M\.gguf/);
  } finally { fake.server.close(); }
});

test("lmstudio: a context that does not fit is halved until it does, and the error is readable", async () => {
  const dir = tmpdir("lms-fit");
  const file = touch(path.join(dir, "a", "b", "M-Q4_K_M.gguf"));
  const fake = await fakeLmStudio({ dir, maxCtx: 40000 });
  const retries = [];
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "m:q4_k_m", file }, 131072, {
      ...quick, run: fake.run, dirs: [dir], onProgress: (p) => p.stage === "retry" && retries.push(p.ctx),
    });
    assert.strictEqual(r.ctx, 32768);
    assert.deepStrictEqual(retries, [65536, 32768]);
  } finally { fake.server.close(); }

  const fake2 = await fakeLmStudio({ dir, maxCtx: 1 });
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake2.port }, { id: "m:q4_k_m", file }, 8192,
      { ...quick, run: fake2.run, dirs: [dir] });
    assert.strictEqual(r.failed, true);
    assert.strictEqual(r.error, "Error: failed to allocate memory for the model");
    assert.ok(!/\x1b|Loading m/.test(r.log), r.log);
  } finally { fake2.server.close(); }
});

test("lmstudio: no lms and no server is a clear error, not a hang", async () => {
  const fake = await fakeLmStudio();
  const port = fake.port;
  await new Promise((r) => fake.server.close(r)); // a port nothing answers on
  await assert.rejects(
    lmstudio.ensureServer({ lmstudioPort: port }, { findLms: () => null }),
    (e) => e.code === "NO_LMSTUDIO" && /lmstudio\.ai/.test(e.message));
});

test("lmstudio: the server is started on the configured port when it is down", async () => {
  const fake = await fakeLmStudio();
  const port = fake.port;
  await new Promise((r) => fake.server.close(r));
  let started = null;
  const run = (exe, args) => {
    started = args;
    fake.server.listen(port, "127.0.0.1");
    return { ok: true, out: "" };
  };
  try {
    const r = await lmstudio.ensureServer({ lmstudioPort: port }, { findLms: () => "lms", run, pollMs: 20 });
    assert.deepStrictEqual(started, ["server", "start", "--port", String(port)]);
    assert.strictEqual(r.port, port);
  } finally { fake.server.close(); }
});

test("lmstudio: serve dispatches on the engine setting", async () => {
  assert.strictEqual(serve.engineKind({}), "llamacpp");
  assert.strictEqual(serve.engineKind({ engine: "lmstudio" }), "lmstudio");
  assert.strictEqual(serve.portFor({}), serve.DEFAULT_PORT);
  assert.strictEqual(serve.portFor({ engine: "lmstudio" }), 1234);
  assert.strictEqual(serve.portFor({ engine: "lmstudio", lmstudioPort: 4321 }), 4321);
  // The llama.cpp port does not leak into LM Studio's.
  assert.strictEqual(serve.portFor({ engine: "lmstudio", port: 11434 }), 1234);

  const dir = tmpdir("lms-serve");
  const file = touch(path.join(dir, "p", "r", "S-Q4_K_M.gguf"));
  const fake = await fakeLmStudio({ dir });
  try {
    const r = await serve.prepareModel({ engine: "lmstudio", lmstudioPort: fake.port },
      { id: "s:q4_k_m", file }, 8192, "f16", { ...quick, run: fake.run, dirs: [dir] });
    assert.strictEqual(r.servedId, "s:q4_k_m");
    assert.strictEqual(r.port, fake.port);
  } finally { fake.server.close(); }
});

test("lmstudio: paths, names, runtime, output", async () => {
  assert.strictEqual(lmstudio.relativeTo(path.resolve("/m"), path.resolve("/m/a/b/c.gguf")), "a/b/c.gguf");
  assert.strictEqual(lmstudio.relativeTo(path.resolve("/m"), path.resolve("/other/c.gguf")), null);
  assert.strictEqual(lmstudio.repoNameFor({ id: "qwen3.6-35b-a3b:ud-q5_k_xl" }), "qwen3.6-35b-a3b-ud-q5_k_xl");
  const fake = await fakeLmStudio();
  fake.server.close();
  assert.strictEqual(lmstudio.runtime({}, { findLms: () => "lms", run: fake.run }),
    "llama.cpp-win-x86_64-vulkan-avx2@2.67.0");
  assert.strictEqual(lmstudio.runtime({}, { findLms: () => null }), null);
  assert.strictEqual(lmstudio.cleanOutput("\x1b[?25lLoading glm 0% ⠋\x1b[?25lLoading glm 79% ⠋\x1b[K\x1b[?25hModel loaded successfully in 23.39s.\n(17.05 GiB)"),
    "Model loaded successfully in 23.39s.\n(17.05 GiB)");
});
