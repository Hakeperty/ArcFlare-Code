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

/**
 * Start the loopback listener and cloudflared. Resolves { url, close } once Cloudflare has handed out an address
 * (or rejects after `timeoutMs`). `onUrl(url)` fires on that and on every later address (cloudflared restarted).
 */
function startCloudflare({ mailbox, roomId, file, onUrl, log = () => {}, exe = findCloudflared(), prefixArgs = [], timeoutMs = 60_000 }) {
  if (!exe) return Promise.reject(Object.assign(new Error("cloudflared is not installed (winget install Cloudflare.cloudflared, or brew install cloudflared)"), { code: "NO_CLOUDFLARED" }));
  const server = http.createServer((req, res) => {
    if (!allowedPath(req.url || "", roomId) || !["GET", "POST", "OPTIONS"].includes(req.method)) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"error":"not found"}');
      return;
    }
    mailbox.handle(req, res, callerOf(req));
  });
  let child = null, closed = false, current = null, restarts = 0;
  const publish = (url) => {
    current = url;
    if (file) { try { fs.writeFileSync(file, JSON.stringify({ url, at: Date.now() }), { mode: 0o600 }); } catch { /* best effort */ } }
    try { if (onUrl) onUrl(url); } catch { /* listener's problem */ }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; close(); reject(new Error("Cloudflare did not hand out an address in time")); } }, timeoutMs);
    const run = (port) => {
      if (closed) return;
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
    server.listen(0, "127.0.0.1", () => run(server.address().port));
    server.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
  function close() {
    closed = true;
    try { if (child) child.kill(); } catch { /* gone */ }
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

module.exports = { startCloudflare, currentUrl, findCloudflared, installPortable, assetName, ownDir, allowedPath, callerOf, URL_RE };
