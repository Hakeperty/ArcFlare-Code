"use strict";
// Storage hygiene (real scans of the shell sources) and "native source lint": greps over files nobody can compile here.
// A grep cannot catch an inverted condition; the navigation RULE itself is tested by running it (navpolicy.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const www = path.join(root, "www");
const native = path.join(root, "android", "app", "src", "main");
const read = (p) => fs.readFileSync(p, "utf8");
const shellFiles = fs.readdirSync(www).filter((f) => f.endsWith(".js") || f.endsWith(".html") || f.endsWith(".css")).map((f) => path.join(www, f));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");

test("the shell has sources to scan", () => assert.ok(shellFiles.length >= 10));

test("shell sources never use localStorage/sessionStorage (except .clear() when wiping)", () => {
  for (const f of shellFiles) {
    const code = strip(read(f));
    for (const m of code.matchAll(/\b(localStorage|sessionStorage)\b(?!\s*\.\s*clear\s*\(\s*\))/g)) assert.fail(`${path.basename(f)} uses ${m[0]}`);
  }
});

test("shell sources contain no console.* calls, no document.cookie, no history/URL writes of data", () => {
  for (const f of shellFiles) {
    const code = strip(read(f));
    assert.doesNotMatch(code, /\bconsole\s*\./, `${path.basename(f)} calls console`);
    assert.doesNotMatch(code, /document\s*\.\s*cookie/, `${path.basename(f)} touches document.cookie`);
    assert.doesNotMatch(code, /history\s*\.\s*(push|replace)State/, `${path.basename(f)} writes history`);
    assert.doesNotMatch(code, /location\s*\.\s*(hash|search)\s*=/, `${path.basename(f)} writes the URL`);
    assert.doesNotMatch(code, /\balert\s*\(|\bprompt\s*\(/, `${path.basename(f)} uses a dialog`);
  }
});

test("shell sources navigate only to the bundled UI (shell.js calls Native.navigate with two literal paths; nothing else navigates)", () => {
  const code = strip(read(path.join(www, "shell.js")));
  const navs = [...code.matchAll(/Native\.navigate\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(navs.sort(), ['"ui/index.html?via=home"', '"ui/index.html?via=relay"']);
  for (const f of shellFiles) {
    const c = strip(read(f));
    assert.doesNotMatch(c, /window\.open|location\.href\s*=|location\.replace\(|NavGuard|setLan|navigate\(\s*rec\./, path.basename(f));
  }
  // location.assign appears exactly once in the whole shell: inside Native.navigate (behaviour covered in native.test.js)
  const assigns = shellFiles.flatMap((f) => [...strip(read(f)).matchAll(/location\.assign\(/g)].map(() => path.basename(f)));
  assert.deepEqual(assigns, ["native.js"]);
});

test("no inline script or style in shell pages (CSP forbids them)", () => {
  for (const f of [path.join(www, "index.html")]) {
    const html = read(f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handler");
  }
});

test("CSP meta is present on the shell and equals the specified policy", () => {
  const want = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; base-uri 'none'; form-action 'none'";
  assert.ok(read(path.join(www, "index.html")).includes(`content="${want}"`));
  assert.equal(require("../scripts/sync-ui.js").CSP, want);
});

test("the pairing secret is only handled by link.js (validation, canonical link) and connector.js (handing it to pair())", () => {
  for (const f of shellFiles.filter((f) => f.endsWith(".js"))) {
    const code = strip(read(f));
    const uses = [...code.matchAll(/\.secret\b|\bps\b\s*[=:]|\bsas\b/gi)].length;
    const base = path.basename(f);
    if (["link.js", "connector.js"].includes(base)) continue;
    if (base === "shell.js") { assert.doesNotMatch(code, /\.secret\b/, "shell.js never reads the secret"); continue; }
    assert.equal(uses, 0, base + " touches the pairing secret or SAS");
  }
  const store = strip(read(path.join(www, "store.js")));
  assert.doesNotMatch(store, /\bsecret\b|\.ps\b|\bsas\b/i);
  // the device record the shell stores is built from fixed fields only (store.save)
  assert.match(store, /v: device\.v, relay: bases\.relay/);
});

test("the copied tunnel client (key owner) does not use Web Storage or console", () => {
  const f = path.join(www, "ui", "tunnel-client.js");
  assert.ok(fs.existsSync(f), "run scripts/sync-ui.js first");
  const code = strip(read(f));
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  assert.match(code, /generateKey\(\{ name: "X25519" \}, false,/, "device key must be generated non-extractable");
});

test("bundled UI page: CSP meta, and transport scripts run BEFORE app.js", () => {
  const html = read(path.join(www, "ui", "index.html"));
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["tunnel-client.js", "../vendor/capacitor.js", "../link.js", "../mode.js", "../native.js", "../lanfetch.js", "../store.js", "../connector.js", "../transport.js", "../relay-boot.js", "app.js", "../relay-chip.js"]);
});

// ---------------------------------------------------------------- native lint

test("manifest: allowBackup=false, rules files, networkSecurityConfig, no debuggable, one exported component", () => {
  const m = read(path.join(native, "AndroidManifest.xml"));
  assert.match(m, /android:allowBackup="false"/);
  assert.match(m, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(m, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(m, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.doesNotMatch(m, /android:debuggable/);
  assert.doesNotMatch(m, /<provider|<service|<receiver/);
  assert.equal([...m.matchAll(/android:exported="true"/g)].length, 1);
  assert.equal([...m.matchAll(/<activity\b/g)].length, 1);
  assert.match(m, /android:exported="true"[\s\S]*<\/activity>/);
  // intent filter: arcflare://pair only, never https app links
  assert.match(m, /<data android:scheme="arcflare" android:host="pair" \/>/);
  assert.doesNotMatch(m, /android:autoVerify|android:scheme="https?"/);
  assert.equal([...m.matchAll(/<uses-permission/g)].length, 1);
  assert.match(m, /android\.permission\.INTERNET/);
});

test("backup rule files exclude every domain", () => {
  const de = read(path.join(native, "res", "xml", "data_extraction_rules.xml"));
  const bk = read(path.join(native, "res", "xml", "backup_rules.xml"));
  for (const d of ["root", "file", "database", "sharedpref", "external"]) {
    assert.equal([...de.matchAll(new RegExp(`<exclude domain="${d}"`, "g"))].length, 2, d + " (cloud + transfer)");
    assert.match(bk, new RegExp(`<exclude domain="${d}"`));
  }
  assert.doesNotMatch(de + bk, /<include/);
});

test("capacitor config: debugging off, logging off, no navigation allow-list, no http/cookie patching, WebView >= 133 with an error page", () => {
  const c = JSON.parse(read(path.join(root, "capacitor.config.json")));
  assert.equal(c.android.webContentsDebuggingEnabled, false);
  assert.equal(c.android.allowMixedContent, false);
  assert.equal(c.android.minWebViewVersion, 133, "Capacitor 8 key android.minWebViewVersion (X25519 needs Chromium 133)");
  assert.equal(c.loggingBehavior, "none");
  assert.equal(c.server.androidScheme, "https");
  assert.equal(c.server.allowNavigation, undefined);
  assert.equal(c.server.url, undefined);
  assert.equal(c.plugins.CapacitorHttp.enabled, false);
  assert.equal(c.plugins.CapacitorCookies.enabled, false);
  // Without server.errorPath Capacitor only LOGS that the WebView is too old and loads the app anyway.
  assert.equal(c.server.errorPath, "webview-error.html");
  const err = read(path.join(www, c.server.errorPath));
  assert.doesNotMatch(err, /<script/i);
  assert.match(err, /Content-Security-Policy/);
  assert.match(err, /133/);
});

test("gradle: minSdk 26, release not debuggable, signing only from environment", () => {
  assert.match(read(path.join(root, "android", "variables.gradle")), /minSdkVersion = 26/);
  const g = read(path.join(root, "android", "app", "build.gradle"));
  assert.match(g, /debuggable false/);
  assert.match(g, /System\.getenv\("ARCFLARE_KEYSTORE"\)/);
  assert.doesNotMatch(g, /storePassword\s+["'][^"']+["']/);
});

test("native source lint (greps only, cannot catch an inverted condition): MainActivity and NavPolicy", () => {
  const dir = path.join(native, "java", "net", "arcflare", "app");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["MainActivity.java", "NavPolicy.java"], "no NavGuard plugin any more");
  const main = read(path.join(dir, "MainActivity.java"));
  const java = main + read(path.join(dir, "NavPolicy.java"));
  assert.match(main, /FLAG_SECURE/);
  assert.match(main, /setAllowFileAccess\(false\)/);
  assert.match(main, /setAllowContentAccess\(false\)/);
  assert.match(main, /setImportantForAutofill\(View\.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS\)/);
  // both shouldOverrideUrlLoading overloads block exactly what NavPolicy does not allow
  assert.equal([...main.matchAll(/public boolean shouldOverrideUrlLoading\(/g)].length, 2);
  assert.equal([...main.matchAll(/return !NavPolicy\.allows\(/g)].length, 2);
  // main-frame requests (POST, history) are judged before they hit the network; page start/finish re-check
  assert.match(main, /shouldInterceptRequest[\s\S]*isForMainFrame\(\) && !NavPolicy\.allows\(/);
  assert.match(main, /onPageStarted[\s\S]*if \(!NavPolicy\.allows\(url\)\)[\s\S]*loadUrl\(NavPolicy\.START\)/);
  assert.match(main, /onPageFinished[\s\S]*if \(!NavPolicy\.allows\(url\)\)[\s\S]*loadUrl\(NavPolicy\.START\)/);
  assert.match(main, /bridge\.setWebViewClient\(new GuardedClient\(bridge\)\)/);
  // there is no way to add an exception, no plugin, no settable state
  assert.doesNotMatch(java, /registerPlugin|@CapacitorPlugin|@PluginMethod|setLan|lanOrigin|static\s+(volatile\s+)?String\s+\w+\s*=\s*null/);
  assert.doesNotMatch(java, /addJavascriptInterface|@JavascriptInterface|setWebContentsDebuggingEnabled\(true\)|android\.util\.Log|\bLog\.|System\.out|printStackTrace/);
  assert.doesNotMatch(java, /startActivity|ACTION_VIEW|launchIntent/, "external links must open nothing");
  assert.equal(read(path.join(native, "res", "layout", "activity_main.xml")).includes('android:importantForAutofill="noExcludeDescendants"'), true);
});

test("native source lint: cleartext is allowed only in the network security config, and the plain-HTTP page path is gone from the project", () => {
  const nsc = read(path.join(native, "res", "xml", "network_security_config.xml"));
  assert.match(nsc, /cleartextTrafficPermitted="true"/);
  assert.match(nsc, /cannot be narrowed to private addresses/);
  // no code path loads a hub page: no probe, no LAN navigation, no pin
  for (const f of shellFiles) assert.doesNotMatch(strip(read(f)), /probeLan|looksLikeHub|\/api\/status|httpGet|setLan|NavGuard/, path.basename(f));
  assert.doesNotMatch(read(path.join(root, "scripts", "sync-ui.js")), /NavGuard|setLan/);
});

test("network security config trusts system CAs only", () => {
  const n = read(path.join(native, "res", "xml", "network_security_config.xml"));
  assert.match(n, /<certificates src="system" \/>/);
  assert.doesNotMatch(n, /src="user"|debug-overrides/);
});

test("no keystore, key or local.properties is tracked in the project tree", () => {
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".gradle" || e.name === "build") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jks|keystore|p12|pem)$|^local\.properties$|keystore.*\.b64$/.test(e.name)) bad.push(p);
    }
  })(root);
  assert.deepEqual(bad, []);
});

test("sync-ui transformIndex refuses a page it does not understand", () => {
  const { transformIndex, SyncError } = require("../scripts/sync-ui.js");
  assert.throws(() => transformIndex("<html><head><meta charset=\"utf-8\"></head></html>"), SyncError);
});
