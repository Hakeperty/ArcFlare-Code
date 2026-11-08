"use strict";
// The phone app's own updates, served by the hub to signed-in phones.
//
// `arcflare phone app publish <apk> --version-code N` copies a built APK into
// <hub>/app/ with its size, SHA-256 and version. The hub answers
//   GET /api/app/version          the published version, or { available: false }
//   GET /api/app/apk?part=N       one base64 chunk of it
// to signed-in sessions only (the routes sit behind the hub's login), over the
// same paths as everything else: the encrypted tunnel or the LAN.
//
// Why this is safe to install from: the phone checks size and SHA-256 against
// /api/app/version before it hands the file to Android, and Android itself
// refuses an update that is not signed with the same key as the installed app.
// A hub can therefore only offer an APK signed by whoever signed the app.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHUNK = 384 * 1024;                // raw bytes per part (~512 KB of base64), well under a tunnel reply
const MAX_APK = 200 * 1024 * 1024;
const META = "current.json";
const APK = "current.apk";

function appDir(hubDir) { return path.join(hubDir, "app"); }

function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/** Is this a zip (an APK) at all? A cheap guard against publishing the wrong file. */
function looksLikeApk(file) {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  } finally { fs.closeSync(fd); }
}

/**
 * Publish an APK. versionCode must be a positive integer and higher than the
 * published one (Android refuses a downgrade, so offering one would only fail).
 */
function publish(hubDir, apkPath, { versionCode, versionName } = {}) {
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error("--version-code must be a whole number from 1 to 2100000000");
  }
  const st = fs.statSync(apkPath);
  if (!st.isFile()) throw new Error(`not a file: ${apkPath}`);
  if (st.size < 1024 || st.size > MAX_APK) throw new Error(`an APK of ${st.size} bytes? expected 1 KB .. ${MAX_APK} bytes`);
  if (!looksLikeApk(apkPath)) throw new Error(`${apkPath} is not an APK (not a zip file)`);
  const cur = info(hubDir);
  if (cur && versionCode <= cur.versionCode) {
    throw new Error(`version code ${versionCode} is not above the published ${cur.versionCode}: Android would refuse it as a downgrade`);
  }
  const dir = appDir(hubDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${APK}.${process.pid}`);
  fs.copyFileSync(apkPath, tmp);
  const meta = {
    v: 1,
    versionCode,
    versionName: String(versionName || versionCode).slice(0, 40),
    size: fs.statSync(tmp).size,
    sha256: sha256File(tmp),
    chunk: CHUNK,
    published: new Date().toISOString(),
  };
  // The APK first, then the metadata that names its hash: a reader never sees metadata for a file not yet in place.
  fs.renameSync(tmp, path.join(dir, APK));
  fs.writeFileSync(path.join(dir, `.${META}.tmp`), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(path.join(dir, `.${META}.tmp`), path.join(dir, META));
  return meta;
}

/** The published version, or null. Checks the file is still the size the metadata says. */
function info(hubDir) {
  const dir = appDir(hubDir);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, META), "utf8")); } catch { return null; }
  if (!meta || meta.v !== 1 || !Number.isSafeInteger(meta.versionCode) || !/^[0-9a-f]{64}$/.test(meta.sha256)) return null;
  let st;
  try { st = fs.statSync(path.join(dir, APK)); } catch { return null; }
  if (st.size !== meta.size) return null;
  return { versionCode: meta.versionCode, versionName: meta.versionName, size: meta.size, sha256: meta.sha256, chunk: meta.chunk || CHUNK, parts: Math.ceil(meta.size / (meta.chunk || CHUNK)) };
}

/** Part `part` (0-based) as base64, or null when out of range. */
function readPart(hubDir, part) {
  const m = info(hubDir);
  if (!m || !Number.isSafeInteger(part) || part < 0 || part >= m.parts) return null;
  const start = part * m.chunk;
  const len = Math.min(m.chunk, m.size - start);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(path.join(appDir(hubDir), APK), "r");
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return { part, parts: m.parts, sha256: m.sha256, data: buf.toString("base64") };
}

/** The object the hub server takes as `appUpdates`. */
function forHub(hubDir) {
  return { info: () => info(hubDir), part: (n) => readPart(hubDir, n) };
}

module.exports = { publish, info, readPart, forHub, CHUNK, MAX_APK };
