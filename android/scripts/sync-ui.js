#!/usr/bin/env node
// Build step: copy the phone UI (lib/hub/ui) into www/ui and turn its index.html into the
// bundled relay-mode page. www/ui and www/vendor are generated and never committed.
//
//  - ui/index.html gets a Content-Security-Policy <meta> (the hub sends its CSP as a header;
//    a bundled file has no header), and its script list becomes
//      tunnel-client, store, transport adapter, relay-boot (sets window.ArcFlareTransport),
//      app.js, relay-chip (chip = "Relay")
//    so the transport exists BEFORE app.js reads it.
//  - vendor/capacitor.js = @capacitor/core's browser runtime (registerPlugin for the shell).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const src = process.env.ARCFLARE_UI_SRC ? path.resolve(process.env.ARCFLARE_UI_SRC) : path.resolve(root, "..", "lib", "hub", "ui");
const out = path.join(root, "www", "ui");
const vendor = path.join(root, "www", "vendor");

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; base-uri 'none'; form-action 'none'";
const APP_TAG = '<script src="app.js" defer></script>';

function die(msg) { process.stderr.write("sync-ui: " + msg + "\n"); process.exit(1); }

/** Pure: the bundled index.html from the hub's index.html. Exported for tests. */
function transformIndex(html) {
  if (html.split(APP_TAG).length !== 2) die('expected exactly one ' + APP_TAG + " in index.html");
  if (!/<meta charset="utf-8">/.test(html)) die("expected <meta charset=\"utf-8\"> in index.html");
  if (/Content-Security-Policy/i.test(html)) die("index.html already carries a CSP meta; review sync-ui.js");
  const scripts = [
    '<script src="tunnel-client.js" defer></script>',
    '<script src="../store.js" defer></script>',
    '<script src="../transport.js" defer></script>',
    '<script src="../relay-boot.js" defer></script>',
    APP_TAG,
    '<script src="../relay-chip.js" defer></script>',
  ].join("\n  ");
  return html
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="' + CSP + '">')
    .replace(APP_TAG, scripts);
}

function main() {
  if (!fs.existsSync(path.join(src, "index.html"))) die("phone UI not found at " + src);
  for (const f of ["app.js", "style.css", "tunnel-client.js", "index.html"]) if (!fs.existsSync(path.join(src, f))) die("missing " + f + " in " + src);
  const appJs = fs.readFileSync(path.join(src, "app.js"), "utf8");
  if (!/window\.ArcFlareTransport/.test(appJs)) die("app.js does not read window.ArcFlareTransport; the relay mode would not work");

  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(src, out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), transformIndex(fs.readFileSync(path.join(src, "index.html"), "utf8")));

  const core = path.join(root, "node_modules", "@capacitor", "core", "dist", "capacitor.js");
  if (!fs.existsSync(core)) die("run npm ci first (@capacitor/core missing)");
  fs.rmSync(vendor, { recursive: true, force: true });
  fs.mkdirSync(vendor, { recursive: true });
  fs.copyFileSync(core, path.join(vendor, "capacitor.js"));
  process.stdout.write("sync-ui: " + path.relative(root, out) + " <- " + path.relative(root, src) + ", vendor/capacitor.js\n");
}

if (require.main === module) main();
module.exports = { transformIndex, CSP };
