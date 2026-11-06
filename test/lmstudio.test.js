// LM Studio as an engine, against a fake LM Studio: an HTTP server that speaks
// the parts of its API ArcFlare uses, and a recorded `lms` that loads models
// into it. The real thing is not needed to check what ArcFlare asks it to do.

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

/** A fake LM Studio server. `maxCtx` is the most context that "fits". */
function fakeLmStudio({ maxCtx = Infinity } = {}) {
  const state = { loaded: [], calls: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/models") return send(200, { object: "list", data: state.loaded.map((l) => ({ id: l.id })) });
      if (req.url === "/api/v1/models") {
        return send(200, { models: [{ key: "some/model", display_name: "Some", max_context_length: 32768,
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
  // The recorded `lms`. Only what ArcFlare runs is implemented.
  const run = (exe, args) => {
    state.calls.push(args);
    if (args[0] === "unload") { state.loaded = []; return { ok: true, out: "" }; }
    if (args[0] === "import") return { ok: true, out: "imported" };
    if (args[0] === "load") {
      const ctx = Number(args[args.indexOf("--context-length") + 1]);
      if (ctx > maxCtx) return { ok: false, out: "Error: failed to allocate memory for the model" };
      state.loaded.push({ id: args[args.indexOf("--identifier") + 1], ctx });
      return { ok: true, out: "loaded" };
    }
    if (args[0] === "runtime") return { ok: true, out: "llama.cpp-win-x86_64-vulkan-avx2@1.50.0" };
    return { ok: false, out: "unknown" };
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, port: server.address().port, state, run })));
}

test("lmstudio: a model inside LM Studio's folder loads by its relative path, under ArcFlare's id", async () => {
  const fake = await fakeLmStudio();
  const dir = tmpdir("lms-models");
  const file = path.join(dir, "lmstudio-community", "Qwen-GGUF", "Qwen-Q4_K_M.gguf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  const steps = [];
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "qwen:q4_k_m", file }, 32768, {
      run: fake.run, findLms: () => "lms", dirs: [dir], onProgress: (p) => steps.push(p.stage),
    });
    assert.deepStrictEqual(r, { port: fake.port, servedId: "qwen:q4_k_m", ctx: 32768 });
    const load = fake.state.calls.find((a) => a[0] === "load");
    assert.deepStrictEqual(load, ["load", "lmstudio-community/Qwen-GGUF/Qwen-Q4_K_M.gguf",
      "--identifier", "qwen:q4_k_m", "--context-length", "32768", "--gpu", "max"]);
    assert.ok(!fake.state.calls.some((a) => a[0] === "import"), "nothing to import");
    // Whatever was loaded before goes first: one resident model.
    assert.strictEqual(fake.state.calls[0][0], "unload");
    assert.deepStrictEqual(steps, ["loading", "loaded"]);
    assert.deepStrictEqual(await lmstudio.listLoaded(fake.port), ["qwen:q4_k_m"]);
  } finally { fake.server.close(); }
});

test("lmstudio: a model from elsewhere is linked in, never moved", async () => {
  const fake = await fakeLmStudio();
  const lmsDir = tmpdir("lms-home");
  const other = tmpdir("hf-cache");
  const file = path.join(other, "Big-Q5_K_M-00001-of-00002.gguf");
  fs.writeFileSync(file, "x");
  fs.writeFileSync(path.join(other, "mmproj-F16.gguf"), "x");
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port },
      { id: "big:q5_k_m", file, mmproj: path.join(other, "mmproj-F16.gguf") }, 16384,
      { run: fake.run, findLms: () => "lms", dirs: [lmsDir] });
    assert.ok(!r.failed, r.error);
    const imports = fake.state.calls.filter((a) => a[0] === "import");
    // Both shards and the projector, each as a hard link into arcflare/<id>.
    assert.deepStrictEqual(imports.map((a) => path.basename(a[1])),
      ["Big-Q5_K_M-00001-of-00002.gguf", "Big-Q5_K_M-00002-of-00002.gguf", "mmproj-F16.gguf"]);
    for (const a of imports) {
      assert.deepStrictEqual(a.slice(2), ["--user-repo", "arcflare/big-q5_k_m", "--hard-link", "--yes"]);
    }
    const load = fake.state.calls.find((a) => a[0] === "load");
    assert.strictEqual(load[1], "arcflare/big-q5_k_m/Big-Q5_K_M-00001-of-00002.gguf");
  } finally { fake.server.close(); }
});

test("lmstudio: an import that cannot link fails rather than copy or move", async () => {
  const fake = await fakeLmStudio();
  const run = (exe, args) => {
    if (args[0] !== "import") return fake.run(exe, args);
    fake.state.calls.push(args);
    return { ok: false, out: "cross-device link" };
  };
  const file = path.join(tmpdir("elsewhere"), "M-Q8_0.gguf");
  fs.writeFileSync(file, "x");
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "m:q8_0", file }, 8192,
      { run, findLms: () => "lms", dirs: [tmpdir("lms-home2")] });
    assert.strictEqual(r.failed, true);
    assert.match(r.error, /without copying/);
    const tried = fake.state.calls.filter((a) => a[0] === "import").map((a) => a[4]);
    assert.deepStrictEqual(tried, ["--hard-link", "--symbolic-link"]);
    assert.ok(!fake.state.calls.some((a) => a[0] === "load"));
  } finally { fake.server.close(); }
});

test("lmstudio: a context that does not fit is halved until it does", async () => {
  const fake = await fakeLmStudio({ maxCtx: 40000 });
  const dir = tmpdir("lms-fit");
  const file = path.join(dir, "a", "b", "M-Q4_K_M.gguf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  const retries = [];
  try {
    const r = await lmstudio.prepareModel({ lmstudioPort: fake.port }, { id: "m:q4_k_m", file }, 131072, {
      run: fake.run, findLms: () => "lms", dirs: [dir],
      onProgress: (p) => p.stage === "retry" && retries.push(p.ctx),
    });
    assert.strictEqual(r.ctx, 32768);
    assert.deepStrictEqual(retries, [65536, 32768]);
  } finally { fake.server.close(); }
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
  // The llama.cpp settings do not leak into LM Studio's port, or the reverse.
  assert.strictEqual(serve.portFor({ engine: "lmstudio", port: 11434 }), 1234);

  const fake = await fakeLmStudio();
  const dir = tmpdir("lms-serve");
  const file = path.join(dir, "p", "r", "S-Q4_K_M.gguf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  try {
    const r = await serve.prepareModel({ engine: "lmstudio", lmstudioPort: fake.port },
      { id: "s:q4_k_m", file }, 8192, "f16", { run: fake.run, findLms: () => "lms", dirs: [dir] });
    assert.strictEqual(r.servedId, "s:q4_k_m");
    assert.strictEqual(r.port, fake.port);
  } finally { fake.server.close(); }
});

test("lmstudio: paths and names", () => {
  assert.strictEqual(lmstudio.relativeTo(path.resolve("/m"), path.resolve("/m/a/b/c.gguf")), "a/b/c.gguf");
  assert.strictEqual(lmstudio.relativeTo(path.resolve("/m"), path.resolve("/other/c.gguf")), null);
  assert.strictEqual(lmstudio.repoNameFor({ id: "qwen3.6-35b-a3b:ud-q5_k_xl" }), "qwen3.6-35b-a3b-ud-q5_k_xl");
  assert.strictEqual(lmstudio.runtime({}, { findLms: () => "lms",
    run: () => ({ ok: true, out: "Selected:\nllama.cpp-vulkan@1.50.0" }) }), "llama.cpp-vulkan@1.50.0");
});
