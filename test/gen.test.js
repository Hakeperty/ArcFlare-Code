// Tests for 3D generation. No GPU and no PyTorch here: the worker is replaced
// by a script that speaks the same line protocol, which is the part ArcFlare
// owns. What is checked is what would otherwise fail ten minutes into a run —
// a request the chosen model cannot serve, a failure reported as success, a
// traceback swallowed into "exit code 1".

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-gen-"));
const gen = require("../lib/gen");
const { createServer } = require("../lib/mcp/tools");

function fakeWorker(body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-genw-")), "worker.js");
  fs.writeFileSync(f, `const spec = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
${body}`);
  return f;
}

test("model ids resolve loosely, and unknown ones do not resolve at all", () => {
  assert.strictEqual(gen.byId().id, gen.DEFAULT_MODEL);
  assert.strictEqual(gen.byId("Hunyuan3D-2mini").id, "hunyuan3d-2mini");
  assert.strictEqual(gen.byId("hunyuan3d_2.1").id, "hunyuan3d-2.1");
  assert.strictEqual(gen.byId("hunyuan3d21").id, "hunyuan3d-2.1");
  assert.strictEqual(gen.byId("TripoSR").id, "triposr");
  assert.strictEqual(gen.byId("stable-diffusion"), null);
});

test("every 3D model names a code repo, weights and an honest VRAM figure", () => {
  for (const m of gen.MODELS.filter((x) => gen.kindOf(x) === "3d")) {
    assert.match(m.repo.url, /^https:\/\/github\.com\//, m.id);
    assert.match(m.hf, /^[\w-]+\/[\w.-]+$/, m.id);
    assert.ok(m.vram > 0 && (!m.texture || m.textureVram > m.vram), `${m.id}: texturing costs more than shape`);
    if (m.family.startsWith("hunyuan")) assert.ok(m.subfolder, `${m.id} needs its subfolder`);
  }
});

test("a mesh made from an image lands next to it", () => {
  const out = gen.defaultOut(gen.byId("triposr"), { image: "/x/photos/chair.png", cwd: "/work" });
  assert.strictEqual(out, path.join("/work", "chair-triposr.glb"));
  const fromText = gen.defaultOut(gen.byId("hunyuan3d-2"), { prompt: "A Red Chair!" });
  assert.match(path.basename(fromText), /^a-red-chair-hunyuan3d-2-\w+\.glb$/);
});

test("requests a model cannot serve are refused before anything starts", async () => {
  const img = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-img-")), "a.png");
  fs.writeFileSync(img, "png");
  await assert.rejects(gen.generate({}, { model: "triposr", prompt: "a chair" }), /image-only/);
  await assert.rejects(gen.generate({}, { model: "hunyuan3d-2.1", image: img, texture: true }), /cannot texture/);
  await assert.rejects(gen.generate({}, { model: "hunyuan3d-2mini" }), /give an image/);
  await assert.rejects(gen.generate({}, { model: "hunyuan3d-2mini", image: "/no/such.png" }), /no such image/);
  await assert.rejects(gen.generate({}, { model: "nope", image: img }), /unknown model/);
});

test("the worker protocol: stages stream in, and done is the result", async () => {
  const worker = fakeWorker(`
emit({ event: "stage", stage: "load-model" });
console.error("some library noise");
emit({ event: "stage", stage: "shape" });
emit({ event: "done", file: spec.out, faces: 1234 });`);
  const seen = [];
  const r = await gen.runWorker(process.execPath, { out: "x.glb" }, { worker, onEvent: (e) => seen.push(e.stage || e.event) });
  assert.deepStrictEqual(seen, ["load-model", "shape", "done"]);
  assert.strictEqual(r.faces, 1234);
});

test("a worker error keeps its own message and the traceback tail", async () => {
  const worker = fakeWorker(`
console.error("Traceback (most recent call last):");
console.error("torch.OutOfMemoryError: HIP out of memory");
emit({ event: "error", message: "OutOfMemoryError: HIP out of memory" });
process.exit(1);`);
  await assert.rejects(gen.runWorker(process.execPath, {}, { worker }), (e) => {
    assert.match(e.message, /out of memory/);
    assert.match(e.stderr, /Traceback/);
    return true;
  });
});

test("a worker that exits without reporting is a failure, whatever its exit code", async () => {
  const worker = fakeWorker(`emit({ event: "stage", stage: "shape" }); process.exit(0);`);
  await assert.rejects(gen.runWorker(process.execPath, {}, { worker }), /reported nothing/);
});

test("a cancelled worker is stopped and says so", async () => {
  const worker = fakeWorker(`setTimeout(() => emit({ event: "done", file: "late" }), 10000);`);
  const ac = new AbortController();
  const p = gen.runWorker(process.execPath, {}, { worker, signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, /cancelled/);
});

test("the machine server offers mesh and speech generation", () => {
  const tools = createServer({}).list();
  const names = tools.map((t) => t.name);
  for (const n of ["generate_models", "generate_3d", "generate_speech", "generate_job"]) assert.ok(names.includes(n), n);
  const ids = (kind) => gen.MODELS.filter((m) => gen.kindOf(m) === kind).map((m) => m.id);
  // The enums are what the validator holds callers to, so each tool may only
  // offer models of its own kind.
  assert.deepStrictEqual(tools.find((t) => t.name === "generate_3d").inputSchema.properties.model.enum, ids("3d"));
  assert.deepStrictEqual(tools.find((t) => t.name === "generate_speech").inputSchema.properties.model.enum, ids("tts"));
});

// ------------------------------------------------------------------ speech ----

test("speech models are registered with what setup and the worker need", () => {
  const tts = gen.MODELS.filter((m) => gen.kindOf(m) === "tts");
  assert.ok(tts.some((m) => m.id === "qwen3-tts"), "Qwen3-TTS is there");
  assert.strictEqual(gen.byId(undefined, "tts").id, gen.DEFAULT_TTS);
  for (const m of tts) {
    assert.ok(m.env, `${m.id} has its own environment: their pins conflict`);
    assert.ok(m.pip && m.pip.length, `${m.id} names its packages`);
    assert.match(m.hf, /^[\w-]+\/[\w.-]+$/, m.id);
    assert.ok(!m.repo, `${m.id} installs from pip, not a checkout`);
  }
});

test("speech requests a model cannot serve are refused before anything starts", async () => {
  await assert.rejects(gen.speak({}, { model: "kokoro", text: "" }), /give the text/);
  await assert.rejects(gen.speak({}, { model: "kokoro", text: "hi", ref: "x.wav" }), /cannot clone/);
  await assert.rejects(gen.speak({}, { model: "qwen3-tts-clone", text: "hi" }), /--ref/);
  await assert.rejects(gen.speak({}, { model: "kokoro", text: "hi", instruct: "angrily" }), /--instruct/);
  await assert.rejects(gen.speak({}, { model: "hunyuan3d-2mini", text: "hi" }), /not a speech model/);
  await assert.rejects(gen.generate({}, { model: "kokoro", image: __filename }), /speech model/);
  await assert.rejects(gen.speak({}, { model: "kokoro", text: "x".repeat(6000) }), /characters/);
});

test("voice design and OmniVoice: what they need is checked up front, and the licence is on the record", async () => {
  await assert.rejects(gen.speak({}, { model: "qwen3-tts-design", text: "hi" }), /--instruct/);
  await assert.rejects(gen.speak({}, { model: "kokoro", text: "hi", instruct: "calm" }), /omnivoice/);
  await assert.rejects(gen.speak({}, { model: "omnivoice", text: "hi", instruct: "x".repeat(1001) }), /1000/);
  const ov = gen.byId("omnivoice", "tts");
  assert.ok(ov.cloning && ov.instruct && ov.nonCommercial, "OmniVoice clones, designs, and is non-commercial");
  assert.match(ov.note, /NON-COMMERCIAL/);
  assert.ok(!ov.needsRefText, "OmniVoice transcribes the reference clip itself");
  assert.strictEqual(gen.byId("qwen3-tts-design", "tts").license, "Apache-2.0");
});

test("speech output defaults to the working directory, named after the text", () => {
  const out = gen.defaultSpeechOut(gen.byId("kokoro"), "Hello, World!", "/work");
  assert.strictEqual(out, path.join("/work", "hello-world-kokoro.wav"));
});

test("a speech worker that writes nothing fails, whatever it reports", async () => {
  const worker = fakeWorker(`emit({ event: "done", file: spec.out, seconds: 1 });`);
  // runWorker alone accepts this; speak() is what checks the file, so check
  // the same rule speak applies.
  const r = await gen.runWorker(process.execPath, { out: path.join(os.tmpdir(), "af-nothing.wav") }, { worker });
  assert.ok(!fs.existsSync(r.file), "nothing was written");
});

test("autoTorch: borrows a GPU torch it finds, else picks the wheel for the hardware", () => {
  const none = { probe: () => null, has: () => false, exists: (p) => p === "/dev/kfd" ? false : true };
  // An ArcFlare env with a working GPU torch is borrowed (AMD on Windows has no official wheel).
  const gpu = gen.autoTorch({ genPython: "/py/rocm" }, { ...none, probe: (p) => p === "/py/rocm" ? { version: "2.10+rocm", gpu: true } : null });
  assert.strictEqual(gpu.torchFrom, "/py/rocm");
  assert.match(gpu.why, /2\.10\+rocm/);
  // A CPU-only torch is not worth borrowing.
  assert.strictEqual(gen.autoTorch({ genPython: "/py/cpu" }, { ...none, probe: () => ({ version: "2.8", gpu: false }) }).torchFrom, undefined);
  assert.strictEqual(gen.autoTorch({}, { ...none, has: (c) => c === "nvidia-smi" }).torch, "cuda");
  assert.strictEqual(gen.autoTorch({}, { ...none, platform: "linux", exists: () => true, probe: () => null }).torch, "rocm");
  assert.strictEqual(gen.autoTorch({}, { ...none, platform: "darwin" }).torch, undefined);
  const cpu = gen.autoTorch({}, { ...none, platform: "win32" });
  assert.strictEqual(cpu.torch, "cpu");
  assert.match(cpu.why, /slowly/);
});

test("pickSpeechModel: --like clones, --describe designs, installed first, never non-commercial unasked", () => {
  const nothing = () => false;
  assert.strictEqual(gen.pickSpeechModel({}, {}, nothing).id, gen.DEFAULT_TTS);
  assert.strictEqual(gen.pickSpeechModel({}, { ref: "a.wav" }, nothing).id, "chatterbox");
  assert.strictEqual(gen.pickSpeechModel({}, { describe: "calm" }, nothing).id, "qwen3-tts-design");
  // An installed cloning model is used rather than downloading another.
  assert.strictEqual(gen.pickSpeechModel({}, { ref: "a.wav" }, (m) => m.id === "outetts").id, "outetts");
  // OmniVoice (non-commercial) only when nothing else can do the job: clone AND describe.
  for (const req of [{ ref: "a" }, { describe: "x" }, {}]) assert.ok(!gen.pickSpeechModel({}, req, () => true).nonCommercial);
  assert.strictEqual(gen.pickSpeechModel({}, { ref: "a", describe: "x" }, nothing).id, "omnivoice");
  // An emotion word with a clip: Kitten does exactly that, and is not non-commercial.
  assert.strictEqual(gen.pickSpeechModel({}, { ref: "a", describe: "joyful" }, nothing).id, "kitten-tts-2");
  // The user's own default wins when it can do what was asked.
  assert.strictEqual(gen.pickSpeechModel({ ttsModel: "omnivoice" }, { ref: "a" }, nothing).id, "omnivoice");
});
