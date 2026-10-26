// Tests for update checks. The rule they hold the code to: being offline is a
// normal state, not an error — a check without a network must neither throw,
// nor print, nor claim there is an update.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-upd-"));
delete process.env.ARCFLARE_NO_UPDATE_CHECK;
delete process.env.CI;
const upd = require("../lib/update");
const { version: CURRENT } = require("../package.json");

// A directory that is not a git clone, so check() asks only the version question.
const NOT_GIT = fs.mkdtempSync(path.join(os.tmpdir(), "af-upd-root-"));

const serving = (version) => async () => ({ ok: true, status: 200, json: async () => ({ version }) });
const offline = async () => { throw new TypeError("fetch failed"); };

test("versions compare numerically, and a pre-release sorts before its release", () => {
  assert.strictEqual(upd.compareVersions("1.10.0", "1.9.9"), 1);
  assert.strictEqual(upd.compareVersions("v1.2.0", "1.2.0"), 0);
  assert.strictEqual(upd.compareVersions("1.2.0-beta", "1.2.0"), -1);
  assert.strictEqual(upd.compareVersions("1.2", "1.2.0"), 0);
});

test("a newer published version is an update", async () => {
  const rec = await upd.check({ fetchImpl: serving("99.0.0"), root: NOT_GIT });
  assert.strictEqual(rec.available, true);
  assert.strictEqual(rec.latest, "99.0.0");
  assert.strictEqual(rec.kind, "npm");
});

test("the same or an older published version is not", async () => {
  assert.strictEqual((await upd.check({ fetchImpl: serving(CURRENT), root: NOT_GIT })).available, false);
  assert.strictEqual((await upd.check({ fetchImpl: serving("0.0.1"), root: NOT_GIT })).available, false);
});

test("offline: recorded, never thrown, never an update", async () => {
  const rec = await upd.check({ fetchImpl: offline, root: NOT_GIT });
  assert.strictEqual(rec.offline, true);
  assert.notStrictEqual(rec.available, true);
});

test("the notice reads the cache only, and goes away once installed", () => {
  upd.writeCache({ checkedAt: new Date().toISOString(), available: true, latest: "99.0.0" });
  assert.match(upd.notice().text, new RegExp(`${CURRENT.replace(/\./g, "\\.")} → 99\\.0\\.0`));
  // The cache outlived the update that answered it: no stale nagging.
  upd.writeCache({ checkedAt: new Date().toISOString(), available: true, latest: CURRENT });
  assert.strictEqual(upd.notice(), null);
});

test("checks can be switched off", () => {
  upd.writeCache({ checkedAt: new Date().toISOString(), available: true, latest: "99.0.0" });
  assert.strictEqual(upd.notice({ updateCheck: false }), null);
  assert.strictEqual(upd.refreshInBackground({ updateCheck: false }), false);
});

test("a fresh cache is not re-checked", () => {
  upd.writeCache({ checkedAt: new Date().toISOString() });
  assert.strictEqual(upd.refreshInBackground({}), false);
});

test("an offline source that is not ArcFlare is refused before anything runs", async () => {
  const quiet = () => {};
  const missing = await upd.apply({ from: path.join(NOT_GIT, "nope.tgz"), log: quiet, root: NOT_GIT });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.message, /no such file/);

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "af-upd-other-"));
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "left-pad", version: "9.9.9" }));
  const wrong = await upd.apply({ from: other, log: quiet, root: NOT_GIT });
  assert.strictEqual(wrong.ok, false);
  assert.match(wrong.message, /left-pad/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "af-upd-empty-"));
  assert.match((await upd.apply({ from: empty, log: quiet, root: NOT_GIT })).message, /not an ArcFlare folder/);
});

// Issue #10: `arcflare update` refused to merge because the user had edited
// README.md. A real repository stands in for GitHub through git's own
// url.insteadOf, so the whole fetch/stash/merge path runs.
const { spawnSync } = require("child_process");
function gitIn(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function cloneFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "af-upd-git-"));
  const bare = path.join(base, "up.git"), pusher = path.join(base, "pusher"), user = path.join(base, "user");
  gitIn(base, "init", "-q", "--bare", "-b", "main", bare);
  gitIn(base, "clone", "-q", bare, pusher);
  for (const d of [pusher]) { gitIn(d, "config", "user.email", "t@t"); gitIn(d, "config", "user.name", "t"); }
  fs.writeFileSync(path.join(pusher, "README.md"), "line one\n");
  fs.writeFileSync(path.join(pusher, "package.json"), JSON.stringify({ name: "arcflare", version: "1.0.0" }));
  gitIn(pusher, "add", "."); gitIn(pusher, "commit", "-qm", "init"); gitIn(pusher, "push", "-q", "origin", "HEAD:main");
  gitIn(base, "clone", "-q", bare, user);
  gitIn(user, "config", "user.email", "t@t"); gitIn(user, "config", "user.name", "t");
  const push = (file, text) => {
    fs.writeFileSync(path.join(pusher, file), text);
    gitIn(pusher, "add", "."); gitIn(pusher, "commit", "-qm", "up " + file); gitIn(pusher, "push", "-q", "origin", "HEAD:main");
  };
  return { bare, user, push };
}
async function applyWith(fx) {
  const saved = [process.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0];
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${fx.bare}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/Hakeperty/ArcFlare-Code.git";
  try { return await upd.apply({ yes: true, root: fx.user, log() {} }); }
  finally {
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i];
    });
  }
}

test("update keeps your local edits and still fast-forwards (issue #10)", async () => {
  const fx = cloneFixture();
  fs.writeFileSync(path.join(fx.user, "README.md"), "line one\nmy note\n");
  fx.push("other.txt", "new\n");
  const r = await applyWith(fx);
  assert.strictEqual(r.ok, true, r.message);
  assert.ok(fs.existsSync(path.join(fx.user, "other.txt")));
  assert.strictEqual(fs.readFileSync(path.join(fx.user, "README.md"), "utf8"), "line one\nmy note\n");
  assert.strictEqual(gitIn(fx.user, "stash", "list").trim(), "");
});

test("update succeeds even when your edit collides with the new version, and keeps your edit in the stash", async () => {
  const fx = cloneFixture();
  fs.writeFileSync(path.join(fx.user, "README.md"), "my version\n");
  fx.push("README.md", "their version\n");
  const r = await applyWith(fx);
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(fs.readFileSync(path.join(fx.user, "README.md"), "utf8"), "their version\n");
  assert.match(gitIn(fx.user, "stash", "list"), /arcflare-update/);
  assert.strictEqual(gitIn(fx.user, "status", "--porcelain", "--untracked-files=no").trim(), "");
});
