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
  assert.match(txt, /wire_api = "responses"/);
  // Every key we own has to be stripped before rewrite, or a second `use`
  // leaves two of them and Codex reads whichever it happens to hit first.
  const compact = txt.match(/^model_auto_compact_token_limit = .*/gm) || [];
  assert.strictEqual(compact.length, 1, "exactly one compaction limit");
  assert.strictEqual(compact[0], "model_auto_compact_token_limit = 104857");
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

// The agent is the one harness whose tools ArcFlare runs itself, so it is the
// one entry the `tools` flag belongs on — everything else runs its own.
test("the agent is offered as a harness and is the only one with tools", () => {
  const list = harness.list();
  const agent = list.find((h) => h.id === "agent");
  assert.ok(agent, "the agent is in the menu");
  assert.strictEqual(agent.installed, true, "built in, so never greyed out");
  assert.deepStrictEqual(list.filter((h) => h.tools).map((h) => h.id), ["agent"]);
});

// ------------------------------------------------------------- auto mode ----

// The menu asks about tool approval for every harness that has an auto mode, so
// a missing descriptor silently drops the question for that harness. The plain
// chat is the only entry that should not be asked: it has no tools to approve.
test("every harness that runs tools has an auto mode, and chat does not", () => {
  const list = harness.list();
  assert.deepStrictEqual(
    list.filter((h) => !h.auto).map((h) => h.id), ["chat"]);
  for (const h of list.filter((x) => x.auto)) {
    assert.ok(h.auto.label, `${h.id} says what auto mode does`);
    assert.ok(h.auto.note, `${h.id} says what auto mode costs`);
    // The agent's auto mode is a mode it starts in; every other harness needs
    // something concrete to pass to someone else's binary.
    if (h.id !== "agent") {
      assert.ok(h.auto.flags || h.auto.env,
        `${h.id} has a flag or a variable to set`);
    }
  }
});

test("auto mode arguments are added only when auto mode is on", () => {
  const oc = harness.byId("opencode");
  assert.deepStrictEqual(harness.autoArgs(oc.auto, "yolo", []), ["--auto"]);
  assert.deepStrictEqual(harness.autoArgs(oc.auto, "ask", []), []);
  assert.deepStrictEqual(harness.autoArgs(oc.auto, undefined, []), []);
  // The agent has no binary to pass anything to.
  assert.deepStrictEqual(harness.autoArgs(harness.byId("agent").auto, "yolo", []), []);
  assert.deepStrictEqual(harness.autoArgs(harness.byId("hermes").auto, "yolo", []), ["--yolo"]);
  assert.deepStrictEqual(
    harness.autoArgs(harness.byId("codex").auto, "yolo", []),
    ["--dangerously-bypass-approvals-and-sandbox"]);
});

// A user who typed their own approval argument has answered the question. Two
// answers on one command line is how you end up running under the wrong one.
test("an explicit approval argument wins over auto mode", () => {
  const codex = harness.byId("codex").auto;
  assert.deepStrictEqual(harness.autoArgs(codex, "yolo", ["-s", "read-only"]), []);
  assert.deepStrictEqual(harness.autoArgs(codex, "yolo", ["--ask-for-approval=on-request"]), []);
  assert.deepStrictEqual(harness.autoArgs(codex, "yolo", ["--cd", "."]),
    ["--dangerously-bypass-approvals-and-sandbox"], "unrelated arguments change nothing");
  const hermes = harness.byId("hermes").auto;
  assert.deepStrictEqual(harness.autoArgs(hermes, "yolo", ["--safe-mode"]), []);
  assert.deepStrictEqual(harness.autoArgs(hermes, "yolo", ["--yolo"]), [],
    "the flag is not passed twice when the user typed it");
});

// Hermes Desktop has no flag to take: the toggle lives in the app. The variable
// is read once at backend start, so it has to be in the environment we launch
// with rather than anything written afterwards.
test("hermes desktop carries auto mode in the environment", () => {
  const desktop = harness.byId("hermes-desktop").auto;
  assert.deepStrictEqual(harness.autoEnv(desktop, "yolo"), { HERMES_YOLO_MODE: "1" });
  assert.deepStrictEqual(harness.autoEnv(desktop, "ask"), {});
  assert.deepStrictEqual(harness.autoArgs(desktop, "yolo", []), [],
    "nothing on the command line — `hermes desktop` would reject it");
  // The CLI takes the flag instead, so it must not also set the variable.
  assert.deepStrictEqual(harness.autoEnv(harness.byId("hermes").auto, "yolo"), {});
});

// ------------------------------------------------------- draft sidecars --

// The HF cache splits one model across two repos: ggml-org ships the MTP draft
// for Qwen3.8-27B while unsloth ships the weights. A same-directory scan finds
// nothing, and speculative decoding then stays off without ever saying so.

function put(...parts) {
  const file = path.join(...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
}

// Only models under the temp root — the machine's real ones are also on the
// search path, and a fixture that collided with them would prove nothing.
function discoverIn(d) {
  return models.discover({ roots: [d] }).filter((m) => m.file.startsWith(d));
}

function repo(d, vendor, family) {
  return path.join(d, `models--${vendor}--${family}-GGUF`, "snapshots", vendor);
}

test("a draft model in a sibling repo is still attached", () => {
  const d = tmpdir("mtp-split");
  put(repo(d, "vendora", "Zephyrtest-9Z"), "mtp-Zephyrtest-9Z-Q8_0.gguf");
  put(repo(d, "vendorb", "Zephyrtest-9Z"), "Zephyrtest-9Z-UD-Q5_K_M.gguf");

  const found = discoverIn(d);
  assert.strictEqual(found.length, 1, "the draft is a sidecar, not a model");
  assert.ok(found[0].mtp, "draft attached across repos");
  assert.match(path.basename(found[0].mtp), /^mtp-Zephyrtest-9Z/);
  assert.strictEqual(found[0].mtpFromOtherRepo, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test("a draft beside the weights is used and not flagged cross-repo", () => {
  const d = tmpdir("mtp-local");
  const r = repo(d, "vendorb", "Zephyrtest-9Z");
  put(r, "Zephyrtest-9Z-UD-Q5_K_M.gguf");
  put(r, "mtp-Zephyrtest-9Z-Q8_0.gguf");

  const [m] = discoverIn(d);
  assert.strictEqual(path.dirname(m.mtp), r);
  assert.strictEqual(m.mtpFromOtherRepo, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test("a draft is not borrowed by an unrelated model family", () => {
  const d = tmpdir("mtp-unrelated");
  put(repo(d, "vendora", "Betatest-2B"), "mtp-Betatest-2B-Q8_0.gguf");
  put(repo(d, "vendorb", "Alphatest-1A"), "Alphatest-1A-UD-Q5_K_M.gguf");

  const [m] = discoverIn(d);
  assert.strictEqual(m.id.split(":")[0], "alphatest-1a");
  assert.strictEqual(m.mtp, undefined, "a draft for another model is not a draft");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a vision projector is never borrowed from another repo", () => {
  const d = tmpdir("mmproj-split");
  put(repo(d, "vendora", "Zephyrtest-9Z"), "mmproj-F16.gguf");
  put(repo(d, "vendorb", "Zephyrtest-9Z"), "Zephyrtest-9Z-UD-Q5_K_M.gguf");

  const [m] = discoverIn(d);
  assert.strictEqual(m.mmproj, undefined,
    "pairing a projector with another repo's weights would be a real mistake");
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------- hermes wiring --

// Hermes' tools do not follow the process working directory, and neither
// `--in` nor `--no-restore-cwd` moves them: `terminal.cwd` is the only lever,
// and its default resolves to the user's home. Without this key, `arcflare use
// hermes` inside a project hands you an agent editing files in ~.
test("hermes is pointed at the directory arcflare was run from", () => {
  const d = tmpdir("hermes-cwd");
  const log = path.join(d, "calls.txt");
  const win = process.platform === "win32";
  const shim = path.join(d, win ? "fakehermes.cmd" : "fakehermes.sh");
  if (win) fs.writeFileSync(shim, `@echo off\r\n>>"${log}" echo %*\r\n`);
  else {
    fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    fs.chmodSync(shim, 0o755);
  }

  const r = harness.byId("hermes").configure({
    port: 11434,
    model: { id: "m1", label: "m1" },
    bin: shim,
    cwd: path.join(d, "proj"),
  });

  assert.ok(r.ok, "configure succeeded against the stand-in binary");
  const txt = fs.readFileSync(log, "utf8");
  assert.match(txt, /terminal\.cwd/, "terminal.cwd is set");
  assert.ok(txt.includes(path.join(d, "proj")), "set to the directory we passed");
  assert.match(txt, /model\.default/, "still sets the keys it always did");
  fs.rmSync(d, { recursive: true, force: true });
});

// `hermes desktop` reinstalls workspace deps and rebuilds the Electron app on
// every launch - minutes, with no output - even when the packaged app already
// exists. We skip that only when we can actually see the built artefact.
test("hermes desktop rebuild is skipped only when the built app is visible", () => {
  const d = tmpdir("hermes-desktop");
  const bin = path.join(d, "bin", "hermes");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");

  assert.strictEqual(harness.desktopPrebuilt(bin), false,
    "nothing built yet - let Hermes build rather than pass --skip-build");

  const rel = path.join(d, "hermes-agent", "apps", "desktop", "release", "win-unpacked");
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, "Hermes.exe"), "");
  assert.strictEqual(harness.desktopPrebuilt(bin), true, "built app is found");

  fs.rmSync(d, { recursive: true, force: true });
});

test("an empty release directory does not count as built", () => {
  const d = tmpdir("hermes-desktop-empty");
  const bin = path.join(d, "bin", "hermes");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");
  fs.mkdirSync(path.join(d, "hermes-agent", "apps", "desktop", "release", "win-unpacked"),
    { recursive: true });
  assert.strictEqual(harness.desktopPrebuilt(bin), false);
  fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------ agent model choice --

// `arcflare agent -p "read package.json ..."` used to scan the prompt for a
// model name, fail to match "read", and then silently load the largest model
// on disk instead of the one you had been using.
const cli = require("../bin/arcflare.js");

const CATALOG = [
  { id: "qwen3.6-35b-a3b:ud-q6_k_xl", name: "a.gguf" },   // largest, sorts first
  { id: "tiel-coder-35b-a3b-mtp:ud-q5_k_xl", name: "b.gguf" },
];
const LAST = "tiel-coder-35b-a3b-mtp:ud-q5_k_xl";

test("prompt words are not mistaken for a model name", () => {
  const argv = ["agent", "-p", "Read", "package.json", "and", "report", "the", "version"];
  const sel = cli.pickModel(CATALOG, argv, LAST);
  assert.strictEqual(sel.error, undefined);
  assert.strictEqual(sel.model.id, LAST, "falls back to the model you last used");
});

test("an explicit model before the prompt still wins", () => {
  const argv = ["agent", "qwen3.6-35b-a3b", "-p", "tiel-coder is just a word here"];
  const sel = cli.pickModel(CATALOG, argv, LAST);
  assert.strictEqual(sel.model.id, "qwen3.6-35b-a3b:ud-q6_k_xl");
});

test("a model name that matches nothing is an error, not a fallback", () => {
  const sel = cli.pickModel(CATALOG, ["agent", "no-such-model"], LAST);
  assert.match(sel.error, /no model matching "no-such-model"/);
  assert.strictEqual(sel.model, undefined);
});

test("flags are skipped when looking for the model name", () => {
  const sel = cli.pickModel(CATALOG, ["agent", "--yolo"], LAST);
  assert.strictEqual(sel.error, undefined);
  assert.strictEqual(sel.model.id, LAST);
});

test("with no model named and nothing remembered, the first is used", () => {
  const sel = cli.pickModel(CATALOG, ["agent"], null);
  assert.strictEqual(sel.model.id, "qwen3.6-35b-a3b:ud-q6_k_xl");
});

test("an empty catalog yields no model rather than throwing", () => {
  const sel = cli.pickModel([], ["agent"], null);
  assert.strictEqual(sel.model, null);
});

// ---------------------------------------------------------- sampling ----

// Qwen3-class files publish the sampling they were tuned for, and the thinking
// and non-thinking presets differ (top_p 0.95 vs 0.8). These models think, so
// inheriting the wrong preset quietly costs output quality.
test("declared sampling is read from GGUF metadata", () => {
  const s = gguf.summarize({
    "general.architecture": "qwen35moe",
    "general.sampling.temp": 1,
    "general.sampling.top_p": 0.949999988079071, // float32 round-trip
    "general.sampling.top_k": 20,
  });
  assert.deepStrictEqual(s.sampling, { temperature: 1, top_p: 0.95, top_k: 20 });
});

test("a file that declares no sampling reports none, rather than a guess", () => {
  const s = gguf.summarize({ "general.architecture": "llama" });
  assert.strictEqual(s.sampling, null);
});

test("nonsense sampling values are ignored", () => {
  const s = gguf.summarize({
    "general.architecture": "llama",
    "general.sampling.temp": "hot",
    "general.sampling.top_p": NaN,
    "general.sampling.top_k": 20,
  });
  assert.deepStrictEqual(s.sampling, { top_k: 20 });
});

// ------------------------------------------------------------- batch size --

// Physical batch trades VRAM for prefill speed. Measured on a 35B-A3B at Q5,
// three runs each with under 1% spread: a 1.4k prompt prefills at 369 tok/s
// against 265 at the stock 512, while an 8k prompt gives back 6.5%.
test("batch size defaults, and a configured value wins", () => {
  assert.strictEqual(cli.ubatchFor({}), cli.DEFAULT_UBATCH);
  assert.strictEqual(cli.ubatchFor(undefined), cli.DEFAULT_UBATCH);
  assert.strictEqual(cli.ubatchFor({ ubatch: 512 }), 512);
  assert.strictEqual(cli.ubatchFor({ ubatch: "1024" }), 1024);
});

test("a nonsense batch size falls back rather than reaching llama-server", () => {
  for (const bad of [0, -1, "abc", null, NaN, 12]) {
    assert.strictEqual(cli.ubatchFor({ ubatch: bad }), cli.DEFAULT_UBATCH,
      `ubatch ${String(bad)} should not be honoured`);
  }
});

test("the fallback batch is llama.cpp's own default", () => {
  // Context is what we protect; batch is what we give up to protect it.
  assert.strictEqual(cli.MIN_UBATCH, 512);
  assert.ok(cli.DEFAULT_UBATCH > cli.MIN_UBATCH);
});
