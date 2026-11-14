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
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dl, "android.json"), "utf8")).versionCode, 10, "a refused publish changes nothing");
});
