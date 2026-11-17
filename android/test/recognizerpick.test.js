"use strict";
// BEHAVIOUR test of RecognizerPick.java (which recognizer the agent build's assistant hands voice input to). It is pure
// Java, so this compiles the REAL source with javac and runs it. Skipped (loudly) when no JDK is installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "android", "app", "src", "agent", "java", "net", "arcflare", "app", "RecognizerPick.java");
const jdk = spawnSync("javac", ["-version"], { encoding: "utf8" });
const opts = { skip: !jdk.error && jdk.status === 0 ? false : "no JDK (javac) installed: RecognizerPick.java was NOT executed" };

let out;
// Each case is one line: the components joined with ",", "NONE" for an empty list, "NULL" for null. Prints the pick.
function pick(cases) {
  if (!out) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recpick-"));
    const pkg = path.join(dir, "src", "net", "arcflare", "app");
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(SRC, path.join(pkg, "RecognizerPick.java"));
    fs.writeFileSync(path.join(pkg, "Probe.java"), `package net.arcflare.app;
import java.io.*; import java.util.*;
public class Probe { public static void main(String[] a) throws Exception {
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in, "UTF-8")); String l;
  while ((l = r.readLine()) != null) {
    List<String> c = l.equals("NULL") ? null : l.equals("NONE") ? new ArrayList<>() : new ArrayList<>(Arrays.asList(l.split(",", -1)));
    System.out.println(String.valueOf(RecognizerPick.pick(c, "net.arcflare.app.agent")));
  } } }
`);
    out = path.join(dir, "out");
    const c = spawnSync("javac", ["-d", out, path.join(pkg, "RecognizerPick.java"), path.join(pkg, "Probe.java")], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
  }
  const r = spawnSync("java", ["-cp", out, "net.arcflare.app.Probe"], { input: cases.join("\n") + "\n", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
}

const OWN = "net.arcflare.app.agent/net.arcflare.app.ArcRecognitionService";
const GOOGLE = "com.google.android.tts/com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService";
const SAMSUNG = "com.samsung.android.bixby.agent/com.samsung.android.bixby.agent.SpeechRecognitionService";

test("the assistant never hands voice input to itself, prefers Google's recognizer, else any other", opts, () => {
  assert.deepEqual(pick([
    [OWN, SAMSUNG, GOOGLE].join(","),
    [OWN, SAMSUNG].join(","),
    OWN,
    "NONE",
    "NULL",
    ["", "noslash", "pkg/", "/cls", SAMSUNG].join(","),
  ]), [GOOGLE, SAMSUNG, "null", "null", "null", SAMSUNG]);
});
