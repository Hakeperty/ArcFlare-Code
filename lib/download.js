// Downloads with no dependencies: follows redirects, resumes a partial file
// with a Range request, and checks size and SHA-256 when they are known.
//
// The file is written as `<dest>.part` and renamed only once it is complete
// and verified, so a half-finished download is never mistaken for a model.

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const UA = "arcflare (+https://arcflare.net)";

/**
 * GET a URL, following up to 8 redirects. Headers in `auth` are only sent to
 * the original host, never to a CDN the request is redirected to.
 */
function get(url, { headers = {}, auth = {}, signal, method = "GET" } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, {
      method,
      headers: { "User-Agent": UA, ...headers, ...auth },
      signal,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 8) return reject(new Error("too many redirects"));
        const next = new URL(res.headers.location, url);
        // Credentials stay with the host they were meant for.
        const keep = next.host === u.host ? auth : {};
        return resolve(get(next.toString(), { headers, auth: keep, signal, method }, hops + 1));
      }
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

/** GET and parse JSON; throws with the status on failure. */
async function getJson(url, opts = {}) {
  const res = await get(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
  const chunks = [];
  for await (const ch of res) chunks.push(ch);
  const body = Buffer.concat(chunks).toString("utf8");
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const e = new Error(`${url} answered ${res.statusCode}`);
    e.status = res.statusCode;
    e.body = body.slice(0, 400);
    throw e;
  }
  return JSON.parse(body);
}

function hashFile(file, hash) {
  return new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on("data", (d) => hash.update(d));
    s.on("end", resolve);
    s.on("error", reject);
  });
}

/**
 * Download `url` to `dest`.
 *   size     expected byte count (optional; checked at the end)
 *   sha256   expected hex digest (optional; checked at the end)
 *   onProgress({ done, total, rate })
 * Resumes `<dest>.part` if it exists and the server honours Range.
 */
async function download(url, dest, { size, sha256, auth, onProgress, signal } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* fresh */ }
  if (size && have > size) { fs.rmSync(part, { force: true }); have = 0; }

  const hash = sha256 ? crypto.createHash("sha256") : null;
  // A resumed file's first bytes still have to go into the digest.
  if (hash && have > 0) await hashFile(part, hash);

  let res;
  if (size && have === size) {
    res = null; // already all here; just verify
  } else {
    res = await get(url, { auth, signal, headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
    if (have > 0 && res.statusCode === 200) {
      // The server ignored Range: start over from nothing (fresh digest too).
      res.resume();
      fs.rmSync(part, { force: true });
      return download(url, dest, { size, sha256, auth, onProgress, signal });
    }
    if (res.statusCode === 416 && size && have === size) {
      res.resume();
      res = null;
    } else if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      const e = new Error(`download failed: ${url} answered ${res.statusCode}`);
      e.status = res.statusCode;
      throw e;
    }
  }

  if (res) {
    const total = size || (have + Number(res.headers["content-length"] || 0)) || 0;
    const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
    let done = have;
    let lastT = Date.now(), lastDone = done, rate = 0;
    await new Promise((resolve, reject) => {
      res.on("data", (d) => {
        if (hash) hash.update(d);
        done += d.length;
        const now = Date.now();
        if (now - lastT >= 250) {
          rate = (done - lastDone) / ((now - lastT) / 1000);
          lastT = now; lastDone = done;
          if (onProgress) onProgress({ done, total, rate });
        }
        if (!out.write(d)) { res.pause(); out.once("drain", () => res.resume()); }
      });
      res.on("end", () => out.end(resolve));
      res.on("error", (e) => { out.end(); reject(e); });
      out.on("error", reject);
    });
    if (onProgress) onProgress({ done, total, rate });
  }

  const got = fs.statSync(part).size;
  if (size && got !== size) {
    throw new Error(`incomplete download: ${got} of ${size} bytes (run the same command again to resume)`);
  }
  if (hash) {
    const digest = hash.digest("hex");
    if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
      fs.rmSync(part, { force: true });
      throw new Error(`checksum mismatch for ${path.basename(dest)}: the download was corrupted, run the command again`);
    }
  }
  fs.renameSync(part, dest);
  return dest;
}

/** "[#######-------] 48%  1.2/2.5 GB  35 MB/s" */
function progressText({ done, total, rate }, fmtBytes, width = 20) {
  if (!total) return `${fmtBytes(done)}  ${rate ? fmtBytes(rate) + "/s" : ""}`.trim();
  const p = Math.min(1, done / total);
  const n = Math.round(p * width);
  const bar = "#".repeat(n) + "-".repeat(width - n);
  return `[${bar}] ${String(Math.floor(p * 100)).padStart(3)}%  ${fmtBytes(done)}/${fmtBytes(total)}` +
    (rate ? `  ${fmtBytes(rate)}/s` : "");
}

module.exports = { get, getJson, download, progressText, UA };
