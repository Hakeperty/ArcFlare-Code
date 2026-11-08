// Saved voices (lib/gen/voices.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "voices-"));
const voices = require("../lib/gen/voices");
const clip = path.join(process.env.ARCFLARE_HOME, "me.wav");
fs.writeFileSync(clip, Buffer.alloc(1000));

test("a voice copied from a clip keeps its own copy of the clip", () => {
  const v = voices.save("Narrator", { like: clip, refText: "hello there" });
  assert.strictEqual(v.name, "narrator");
  fs.unlinkSync(clip); // the original can go away
  const got = voices.get("narrator");
  assert.ok(fs.existsSync(got.clipPath));
  assert.deepStrictEqual(voices.toSpeak(got), { ref: got.clipPath, refText: "hello there", instruct: null, model: null });
});

test("a described voice; names are checked; no silent overwrite", () => {
  voices.save("guide", { describe: "a calm, warm female voice", model: "qwen3-tts-design" });
  assert.strictEqual(voices.toSpeak(voices.get("guide")).instruct, "a calm, warm female voice");
  assert.throws(() => voices.save("guide", { describe: "other" }), /--force/);
  voices.save("guide", { describe: "other", overwrite: true });
  assert.strictEqual(voices.get("guide").describe, "other");
  for (const bad of ["../x", "a/b", "", "x".repeat(41), "-x"]) assert.throws(() => voices.save(bad, { describe: "d" }), /name/);
  assert.throws(() => voices.save("both", { describe: "d", like: "x.wav" }), /not both/);
  assert.throws(() => voices.save("none", {}), /either/);
  assert.throws(() => voices.save("txt", { like: __filename }), /audio file/);
});

test("list, and remove deletes the clip too", () => {
  assert.deepStrictEqual(voices.list().map((v) => v.name), ["guide", "narrator"]);
  const p = voices.get("narrator").clipPath;
  voices.remove("narrator");
  assert.ok(!fs.existsSync(p));
  assert.throws(() => voices.get("narrator"), /Saved: guide/);
});

test("a hand-edited voice cannot point its clip outside the voices folder", () => {
  fs.writeFileSync(path.join(voices.dir(), "evil.json"), JSON.stringify({ name: "evil", clip: "../../secret.wav" }));
  assert.strictEqual(path.dirname(voices.get("evil").clipPath), voices.dir());
});
