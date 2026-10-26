#!/usr/bin/env node
// Looks inside a BUILT apk and fails if its merged manifest is not what the README claims.
//
// Why: the source manifest says allowBackup=false, only INTERNET, one launcher activity, a single arcflare://pair
// link. What ships is the MERGED manifest (library manifests, Gradle injections), and nobody could check that before
// there was a build. This runs in CI against the real apk with the SDK's own aapt2.
//
//   node scripts/inspect-apk.js <apk> --debug|--release [--package net.arcflare.app]
//
// The parser and the checks are pure and tested in test/inspect-apk.test.js against a sample of aapt2 output; only
// `main` touches the machine.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ------------------------------------------------------------------ parser ----

/** The tree `aapt2 dump xmltree` prints: `E: name`, `A: attr(0x...)=value`, `N:` lines, indented by two spaces per level. */
function parseXmlTree(text) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [{ depth: -1, node: root }];
  for (const raw of String(text).split("\n")) {
    const m = /^(\s*)([EAN]): (.*)$/.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    const depth = m[1].length / 2;
    const kind = m[2], body = m[3];
    if (kind === "N") continue;
    if (kind === "E") {
      const node = { tag: body.replace(/\s*\(line=\d+\)\s*$/, "").trim(), attrs: {}, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, node });
    } else {
      // attribute of the innermost element opened at depth-1
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const a = /^([^=(]+?)(?:\(0x[0-9a-fA-F]+\))?=(.*)$/.exec(body);
      if (a) stack[stack.length - 1].node.attrs[a[1].trim()] = cleanValue(a[2]);
    }
  }
  return root;
}

/** `"x" (Raw: "x")` -> x, `(type 0x12)0xffffffff` -> true, `(type 0x12)0x0` -> false, `true` -> true. */
function cleanValue(v) {
  let s = String(v).trim().replace(/\s*\(Raw: .*\)\s*$/, "");
  let m = /^\(type 0x12\)(0x[0-9a-fA-F]+)$/.exec(s);
  if (m) return Number(m[1]) !== 0;
  m = /^\(type 0x[0-9a-fA-F]+\)(0x[0-9a-fA-F]+)$/.exec(s);
  if (m) return Number(m[1]);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^"[\s\S]*"$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

const find = (n, tag) => n.children.filter((c) => c.tag === tag);
const attr = (n, name) => (n.attrs[name] !== undefined ? n.attrs[name] : n.attrs["android:" + name]);

/** What the checks need, from the parsed manifest. */
function summarize(tree) {
  const manifest = find(tree, "manifest")[0];
  if (!manifest) throw new Error("no <manifest> in the dump");
  const app = find(manifest, "application")[0] || { tag: "application", attrs: {}, children: [] };
  const sdk = find(manifest, "uses-sdk")[0] || { attrs: {} };
  const components = [];
  for (const tag of ["activity", "activity-alias", "service", "receiver", "provider"]) {
    for (const c of find(app, tag)) {
      const filters = find(c, "intent-filter").map((f) => ({
        actions: find(f, "action").map((x) => attr(x, "name")),
        categories: find(f, "category").map((x) => attr(x, "name")),
        data: find(f, "data").map((x) => ({ scheme: attr(x, "scheme"), host: attr(x, "host"), path: attr(x, "path") || attr(x, "pathPrefix") || attr(x, "pathPattern") })),
      }));
      components.push({ tag, name: attr(c, "name"), exported: attr(c, "exported"), permission: attr(c, "permission"), filters });
    }
  }
  return {
    package: manifest.attrs["package"],
    minSdk: attr(sdk, "minSdkVersion"),
    targetSdk: attr(sdk, "targetSdkVersion"),
    permissions: find(manifest, "uses-permission").concat(find(manifest, "uses-permission-sdk-23")).map((p) => attr(p, "name")),
    declaredPermissions: find(manifest, "permission").map((p) => attr(p, "name")),
    application: {
      allowBackup: attr(app, "allowBackup"), debuggable: attr(app, "debuggable"),
      usesCleartextTraffic: attr(app, "usesCleartextTraffic"),
      networkSecurityConfig: attr(app, "networkSecurityConfig"),
      dataExtractionRules: attr(app, "dataExtractionRules"), fullBackupContent: attr(app, "fullBackupContent"),
      requestLegacyExternalStorage: attr(app, "requestLegacyExternalStorage"),
    },
    components,
  };
}

// ------------------------------------------------------------------ checks ----

// Exported by libraries we ship, with a permission or no way to receive anything harmful: allowed by name.
const KNOWN_EXPORTED = new Set(["androidx.profileinstaller.ProfileInstallReceiver"]);

/** Returns a list of { ok, what, detail } rows. Pure. */
function check(s, { mode, pkg = "net.arcflare.app" }) {
  const rows = [];
  const ok = (cond, what, detail) => rows.push({ ok: !!cond, what, detail: detail === undefined ? "" : String(detail) });

  ok(s.package === pkg, "package name", s.package);
  ok(Number(s.minSdk) === 26, "minSdk is 26", s.minSdk);
  ok(Number(s.targetSdk) >= 35, "targetSdk is current (35 or newer)", s.targetSdk);
  ok(s.application.allowBackup === false, "cloud and device backup is off (allowBackup=false)", s.application.allowBackup);
  ok(s.application.dataExtractionRules !== undefined && s.application.fullBackupContent !== undefined,
    "backup rules files are present for both old and new Android", `${s.application.dataExtractionRules} / ${s.application.fullBackupContent}`);
  if (mode === "release") ok(s.application.debuggable !== true, "the release build is NOT debuggable", s.application.debuggable);
  ok(s.application.requestLegacyExternalStorage !== true, "no legacy external storage access", s.application.requestLegacyExternalStorage);
  ok(s.application.networkSecurityConfig !== undefined, "a network security config is set", s.application.networkSecurityConfig);

  const extra = s.permissions.filter((p) => p !== "android.permission.INTERNET" && p !== `${pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`);
  ok(s.permissions.includes("android.permission.INTERNET"), "the INTERNET permission is requested", "");
  ok(extra.length === 0, "no other permissions are requested", extra.join(", "));

  // exported components: with targetSdk 31+ a component with an intent filter must say exported explicitly, so
  // "exported" here means exported=true, or a filter with no exported attribute at all (old default).
  const exported = s.components.filter((c) => c.exported === true || (c.exported === undefined && c.filters.length > 0));
  const unexpected = exported.filter((c) => c.name !== "net.arcflare.app.MainActivity" && !KNOWN_EXPORTED.has(c.name));
  ok(exported.some((c) => c.name === "net.arcflare.app.MainActivity"), "the launcher activity exists and is exported", "");
  ok(unexpected.length === 0, "nothing else is exported", unexpected.map((c) => `${c.tag} ${c.name}`).join(", "));
  const providers = s.components.filter((c) => c.tag === "provider" && c.exported === true);
  ok(providers.length === 0, "no content provider is exported", providers.map((c) => c.name).join(", "));
  ok(!s.components.some((c) => /FileProvider/.test(String(c.name))), "no file provider", "");

  const main = s.components.find((c) => c.name === "net.arcflare.app.MainActivity");
  const schemes = new Set();
  for (const c of s.components) for (const f of c.filters) for (const d of f.data) if (d.scheme) schemes.add(String(d.scheme).toLowerCase());
  ok([...schemes].every((x) => x === "arcflare"), "the only link scheme anywhere is arcflare:// (no web links)", [...schemes].join(", "));
  if (main) {
    const links = main.filters.filter((f) => f.data.length);
    ok(links.length === 1 && links[0].data.every((d) => d.scheme === "arcflare" && d.host === "pair" && !d.path),
      "the app opens exactly one link: arcflare://pair", JSON.stringify(links.map((f) => f.data)));
    const launcher = main.filters.some((f) => f.actions.includes("android.intent.action.MAIN") && f.categories.includes("android.intent.category.LAUNCHER"));
    ok(launcher, "it has the launcher entry", "");
  }
  return rows;
}

// -------------------------------------------------------------------- main ----

function findAapt2() {
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!root) throw new Error("ANDROID_HOME is not set");
  const bt = path.join(root, "build-tools");
  const versions = fs.readdirSync(bt).filter((v) => /^\d/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions.reverse()) {
    const p = path.join(bt, v, "aapt2");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("aapt2 not found under " + bt);
}

function main(argv) {
  const apk = argv.find((a) => !a.startsWith("--"));
  const mode = argv.includes("--release") ? "release" : argv.includes("--debug") ? "debug" : null;
  const pi = argv.indexOf("--package");
  if (!apk || !mode) { console.error("usage: inspect-apk.js <apk> --debug|--release [--package id]"); return 2; }
  const dump = execFileSync(findAapt2(), ["dump", "xmltree", "--file", "AndroidManifest.xml", apk], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const summary = summarize(parseXmlTree(dump));
  const rows = check(summary, { mode, pkg: pi >= 0 ? argv[pi + 1] : undefined });
  let bad = 0;
  console.log(`\n${path.basename(apk)} (${mode})`);
  for (const r of rows) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.what}${r.detail ? "  [" + r.detail + "]" : ""}`); if (!r.ok) bad++; }
  console.log(bad ? `\n${bad} check(s) failed: the built app does not match what it claims.` : "\nall manifest checks passed");
  return bad ? 1 : 0;
}

module.exports = { parseXmlTree, cleanValue, summarize, check };
if (require.main === module) process.exit(main(process.argv.slice(2)));
