"use strict";
// scripts/sync-ui.js: explicit allowlist, no symlinks, no stray files, CSP inside <head> before any <script>.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { copyUi, resolveSrc, assertCspInHead, transformIndex, FILES, SyncError } = require("../scripts/sync-ui.js");

const hubUi = path.join(__dirname, "..", "..", "lib", "hub", "ui");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "syncui-"));

/** A copy of the real hub UI restricted to the allowlist (plus whatever `extra` adds). */
function fakeSrc() {
  const d = tmp();
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.copyFileSync(path.join(hubUi, rel), path.join(d, rel));
  }
  return d;
}
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name)).split(path.sep).join("/")]);

test("allowlist equals the files the hub's STATIC table serves", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "hub", "server.js"), "utf8");
  const table = server.slice(server.indexOf("const STATIC = {"), server.indexOf("};", server.indexOf("const STATIC = {")));
  const served = new Set([...table.matchAll(/:\s*\["([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...served].sort(), [...FILES].sort());
  for (const rel of FILES) assert.ok(fs.existsSync(path.join(hubUi, rel)), rel);
});

test("copies exactly the allowlist and a stray extra file is not copied", () => {
  const src = fakeSrc(), out = path.join(tmp(), "ui");
  fs.writeFileSync(path.join(src, "stray.txt"), "x");
  fs.writeFileSync(path.join(src, "assets", "FONT-LICENSES.txt"), "x");
  fs.mkdirSync(path.join(src, "extra")); fs.writeFileSync(path.join(src, "extra", "a.js"), "x");
  copyUi(src, out);
  assert.deepEqual(walk(out).sort(), [...FILES].sort());
});

test("a symlinked file in the source is rejected, and nothing is written", () => {
  const src = fakeSrc(), out = path.join(tmp(), "ui");
  const secret = path.join(tmp(), "secret.js");
  fs.writeFileSync(secret, "window.ArcFlareTransport");
  fs.rmSync(path.join(src, "app.js")); fs.symlinkSync(secret, path.join(src, "app.js"));
  assert.throws(() => copyUi(src, out), (e) => e instanceof SyncError && /symlink/.test(e.message));
  assert.equal(fs.existsSync(out), false);
});

test("a symlinked asset, a symlinked assets directory and a symlinked source directory are rejected", () => {
  let src = fakeSrc(); const out = path.join(tmp(), "ui");
  fs.rmSync(path.join(src, "assets", "mascot-dark.png")); fs.symlinkSync(path.join(src, "app.js"), path.join(src, "assets", "mascot-dark.png"));
  assert.throws(() => copyUi(src, out), /symlink/);
  src = fakeSrc();
  const elsewhere = tmp(); fs.cpSync(path.join(src, "assets"), elsewhere, { recursive: true });
  fs.rmSync(path.join(src, "assets"), { recursive: true }); fs.symlinkSync(elsewhere, path.join(src, "assets"));
  assert.throws(() => copyUi(src, out), /symlink/);
  const link = path.join(tmp(), "ui-link"); fs.symlinkSync(fakeSrc(), link);
  assert.throws(() => copyUi(link, out), /symlink/);
});

test("a missing expected file fails loudly", () => {
  for (const rel of ["style.css", "assets/panda-search.png"]) {
    const src = fakeSrc(); fs.rmSync(path.join(src, rel));
    assert.throws(() => copyUi(src, path.join(tmp(), "ui")), (e) => e instanceof SyncError && e.message.includes("missing " + rel));
  }
});

test("the CSP <meta> lands in <head> before the first <script> in the real output", () => {
  const out = path.join(tmp(), "ui");
  copyUi(fakeSrc(), out);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const meta = html.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(html.indexOf("<head>") < meta && meta < html.indexOf("</head>") && meta < html.indexOf("<script"));
});

test("assertCspInHead fails when the CSP is missing, outside head, or after a script", () => {
  const m = '<meta http-equiv="Content-Security-Policy" content="x">';
  assert.doesNotThrow(() => assertCspInHead(`<html><head>${m}<script src="a.js"></script></head><body></body></html>`));
  assert.throws(() => assertCspInHead("<html><head></head></html>"), /missing/);
  assert.throws(() => assertCspInHead(`<html><head></head><body>${m}</body></html>`), /not inside <head>/);
  assert.throws(() => assertCspInHead(`<html><head><script src="a.js"></script>${m}</head></html>`), /after the first <script>/);
  assert.throws(() => assertCspInHead(`<html>${m}<head></head></html>`), /not inside <head>/);
});

test("transformIndex output passes the CSP placement check for the real index.html", () => {
  assert.doesNotThrow(() => assertCspInHead(transformIndex(fs.readFileSync(path.join(hubUi, "index.html"), "utf8"))));
});

test("ARCFLARE_UI_SRC is ignored unless it resolves inside the repo", () => {
  const repo = tmp(), dflt = path.join(repo, "default-ui");
  fs.mkdirSync(dflt); fs.mkdirSync(path.join(repo, "inside"));
  const outside = tmp();
  const realErr = process.stderr.write; process.stderr.write = () => true;
  try {
    assert.equal(resolveSrc(undefined, repo, dflt), dflt);
    assert.equal(resolveSrc(outside, repo, dflt), dflt);
    assert.equal(resolveSrc(path.join(repo, "nonexistent"), repo, dflt), dflt);
    assert.equal(resolveSrc(path.join(repo, "inside"), repo, dflt), fs.realpathSync(path.join(repo, "inside")));
    const sneaky = path.join(repo, "sneaky"); fs.symlinkSync(outside, sneaky);
    assert.equal(resolveSrc(sneaky, repo, dflt), dflt);
  } finally { process.stderr.write = realErr; }
});
