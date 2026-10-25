"use strict";
// BEHAVIOUR test of the native navigation rule: android/app/src/main/java/net/arcflare/app/NavPolicy.java is pure
// Java (no Android classes), so this test compiles the REAL source with javac and runs it on URL vectors and on a
// fuzz corpus. The invariant checked against an independent implementation (Node's WHATWG URL parser, which parses
// like Chromium does): whatever Java allows must parse to origin https://localhost with no user info.
// Skipped (loudly) when no JDK is installed. MainActivity itself needs the Android SDK and is only linted
// (hygiene.test.js, "native source lint").
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "android", "app", "src", "main", "java", "net", "arcflare", "app", "NavPolicy.java");
const jdk = spawnSync("javac", ["-version"], { encoding: "utf8" });
const haveJdk = !jdk.error && jdk.status === 0;

let dir;
function compile() {
  if (dir) return dir;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "navpolicy-"));
  const pkg = path.join(dir, "src", "net", "arcflare", "app");
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(SRC, path.join(pkg, "NavPolicy.java"));
  fs.writeFileSync(path.join(pkg, "Probe.java"), `package net.arcflare.app;
import java.io.*; import java.util.*; import java.nio.charset.StandardCharsets;
public class Probe { public static void main(String[] a) throws Exception {
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)); String l; StringBuilder out = new StringBuilder();
  while ((l = r.readLine()) != null) { String s = l.equals("NULL") ? null : new String(Base64.getDecoder().decode(l), StandardCharsets.UTF_8); out.append(NavPolicy.allows(s) ? "1" : "0"); }
  System.out.print(out); } }
`);
  const c = spawnSync("javac", ["-d", path.join(dir, "out"), path.join(pkg, "NavPolicy.java"), path.join(pkg, "Probe.java")], { encoding: "utf8" });
  assert.equal(c.status, 0, "javac failed: " + c.stderr);
  return dir;
}
function judge(inputs) {
  const d = compile();
  const stdin = inputs.map((s) => (s === null ? "NULL" : Buffer.from(s, "utf8").toString("base64"))).join("\n") + "\n";
  const r = spawnSync("java", ["-cp", path.join(d, "out"), "net.arcflare.app.Probe"], { input: stdin, encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.length, inputs.length);
  return [...r.stdout].map((c) => c === "1");
}
const opts = { skip: haveJdk ? false : "no JDK (javac) installed: NavPolicy.java was NOT executed" };

const ALLOWED = [
  "https://localhost", "https://localhost/", "https://localhost/index.html", "https://localhost/ui/index.html?via=home",
  "https://localhost/ui/index.html?via=relay", "https://LOCALHOST/x#y", "HTTPS://localhost/", "https://localhost?x=1", "https://localhost#top",
  "https://localhost/webview-error.html",
];
const REFUSED = [
  null, "", "https://", "https:localhost", "https:///localhost/", "//localhost/", "localhost", "https://localhostx/", "https://xlocalhost/", "https://localhost.evil.example/", "https://localhost./",
  "http://localhost/", "http://192.168.1.20:8765/", "http://192.168.1.20:8765", "https://192.168.1.20:8765/", "http://hub.local:8765/",
  "https://localhost:443/", "https://localhost:8443/", "https://localhost:/", "https://localhost@evil.example/", "https://localhost:pw@evil.example/",
  "https://evil.example\\@localhost/", "https://evil.example\\localhost/", "https://localhost\\@evil.example/", "https://localhost/\\evil.example",
  "https://evil.example/https://localhost/", "https://evil.example/?u=https://localhost/", "https://evil.example#https://localhost/",
  "https://localhost/ x", "https://localhost/\tx", "https://localhost/\nx", "https://localhost/\r\nx", "https://localhost\n", " https://localhost/", "https://localhost/ ",
  "https://localhost/\u0000", "https://localhost/\u0001", "https://localhost\u007f/", "https://loc\talhost/", "https://local\nhost/",
  "javascript:alert(1)", "javascript://localhost/%0aalert(1)", "data:text/html,<script>1</script>", "blob:https://localhost/1234", "file:///etc/passwd", "file://localhost/etc/passwd",
  "https://localhost/_capacitor_http_interceptor_", "https://localhost/_capacitor_http_interceptor_?url=http%3A%2F%2F192.168.1.20%3A8765%2Fapi%2Ftunnel",
  "https://localhost/_Capacitor_HTTP_Interceptor_?url=x", "https://localhost/%5Fcapacitor_http_interceptor_?url=x", "https://localhost/_capacitor%5Fhttp%5Finterceptor%5F?url=x",
  "https://localhost/./_capacitor_http_interceptor_", "https://localhost/x/../_capacitor_http_interceptor_?url=x", "https://localhost//_capacitor_http_interceptor_", "https://localhost/_capacitor_http_interceptor_/x", "https://localhost/ui/_capacitor_http_interceptor_", "https://localhost?q=/_capacitor_http_interceptor_",
  "https://localhost/_%63apacitor_http_interceptor_?u=x", "https://localhost/_%43apacitor_http_interceptor_?u=x", "https://localhost/_capacitor_https_interceptor_?u=x", "https://localhost/%255Fcapacitor_http_interceptor_?u=x", "https://localhost/_%2563apacitor_http_interceptor_?u=x", "https://localhost/%5f%63apacitor_http_interceptor_?u=x", "https://localhost/_capacitor_http_interceptor%5f?u=x",
  "about:blank", "intent://x#Intent;scheme=https;end", "content://x", "market://details?id=x", "arcflare://pair?v=1", "ftp://localhost/", "wss://localhost/", "view-source:https://localhost/",
];

test("NavPolicy.java: Capacitor's http interceptor path is refused in every spelling, ordinary paths with similar words stay allowed", opts, () => {
  const ok = ["https://localhost/capacitor.js", "https://localhost/ui/index.html?via=home", "https://localhost/_capacitor"];
  assert.deepEqual(judge(ok), ok.map(() => true));
});

test("NavPolicy.java: the bundled origin is allowed", opts, () => {
  assert.deepEqual(judge(ALLOWED), ALLOWED.map(() => true));
});

test("NavPolicy.java: everything else is refused (cleartext hub, LAN, other hosts, ports, user info, backslash tricks, control characters, other schemes, null)", opts, () => {
  const got = judge(REFUSED);
  REFUSED.forEach((u, i) => assert.equal(got[i], false, "must refuse " + JSON.stringify(u)));
});

test("NavPolicy.java is consistent with a WHATWG URL parser: every vector it allows has origin https://localhost and no user info", opts, () => {
  const got = judge(ALLOWED);
  ALLOWED.forEach((u, i) => { assert.ok(got[i]); const p = new URL(u); assert.equal(p.origin, "https://localhost"); assert.equal(p.username + p.password, ""); });
});

test("NavPolicy.java fuzz: 30000 generated URLs, anything allowed parses (like Chromium) to origin https://localhost with no user info", opts, () => {
  const frags = ["https://", "http://", "HTTPS://", "localhost", "LocalHost", "evil.example", "192.168.1.20", ":8765", ":443", ":", "@", "\\", "/", "//", "?", "#", "\t", "\n", "\r", " ", ".", "%2e", "%40", "%5c", "\u0000", "\u007f", "​", " ", "x", "..", "user:pw", "[::1]", "0", "_capacitor_http_interceptor_", "%5F", "_capacitor"];
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const inputs = [];
  for (let i = 0; i < 30000; i++) {
    let s = i % 3 === 0 ? "https://localhost" : i % 3 === 1 ? "https://" : "";
    for (let k = 1 + rnd(7); k > 0; k--) s += frags[rnd(frags.length)];
    inputs.push(s);
  }
  const got = judge(inputs);
  let allowed = 0;
  inputs.forEach((s, i) => {
    if (!got[i]) return;
    allowed++;
    let p; try { p = new URL(s); } catch (e) { assert.fail("allowed but unparsable: " + JSON.stringify(s)); }
    assert.equal(p.origin, "https://localhost", JSON.stringify(s));
    assert.equal(p.username + p.password, "", JSON.stringify(s));
    // JS mirror of the interceptor rule: nothing allowed may normalise to Capacitor's http-interceptor path
    // decode repeatedly, as NavPolicy.decode does (%2563 -> %63 -> c); stray % stays literal
    let dec = p.pathname, prev;
    for (let n = 0; n < 5 && dec !== prev; n++) { prev = dec; dec = dec.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
    assert.ok(!/_capacitor_https?_interceptor_/i.test(dec), "interceptor path allowed: " + JSON.stringify(s));
  });
  assert.ok(allowed > 100, "the corpus must exercise the allowed branch too (" + allowed + ")");
});

test("NavPolicy.java exists and has no Android dependency (so it can be run here)", () => {
  const src = fs.readFileSync(SRC, "utf8");
  assert.doesNotMatch(src, /import android\.|import com\.getcapacitor/);
});
