// n-gram speculation in the model preset (lib/serve.js writePresetFor).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spec-"));
const serve = require("../lib/serve");

const read = () => fs.readFileSync(serve.PRESET, "utf8");

test("n-gram speculation is on by default and written into the model's section", () => {
  assert.strictEqual(serve.specFor({}), true);
  serve.writePresetFor({ id: "m:q6", file: "/x/m.gguf" }, 8192, "f16", 2048, serve.specFor({}));
  assert.match(read(), /\[m:q6\][\s\S]*spec-type = ngram-simple,ngram-mod/);
});

test("arcflare spec off leaves it out", () => {
  assert.strictEqual(serve.specFor({ spec: "off" }), false);
  serve.writePresetFor({ id: "m:q6", file: "/x/m.gguf" }, 8192, "f16", 2048, serve.specFor({ spec: "off" }));
  assert.ok(!/spec-type/.test(read()));
});

test("a model with its own MTP draft head keeps draft-mtp", () => {
  serve.writePresetFor({ id: "m:q6", file: "/x/m.gguf", mtp: "/x/mtp.gguf" }, 8192, "f16", 2048, true);
  const t = read();
  assert.match(t, /spec-type = draft-mtp/);
  assert.ok(!/ngram-mod/.test(t));
});

test("a draft head inside the model file turns on draft-mtp without a draft file", () => {
  serve.writePresetFor({ id: "m:q6", file: "/x/m.gguf", meta: { nextnLayers: 1 } }, 8192, "f16", 2048, true);
  const t = read();
  assert.match(t, /spec-type = draft-mtp/);
  assert.ok(!/model-draft|ngram/.test(t));
});
