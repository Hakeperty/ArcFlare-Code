// Tests for the answers to complaints.md: the trust prompt names the secrets
// a config would send, updates come from one pinned place and ask first,
// reports are validated before sending, and harness updates plan the right
// command for where each tool was installed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-sec-"));
delete process.env.ARCFLARE_UPDATE_SOURCE;
const trust = require("../lib/agent/trust");
const upd = require("../lib/update");
const report = require("../lib/report");
const hu = require("../lib/harness-update");

const SHA = "0123456789abcdef0123456789abcdef01234567";

// ------------------------------------------------------------------ trust ----

test("the trust prompt says which env vars go to which host", () => {
  const d = trust.describe({
    gh: { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } },
    fs: { command: "npx", args: ["server-fs", "$HOME"], env: { KEY: "${AWS_SECRET}" } },
    plain: { url: "https://docs.example.org/mcp" },
  });
  const by = Object.fromEntries(d.map((x) => [x.name, x]));
  assert.deepStrictEqual(by.gh.sends, ["GITHUB_TOKEN"]);
  assert.ok(by.gh.lines.includes("sends $GITHUB_TOKEN to api.example.com"));
  assert.deepStrictEqual(by.fs.sends, ["AWS_SECRET", "HOME"]);
  assert.ok(by.fs.lines.some((l) => l.startsWith("runs npx server-fs")));
  assert.deepStrictEqual(by.plain.sends, []);
  assert.ok(!by.plain.lines.some((l) => l.startsWith("sends")));
});

test("a token in the url or the token field counts as sent", () => {
  const [d] = trust.describe({ s: { url: "https://${HOST_VAR}.example.com/?k=$API_KEY", token: "${TOK}" } });
  assert.deepStrictEqual(d.sends, ["API_KEY", "HOST_VAR", "TOK"]);
});

test("adding a secret to a header changes the fingerprint", () => {
  const a = { s: { url: "https://x.example.com" } };
  const b = { s: { url: "https://x.example.com", headers: { "X-Key": "${SECRET}" } } };
  assert.notStrictEqual(trust.fingerprint(a), trust.fingerprint(b));
});

// ----------------------------------------------------------------- update ----

test("the update source is official unless named, and must look like owner/repo", () => {
  assert.deepStrictEqual(upd.resolveSource(undefined), { repo: "Hakeperty/ArcFlare-Code", official: true });
  assert.strictEqual(upd.resolveSource("hakeperty/arcflare-code").official, true);
  assert.deepStrictEqual(upd.resolveSource("someone/fork"), { repo: "someone/fork", official: false });
  assert.strictEqual(upd.resolveSource("github:someone/fork.git").repo, "someone/fork");
  assert.ok(upd.resolveSource("https://evil.example.com/x.git").error);
  assert.ok(upd.resolveSource("a/b; rm -rf /").error);
});

test("official remotes are recognised in https and ssh form, and nothing else", () => {
  assert.ok(upd.isOfficialRemote("https://github.com/Hakeperty/ArcFlare-Code.git"));
  assert.ok(upd.isOfficialRemote("git@github.com:Hakeperty/ArcFlare-Code.git\n"));
  assert.ok(!upd.isOfficialRemote("https://github.com/someone/ArcFlare-Code.git"));
  assert.ok(!upd.isOfficialRemote("https://github.com/Hakeperty/ArcFlare-Code-evil.git"));
});

test("npm installs are pinned to an exact sha, never a branch", () => {
  assert.strictEqual(upd.npmSpec("Hakeperty/ArcFlare-Code", SHA), `github:Hakeperty/ArcFlare-Code#${SHA}`);
  assert.throws(() => upd.npmSpec("Hakeperty/ArcFlare-Code", "main"));
  assert.throws(() => upd.npmSpec("Hakeperty/ArcFlare-Code", SHA.slice(0, 7)));
  assert.throws(() => upd.npmSpec("not a repo", SHA));
});

test("an online npm update asks first and installs nothing without consent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-sec-root-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "arcflare", version: "0.0.1" }));
  const fetchImpl = async () => ({ ok: true, text: async () => SHA + "\n" });
  const r = await upd.apply({ root, fetchImpl, log: () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needsConfirm, true);
  assert.strictEqual(r.preview.spec, `github:Hakeperty/ArcFlare-Code#${SHA}`);
  assert.strictEqual(r.preview.official, true);

  const no = await upd.apply({ root, fetchImpl, log: () => {}, confirm: async () => false });
  assert.strictEqual(no.cancelled, true);

  const lines = upd.describePreview({ ...r.preview, repo: "someone/fork", official: false });
  assert.match(lines[0], /NOT the official repository/);
});

test("a malformed update source is refused before anything runs", async () => {
  const r = await upd.apply({ source: "https://evil.example.com/x", log: () => {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /owner\/repo/);
});

// ----------------------------------------------------------------- report ----

test("reports are validated with the site's limits", () => {
  assert.match(report.validate({ title: "hi", body: "long enough body" }).error, /title/);
  assert.match(report.validate({ title: "a title", body: "short" }).error, /body/);
  assert.match(report.validate({ title: "a title", body: "long enough body", kind: "rant" }).error, /kind/);
  assert.match(report.validate({ title: "x".repeat(121), body: "long enough body" }).error, /too long/);
  const ok = report.validate({ title: "  rc link stalls ", body: "after a minute it stops", version: "1.1.0" });
  assert.strictEqual(ok.payload.title, "rc link stalls");
  assert.strictEqual(ok.payload.kind, "bug");
  assert.strictEqual(ok.payload.where, "cli");
  assert.ok(ok.payload.os.length > 0);
});

test("a failed send resolves with the GitHub issues fallback", async () => {
  const r = await report.send({ title: "t" }, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.strictEqual(r.ok, false);
  assert.match(r.fallback, /github\.com\/Hakeperty\/ArcFlare-Code\/issues/);
  const bad = await report.send({}, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: "too many" }) }) });
  assert.strictEqual(bad.error, "too many");
});

// ---------------------------------------------------------------- harness ----

test("harness updates use each tool's own updater, where it was installed", () => {
  const none = () => false;
  assert.deepStrictEqual(hu.plan("codex", "/usr/local/bin/codex", none).args, ["install", "-g", "@openai/codex@latest"]);
  assert.strictEqual(hu.plan("codex", "/opt/homebrew/bin/codex", none).cmd, "brew");
  assert.deepStrictEqual(hu.plan("opencode", "/home/u/.opencode/bin/opencode", none).args, ["upgrade"]);
  assert.deepStrictEqual(hu.plan("hermes", "/x/hermes", none).args, ["update"]);
  assert.deepStrictEqual(hu.plan("claude", "/x/claude", none).args, ["update"]);
  assert.ok(hu.plan("codex", null).skip);
  assert.ok(hu.plan("agent", null).skip);

  // OpenCode bundled in another tool's npm prefix is updated in that prefix.
  const prefix = path.join("C:", "tools", "node");
  const bundled = (p) => p === path.join(prefix, "node_modules", "opencode-ai");
  const p = hu.plan("opencode", path.join(prefix, "opencode"), bundled);
  assert.strictEqual(p.cmd, "npm");
  assert.deepStrictEqual(p.args, ["install", "-g", "opencode-ai@latest", "--prefix", prefix]);
});
