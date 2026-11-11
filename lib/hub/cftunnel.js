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
// cloudflared is found on PATH or in its usual install folders. If it is
// missing, the hub says how to install it and carries on without it.
//
// An address is not a tunnel. Cloudflare hands the address out first; only
// then does cloudflared connect to Cloudflare's network, and that is the step
// that fails on a machine whose firewall drops UDP, or whose DNS will not
// answer for Cloudflare's tunnel servers (common on Linux, where cloudflared
// reads /etc/resolv.conf itself). Until this file waited for that connection,
// the hub announced "on" with an address that answered HTTP 530. So: the
// tunnel counts as up when cloudflared reports a registered connection, or the
// address demonstrably reaches our listener. If neither happens, cloudflared is
// started again over HTTP/2 (TCP), and if that fails too the hub is told why in
// words someone can act on.

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

/** The ways to start cloudflared, in the order they are tried. QUIC is its default; HTTP/2 is for networks that drop UDP. */
const STRATEGIES = [
  { name: "quic", args: [] },
  { name: "http2", args: ["--protocol", "http2"] },
];

/** A quick tunnel's own address: not the API host that shows up in cloudflared's error messages. */
function tunnelUrl(text) {
  for (const m of String(text).matchAll(new RegExp(URL_RE.source, "g"))) {
    if (m[0] !== "https://api.trycloudflare.com") return m[0];
  }
  return null;
}

/** What cloudflared's output says so far: the address, whether it connected, and why not if it says. */
function readLog(text) {
  const t = String(text || "");
  return { url: tunnelUrl(t), connected: /Registered tunnel connection/.test(t), why: diagnose(t) };
}

/** The reason a tunnel is not coming up, in words someone can act on. Null when the log does not say. */
function diagnose(text) {
  const t = String(text || "");
  if (/failed to request quick Tunnel/i.test(t)) {
    return /429|Too Many Requests/i.test(t)
      ? "Cloudflare is refusing new quick tunnels from this address for now (too many were opened). Wait a few minutes and start the hub again"
      : "this computer could not reach Cloudflare to ask for an address. Check that it is online";
  }
  if (/edge discovery|lookup [^\n]*argotunnel\.com[^\n]*(no such host|server misbehaving|i\/o timeout)/i.test(t)) {
    return "this computer's DNS does not answer for Cloudflare's tunnel servers (argotunnel.com). " +
      "Use a public DNS resolver such as 1.1.1.1 or 8.8.8.8" +
      (process.platform === "linux" ? " (in /etc/resolv.conf, or your network settings)" : "") + ", then start the hub again";
  }
  if (/failed to dial to edge|timeout: no recent network activity|network is unreachable|operation not permitted|connection refused|i\/o timeout/i.test(t)) {
    return "outgoing connections to Cloudflare on port 7844 (UDP and TCP) are blocked on this network. Allow them in the firewall" +
      (process.platform === "linux" ? " (for example: sudo ufw allow out 7844)" : "");
  }
  return null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * Is this process the cloudflared we left running? After a reboot the number in
 * the keep file belongs to whatever started since, and "alive" is not enough to
 * go on: the next step may be to kill it. Linux says what a pid is running, so
 * ask; elsewhere, alive is all there is to know.
 */
function isCloudflared(pid) {
  if (!pidAlive(pid)) return false;
  if (process.platform !== "linux") return true;
  try { return /cloudflared/i.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")); } catch { return false; }
}

const modeFileFor = (keepFile) => keepFile.replace(/\.json$/, "") + "-mode.json";

/** The strategy that worked last time on this machine, so a network that needs HTTP/2 does not wait for QUIC to fail on every start. */
function readMode(keepFile) {
  try {
    const j = JSON.parse(fs.readFileSync(modeFileFor(keepFile), "utf8"));
    const i = STRATEGIES.findIndex((x) => x.name === j.mode);
    return i >= 0 ? i : 0;
  } catch { return 0; }
}

function readKeep(keepFile) {
  try {
    const j = JSON.parse(fs.readFileSync(keepFile, "utf8"));
    if (!j || !Number.isInteger(j.pid) || !Number.isInteger(j.port) || typeof j.url !== "string") return null;
    return tunnelUrl(j.url) === j.url ? j : null;
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
  if (keep && isCloudflared(keep.pid)) {
    try {
      const t = await startCloudflareOn({ ...o, port: keep.port, reuse: keep });
      if (await reaches(keep.url, roomId, fetchImpl)) {
        log(`reusing the Cloudflare address from the last run`);
        return t;
      }
      t.close();
    } catch { /* the port is taken, or the old tunnel is dead: start over below */ }
    if (isCloudflared(keep.pid)) { try { process.kill(keep.pid); } catch { /* gone */ } }
  }
  if (keepFile) { try { fs.unlinkSync(keepFile); } catch { /* none */ } }
  return startCloudflareOn({ ...o, port: keepFile ? 0 : 0 });
}

function startCloudflareOn({ mailbox, roomId, file, keepFile, reuse, port: wantPort = 0, onUrl, log = () => {}, exe = findCloudflared(), prefixArgs = [],
  fetchImpl = globalThis.fetch, timeoutMs = 90_000, connectMs = 25_000 }) {
  if (!exe) {
    return Promise.reject(Object.assign(new Error("cloudflared is not installed: run arcflare phone connect install" +
      (process.platform === "win32" ? " (or winget install Cloudflare.cloudflared)" : process.platform === "darwin" ? " (or brew install cloudflared)" : " (or use your distribution's cloudflared package)")),
    { code: "NO_CLOUDFLARED" }));
  }
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
  let child = null, closed = false, current = null, restarts = 0, watch = null, tick = null, keptPid = reuse ? reuse.pid : null;
  let mode = keepFile ? readMode(keepFile) : 0;
  const tried = new Set();
  let lastWhy = null;
  const publish = (url) => {
    current = url;
    if (file) { try { fs.writeFileSync(file, JSON.stringify({ url, at: Date.now() }), { mode: 0o600 }); } catch { /* best effort */ } }
    try { if (onUrl) onUrl(url); } catch { /* listener's problem */ }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); close(); reject(err); } };
    const timer = setTimeout(() => fail(new Error(lastWhy ? `Cloudflare's tunnel did not come up: ${lastWhy}` : "Cloudflare did not hand out an address in time")), timeoutMs);
    const done = (url) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ url, get current() { return current; }, get mode() { return STRATEGIES[mode].name; }, close }); } };
    const backoff = () => Math.min(60_000, 2000 * 2 ** Math.min(5, restarts++));
    // A kept cloudflared is not our child: notice when it dies and start a new one.
    const watchKept = (port) => {
      if (watch) clearInterval(watch);
      watch = setInterval(() => {
        if (closed || pidAlive(keptPid)) return;
        clearInterval(watch); watch = null; keptPid = null;
        log("cloudflared stopped; starting it again");
        tried.clear();
        run(port);
      }, 10_000);
      watch.unref();
    };

    /**
     * One cloudflared, watched until it is up or has shown that it will not be.
     * Up means an address AND a connection behind it; see the top of this file.
     */
    const run = (port) => {
      if (closed) return;
      const strategy = STRATEGIES[mode];
      const args = [...prefixArgs, "tunnel", "--no-autoupdate", ...strategy.args, "--url", `http://127.0.0.1:${port}`];
      let text = "", kid, getText, over = false, urlAt = 0, checking = false;
      if (keepFile) {
        // Detached, logging to a file: it must outlive this process, so it cannot write into our pipes.
        const logFile = keepFile.replace(/\.json$/, "") + ".log";
        const fd = fs.openSync(logFile, "w");
        kid = spawn(exe, args, { stdio: ["ignore", fd, fd], windowsHide: true, detached: true });
        fs.closeSync(fd);
        kid.unref();
        keptPid = kid.pid;
        getText = () => { try { return fs.readFileSync(logFile, "utf8"); } catch { return ""; } };
      } else {
        kid = child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const add = (buf) => { text = (text + String(buf)).slice(-200_000); };
        kid.stdout.on("data", add);
        kid.stderr.on("data", add);
        getText = () => text;
      }
      let exited = false;
      kid.on("error", (e) => { exited = true; log(`cloudflared: ${e.message}`); });
      kid.on("exit", () => {
        exited = true;
        if (child === kid) child = null;
        // After it came up: keep the way in alive with a new one (a new address), backing off up to a minute.
        if (!over || closed || keepFile) return;
        const wait = backoff();
        log(`cloudflared stopped; starting it again in ${Math.round(wait / 1000)} s`);
        tried.clear();
        setTimeout(() => run(port), wait).unref();
      });
      const stop = () => { try { kid.kill(); } catch { /* gone */ } if (keptPid === kid.pid) keptPid = null; };

      const up = (url) => {
        over = true; clearInterval(tick); restarts = 0;
        if (keepFile) {
          try { fs.writeFileSync(keepFile, JSON.stringify({ pid: kid.pid, port, url, mode: strategy.name, at: Date.now() }), { mode: 0o600 }); } catch { /* best effort */ }
          try { fs.writeFileSync(modeFileFor(keepFile), JSON.stringify({ mode: strategy.name }), { mode: 0o600 }); } catch { /* best effort */ }
          watchKept(port);
        }
        if (strategy.name !== "quic") log(`connected over ${strategy.name.toUpperCase()} (QUIC did not get through on this network)`);
        if (url !== current) publish(url);
        done(url);
      };
      // This cloudflared will not work. Try the next way of starting it; when there is none, say why.
      const giveUp = (why, hadAddress) => {
        over = true; clearInterval(tick);
        stop();
        if (closed) return;
        lastWhy = why || lastWhy;
        if (hadAddress) {
          tried.add(mode);
          const next = STRATEGIES.findIndex((_, i) => !tried.has(i));
          if (next >= 0) {
            log(`no connection to Cloudflare over ${strategy.name.toUpperCase()}; trying ${STRATEGIES[next].name.toUpperCase()}`);
            mode = next;
            return run(port);
          }
          const err = Object.assign(new Error("Cloudflare gave an address, but cloudflared could not connect to Cloudflare's network: " +
            (lastWhy || "it reported no reason; the last lines of its log are in ~/.arcflare/hub/cloudflared.log")), { code: "CF_NOT_CONNECTED" });
          if (!settled) return fail(err);
          tried.clear();
        }
        // Never got an address, or it was up before and the retries ran out: wait, then start over.
        const wait = backoff();
        log(`${lastWhy || "cloudflared stopped"}; trying again in ${Math.round(wait / 1000)} s`);
        setTimeout(() => run(port), wait).unref();
      };

      clearInterval(tick);
      tick = setInterval(() => {
        if (closed || over || checking) { if (closed) clearInterval(tick); return; }
        const st = readLog(getText());
        if (st.url && !urlAt) urlAt = Date.now();
        if (st.url && st.connected) return up(st.url);
        if (exited || (keepFile && !pidAlive(kid.pid))) return giveUp(st.why, !!st.url);
        if (st.url && Date.now() - urlAt > connectMs) {
          // No "registered" line. Before calling it dead, ask the address itself: a cloudflared that words
          // its log differently one day must not make a working tunnel look broken.
          checking = true;
          reaches(st.url, roomId, fetchImpl, 8000).then((ok) => {
            checking = false;
            if (closed || over) return;
            if (ok) up(st.url); else giveUp(readLog(getText()).why, true);
          });
        }
      }, 250);
      tick.unref();
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
    if (tick) clearInterval(tick);
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
async function installPortable({ fetchImpl = globalThis.fetch, dir = ownDir(), log = () => {}, apiMs = 30_000, downloadMs = 600_000 } = {}) {
  const timedOut = (e, what) => (e && (e.name === "TimeoutError" || e.name === "AbortError") ? new Error(`timed out ${what}; check the connection and try again`) : e);
  const name = assetName();
  if (!name) throw new Error(`no standalone cloudflared for ${process.platform}/${process.arch}`);
  // A stalled connection must not hang first-time setup: the API answer is small, the binary is tens of MB.
  const rel = await fetchImpl("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", { headers: { Accept: "application/vnd.github+json", "User-Agent": "arcflare-cli" }, signal: AbortSignal.timeout(apiMs) })
    .catch((e) => { throw timedOut(e, `asking GitHub for the latest cloudflared release (${apiMs / 1000} s)`); });
  if (!rel.ok) {
    // 403 and 429 are GitHub's limit on unsigned requests from one address, not a missing release.
    const limited = rel.status === 403 || rel.status === 429;
    throw new Error(limited
      ? `GitHub is not answering requests from this address right now (HTTP ${rel.status}). Try again in an hour, or install it yourself` +
        (process.platform === "linux" ? ": your distribution's cloudflared package, or Cloudflare's at pkg.cloudflare.com" : "")
      : `GitHub answered ${rel.status}`);
  }
  const j = await rel.json();
  const asset = (j.assets || []).find((x) => x && x.name === name);
  if (!asset || !/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//.test(asset.browser_download_url)) throw new Error(`release ${j.tag_name} has no ${name}`);
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || "");
  if (!want) throw new Error("the release does not publish a checksum for this file; not installing it");
  log(`downloading cloudflared ${j.tag_name} (${Math.round(asset.size / 1e6)} MB) from Cloudflare's GitHub releases`);
  // One signal for the whole download, body included.
  const dl = AbortSignal.timeout(downloadMs);
  const res = await fetchImpl(asset.browser_download_url, { headers: { "User-Agent": "arcflare-cli" }, signal: dl })
    .catch((e) => { throw timedOut(e, `downloading cloudflared (${downloadMs / 60000} min)`); });
  if (!res.ok) throw new Error(`download answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer().catch((e) => { throw timedOut(e, `downloading cloudflared (${downloadMs / 60000} min)`); }));
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
    return typeof j.url === "string" && tunnelUrl(j.url) === j.url ? j.url : null;
  } catch { return null; }
}

/** Stop a cloudflared kept from an earlier run (arcflare phone connect off). True when one was running. */
function stopKept(keepFile) {
  const k = readKeep(keepFile);
  try { fs.unlinkSync(keepFile); } catch { /* none */ }
  // Only a process that really is cloudflared: the number may have been reused since.
  if (!k || !isCloudflared(k.pid)) return false;
  try { process.kill(k.pid); return true; } catch { return false; }
}

module.exports = {
  startCloudflare, stopKept, readKeep, pidAlive, isCloudflared, currentUrl, findCloudflared, installPortable, assetName, ownDir, allowedPath, callerOf,
  readLog, diagnose, tunnelUrl, STRATEGIES, URL_RE,
};
