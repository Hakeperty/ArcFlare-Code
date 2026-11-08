"use strict";
// Reaching the hub from anywhere for free, with no relay server and no Redis:
// a Cloudflare quick tunnel (`cloudflared tunnel --url`, no account needed)
// gives an https://<random>.trycloudflare.com address that forwards to a small
// listener on this computer's loopback. That listener serves ONLY the phone
// endpoints of the hub's own mailbox (lib/hub/lanrelay.js), the same blind,
// end-to-end encrypted Relay API the phone uses at home. The web UI, the login
// page and the rest of the API are not reachable through it.
//
// The address changes every time cloudflared starts. The hub tells paired
// phones the current one (GET /api/status over the tunnel), and a phone stores
// it, so a phone that has connected once since a restart (at home, say) keeps
// working away from home. `arcflare phone pair` puts the current one in the QR.
//
// cloudflared is found on PATH or in its usual Windows install folders. If it is
// missing, the hub says how to install it and carries on without it.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const os = require("node:os");
const crypto = require("node:crypto");

/** Where `arcflare phone connect install` puts its own copy (no admin rights needed). */
function ownDir() { return path.join(process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "bin"); }

function findCloudflared() {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const dirs = [ownDir(), ...(process.env.PATH || "").split(path.delimiter).filter(Boolean)];
  if (process.platform === "win32") {
    dirs.push("C:\\Program Files (x86)\\cloudflared", "C:\\Program Files\\cloudflared",
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"));
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
  }
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/** Only /api/tunnel/room/<roomId>/client (GET, POST, OPTIONS) gets through to the mailbox. */
function allowedPath(url, roomId) {
  const q = url.indexOf("?");
  const p = q === -1 ? url : url.slice(0, q);
  return p === `/api/tunnel/room/${roomId}/client`;
}

/** The caller's address for the mailbox's per-address limits: Cloudflare's header (only cloudflared can reach this loopback port). */
function callerOf(req) {
  const h = String(req.headers["cf-connecting-ip"] || "").trim();
  return /^[0-9a-fA-F.:]{2,45}$/.test(h) ? h : "cloudflare";
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readKeep(keepFile) {
  try {
    const j = JSON.parse(fs.readFileSync(keepFile, "utf8"));
    if (!j || !Number.isInteger(j.pid) || !Number.isInteger(j.port) || typeof j.url !== "string") return null;
    const m = URL_RE.exec(j.url);
    return m && m[0] === j.url ? j : null;
  } catch { return null; }
}

/** Does the public address reach our loopback listener? Any answer from it counts (even a 404 for a bad path). */
async function reaches(url, roomId, fetchImpl, ms = 15_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetchImpl(`${url}/api/tunnel/room/${roomId}/client`, { method: "OPTIONS", signal: ac.signal });
    return r.status < 500 || r.status === 501;
  } catch { return false; } finally { clearTimeout(t); }
}

/**
 * Start the loopback listener and cloudflared. Resolves { url, close } once Cloudflare has handed out an address
 * (or rejects after `timeoutMs`). `onUrl(url)` fires on that and on every later address (cloudflared restarted).
 *
 * With `keepFile`, the address survives hub restarts: cloudflared runs detached on a fixed loopback port and is
 * left running when the hub stops (close({ keep: true })). The next hub start listens on the same port, checks that
 * the address still reaches it, and reuses it. A quick tunnel's address is random and Cloudflare cannot give the
 * same one back, so this is the only way a phone away from home keeps finding the hub across restarts.
 */
async function startCloudflare(o) {
  const { roomId, keepFile, log = () => {}, fetchImpl = globalThis.fetch } = o;
  const keep = keepFile ? readKeep(keepFile) : null;
  if (keep && pidAlive(keep.pid)) {
    try {
      const t = await startCloudflareOn({ ...o, port: keep.port, reuse: keep });
      if (await reaches(keep.url, roomId, fetchImpl)) {
        log(`reusing the Cloudflare address from the last run`);
        return t;
      }
      t.close();
    } catch { /* the port is taken, or the old tunnel is dead: start over below */ }
    try { process.kill(keep.pid); } catch { /* gone */ }
  }
  if (keepFile) { try { fs.unlinkSync(keepFile); } catch { /* none */ } }
  return startCloudflareOn({ ...o, port: keepFile ? 0 : 0 });
}

function startCloudflareOn({ mailbox, roomId, file, keepFile, reuse, port: wantPort = 0, onUrl, log = () => {}, exe = findCloudflared(), prefixArgs = [], timeoutMs = 60_000 }) {
  if (!exe) return Promise.reject(Object.assign(new Error("cloudflared is not installed (winget install Cloudflare.cloudflared, or brew install cloudflared)"), { code: "NO_CLOUDFLARED" }));
  const server = http.createServer((req, res) => {
    if (!allowedPath(req.url || "", roomId) || !["GET", "POST", "OPTIONS"].includes(req.method)) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"error":"not found"}');
      return;
    }
    // Internet-facing: whatever goes wrong in one request must never take the hub down.
    Promise.resolve().then(() => mailbox.handle(req, res, callerOf(req))).catch(() => {
      try { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); } catch { /* gone */ }
    });
  });
  let child = null, closed = false, current = null, restarts = 0, watch = null, keptPid = reuse ? reuse.pid : null;
  const publish = (url) => {
    current = url;
    if (file) { try { fs.writeFileSync(file, JSON.stringify({ url, at: Date.now() }), { mode: 0o600 }); } catch { /* best effort */ } }
    try { if (onUrl) onUrl(url); } catch { /* listener's problem */ }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; close(); reject(new Error("Cloudflare did not hand out an address in time")); } }, timeoutMs);
    const done = (url) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ url, get current() { return current; }, close }); } };
    // A kept cloudflared is not our child: notice when it dies and start a new one.
    const watchKept = (port) => {
      watch = setInterval(() => {
        if (closed || pidAlive(keptPid)) return;
        clearInterval(watch); watch = null; keptPid = null;
        log("cloudflared stopped; starting it again");
        run(port);
      }, 10_000);
      watch.unref();
    };
    const run = (port) => {
      if (closed) return;
      if (keepFile) {
        // Detached, logging to a file: it must outlive this process, so it cannot write into our pipes.
        const logFile = keepFile.replace(/\.json$/, "") + ".log";
        const fd = fs.openSync(logFile, "w");
        const kid = spawn(exe, [...prefixArgs, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
          { stdio: ["ignore", fd, fd], windowsHide: true, detached: true });
        fs.closeSync(fd);
        kid.on("error", (e) => log(`cloudflared: ${e.message}`));
        kid.unref();
        keptPid = kid.pid;
        const poll = setInterval(() => {
          if (closed) return clearInterval(poll);
          let text = "";
          try { text = fs.readFileSync(logFile, "utf8"); } catch { /* not yet */ }
          const m = URL_RE.exec(text);
          if (m) {
            clearInterval(poll);
            try { fs.writeFileSync(keepFile, JSON.stringify({ pid: kid.pid, port, url: m[0], at: Date.now() }), { mode: 0o600 }); } catch { /* best effort */ }
            if (m[0] !== current) publish(m[0]);
            done(m[0]);
            watchKept(port);
          } else if (!pidAlive(kid.pid)) {
            clearInterval(poll);
            const wait = Math.min(60_000, 2000 * 2 ** Math.min(5, restarts++));
            log(`cloudflared stopped; starting it again in ${Math.round(wait / 1000)} s`);
            setTimeout(() => run(port), wait).unref();
          }
        }, 500);
        poll.unref();
        return;
      }
      child = spawn(exe, [...prefixArgs, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const scan = (buf) => {
        const m = URL_RE.exec(String(buf));
        if (!m || m[0] === current) return;
        publish(m[0]);
        if (!settled) { settled = true; clearTimeout(timer); resolve({ url: m[0], get current() { return current; }, close }); }
      };
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      child.on("error", (e) => log(`cloudflared: ${e.message}`));
      child.on("exit", () => {
        child = null;
        if (closed) return;
        // Keep the way in alive: start again (a new address), backing off up to a minute.
        const wait = Math.min(60_000, 2000 * 2 ** Math.min(5, restarts++));
        log(`cloudflared stopped; starting it again in ${Math.round(wait / 1000)} s`);
        setTimeout(() => run(port), wait).unref();
      });
    };
    server.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    server.listen(wantPort, "127.0.0.1", () => {
      if (reuse) {
        // The kept cloudflared already forwards this port: nothing to start.
        publish(reuse.url);
        done(reuse.url);
        watchKept(wantPort);
      } else run(server.address().port);
    });
  });
  /** close() stops everything; close({ keep: true }) leaves a kept cloudflared running for the next hub start. */
  function close(opts) {
    closed = true;
    if (watch) clearInterval(watch);
    try { if (child) child.kill(); } catch { /* gone */ }
    if (keptPid && !(opts && opts.keep)) {
      try { process.kill(keptPid); } catch { /* gone */ }
      if (keepFile) { try { fs.unlinkSync(keepFile); } catch { /* gone */ } }
    }
    try { server.close(); } catch { /* gone */ }
    if (file) { try { fs.unlinkSync(file); } catch { /* gone */ } }
  }
}

/** Cloudflare's release file for this computer, or null when there is no standalone build for it. */
function assetName(platform = process.platform, arch = process.arch) {
  const a = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" }[arch];
  if (!a) return null;
  if (platform === "win32") return a === "amd64" || a === "386" ? `cloudflared-windows-${a}.exe` : null;
  if (platform === "linux") return `cloudflared-linux-${a}`;
  if (platform === "darwin") return a === "amd64" || a === "arm64" ? `cloudflared-darwin-${a}.tgz` : null;
  return null;
}

/**
 * Install Cloudflare's own standalone cloudflared into ~/.arcflare/bin, for this user only (no admin, no package
 * manager): the latest release from github.com/cloudflare/cloudflared, checked against the SHA-256 GitHub publishes
 * for that file before it is kept. Resolves the installed path.
 */
async function installPortable({ fetchImpl = globalThis.fetch, dir = ownDir(), log = () => {} } = {}) {
  const name = assetName();
  if (!name) throw new Error(`no standalone cloudflared for ${process.platform}/${process.arch}`);
  const rel = await fetchImpl("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", { headers: { Accept: "application/vnd.github+json", "User-Agent": "arcflare-cli" } });
  if (!rel.ok) throw new Error(`GitHub answered ${rel.status}`);
  const j = await rel.json();
  const asset = (j.assets || []).find((x) => x && x.name === name);
  if (!asset || !/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//.test(asset.browser_download_url)) throw new Error(`release ${j.tag_name} has no ${name}`);
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || "");
  if (!want) throw new Error("the release does not publish a checksum for this file; not installing it");
  log(`downloading cloudflared ${j.tag_name} (${Math.round(asset.size / 1e6)} MB) from Cloudflare's GitHub releases`);
  const res = await fetchImpl(asset.browser_download_url, { headers: { "User-Agent": "arcflare-cli" } });
  if (!res.ok) throw new Error(`download answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  if (got !== want[1]) throw new Error("checksum mismatch: the download is not the file Cloudflare published; not installing it");
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (name.endsWith(".tgz")) {
    const tgz = exe + ".tgz";
    fs.writeFileSync(tgz, buf);
    const r = require("node:child_process").spawnSync("tar", ["-xzf", tgz, "-C", dir], { stdio: "ignore" });
    fs.rmSync(tgz, { force: true });
    if (r.status !== 0) throw new Error("could not unpack the download");
  } else {
    const tmp = exe + ".part";
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, exe);
  }
  try { fs.chmodSync(exe, 0o755); } catch { /* Windows */ }
  return exe;
}

/** The address a running hub published, or null. */
function currentUrl(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof j.url === "string" && URL_RE.test(j.url) && j.url.match(URL_RE)[0] === j.url ? j.url : null;
  } catch { return null; }
}

/** Stop a cloudflared kept from an earlier run (arcflare phone connect off). True when one was running. */
function stopKept(keepFile) {
  const k = readKeep(keepFile);
  try { fs.unlinkSync(keepFile); } catch { /* none */ }
  if (!k || !pidAlive(k.pid)) return false;
  try { process.kill(k.pid); return true; } catch { return false; }
}

module.exports = { startCloudflare, stopKept, readKeep, pidAlive, currentUrl, findCloudflared, installPortable, assetName, ownDir, allowedPath, callerOf, URL_RE };
