// One model across several computers, with llama.cpp's RPC backend.
//
// A worker runs `ggml-rpc-server`, which lends its GPU to whoever connects.
// The main computer passes `--rpc host:port,...` to llama-server, and llama.cpp
// spreads the weights and KV cache over local and remote devices in proportion
// to their free memory. So two 64 GB boxes can load a model neither could alone.
// Each token still passes through every machine in turn: memory adds up, speed
// does not. MoE models, which read few weights per token, suffer least.
//
// ggml-rpc-server has no authentication; llama.cpp's own README says never to
// expose it. So a worker never exposes it directly: it listens on localhost,
// and `lib/cluster-worker.js` sits in front of it on the LAN and drops every
// connection that is not from an allowed address.

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const WORKER_FILE = path.join(HOME, "cluster-worker.json");
const WORKER_LOG = path.join(HOME, "cluster-worker.log");
const STATE_FILE = path.join(HOME, "cluster-state.json");
const DEFAULT_PORT = 50052; // ggml-rpc-server's own default
const EXE = process.platform === "win32" ? ".exe" : "";
// The binary was called rpc-server until llama.cpp renamed it.
const RPC_NAMES = ["ggml-rpc-server" + EXE, "rpc-server" + EXE];
// How long a measured remote memory figure is trusted by the synchronous
// callers (the desktop's "fits" badges), which cannot go and ask.
const STATE_TTL_MS = 10 * 60 * 1000;

// ----------------------------------------------------------------- nodes --

/** "10.0.0.5", "box2:50052", "[fd00::5]:50052" -> { host, port } */
function parseNode(spec) {
  const s = String(spec || "").trim();
  let host = s;
  let port = DEFAULT_PORT;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if (/^[^:]+:\d+$/.test(s)) {
    [host, port] = [s.slice(0, s.lastIndexOf(":")), Number(s.slice(s.lastIndexOf(":") + 1))];
  } else if (s.includes(":") && net.isIPv6(s)) {
    host = s;
  }
  if (!host || /[\s/,]/.test(host)) throw new Error(`not a host: "${spec}"`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port in "${spec}"`);
  return { host, port };
}

/** The form llama-server's --rpc takes. */
function endpoint(node) {
  return net.isIPv6(node.host) ? `[${node.host}]:${node.port}` : `${node.host}:${node.port}`;
}

function nodes(cfg) {
  return ((cfg && cfg.cluster && cfg.cluster.nodes) || []).map((n) => ({ host: n.host, port: n.port }));
}

function enabled(cfg) {
  return Boolean(cfg && cfg.cluster && cfg.cluster.enabled !== false && nodes(cfg).length);
}

/** A copy of cfg with the node added (once). */
function addNode(cfg, spec) {
  const n = parseNode(spec);
  const list = nodes(cfg).filter((x) => endpoint(x) !== endpoint(n));
  return { ...cfg, cluster: { ...(cfg.cluster || {}), enabled: true, nodes: [...list, n] } };
}

/** A copy of cfg without the node; "all" clears the list. */
function removeNode(cfg, spec) {
  const keep = spec === "all" ? [] : nodes(cfg).filter((x) => endpoint(x) !== endpoint(parseNode(spec)));
  return { ...cfg, cluster: { ...(cfg.cluster || {}), nodes: keep } };
}

function setEnabled(cfg, on) {
  return { ...cfg, cluster: { ...(cfg.cluster || { nodes: [] }), enabled: Boolean(on) } };
}

// ------------------------------------------------------------- addresses --

function ipv4Parts(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || "");
  return m ? m.slice(1).map(Number) : null;
}

/**
 * Addresses that can't be reached from the internet at large: loopback, the
 * private ranges, link-local, and 100.64/10 (CGNAT, where Tailscale lives).
 * A worker refuses to listen anywhere else.
 */
function isPrivate(ip) {
  const addr = String(ip || "").replace(/^::ffff:/, "");
  const p = ipv4Parts(addr);
  if (p) {
    const [a, b] = p;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = addr.toLowerCase();
  return v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** This machine's private IPv4 addresses, LAN first. */
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || !isPrivate(a.address)) continue;
      out.push({ iface: name, address: a.address, netmask: a.netmask });
    }
  }
  // 192.168 and 10.x are what home and office LANs use; CGNAT is a VPN.
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return out.sort((x, y) => rank(x.address) - rank(y.address));
}

// --------------------------------------------------------------- probing --

/** Can we open a TCP connection? { ok, ms, error } */
function reach(node, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: node.host, port: node.port });
    const done = (ok, error) => {
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0, error: error || null });
    };
    sock.setTimeout(timeoutMs, () => done(false, "timed out"));
    sock.once("connect", () => done(true));
    sock.once("error", (e) => done(false, e.code || e.message));
  });
}

/**
 * Every host on this machine's /24 networks with the port open: the quick way
 * to find workers without typing addresses. An open port is only a candidate;
 * `add` confirms it is really a ggml-rpc-server.
 */
async function scan(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  let hosts = opts.hosts;
  if (!hosts) {
    const mine = new Set(localAddresses().map((a) => a.address));
    hosts = [];
    for (const a of localAddresses()) {
      const p = ipv4Parts(a.address);
      if (!p) continue;
      for (let i = 1; i < 255; i++) {
        const ip = `${p[0]}.${p[1]}.${p[2]}.${i}`;
        if (!mine.has(ip)) hosts.push(ip);
      }
    }
    hosts = [...new Set(hosts)];
  }
  const found = [];
  const batch = opts.concurrency || 128;
  for (let i = 0; i < hosts.length; i += batch) {
    const slice = hosts.slice(i, i + batch);
    const res = await Promise.all(slice.map((h) => reach({ host: h, port }, opts.timeoutMs || 400)));
    res.forEach((r, j) => { if (r.ok) found.push({ host: slice[j], port }); });
  }
  return found;
}

const DEVICE_RE = /^\s*(\S+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;

/** RPC devices from `llama-server --rpc ... --list-devices` output. */
function parseRemoteDevices(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = DEVICE_RE.exec(line);
    if (!m || !/^RPC/.test(m[1])) continue;
    // "RPC0[10.0.0.5:50052]" in current builds; older ones put the endpoint in
    // the description instead.
    const ep = /\[([^\]]+:\d+)\]/.exec(m[1]) || /(\S+:\d+)/.exec(m[2]);
    out.push({
      handle: m[1], name: m[2], endpoint: ep ? ep[1] : null,
      totalMiB: Number(m[3]), freeMiB: Number(m[4]),
    });
  }
  return out;
}

/**
 * Ask llama.cpp itself what one worker offers. This is the real test: it
 * speaks the RPC protocol, so it also fails when the worker refuses this
 * computer or runs a llama.cpp build too different to talk to.
 *
 * One worker per call: a worker that drops the connection can make llama.cpp
 * hang or crash, and in a shared call that would hide every healthy one.
 */
function probeNode(server, node, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(server, ["--rpc", endpoint(node), "--list-devices"], {
      cwd: path.dirname(server), windowsHide: true,
    });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({
      devices: [],
      error: "no answer to llama.cpp's handshake: the worker's --allow may not include this " +
        "computer, or it runs a different llama.cpp version",
    }), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => finish({ devices: [], error: e.message }));
    child.on("close", (code) => {
      if (/RPC not supported/i.test(out)) {
        return finish({ devices: [], unsupported: true,
          error: "this llama.cpp build has no RPC support (build it with -DGGML_RPC=ON)" });
      }
      const devices = parseRemoteDevices(out);
      let error = null;
      if (!devices.length) {
        const why = out.split(/\r?\n/).find((l) => /error|failed|version/i.test(l));
        if (/recv failed|send failed|connection (reset|closed)/i.test(out)) {
          error = "the worker hung up: its --allow doesn't include this computer, " +
            "or it runs a different llama.cpp version";
        } else {
          error = why ? why.trim().slice(0, 200)
            : `llama.cpp could not use this worker (exit ${code}): same llama.cpp version on both?`;
        }
      }
      finish({ devices, error });
    });
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

/**
 * Where every node stands: reachable, what devices it lends, how much is free.
 * Also remembers the result, so synchronous callers can count it (see
 * cachedRemoteFreeBytes).
 *
 * `opts.inUse` lists endpoints the running model is loaded on. A worker serves
 * one client at a time, so asking one of those would only queue behind the
 * model; they are reported from the last check instead.
 */
async function check(cfg, server, opts = {}) {
  const list = nodes(cfg);
  const busy = new Set(opts.inUse || []);
  const last = readState().nodes || {};
  const reached = await Promise.all(list.map((n) =>
    busy.has(endpoint(n)) ? { ok: true, ms: 0, error: null } : reach(n)));
  const probes = await Promise.all(list.map((n, i) => {
    if (busy.has(endpoint(n))) return { devices: last[endpoint(n)] || [], error: null };
    if (!reached[i].ok) return { devices: [], error: null };
    if (!server) return { devices: [], error: "llama-server not found" };
    return probeNode(server, n);
  }));
  const report = list.map((n, i) => {
    const ep = endpoint(n);
    const devices = probes[i].devices;
    return {
      node: n, endpoint: ep, reachable: reached[i].ok, ms: reached[i].ms, inUse: busy.has(ep),
      reachError: reached[i].error, devices, error: probes[i].error,
      freeBytes: devices.reduce((s, d) => s + d.freeMiB * 1048576, 0),
      totalBytes: devices.reduce((s, d) => s + d.totalMiB * 1048576, 0),
    };
  });
  const usable = report.filter((r) => r.reachable && r.devices.length);
  const state = {
    at: Date.now(),
    rpc: usable.map((r) => r.endpoint).join(","),
    freeBytes: usable.reduce((s, r) => s + r.freeBytes, 0),
    totalBytes: usable.reduce((s, r) => s + r.totalBytes, 0),
    nodes: Object.fromEntries(usable.map((r) => [r.endpoint, r.devices])),
  };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* the cache is only a convenience */ }
  const unsupported = probes.some((p) => p.unsupported);
  return {
    ...state, nodes: report, unsupported,
    error: unsupported ? probes.find((p) => p.unsupported).error : (!server ? "llama-server not found" : null),
  };
}

/** Remote free memory from the last check, if recent and the cluster is on. */
function cachedRemoteFreeBytes(cfg) {
  if (!enabled(cfg)) return 0;
  const s = readState();
  return s.at && Date.now() - s.at < STATE_TTL_MS ? s.freeBytes || 0 : 0;
}

// ---------------------------------------------------------------- worker --

/** ggml-rpc-server beside the llama-server ArcFlare uses, or where it's configured. */
function findRpcServer(cfg = {}, llamaServer) {
  const dirs = [];
  for (const c of [cfg.rpcServer, process.env.ARCFLARE_RPC_SERVER]) {
    if (!c) continue;
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    dirs.push(c);
  }
  if (llamaServer) dirs.push(path.dirname(llamaServer));
  dirs.push(
    path.join(os.homedir(), "llamacpp", "vulkan"), path.join(os.homedir(), "llamacpp", "rocm"),
    path.join(os.homedir(), "llamacpp", "cuda"), path.join(os.homedir(), "llamacpp"),
    path.join(os.homedir(), "llama.cpp", "build", "bin"),
  );
  for (const d of dirs) {
    for (const n of RPC_NAMES) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The worker running on this machine, if any. */
function workerStatus() {
  try {
    const w = JSON.parse(fs.readFileSync(WORKER_FILE, "utf8"));
    if (pidAlive(w.pid)) return { running: true, ...w };
  } catch { /* none */ }
  return { running: false };
}

/**
 * Start lending this machine's GPU: ggml-rpc-server on localhost, and the
 * gatekeeper in front of it on `bind:port`. Detached, so it outlives the CLI.
 * Resolves once the gatekeeper is listening (or rejects with its log).
 */
async function startWorker(opts) {
  const { rpcServer, bind, port = DEFAULT_PORT, allow, cache = true } = opts;
  if (workerStatus().running) throw new Error("a worker is already running here - `arcflare cluster leave` first");
  if (!allow || !allow.length) throw new Error("say which computers may connect (--allow)");
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(WORKER_LOG, "a");
  fs.writeSync(out, `\n=== ${new Date().toISOString()} worker on ${bind}:${port}, allow ${allow.join(",")}\n`);
  const args = [path.join(__dirname, "cluster-worker.js"),
    "--rpc-server", rpcServer, "--bind", bind, "--port", String(port), "--allow", allow.join(",")];
  if (cache) args.push("--cache");
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", out, out], detached: true, windowsHide: true,
    env: { ...process.env, ARCFLARE_HOME: HOME },
  });
  child.unref();

  const t0 = Date.now();
  while (Date.now() - t0 < (opts.timeoutMs || 20000)) {
    await new Promise((r) => setTimeout(r, 300));
    const st = workerStatus();
    if (st.running && st.ready) return st;
    if (!pidAlive(child.pid)) break;
  }
  const e = new Error("the worker did not start");
  e.log = tailWorkerLog(15);
  throw e;
}

function stopWorker() {
  const st = workerStatus();
  if (!st.running) return false;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(st.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(st.pid, "SIGTERM");
    }
  } catch { /* already gone */ }
  try { fs.unlinkSync(WORKER_FILE); } catch {}
  return true;
}

function tailWorkerLog(n = 30) {
  try { return fs.readFileSync(WORKER_LOG, "utf8").split(/\r?\n/).slice(-n).join("\n"); }
  catch { return ""; }
}

module.exports = {
  DEFAULT_PORT, WORKER_FILE, WORKER_LOG, STATE_FILE,
  parseNode, endpoint, nodes, enabled, addNode, removeNode, setEnabled,
  isPrivate, localAddresses, reach, scan, parseRemoteDevices, probeNode, check,
  cachedRemoteFreeBytes, findRpcServer, workerStatus, startWorker, stopWorker, tailWorkerLog,
};
