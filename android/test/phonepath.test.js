"use strict";
// BEHAVIOUR test of the paths the agent's file tools accept: PhonePath.java is pure Java, so this compiles the REAL
// source with javac and runs it. PhoneFilesPlugin (needs the Android SDK) is compile-checked by the build, not here.
// Skipped (loudly) when no JDK is installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "android", "app", "src", "agent", "java", "net", "arcflare", "app", "PhonePath.java");
const jdk = spawnSync("javac", ["-version"], { encoding: "utf8" });
const opts = { skip: !jdk.error && jdk.status === 0 ? false : "no JDK (javac) installed: PhonePath.java was NOT executed" };

let out;
// One path per line. The literal line NULL is a null path. Prints "null", "(root)" or the pieces joined with "|".
function run(paths) {
  if (!out) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonepath-"));
    const pkg = path.join(dir, "src", "net", "arcflare", "app");
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(SRC, path.join(pkg, "PhonePath.java"));
    fs.writeFileSync(path.join(pkg, "Probe.java"), `package net.arcflare.app;
import java.io.*;
public class Probe { public static void main(String[] a) throws Exception {
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in, "UTF-8")); String l;
  while ((l = r.readLine()) != null) {
    String[] s = PhonePath.split(l.equals("NULL") ? null : l);
    System.out.println(s == null ? "null" : s.length == 0 ? "(root)" : String.join("|", s));
  } } }
`);
    out = path.join(dir, "out");
    const c = spawnSync("javac", ["-d", out, path.join(pkg, "PhonePath.java"), path.join(pkg, "Probe.java")], { encoding: "utf8" });
    assert.equal(c.status, 0, "javac failed: " + c.stderr);
  }
  const r = spawnSync("java", ["-cp", out, "net.arcflare.app.Probe"], { input: paths.map((p) => p + "\n").join(""), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").slice(0, paths.length);
}

const same = (name, n) => name.repeat(n);

test("PhonePath.java: null, empty, slash and dot all mean the picked folder itself", opts, () => {
  assert.deepEqual(run(["NULL", "", "/", "."]), ["(root)", "(root)", "(root)", "(root)"]);
});

test("PhonePath.java: plain relative paths are split into their names, in order", opts, () => {
  assert.deepEqual(run(["notes.txt", "a/b/c.txt"]), ["notes.txt", "a|b|c.txt"]);
});

test("PhonePath.java: leading, trailing and doubled slashes are dropped", opts, () => {
  assert.deepEqual(run(["/a//b/", "a/b/", "//", "//a"]), ["a|b", "a|b", "(root)", "a"]);
});

test("PhonePath.java: refuses dot segments, backslashes, control characters and stray whitespace", opts, () => {
  const bad = ["..", "a/../b", "./a", "a/./b", "a\\b", "a\tb", "a\u0001b", "a\u007fb", " a", "a ", "a/ b", "a/b "];
  assert.deepEqual(run(bad), bad.map(() => "null"));
});

test("PhonePath.java: refuses a name over 255 characters and a path over 1024 characters", opts, () => {
  assert.deepEqual(run([same("n", 256), "a/" + same("n", 256), same("a", 1025)]), ["null", "null", "null"]);
});

test("PhonePath.java: refuses more than 32 segments", opts, () => {
  const thirtyThree = Array(33).fill("a").join("/");
  assert.deepEqual(run([thirtyThree]), ["null"]);
});

test("PhonePath.java: accepts a 255-character name, exactly 32 segments and a 1023-character path", opts, () => {
  const name255 = same("n", 255);
  const thirtyTwo = Array.from({ length: 32 }, (_, i) => "s" + i);
  const long = [same("a", 255), same("b", 255), same("c", 255), same("d", 255)].join("/");
  assert.equal(long.length, 1023);
  assert.deepEqual(run([name255, thirtyTwo.join("/"), long]), [name255, thirtyTwo.join("|"), [same("a", 255), same("b", 255), same("c", 255), same("d", 255)].join("|")]);
});
