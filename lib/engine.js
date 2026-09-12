// Supervises the real llama.cpp `llama-server` binary as a child process.
//
// This is the big change from ArcFlare 0.x, which embedded llama.cpp in-process
// via node-llama-cpp. Driving the stock binary instead means:
//   * the Node process stays ~40 MB instead of hosting the model's allocator
//   * weights are mapped once, by the engine that owns them
//   * you get whatever llama.cpp build you already tuned (Vulkan/CUDA/ROCm)
//   * zero native dependencies to install or rebuild
//
// We run llama-server in *router* mode, which serves many models from a
// directory and loads them on demand — the behaviour people expect from Ollama.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const RUN_FILE = path.join(HOME, "server.json");
const LOG_FILE = path.join(HOME, "server.log");

const EXE = process.platform === "win32" ? ".exe" : "";

/** Locate llama-server, preferring an explicit setting. */
function findServer(configured) {
  const names = ["llama-server" + EXE];
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.env.ARCFLARE_LLAMA_SERVER) candidates.push(process.env.ARCFLARE_LLAMA_SERVER);

  for (const c of candidates) {
    if (!c) continue;
    const p = path.resolve(c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    for (const n of names) {
      const q = path.join(p, n);
      if (fs.existsSync(q)) return q;
    }
  }

  // PATH
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["llama-server"], { encoding: "utf8" });
  if (r.status === 0) {
    const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (first && fs.existsSync(first.trim())) return first.trim();
  }

  // Common local installs
  const guesses = [
    path.join(os.homedir(), "llamacpp", "vulkan"),
    path.join(os.homedir(), "llamacpp", "cuda"),
    path.join(os.homedir(), "llamacpp", "rocm"),
    path.join(os.homedir(), "llamacpp"),
    path.join(os.homedir(), "llama.cpp", "build", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const g of guesses) {
    for (const n of names) {
      const q = path.join(g, n);
      if (fs.existsSync(q)) return q;
    }
  }
  return null;
}

function readRun() {
  try { return JSON.parse(fs.readFileSync(RUN_FILE, "utf8")); } catch { return null; }
}

function writeRun(info) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify(info, null, 2));
}

function clearRun() {
  try { fs.unlinkSync(RUN_FILE); } catch {}
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** GET a JSON endpoint on the local server. Resolves null on any failure. */
function get(port, route, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: route, timeout },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode >= 400) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(body || null); }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function health(port) {
  const h = await get(port, "/health");
  return Boolean(h && (h.status === "ok" || h.status === "no slot available"));
}

/** Is something already serving on this port, ours or not? */
async function status(port) {
  const run = readRun();
  const up = await health(port || (run && run.port) || 11434);
  return {
    running: up,
    ...(run || {}),
    managed: Boolean(run && pidAlive(run.pid)),
  };
}

/**
 * Write a llama.cpp router preset .ini.
 * Section keys are model ids as the router will expose them; values are
 * llama-server arguments without their leading dashes.
 */
function writePreset(file, globals, perModel) {
  const lines = ["version = 1", ""];
  if (globals && Object.keys(globals).length) {
    lines.push("[*]");
    for (const [k, v] of Object.entries(globals)) lines.push(`${k} = ${v}`);
    lines.push("");
  }
  for (const [name, opts] of Object.entries(perModel || {})) {
    lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(opts)) lines.push(`${k} = ${v}`);
    lines.push("");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/**
 * Start llama-server in router mode.
 * Returns { pid, port, exe, log }.
 */
async function start(opts) {
  const {
    exe,
    port = 11434,
    modelsDir,
    preset,
    apiKey,
    extraArgs = [],
    detach = true,
    env = {},
  } = opts;

  if (await health(port)) {
    const run = readRun();
    return { already: true, port, pid: run && run.pid, exe: run && run.exe };
  }

  const args = ["--host", "127.0.0.1", "--port", String(port)];
  if (modelsDir) args.push("--models-dir", modelsDir);
  if (preset) args.push("--models-preset", preset);
  if (apiKey) args.push("--api-key", apiKey);
  // Let llama.cpp shrink any unset sizing argument to fit device memory. This
  // is what makes "just use max context" safe rather than an OOM lottery.
  args.push("--fit", "on");
  args.push("--jinja");
  args.push(...extraArgs);

  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  fs.writeSync(out, `\n=== ${new Date().toISOString()} ${exe} ${args.join(" ")}\n`);

  const child = spawn(exe, args, {
    stdio: ["ignore", out, out],
    detached: detach && process.platform !== "win32",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (detach && process.platform !== "win32") child.unref();

  const info = { pid: child.pid, port, exe, args, log: LOG_FILE, started: Date.now() };
  writeRun(info);
  return info;
}

/** Poll until the server answers, or give up. */
async function waitReady(port, timeoutMs = 600000, onTick) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await health(port)) return true;
    const run = readRun();
    if (run && run.pid && !pidAlive(run.pid)) return false;
    if (onTick) onTick(Date.now() - t0);
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stop() {
  const run = readRun();
  if (!run || !run.pid) return false;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(run.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(run.pid, "SIGTERM");
    }
  } catch { /* already gone */ }
  clearRun();
  return true;
}

/** Models the running router knows about. */
async function listServed(port) {
  const j = await get(port, "/v1/models", 4000);
  if (!j || !Array.isArray(j.data)) return [];
  return j.data.map((m) => m.id);
}

function tailLog(n = 40) {
  try {
    const txt = fs.readFileSync(LOG_FILE, "utf8");
    return txt.split(/\r?\n/).slice(-n).join("\n");
  } catch { return ""; }
}

module.exports = {
  findServer, start, stop, status, health, waitReady, writePreset,
  listServed, readRun, tailLog, get,
  HOME, RUN_FILE, LOG_FILE,
};
