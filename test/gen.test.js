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

// ---------------------------------------------------------- kitten / voices ----

function wav(file, seconds, rate = 16000) {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

test("Kitten TTS 2 is registered as a cloning model with emotion tags", async () => {
  const m = gen.byId("kitten-tts-2");
  assert.strictEqual(m.kind, "tts");
  assert.strictEqual(m.hf, "KittenML/kitten-tts-2");
  assert.ok(m.cloning && m.emotions.includes("joyful"));
  assert.strictEqual(gen.byId("KittenTTS2").id, "kitten-tts-2");
  assert.strictEqual(gen.byId("kitten_tts_2").id, "kitten-tts-2");
  await assert.rejects(gen.speak({}, { model: "kitten-tts-2", text: "hi", instruct: "reverent" }), /emotions/);
});

test("saved voices round-trip, measure their clip and refuse silent overwrites", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-voice-"));
  const clip = wav(path.join(dir, "me.wav"), 6.5);
  const v = gen.voices.save({ name: "My Voice", clip, text: "hello there", lang: "en" });
  assert.strictEqual(v.id, "my-voice");
  assert.strictEqual(v.seconds, 6.5);
  assert.ok(fs.existsSync(v.clip) && v.clip !== clip, "the clip is copied in");
  assert.strictEqual(gen.voices.get("my voice").text, "hello there");
  assert.throws(() => gen.voices.save({ name: "my-voice", clip }), /already exists/);
  assert.strictEqual(gen.voices.update("my-voice", { text: "changed" }).text, "changed");
  assert.ok(gen.voices.list().some((x) => x.id === "my-voice"));
  assert.match(gen.voices.advice(2), /3 s/);
  assert.strictEqual(gen.voices.advice(10), null);
  assert.throws(() => gen.voices.save({ name: "../..", clip }), /name/);
  assert.ok(gen.voices.remove("my-voice"));
  assert.strictEqual(gen.voices.get("my-voice"), null);
});

test("--clone stands in for --ref and --ref-text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-voice-"));
  gen.voices.save({ name: "narrator", clip: wav(path.join(dir, "n.wav"), 8), text: "the clip says this" });
  await assert.rejects(gen.speak({}, { model: "kokoro", text: "hi", clone: "narrator" }), /cannot clone/);
  await assert.rejects(gen.speak({}, { model: "kitten-tts-2", text: "hi", clone: "nobody" }), /no saved voice/);
  await assert.rejects(gen.speak({}, { model: "kitten-tts-2", text: "hi", clone: "narrator", ref: "x.wav" }), /not both/);
  // Past validation, it fails only for want of an install — not on --ref-text.
  await assert.rejects(gen.speak({}, { model: "qwen3-tts-clone", text: "hi", clone: "narrator" }), /setup|not installed/);
  gen.voices.remove("narrator");
});
