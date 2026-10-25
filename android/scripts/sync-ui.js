#!/usr/bin/env node
// Build step: copy the phone UI (lib/hub/ui) into www/ui and turn its index.html into the
// bundled tunnel-mode page. www/ui and www/vendor are generated and never committed.
//
//  - ui/index.html gets a Content-Security-Policy <meta> (the hub sends its CSP as a header;
//    a bundled file has no header), and its script list becomes
//      tunnel-client, Capacitor runtime, link/mode/native/lanfetch/store/connector, transport adapter,
//      relay-boot (sets window.ArcFlareTransport), app.js, relay-chip (chip = "Home network" | "Relay")
//    so the transport exists BEFORE app.js reads it.
//  - vendor/capacitor.js = @capacitor/core's browser runtime (registerPlugin for the shell).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "..");
const defaultSrc = path.join(repoRoot, "lib", "hub", "ui");
const out = path.join(root, "www", "ui");
const vendor = path.join(root, "www", "vendor");

// EXPLICIT allowlist: exactly what the hub's STATIC table (lib/hub/server.js) serves. Nothing else is copied,
// so a stray file in the source directory can never end up in the APK. test/sync-ui.test.js checks this list
// against the STATIC table.
const FILES = [
  "index.html", "app.js", "style.css", "tunnel-client.js",
  "assets/bitcount-single.ttf", "assets/geist-latin.woff2", "assets/geist-mono-latin.woff2",
  "assets/mascot-light.png", "assets/mascot-dark.png", "assets/panda-search.png",
];

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; base-uri 'none'; form-action 'none'";
const APP_TAG = '<script src="app.js" defer></script>';

class SyncError extends Error {}
function die(msg) { throw new SyncError(msg); }

const isInside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

/** The UI source directory: ARCFLARE_UI_SRC only if it resolves (symlinks followed) inside the repo, else the default. */
function resolveSrc(envValue, repo = repoRoot, dflt = defaultSrc) {
  if (!envValue) return dflt;
  try {
    const real = fs.realpathSync(path.resolve(envValue));
    if (isInside(fs.realpathSync(repo), real)) return real;
  } catch { /* fall through */ }
  process.stderr.write("sync-ui: ignoring ARCFLARE_UI_SRC (does not resolve inside the repository)\n");
  return dflt;
}

/** Pure: the bundled index.html from the hub's index.html. Exported for tests. */
function transformIndex(html) {
  if (html.split(APP_TAG).length !== 2) die('expected exactly one ' + APP_TAG + " in index.html");
  if (!/<meta charset="utf-8">/.test(html)) die("expected <meta charset=\"utf-8\"> in index.html");
  if (/Content-Security-Policy/i.test(html)) die("index.html already carries a CSP meta; review sync-ui.js");
  if (!/<head[\s>]/i.test(html)) die("expected a <head> in index.html");
  const scripts = [
    '<script src="tunnel-client.js" defer></script>',
    '<script src="../vendor/capacitor.js" defer></script>',
    '<script src="../link.js" defer></script>',
    '<script src="../mode.js" defer></script>',
    '<script src="../native.js" defer></script>',
    '<script src="../lanfetch.js" defer></script>',
    '<script src="../store.js" defer></script>',
    '<script src="../connector.js" defer></script>',
    '<script src="../transport.js" defer></script>',
    '<script src="../relay-boot.js" defer></script>',
    APP_TAG,
    '<script src="../relay-chip.js" defer></script>',
  ].join("\n  ");
  const result = html
    .replace('<meta charset="utf-8">', () => '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="' + CSP + '">')
    .replace(APP_TAG, () => scripts);
  assertCspInHead(result);
  return result;
}

/** Fails (throws) unless the CSP <meta> sits inside <head> and before the first <script>. */
function assertCspInHead(html) {
  const meta = html.search(/<meta\s+http-equiv="Content-Security-Policy"/i);
  const head = html.search(/<head[\s>]/i);
  const headEnd = html.search(/<\/head\s*>/i);
  const script = html.search(/<script[\s>]/i);
  if (meta === -1) die("CSP <meta> is missing from the bundled index.html");
  if (head === -1 || headEnd === -1 || !(head < meta && meta < headEnd)) die("CSP <meta> is not inside <head>");
  if (script !== -1 && script < meta) die("CSP <meta> comes after the first <script>");
}

/** Reads one allowlisted file: must be a regular file (no symlink, here or in any directory on the way), inside srcDir. */
function readAllowed(srcDir, rel) {
  const full = path.join(srcDir, rel);
  if (!isInside(srcDir, full)) die("refusing path outside the UI directory: " + rel);
  let dir = srcDir;
  for (const part of rel.split("/").slice(0, -1)) {
    dir = path.join(dir, part);
    let st;
    try { st = fs.lstatSync(dir); } catch { die("missing directory " + part + " in " + srcDir); }
    if (st.isSymbolicLink() || !st.isDirectory()) die("refusing symlink or non-directory: " + path.relative(srcDir, dir));
  }
  let st;
  try { st = fs.lstatSync(full); } catch { die("missing " + rel + " in " + srcDir); }
  if (st.isSymbolicLink()) die("refusing symlink: " + rel);
  if (!st.isFile()) die("not a regular file: " + rel);
  return fs.readFileSync(full);
}

/** Copies the allowlist from srcDir into outDir (replaced). Validates everything before touching outDir. */
function copyUi(srcDir, outDir) {
  let st;
  try { st = fs.lstatSync(srcDir); } catch { die("phone UI not found at " + srcDir); }
  if (st.isSymbolicLink() || !st.isDirectory()) die("UI source must be a real directory, not a symlink: " + srcDir);
  const data = new Map();
  for (const rel of FILES) data.set(rel, readAllowed(srcDir, rel));
  if (!/window\.ArcFlareTransport/.test(data.get("app.js").toString("utf8"))) die("app.js does not read window.ArcFlareTransport; the tunnel mode would not work");
  data.set("index.html", Buffer.from(transformIndex(data.get("index.html").toString("utf8"))));
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [rel, buf] of data) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return [...data.keys()];
}

function main() {
  const src = resolveSrc(process.env.ARCFLARE_UI_SRC);
  copyUi(src, out);

  const core = path.join(root, "node_modules", "@capacitor", "core", "dist", "capacitor.js");
  if (!fs.existsSync(core)) die("run npm ci first (@capacitor/core missing)");
  fs.rmSync(vendor, { recursive: true, force: true });
  fs.mkdirSync(vendor, { recursive: true });
  fs.copyFileSync(core, path.join(vendor, "capacitor.js"));
  process.stdout.write("sync-ui: " + path.relative(root, out) + " <- " + path.relative(root, src) + " (" + FILES.length + " files), vendor/capacitor.js\n");
}

if (require.main === module) {
  try { main(); } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    process.stderr.write("sync-ui: " + e.message + "\n");
    process.exit(1);
  }
}
module.exports = { transformIndex, assertCspInHead, copyUi, resolveSrc, FILES, CSP, SyncError };
