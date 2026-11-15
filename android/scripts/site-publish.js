#!/usr/bin/env node
// Puts a release APK on the website so phones can update without a computer (OnlineUpdate.java reads
// arcflare.net/downloads/android.json). Copies the APK into the site repo's public/downloads and writes its .sha256
// and android.json; then commit and push the site. --agent publishes ArcFlare Agent's download, android-agent.json.
//
//   node scripts/site-publish.js <signed.apk> <site repo> --version-code N --version-name 1.0.N [--agent]
//   (build-apk.js --release --site <site repo> does the same after building)
//
// Only an APK signed with the release key belongs here: phones refuse any other as an update.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_SIZE = 200 * 1024 * 1024;

function publishToSite(apk, siteDir, { versionCode, versionName, agent }) {
  // The same limits as OnlineUpdate.problem(): anything else is published and then refused by every phone.
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2147483647) throw new Error("--version-code must be a positive integer of at most 2147483647");
  if (!/^[0-9][0-9.]{0,30}$/.test(String(versionName))) throw new Error("--version-name must look like 1.0.123");
  const dl = path.join(siteDir, "public", "downloads");
  if (!fs.existsSync(dl)) throw new Error(`${dl} does not exist: give the path of the ArcFlare site repo`);
  const manifestName = agent ? "android-agent.json" : "android.json";
  const old = path.join(dl, manifestName);
  if (fs.existsSync(old) && JSON.parse(fs.readFileSync(old, "utf8")).versionCode >= versionCode) throw new Error(`the site already offers version code ${versionCode} or newer`);
  const file = agent ? `ArcFlare-Agent-android-${versionName}.apk` : `ArcFlare-android-${versionName}.apk`;
  const buf = fs.readFileSync(apk);
  if (buf.length < 1024 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${apk} is not an APK`);
  if (buf.length > MAX_SIZE) throw new Error(`${apk} is larger than the 200 MB phones accept`);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(path.join(dl, file), buf);
  fs.writeFileSync(path.join(dl, file + ".sha256"), `${sha256}  ${file}\n`);
  const manifest = { versionCode, versionName, apk: file, size: buf.length, sha256 };
  fs.writeFileSync(old, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

module.exports = { publishToSite, MAX_SIZE };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
  try {
    if (argv.length < 2 || argv[0].startsWith("--")) throw new Error("usage: site-publish.js <signed.apk> <site repo> --version-code N --version-name 1.0.N [--agent]");
    const agent = argv.slice(2).includes("--agent");
    const m = publishToSite(argv[0], argv[1], { versionCode: Number(opt("--version-code")), versionName: opt("--version-name"), agent });
    const manifest = agent ? "android-agent.json" : "android.json";
    console.log(`  on the site: public/downloads/${m.apk} (${m.size} bytes, sha256 ${m.sha256})\n  commit and push the site repo; phones see it at arcflare.net/downloads/${manifest}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
