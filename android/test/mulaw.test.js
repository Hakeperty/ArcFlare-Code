"use strict";
// The call recordings' WAV writer (MuLawWav.java, pure Java) compiled with javac and checked against an
// independent G.711 mu-law decoder: the header must be readable and every sample must decode close to what went in.
// Skipped (loudly) when no JDK is installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "android", "app", "src", "main", "java", "net", "arcflare", "app", "MuLawWav.java");
const jdk = spawnSync("javac", ["-version"], { encoding: "utf8" });

// G.711 decode, written from the standard, not from the Java.
function decode(u) {
  u = ~u & 0xff;
  const t = ((u & 0x0f) << 3) + 0x84 << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

test("call recordings: a valid mu-law WAV whose samples decode to what was recorded", { skip: jdk.status !== 0 && "no JDK" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mulaw-"));
  const pkg = path.join(dir, "net", "arcflare", "app");
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(SRC, path.join(pkg, "MuLawWav.java"));
  const input = [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 32767, -32768, 12345, -23456];
  fs.writeFileSync(path.join(pkg, "Probe.java"), `package net.arcflare.app;
public class Probe { public static void main(String[] a) throws Exception {
  MuLawWav w = new MuLawWav(new java.io.File(a[0]));
  short[] s = { ${input.join(", ")} };
  w.write(s, 7); w.write(java.util.Arrays.copyOfRange(s, 7, s.length), s.length - 7); w.close(); } }
`);
  const c = spawnSync("javac", ["-d", dir, path.join(pkg, "MuLawWav.java"), path.join(pkg, "Probe.java")], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  const file = path.join(dir, "out.wav");
  const r = spawnSync("java", ["-cp", dir, "net.arcflare.app.Probe", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const b = fs.readFileSync(file);
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.toString("ascii", 8, 16), "WAVEfmt ");
  assert.deepEqual([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)], [7, 1, 16000, 8]);
  assert.equal(b.toString("ascii", 38, 42), "fact");
  assert.equal(b.readUInt32LE(46), input.length);
  assert.equal(b.toString("ascii", 50, 54), "data");
  assert.equal(b.readUInt32LE(54), input.length);
  input.forEach((x, i) => {
    const y = decode(b[58 + i]);
    // mu-law keeps about 4 bits of mantissa: the error grows with the level.
    assert.ok(Math.abs(y - x) <= Math.max(8, Math.abs(x) / 16), `sample ${x} decoded as ${y}`);
  });
});
