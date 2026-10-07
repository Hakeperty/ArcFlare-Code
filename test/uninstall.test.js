// Tests for `arcflare uninstall` and `arcflare shop`'s hub loader.
//
// The uninstaller is tested by letting it really delete — in throwaway
// folders — because the property that matters is what it refuses to touch:
// a home directory, a drive root, a folder that is not ArcFlare's, and models
// that other tools share.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const un = require("../lib/uninstall");
const hub = require("../lib/hub");

function fakeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-un-"));
  const home = path.join(root, ".arcflare");
  fs.mkdirSync(path.join(home, "gen", "envs", "kokoro"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), "{}");
  fs.writeFileSync(path.join(home, "rc.json"), "{}");
  fs.writeFileSync(path.join(home, "gen", "envs", "kokoro", "big.bin"), Buffer.alloc(4096));
  fs.mkdirSync(path.join(home, "models"));
  fs.writeFileSync(path.join(home, "models", "m.gguf"), Buffer.alloc(1024));
  return { root, home };
}

// ----------------------------------------------------------------- safety ----

test("it will not treat a home directory, a drive root or a stranger's folder as ArcFlare's", () => {
  assert.strictEqual(un.looksLikeArcflareHome(os.homedir()), false);
  assert.strictEqual(un.looksLikeArcflareHome(path.parse(process.cwd()).root), false);
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "af-stranger-"));
  fs.writeFileSync(path.join(stranger, "thesis.docx"), "years of work");
  assert.strictEqual(un.looksLikeArcflareHome(stranger), false);
  assert.throws(() => un.execute(un.survey({ home: stranger })), /refusing/);
  assert.ok(fs.existsSync(path.join(stranger, "thesis.docx")), "and nothing was deleted");
});

test("a custom ARCFLARE_HOME is accepted when it holds ArcFlare's own files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-custom-"));
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  fs.writeFileSync(path.join(dir, "models.ini"), "");
  assert.strictEqual(un.looksLikeArcflareHome(dir), true);
});

// ------------------------------------------------------------------ plan ----

test("the survey lists everything with sizes and changes nothing", () => {
  const { home } = fakeHome();
  const plan = un.survey({ home });
  assert.ok(plan.homeOk);
  assert.ok(plan.remove.some((i) => i.path.endsWith("gen") && i.bytes >= 4096));
  assert.ok(plan.keep.some((k) => k.path.endsWith("models")), "pulled models are kept by default");
  assert.ok(fs.existsSync(path.join(home, "gen")), "a survey deletes nothing");
});

test("models outside ArcFlare's folder are listed, never deleted", () => {
  const { home } = fakeHome();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "af-llamacache-"));
  fs.writeFileSync(path.join(shared, "big.gguf"), Buffer.alloc(2048));
  const plan = un.survey({ home, modelRoots: [shared], withModels: true });
  assert.ok(plan.keep.some((k) => k.path === shared && k.bytes === 2048));
  un.execute(plan, { removeCli: false });
  assert.ok(fs.existsSync(path.join(shared, "big.gguf")), "--models never reaches a shared cache");
});

test("harness configs that mention ArcFlare are reported with their backups, not edited", () => {
  const { root, home } = fakeHome();
  const cfgFile = path.join(root, "opencode.json");
  fs.writeFileSync(cfgFile, '{"provider":{"arcflare":{}}}');
  fs.writeFileSync(cfgFile + ".arcflare-bak", "{}");
  const plan = un.survey({ home, harnesses: [{ label: "OpenCode", configFile: () => cfgFile }] });
  assert.deepStrictEqual(plan.configs, [{ label: "OpenCode", file: cfgFile, backup: cfgFile + ".arcflare-bak" }]);
  un.execute(plan, { removeCli: false });
  assert.strictEqual(fs.readFileSync(cfgFile, "utf8"), '{"provider":{"arcflare":{}}}', "left exactly as it was");
});

// --------------------------------------------------------------- execute ----

test("executing removes ArcFlare's files and keeps pulled models", () => {
  const { home } = fakeHome();
  const failed = un.execute(un.survey({ home }), { removeCli: false });
  assert.deepStrictEqual(failed, []);
  assert.ok(!fs.existsSync(path.join(home, "gen")));
  assert.ok(!fs.existsSync(path.join(home, "rc.json")), "the remote-control key is gone");
  assert.ok(fs.existsSync(path.join(home, "models", "m.gguf")), "the models are not");
});

test("with --models, ArcFlare's own model folder goes too, and the empty home with it", () => {
  const { home } = fakeHome();
  un.execute(un.survey({ home, withModels: true }), { removeCli: false });
  assert.ok(!fs.existsSync(home));
});

// -------------------------------------------------------------------- hub ----

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-hub-"));

test("the shop falls back to the bundled hub when the site is unreachable", async () => {
  const offline = async () => { throw new TypeError("fetch failed"); };
  const r = await hub.load({ cfg: { hub: "http://127.0.0.1:9" }, fetchImpl: offline, refresh: true });
  assert.strictEqual(r.source, "bundled");
  assert.ok(r.data.models.length > 10);
});

test("fit agrees with the website's thresholds", () => {
  assert.strictEqual(hub.fit({ vram: "~6 GB" }, 8), "fits");     // 6 <= 6.8
  assert.strictEqual(hub.fit({ vram: "~7.5 GB" }, 8), "tight");  // 6.8 < 7.5 <= 8
  assert.strictEqual(hub.fit({ vram: "~16 GB" }, 8), "no");
  assert.strictEqual(hub.fit({ vram: "varies" }, 8), "unknown");
});

test("install plans come only from commands the CLI really has", () => {
  assert.deepStrictEqual(hub.installPlan({ run: "arcflare pull unsloth/Qwen3-8B-GGUF:Q4_K_M", runnable: true }).argv,
    ["pull", "unsloth/Qwen3-8B-GGUF:Q4_K_M"]);
  assert.deepStrictEqual(hub.installPlan({ run: 'arcflare gen tts "Hello" -m kokoro', runnable: true }).argv,
    ["gen", "setup", "kokoro"]);
  assert.strictEqual(hub.installPlan({ run: "arcflare run qwen2.5", runnable: false }).kind, "none",
    "a placeholder command from the early catalogue is not run");
});

test("search ranks name hits first and needs every word", () => {
  const models = [
    { name: "qwen3-coder", slug: "qwen3-coder", author: "Qwen", category: "Code", tags: ["code"], description: "" },
    { name: "devstral", slug: "devstral", author: "Mistral", category: "Code", tags: ["code"], description: "a coder" },
    { name: "kokoro", slug: "kokoro", author: "hexgrad", category: "Audio", tags: ["tts"], description: "" },
  ];
  assert.deepStrictEqual(hub.search(models, "coder").map((m) => m.slug), ["qwen3-coder", "devstral"]);
  assert.deepStrictEqual(hub.search(models, "code mistral").map((m) => m.slug), ["devstral"]);
});
