"use strict";
// BEHAVIOUR test of what the app accepts from arcflare.net/downloads/android.json: OnlineUpdate.java is pure Java, so
// this compiles the REAL source with javac and runs it. AppUpdaterPlugin (needs the Android SDK) is linted in
// hygiene.test.js. Skipped (loudly) when no JDK is installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "android", "app", "src", "main", "java", "net", "arcflare", "app", "OnlineUpdate.java");
const jdk = spawnSync("javac", ["-version"], { encoding: "utf8" });
const opts = { skip: !jdk.error && jdk.status === 0 ? false : "no JDK (javac) installed: OnlineUpdate.java was NOT executed" };

let out;
function run(lines) {
  if (!out) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onlineupdate-"));
    const pkg = path.join(dir, "src", "net", "arcflare", "app");
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(SRC, path.join(pkg, "OnlineUpdate.java"));
    // One case per line, tab separated: versionCode, apk (NULL for null), size, sha256 (NULL for null), chat or agent.
    fs.writeFileSync(path.join(pkg, "Probe.java"), `package net.arcflare.app;
import java.io.*;
public class Probe { public static void main(String[] a) throws Exception {
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in, "UTF-8")); String l;
  System.out.println(OnlineUpdate.manifest(false) + " " + OnlineUpdate.manifest(true) + " " + OnlineUpdate.apkUrl("ArcFlare-android-1.0.1.apk"));
  while ((l = r.readLine()) != null) { String[] f = l.split("\\t", -1); String p = OnlineUpdate.problem(Long.parseLong(f[0]), f[1].equals("NULL") ? null : f[1], Long.parseLong(f[2]), f[3].equals("NULL") ? null : f[3], f[4].equals("agent"));
    System.out.println(p == null ? "ok" : p); } } }
`);
    out = path.join(dir, "out");
    const c = spawnSync("javac", ["-d", out, path.join(pkg, "OnlineUpdate.java"), path.join(pkg, "Probe.java")], { encoding: "utf8" });
    assert.equal(c.status, 0, "javac failed: " + c.stderr);
  }
  const r = spawnSync("java", ["-cp", out, "net.arcflare.app.Probe"], { input: lines.map((l) => l.join("\t") + "\n").join(""), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
}
const SHA = "a".repeat(64), APK = "ArcFlare-android-1.0.450271.apk", AGENT_APK = "ArcFlare-Agent-android-1.0.450271.apk";
const CHAT = "chat", AGENT = "agent";

test("OnlineUpdate.java: the addresses are arcflare.net/downloads only, one manifest per app", opts, () => {
  assert.equal(run([])[0], "https://arcflare.net/downloads/android.json https://arcflare.net/downloads/android-agent.json https://arcflare.net/downloads/ArcFlare-android-1.0.1.apk");
});

test("OnlineUpdate.java: a well-formed manifest passes, anything else names what is wrong", opts, () => {
  const cases = [
    [[450271, APK, 3549285, SHA, CHAT], "ok"],
    [[1, "ArcFlare-android-2.apk", 1024, SHA, CHAT], "ok"],
    [[0, APK, 3549285, SHA, CHAT], "bad versionCode"],
    [[-5, APK, 3549285, SHA, CHAT], "bad versionCode"],
    [[2147483648, APK, 3549285, SHA, CHAT], "bad versionCode"],
    [[2, "NULL", 3549285, SHA, CHAT], "bad apk name"],
    ...["../ArcFlare-android-1.apk", "ArcFlare-android-1.apk?x=1", "https://evil.example/ArcFlare-android-1.apk", "sub/ArcFlare-android-1.apk", "ArcFlare-android-.apk",
      "ArcFlare-android-1.apk/", "arcflare-android-1.apk", "ArcFlare-android-1.APK", "ArcFlare-android-1.apk\u0000", "evil.apk", "ArcFlare-android-1.zip", "ArcFlare-android-1 .apk",
      "ArcFlare-android-" + "1".repeat(40) + ".apk"].map((n) => [[2, n, 3549285, SHA, CHAT], "bad apk name"]),
    [[2, APK, 1023, SHA, CHAT], "bad size"],
    [[2, APK, 200 * 1024 * 1024 + 1, SHA, CHAT], "bad size"],
    [[2, APK, -1, SHA, CHAT], "bad size"],
    [[2, APK, 3549285, "NULL", CHAT], "bad sha256"],
    [[2, APK, 3549285, "A".repeat(64), CHAT], "bad sha256"],
    [[2, APK, 3549285, "a".repeat(63), CHAT], "bad sha256"],
    [[2, APK, 3549285, "g".repeat(64), CHAT], "bad sha256"],
  ];
  const got = run(cases.map((c) => c[0])).slice(1);
  assert.deepEqual(got, cases.map((c) => c[1]));
});

test("OnlineUpdate.java: the agent app takes only ArcFlare-Agent-android names, the chat app only ArcFlare-android", opts, () => {
  const cases = [
    [[450271, AGENT_APK, 3549285, SHA, AGENT], "ok"],
    [[1, "ArcFlare-Agent-android-2.apk", 1024, SHA, AGENT], "ok"],
    [[450271, APK, 3549285, SHA, AGENT], "bad apk name"],
    [[450271, AGENT_APK, 3549285, SHA, CHAT], "bad apk name"],
    [[450271, "ArcFlare-android-1.0.1.apk", 3549285, SHA, AGENT], "bad apk name"],
    [[450271, "ArcFlare-Agent-android-1.0.1.apk", 3549285, SHA, CHAT], "bad apk name"],
    [[450271, "ArcFlare-Agent-android-1.apk", 3549285, SHA, AGENT], "ok"],
    [[0, AGENT_APK, 3549285, SHA, AGENT], "bad versionCode"],
    [[2, AGENT_APK, 1023, SHA, AGENT], "bad size"],
    [[2, AGENT_APK, 3549285, "NULL", AGENT], "bad sha256"],
    [[2, "NULL", 3549285, SHA, AGENT], "bad apk name"],
    ...["../ArcFlare-Agent-android-1.0.1.apk", "ArcFlare-Agent-android-1.0.1.apk/../x", "ArcFlare-Agent-android-1.0.1.apk?x=1",
      "https://evil.example/ArcFlare-Agent-android-1.apk", "sub/ArcFlare-Agent-android-1.apk", "ArcFlare-Agent-android-.apk",
      "ArcFlare-Agent-android-1.0.1.apk/", "arcflare-agent-android-1.apk", "ArcFlare-Agent-android-1.APK", "ArcFlare-Agent-android-1.apk\u0000",
      "ArcFlare-Agent-android-1 .apk", "ArcFlare-Agent-android-" + "1".repeat(40) + ".apk"].map((n) => [[2, n, 3549285, SHA, AGENT], "bad apk name"]),
  ];
  const got = run(cases.map((c) => c[0])).slice(1);
  assert.deepEqual(got, cases.map((c) => c[1]));
});
