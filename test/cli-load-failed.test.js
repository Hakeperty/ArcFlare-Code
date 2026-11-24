// `arcflare run` and `arcflare use` must stop when the model fails to load, not open a chat or wire a harness up
// against a server with no model. The load itself is stubbed: reaching a real failure needs a llama-server that
// cannot load the model.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LIB = path.join(__dirname, "..", "lib");
const BIN = path.join(__dirname, "..", "bin", "arcflare.js");

function runCli(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-loadfail-"));
  const marker = path.join(home, "configured");
  const stub = path.join(home, "stub.js");
  fs.writeFileSync(stub, `
    const serve = require(${JSON.stringify(path.join(LIB, "serve"))});
    const models = require(${JSON.stringify(path.join(LIB, "models"))});
    const harness = require(${JSON.stringify(path.join(LIB, "harness"))});
    const m = { id: "tiny", file: "/no/tiny.gguf", size: 1e9, meta: { trainCtx: 4096 } };
    models.discover = () => [m];
    models.resolve = () => m;
    serve.planningBudget = async () => 16e9;
    serve.prepareModel = async () => ({ failed: true, error: "the test made it fail" });
    harness.byId = () => ({ id: "fake", label: "Fake", detect: () => ({ installed: true, bin: "/bin/true" }),
      configure: () => { require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); return {}; },
      launch: () => { require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); return null; } });
  `);
  const r = spawnSync(process.execPath, ["-r", stub, BIN, ...args], {
    encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ARCFLARE_HOME: home, NO_COLOR: "1" },
  });
  return { ...r, configured: fs.existsSync(marker) };
}

test("arcflare run stops with the reason when the model fails to load", () => {
  const r = runCli(["run", "tiny"]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /could not load .*the test made it fail/);
  assert.doesNotMatch(r.stdout, /ctx/, "it did not go on to open the chat");
});

test("arcflare use stops with the reason when the model fails to load, before wiring the harness", () => {
  const r = runCli(["use", "fake", "tiny"]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /could not load .*the test made it fail/);
  assert.strictEqual(r.configured, false, "the harness config was not touched");
});
