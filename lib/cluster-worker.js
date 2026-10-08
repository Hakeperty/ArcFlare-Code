#!/usr/bin/env node
// The worker side of `arcflare cluster`: runs detached, started by
// cluster.startWorker.
//
//   ggml-rpc-server on 127.0.0.1:<random>   <-  this process on <bind>:<port>  <-  allowed hosts
//
// ggml-rpc-server will run whatever a client sends it and has no notion of who
// that client is, so it only ever listens on localhost. This process is the
// one thing on the network, and it closes every connection whose source
// address is not on the allow list before a single byte reaches the server.
// An address can be spoofed by someone already on your LAN, so this keeps out
// the rest of the network, not a hostile neighbour; for that, run the cluster
// over a VPN such as WireGuard.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const WORKER_FILE = path.join(HOME, "cluster-worker.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const norm = (ip) => String(ip || "").replace(/^::ffff:/, "").toLowerCase();

/** A port nothing is using right now, on localhost. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: "127.0.0.1", port });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - t0 > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

/**
 * Pipe an accepted socket to the local server, or drop it if not allowed.
 * `innerPort` is a number or a function returning one (it changes when
 * ggml-rpc-server is restarted).
 */
function gate(allow, innerPort) {
  const target = typeof innerPort === "function" ? innerPort : () => innerPort;
  return (client) => {
    const from = norm(client.remoteAddress);
    if (!allow.has(from)) {
      log(`refused ${from}`);
      client.destroy();
      return;
    }
    log(`connected ${from}`);
    const inner = net.connect({ host: "127.0.0.1", port: target() });
    // RPC is many small round trips per token: Nagle's delay would cost more
    // than the hop itself.
    client.setNoDelay(true);
    inner.setNoDelay(true);
    client.pipe(inner);
    inner.pipe(client);
    const end = () => { client.destroy(); inner.destroy(); };
    client.once("close", () => { log(`closed ${from}`); end(); });
    inner.once("close", end);
    client.on("error", end);
    inner.on("error", end);
  };
}

async function main() {
  const rpcServer = arg("--rpc-server");
  const bind = arg("--bind");
  const port = Number(arg("--port", "50052"));
  const allow = new Set(String(arg("--allow", "")).split(",").map(norm).filter(Boolean));
  if (!rpcServer || !bind || !allow.size) {
    console.error("usage: cluster-worker.js --rpc-server <path> --bind <ip> --port <n> --allow <ip,...> [--cache]");
    process.exit(2);
  }

  // ggml-rpc-server is a proof of concept by llama.cpp's own account: a client
  // that disconnects mid-reply can kill it with SIGPIPE. Restart it rather
  // than take the worker down, unless it keeps dying.
  const inner = { port: 0, proc: null };
  const restarts = [];
  let stopping = false;
  let server = null;

  const shutdown = (code) => {
    stopping = true;
    try { if (inner.proc) inner.proc.kill(); } catch {}
    if (server) server.close();
    try {
      const w = JSON.parse(fs.readFileSync(WORKER_FILE, "utf8"));
      if (w.pid === process.pid) fs.unlinkSync(WORKER_FILE);
    } catch {}
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  const startRpc = async () => {
    inner.port = await freePort();
    const rpcArgs = ["-H", "127.0.0.1", "-p", String(inner.port)];
    if (process.argv.includes("--cache")) rpcArgs.push("-c");
    log(`starting ${rpcServer} ${rpcArgs.join(" ")}`);
    const proc = spawn(rpcServer, rpcArgs, {
      cwd: path.dirname(rpcServer),
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      // RDMA negotiates a direct path between the two hosts, which would go
      // around this gate. Plain TCP keeps every byte coming through it.
      env: { ...process.env, GGML_RPC_NO_RDMA: "1" },
    });
    inner.proc = proc;
    proc.on("error", (e) => { log(`ggml-rpc-server failed to start: ${e.message}`); shutdown(1); });
    proc.on("exit", async (c, sig) => {
      if (stopping) return;
      log(`ggml-rpc-server exited (${sig || c})`);
      const now = Date.now();
      restarts.push(now);
      while (restarts.length && now - restarts[0] > 60000) restarts.shift();
      if (restarts.length > 5) {
        log("it keeps exiting - giving up");
        shutdown(1);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (!stopping && !(await startRpc())) shutdown(1);
    });
    if (!(await waitForPort(inner.port, 30000))) {
      log("ggml-rpc-server never started listening");
      return false;
    }
    return true;
  };

  if (!(await startRpc())) {
    shutdown(1);
    return;
  }

  server = net.createServer(gate(allow, () => inner.port));
  server.on("error", (e) => { log(`cannot listen on ${bind}:${port}: ${e.message}`); shutdown(1); });
  server.listen(port, bind, () => {
    log(`listening on ${bind}:${port}, allowing ${[...allow].join(", ")}`);
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(WORKER_FILE, JSON.stringify({
      pid: process.pid, bind, port, allow: [...allow],
      cache: process.argv.includes("--cache"), started: Date.now(), ready: true,
    }, null, 2));
  });
}

if (require.main === module) main();

module.exports = { gate, norm };
