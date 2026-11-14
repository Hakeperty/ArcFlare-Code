#!/usr/bin/env node
// Puts a release APK on the website so phones can update without a computer (OnlineUpdate.java reads
// arcflare.net/downloads/android.json). Copies the APK into the site repo's public/downloads and writes its .sha256
// and android.json; then commit and push the site.
//
//   node scripts/site-publish.js <signed.apk> <site repo> --version-code N --version-name 1.0.N
//   (build-apk.js --release --site <site repo> does the same after building)
//
// Only an APK signed with the release key belongs here: phones refuse any other as an update.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function publishToSite(apk, siteDir, { versionCode, versionName }) {
  if (!Number.isInteger(versionCode) || versionCode < 1) throw new Error("--version-code must be a positive integer");
  if (!/^[0-9][0-9.]{0,30}$/.test(String(versionName))) throw new Error("--version-name must look like 1.0.123");
  const dl = path.join(siteDir, "public", "downloads");
  if (!fs.existsSync(dl)) throw new Error(`${dl} does not exist: give the path of the ArcFlare site repo`);
  const old = path.join(dl, "android.json");
  if (fs.existsSync(old) && JSON.parse(fs.readFileSync(old, "utf8")).versionCode >= versionCode) throw new Error(`the site already offers version code ${versionCode} or newer`);
  const file = `ArcFlare-android-${versionName}.apk`;
  const buf = fs.readFileSync(apk);
  if (buf.length < 1024 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${apk} is not an APK`);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(path.join(dl, file), buf);
  fs.writeFileSync(path.join(dl, file + ".sha256"), `${sha256}  ${file}\n`);
  const manifest = { versionCode, versionName, apk: file, size: buf.length, sha256 };
  fs.writeFileSync(old, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

module.exports = { publishToSite };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
  try {
    if (argv.length < 2 || argv[0].startsWith("--")) throw new Error("usage: site-publish.js <signed.apk> <site repo> --version-code N --version-name 1.0.N");
    const m = publishToSite(argv[0], argv[1], { versionCode: Number(opt("--version-code")), versionName: opt("--version-name") });
    console.log(`  on the site: public/downloads/${m.apk} (${m.size} bytes, sha256 ${m.sha256})\n  commit and push the site repo; phones see it at arcflare.net/downloads/android.json`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
