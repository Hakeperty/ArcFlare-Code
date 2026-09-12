// Zero-dependency test suite: `node --test test/`
//
// Covers the parts where being wrong is expensive and silent — KV cache maths
// (gets you an OOM at max context), model id parsing (picks the wrong quant),
// and the harness config writers (corrupts someone else's editor config).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const gguf = require("../lib/gguf");
const models = require("../lib/models");
const engine = require("../lib/engine");
const harness = require("../lib/harness");

function tmpdir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "arcflare-" + name + "-"));
  return d;
}

// --------------------------------------------------------------- KV maths --

// Shapes taken from the real GGUF headers of models we ship against.
const QWEN38_27B = {
  arch: "qwen35", nLayer: 65, kvHeads: 4, headDimK: 256, headDimV: 256,
  trainCtx: 262144, fullAttnInterval: 4, nextnLayers: 1,
};
const QWEN36_MOE = {
  arch: "qwen35moe", nLayer: 41, kvHeads: 2, headDimK: 256, headDimV: 256,
  trainCtx: 262144, fullAttnInterval: 4, nextnLayers: 1,
};
const PLAIN_DENSE = {
  arch: "llama", nLayer: 32, kvHeads: 8, headDimK: 128, headDimV: 128,
  trainCtx: 8192, fullAttnInterval: null, nextnLayers: 0,
};
const MLA = {
  arch: "glm4moe", nLayer: 47, kvHeads: 20, headDimK: 128, headDimV: 128,
  trainCtx: 202752, kvLoraRank: 512, qkRopeHeadDim: 64, nextnLayers: 1,
};

test("hybrid models count only full-attention layers", () => {
  // 65 blocks - 1 MTP = 64 real, every 4th attends => 16
  assert.strictEqual(gguf.attendingLayers(QWEN38_27B), 16);
  // 41 - 1 = 40 real, every 4th => 10
  assert.strictEqual(gguf.attendingLayers(QWEN36_MOE), 10);
});

test("a plain dense model has every layer attending", () => {
  assert.strictEqual(gguf.attendingLayers(PLAIN_DENSE), 32);
});

test("KV per token matches hand-computed values", () => {
  // 16 layers * 2 (K+V) * 4 heads * 256 dim * 2 bytes = 65536
  assert.strictEqual(gguf.kvBytesPerToken(QWEN38_27B, "f16"), 64 * 1024);
  // 10 layers * 2 * 2 heads * 256 dim * 2 bytes = 20480
  assert.strictEqual(gguf.kvBytesPerToken(QWEN36_MOE, "f16"), 20 * 1024);
});

test("q8_0 cache is about half of f16", () => {
  const f16 = gguf.kvBytesPerToken(QWEN36_MOE, "f16");
  const q8 = gguf.kvBytesPerToken(QWEN36_MOE, "q8_0");
  const ratio = q8 / f16;
  assert.ok(ratio > 0.5 && ratio < 0.56, `ratio was ${ratio}`);
});

test("ignoring the hybrid layout would overestimate 4x", () => {
  // This is the bug that made max context look impossible. Guard against it.
  const correct = gguf.kvBytesPerToken(QWEN38_27B, "f16");
  const naive = 65 * 4 * (256 + 256) * 2; // every layer attends
  assert.ok(naive / correct > 3.9, "naive estimate should be ~4x the real one");
});

test("MLA caches one latent per layer, not separate K and V", () => {
  const per = gguf.kvBytesPerToken(MLA, "f16");
  // 46 attending layers * (512 + 64) * 2 bytes
  assert.strictEqual(per, 46 * (512 + 64) * 2);
  // and it must be far cheaper than treating it as 20-head MHA
  const asMha = 46 * 20 * (128 + 128) * 2;
  assert.ok(per < asMha / 8);
});

test("maxContextFor never exceeds the trained context", () => {
  const huge = 900 * 1024 * 1024 * 1024;
  assert.strictEqual(gguf.maxContextFor(QWEN36_MOE, huge, "f16"), 262144);
});

test("maxContextFor shrinks to fit a small budget", () => {
  // 1 GiB of cache at 20 KiB/token ~= 52k tokens
  const ctx = gguf.maxContextFor(QWEN36_MOE, 1024 * 1024 * 1024, "f16");
  assert.ok(ctx >= 32768 && ctx <= 65536, `got ${ctx}`);
  assert.strictEqual(ctx % 1024, 0, "should land on a 1024 boundary");
});

test("incomplete metadata yields null rather than a wrong number", () => {
  assert.strictEqual(gguf.kvBytesPerToken({ arch: "x" }, "f16"), null);
  assert.strictEqual(gguf.kvBytesPerToken(null, "f16"), null);
});

// ------------------------------------------------------------- model ids ----

test("model ids split name from quant", () => {
  assert.strictEqual(models.idFor("/m/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf"),
    "qwen3.6-35b-a3b:ud-q6_k_xl");
  assert.strictEqual(models.idFor("/m/Qwen3.8-27B-UD-Q5_K_M.gguf"),
    "qwen3.8-27b:ud-q5_k_m");
  assert.strictEqual(models.idFor("/m/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"),
    "meta-llama-3.1-8b-instruct:q4_k_m");
});

test("sharded files collapse to one id", () => {
  assert.strictEqual(
    models.idFor("/m/Big-Model-BF16-00001-of-00002.gguf"),
    models.idFor("/m/Big-Model-BF16-00002-of-00002.gguf"));
});

test("resolve prefers an exact id over a substring", () => {
  const list = [
    { id: "qwen3.6-35b-a3b:ud-q5_k_xl", name: "a.gguf" },
    { id: "qwen3.6-35b-a3b:ud-q6_k_xl", name: "b.gguf" },
  ];
  assert.strictEqual(
    models.resolve(list, "qwen3.6-35b-a3b:ud-q6_k_xl").id,
    "qwen3.6-35b-a3b:ud-q6_k_xl");
});

// ---------------------------------------------------------------- jsonc -----

test("JSONC parser strips comments and trailing commas", () => {
  const src = `{
    // line comment
    "a": 1, /* block */
    "b": "http://x/y", // url with // inside a string
    "c": [1, 2,],
  }`;
  const o = harness.parseJsonc(src);
  assert.strictEqual(o.a, 1);
  assert.strictEqual(o.b, "http://x/y");
  assert.deepStrictEqual(o.c, [1, 2]);
});

// ------------------------------------------------------------- presets ------

test("preset ini renders sections and a global block", () => {
  const d = tmpdir("preset");
  const f = path.join(d, "models.ini");
  engine.writePreset(f, { "n-gpu-layers": 99 }, {
    "unsloth/Repo-GGUF:Q6_K_XL": { c: 262144, "cache-type-k": "q8_0", jinja: true },
  });
  const txt = fs.readFileSync(f, "utf8");
  assert.match(txt, /^version = 1/m);
  assert.match(txt, /^\[\*\]$/m);
  assert.match(txt, /^n-gpu-layers = 99$/m);
  assert.match(txt, /^\[unsloth\/Repo-GGUF:Q6_K_XL\]$/m);
  assert.match(txt, /^c = 262144$/m);
  assert.match(txt, /^jinja = true$/m);
  fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------- harnesses ----

test("opencode config keeps other providers and makes a backup", () => {
  const d = tmpdir("opencode");
  const f = path.join(d, "opencode.json");
  fs.writeFileSync(f, JSON.stringify({
    model: "ollama/something",
    provider: { ollama: { name: "Ollama", options: { baseURL: "http://x" } } },
  }, null, 2));

  const oc = Object.create(harness.byId("opencode"));
  oc.configFile = () => f;
  const res = oc.configure({
    port: 11434, ctx: 262144, apiKey: "arcflare",
    model: { id: "unsloth/Repo-GGUF:Q6_K_XL", label: "Repo" },
  });

  assert.ok(res.ok);
  const out = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.ok(out.provider.ollama, "must not clobber the existing provider");
  assert.strictEqual(out.provider.arcflare.options.baseURL, "http://127.0.0.1:11434/v1");
  assert.strictEqual(out.model, "arcflare/unsloth/Repo-GGUF:Q6_K_XL");
  assert.strictEqual(
    out.provider.arcflare.models["unsloth/Repo-GGUF:Q6_K_XL"].limit.context, 262144);
  assert.ok(fs.existsSync(f + ".arcflare-bak"), "a backup must exist");
  fs.rmSync(d, { recursive: true, force: true });
});

test("opencode config refuses to write over a file it cannot parse", () => {
  const d = tmpdir("opencode-bad");
  const f = path.join(d, "opencode.json");
  fs.writeFileSync(f, "{ this is not json at all ");
  const oc = Object.create(harness.byId("opencode"));
  oc.configFile = () => f;
  const res = oc.configure({
    port: 11434, ctx: 4096, model: { id: "m", label: "m" },
  });
  assert.strictEqual(res.ok, false, "should report failure, not overwrite");
  assert.match(fs.readFileSync(f, "utf8"), /not json/, "original must be untouched");
  fs.rmSync(d, { recursive: true, force: true });
});

test("codex config is replaced cleanly, not appended twice", () => {
  const d = tmpdir("codex");
  const f = path.join(d, "config.toml");
  const cx = Object.create(harness.byId("codex"));
  cx.configFile = () => f;
  const opts = { port: 11434, ctx: 131072, model: { id: "m1", label: "m1" } };

  cx.configure(opts);
  cx.configure({ ...opts, model: { id: "m2", label: "m2" } });

  const txt = fs.readFileSync(f, "utf8");
  const blocks = txt.match(/\[model_providers\.arcflare\]/g) || [];
  assert.strictEqual(blocks.length, 1, "exactly one provider block");
  const modelLines = txt.match(/^model = .*/gm) || [];
  assert.strictEqual(modelLines.length, 1, "exactly one model line");
  assert.match(txt, /model = "m2"/);
  assert.match(txt, /wire_api = "chat"/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("codex config preserves unrelated user settings", () => {
  const d = tmpdir("codex-keep");
  const f = path.join(d, "config.toml");
  fs.writeFileSync(f, 'approval_policy = "on-request"\n\n[tui]\ntheme = "dark"\n');
  const cx = Object.create(harness.byId("codex"));
  cx.configFile = () => f;
  cx.configure({ port: 11434, ctx: 4096, model: { id: "m", label: "m" } });
  const txt = fs.readFileSync(f, "utf8");
  assert.match(txt, /approval_policy = "on-request"/);
  assert.match(txt, /\[tui\]/);
  assert.match(txt, /theme = "dark"/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("every harness exposes the interface the CLI relies on", () => {
  for (const h of harness.list()) {
    assert.strictEqual(typeof h.id, "string");
    assert.strictEqual(typeof h.label, "string");
    assert.strictEqual(typeof h.detect, "function");
    assert.strictEqual(typeof h.configure, "function");
    assert.strictEqual(typeof h.launch, "function");
  }
});

test("BASE builds a v1 endpoint", () => {
  assert.strictEqual(harness.BASE(11434), "http://127.0.0.1:11434/v1");
});
