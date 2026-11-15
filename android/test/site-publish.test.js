"use strict";
// scripts/site-publish.js: what the website serves to phones that update without a computer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { publishToSite } = require("../scripts/site-publish.js");

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  fs.mkdirSync(path.join(dir, "public", "downloads"), { recursive: true });
  const apk = path.join(dir, "app-release.apk");
  fs.writeFileSync(apk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(4000)]));
  return { dir, apk, dl: path.join(dir, "public", "downloads") };
}

test("writes the APK, its .sha256 and android.json in the shape OnlineUpdate.java accepts", () => {
  const s = site();
  const m = publishToSite(s.apk, s.dir, { versionCode: 457800, versionName: "1.0.457800" });
  const sha = crypto.createHash("sha256").update(fs.readFileSync(s.apk)).digest("hex");
  assert.deepEqual(m, { versionCode: 457800, versionName: "1.0.457800", apk: "ArcFlare-android-1.0.457800.apk", size: 4004, sha256: sha });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dl, "android.json"), "utf8")), m);
  assert.ok(fs.readFileSync(path.join(s.dl, m.apk)).equals(fs.readFileSync(s.apk)));
  assert.equal(fs.readFileSync(path.join(s.dl, m.apk + ".sha256"), "utf8"), `${sha}  ${m.apk}\n`);
  assert.match(m.apk, /^ArcFlare-android-[0-9][0-9.]{0,30}\.apk$/, "the name OnlineUpdate.problem() allows");
});

test("refuses an older or equal version, a non-APK, a wrong folder and a bad version", () => {
  const s = site();
  publishToSite(s.apk, s.dir, { versionCode: 10, versionName: "1.0.10" });
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 10, versionName: "1.0.10" }), /already offers/);
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 9, versionName: "1.0.9" }), /already offers/);
  const txt = path.join(s.dir, "x.apk"); fs.writeFileSync(txt, "x".repeat(5000));
  assert.throws(() => publishToSite(txt, s.dir, { versionCode: 11, versionName: "1.0.11" }), /not an APK/);
  assert.throws(() => publishToSite(s.apk, os.tmpdir(), { versionCode: 11, versionName: "1.0.11" }), /does not exist/);
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 11, versionName: "../x" }), /version-name/);
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 1.5, versionName: "1.0.11" }), /version-code/);
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 2147483648, versionName: "1.0.11" }), /version-code/);
  const big = path.join(s.dir, "big.apk");
  fs.writeFileSync(big, Buffer.alloc(200 * 1024 * 1024 + 1)); fs.writeFileSync(big, Buffer.from([0x50, 0x4b, 0x03, 0x04]), { flag: "r+" });
  assert.throws(() => publishToSite(big, s.dir, { versionCode: 11, versionName: "1.0.11" }), /larger than the 200 MB/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dl, "android.json"), "utf8")).versionCode, 10, "a refused publish changes nothing");
});

test("--agent writes the ArcFlare Agent APK, its .sha256 and android-agent.json, within the limits for the agent app", () => {
  const s = site();
  const m = publishToSite(s.apk, s.dir, { versionCode: 457800, versionName: "1.0.457800", agent: true });
  const sha = crypto.createHash("sha256").update(fs.readFileSync(s.apk)).digest("hex");
  assert.deepEqual(m, { versionCode: 457800, versionName: "1.0.457800", apk: "ArcFlare-Agent-android-1.0.457800.apk", size: 4004, sha256: sha });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dl, "android-agent.json"), "utf8")), m);
  assert.ok(fs.readFileSync(path.join(s.dl, m.apk)).equals(fs.readFileSync(s.apk)));
  assert.equal(fs.readFileSync(path.join(s.dl, m.apk + ".sha256"), "utf8"), `${sha}  ${m.apk}\n`);
  // The limits OnlineUpdate.problem() applies for the agent app (agent = true).
  assert.match(m.apk, /^ArcFlare-Agent-android-[0-9][0-9.]{0,30}\.apk$/, "the agent name OnlineUpdate.problem() allows");
  assert.ok(m.size >= 1024 && m.size <= 200 * 1024 * 1024, "the size range OnlineUpdate.problem() allows");
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(s.dl, "android.json")), false, "an agent publish writes no chat manifest");
});

test("--agent: an existing android.json with a higher version code does not block the agent publish", () => {
  const s = site();
  fs.writeFileSync(path.join(s.dl, "android.json"), JSON.stringify({ versionCode: 900000 }));
  const m = publishToSite(s.apk, s.dir, { versionCode: 10, versionName: "1.0.10", agent: true });
  assert.equal(m.versionCode, 10);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dl, "android-agent.json"), "utf8")).versionCode, 10);
});

test("--agent: an existing android-agent.json with the same or a higher version code blocks the agent publish", () => {
  const s = site();
  publishToSite(s.apk, s.dir, { versionCode: 10, versionName: "1.0.10", agent: true });
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 10, versionName: "1.0.10", agent: true }), /already offers/);
  assert.throws(() => publishToSite(s.apk, s.dir, { versionCode: 9, versionName: "1.0.9", agent: true }), /already offers/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dl, "android-agent.json"), "utf8")).versionCode, 10, "a refused publish changes nothing");
});

test("--agent leaves android.json and the chat APK untouched, byte for byte", () => {
  const s = site();
  const chat = publishToSite(s.apk, s.dir, { versionCode: 10, versionName: "1.0.10" });
  const manifestBefore = fs.readFileSync(path.join(s.dl, "android.json"));
  const apkBefore = fs.readFileSync(path.join(s.dl, chat.apk));
  const shaBefore = fs.readFileSync(path.join(s.dl, chat.apk + ".sha256"));
  publishToSite(s.apk, s.dir, { versionCode: 11, versionName: "1.0.11", agent: true });
  assert.ok(fs.readFileSync(path.join(s.dl, "android.json")).equals(manifestBefore), "android.json unchanged");
  assert.ok(fs.readFileSync(path.join(s.dl, chat.apk)).equals(apkBefore), "chat APK unchanged");
  assert.ok(fs.readFileSync(path.join(s.dl, chat.apk + ".sha256")).equals(shaBefore), "chat .sha256 unchanged");
});
