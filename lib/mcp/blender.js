// Blender, from the machine's side.
//
// There is already an excellent MCP server for *driving* Blender — it models,
// sculpts, lights and renders through the running application, and ArcFlare
// reaches it like any other server. This file is deliberately not that. It
// covers the three things that server cannot do, because all three are true
// before it can answer at all:
//
//   1. Finding Blender. An artist's machine has 5.2 in Program Files, an LTS
//      beside it and sometimes a Steam copy; "blender" on PATH is the least
//      likely of the three on Windows.
//   2. Getting it running, and knowing that it is. The driving server talks to
//      an addon on a TCP port inside a live Blender. If Blender is closed, or
//      open with the addon switched off, every one of its tools fails with the
//      same connection error — and "start it" is a machine-level job.
//   3. Headless work. `blender --background` needs no GUI, no addon and no
//      port: it converts formats, batch-renders and reads .blend files in
//      seconds. Driving the GUI to do that is slower and worse.
//
// The split is the same one the rest of this server makes: ArcFlare gets you a
// working thing and tells you the truth about whether it works; what to model
// once you are there is somebody else's tool.

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

const IS_WIN = process.platform === "win32";
const DEFAULT_PORT = 9876;

// ------------------------------------------------------------------ finding --

/** Directories worth looking in, most likely first. */
function searchRoots() {
  const home = os.homedir();
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      path.join(pf, "Blender Foundation"),
      path.join(pf86, "Blender Foundation"),
      path.join(pf, "Steam", "steamapps", "common"),
      path.join(pf86, "Steam", "steamapps", "common"),
      path.join(home, "AppData", "Local", "Programs"),
      path.join(home, "blender"),
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications", path.join(home, "Applications")];
  }
  return ["/usr/bin", "/usr/local/bin", "/opt", "/snap/bin", path.join(home, ".local", "bin")];
}

function exeName() {
  if (IS_WIN) return "blender.exe";
  if (process.platform === "darwin") return "Blender";
  return "blender";
}

/** A version tuple parsed out of a path like "...\\Blender Foundation\\Blender 5.2". */
function versionFromPath(p) {
  const m = String(p).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function newerFirst(a, b) {
  const va = versionFromPath(a.path);
  const vb = versionFromPath(b.path);
  for (let i = 0; i < 3; i++) if (vb[i] !== va[i]) return vb[i] - va[i];
  return 0;
}

/** Every Blender executable we can see, newest first. */
function installations() {
  const found = new Map();
  const add = (p, how) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (found.has(abs.toLowerCase())) return;
    try { if (!fs.statSync(abs).isFile()) return; } catch { return; }
    found.set(abs.toLowerCase(), { path: abs, how });
  };

  // An explicit choice beats anything discovered.
  if (process.env.BLENDER) add(process.env.BLENDER, "BLENDER");
  if (process.env.ARCFLARE_BLENDER) add(process.env.ARCFLARE_BLENDER, "ARCFLARE_BLENDER");

  try { add(require("./apps").onPath(exeName()), "PATH"); } catch {}

  const exe = exeName();
  for (const root of searchRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }

    // The executable may sit in the root itself (Linux /usr/bin) or one level
    // down in a versioned folder (Windows "Blender 5.2", Steam "Blender").
    add(path.join(root, exe), root);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/blender/i.test(e.name)) continue;
      const dir = path.join(root, e.name);
      add(path.join(dir, exe), dir);
      // macOS keeps it inside the bundle.
      add(path.join(dir, "Contents", "MacOS", "Blender"), dir);
    }
  }

  return [...found.values()].sort(newerFirst);
}

/** The one we would use. */
function find() {
  return installations()[0] || null;
}

/**
 * Blender's own version string.
 *
 * Asked of the binary rather than inferred from its folder: a "Blender 4.2"
 * directory someone upgraded in place reports 5.2, and the folder name is the
 * thing that lies.
 */
function parseVersion(text) {
  const m = String(text || "").match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/i);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------- bridge --

/**
 * The port the in-Blender addon listens on.
 *
 * Read from the driving server's own config where it exists, so the two agree
 * without anyone configuring ArcFlare separately.
 */
function bridgePort() {
  const env = Number(process.env.ARCFLARE_BLENDER_PORT || process.env.BLENDER_MCP_PORT);
  if (Number.isFinite(env) && env > 0) return env;
  const cfg = process.env.BLENDER_MCP_CONFIG ||
    path.join(os.homedir(), ".blender_mcp", "config.toml");
  try {
    const text = fs.readFileSync(cfg, "utf8");
    const section = text.split(/^\s*\[/m).find((s) => s.startsWith("blender_bridge]"));
    const m = section && section.match(/^\s*port\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* the default is the documented one */ }
  return DEFAULT_PORT;
}

/**
 * One request to the addon: a big-endian uint32 length, then that many bytes
 * of UTF-8 JSON, and the same shape back. The addon serves one request per
 * connection, so there is no framing state to keep between calls.
 */
function bridgeCall(cmd, args = {}, opts = {}) {
  const port = opts.port || bridgePort();
  const host = opts.host || "127.0.0.1";
  const timeoutMs = opts.timeoutMs || 15000;
  const id = Math.random().toString(16).slice(2) + Date.now().toString(16);

  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let header = null;
    let buf = Buffer.alloc(0);
    let settled = false;

    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };

    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => done({ ok: false, error: "timeout", port }));
    sock.on("error", (e) => done({ ok: false, error: e.code || e.message, port }));

    sock.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ id, cmd, args: args || {} }), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      sock.write(Buffer.concat([head, body]));
    });

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (header == null) {
        if (buf.length < 4) return;
        header = buf.readUInt32BE(0);
        buf = buf.subarray(4);
      }
      if (buf.length < header) return;
      let msg;
      try { msg = JSON.parse(buf.subarray(0, header).toString("utf8")); }
      catch (e) { return done({ ok: false, error: `bad frame: ${e.message}`, port }); }
      if (msg && msg.ok === false) {
        const err = msg.error || {};
        return done({ ok: false, error: err.message || "the addon refused the command", port });
      }
      done({ ok: true, result: (msg && msg.result) ?? null, port });
    });

    // A closed connection with nothing in it is the addon dying mid-request.
    sock.on("close", () => done({ ok: false, error: "connection closed with no reply", port }));
  });
}

/**
 * Is there a live Blender with the addon listening?
 *
 * A port being open is not the same answer: something else may hold 9876, and
 * a Blender busy in a modal operator accepts the connection and never replies.
 * So this asks a real question and reads the real answer.
 */
async function bridgeStatus(opts = {}) {
  const r = await bridgeCall("system_status", {}, { timeoutMs: 5000, ...opts });
  if (r.ok) return { reachable: true, port: r.port, status: r.result };
  const refused = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|closed with no reply/i.test(r.error || "");
  return {
    reachable: false,
    port: r.port,
    error: r.error,
    // The distinction people actually need: is Blender not running, or is it
    // running with the addon off? Only one of those is fixed by launching it.
    likely: refused ? "nothing is listening — Blender is closed, or the MCP bridge addon is disabled"
      : `the port answered but the command did not complete (${r.error})`,
  };
}

// ----------------------------------------------------------------- headless --

/**
 * Argument vector for a headless Python run.
 *
 * `--` matters: everything after it is handed to the script rather than parsed
 * by Blender, and without it a script argument that looks like a Blender flag
 * is quietly eaten by Blender instead.
 */
function headlessArgs({ blend, expr, script, factoryStartup = true, args = [] } = {}) {
  if (!expr && !script) throw new Error("headless needs either expr or script");
  const argv = ["--background"];
  if (factoryStartup) argv.push("--factory-startup");
  if (blend) argv.push(path.resolve(blend));
  argv.push("--enable-autoexec");
  if (script) argv.push("--python", path.resolve(script));
  else argv.push("--python-expr", expr);
  if (args && args.length) argv.push("--", ...args.map(String));
  return argv;
}

// Blender narrates its own startup and shutdown on stdout, and none of it is
// the answer to anything anyone asked.
const NOISE = [
  /^Blender\s+\d/,
  /^Read prefs:/,
  /^Read blend:/,
  /^\s*$/,
  /^Blender quit$/,
  /^found bundled python:/i,
  /^Warning: Falling back to the standard locale/i,
  /^AL lib:/,
  /^Color management:/i,
  /^Writing:/,
  /^Saved:/,
];

/** What the script actually printed, with Blender's own chatter removed. */
function cleanOutput(text) {
  const kept = [];
  const notes = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^(Writing|Saved):/.test(line)) { notes.push(line.trim()); continue; }
    if (NOISE.some((re) => re.test(line))) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { text: kept.join("\n").trim(), notes };
}

/**
 * A Python failure inside Blender, pulled out of the log.
 *
 * Blender exits 0 after a script raises — it prints the traceback, finishes
 * shutting down and reports success. Reading the exit code alone would call
 * that a working render, which is exactly the failure this whole server exists
 * to stop.
 */
function pythonError(text) {
  // The supervisor merges the two streams and marks which is which; a
  // traceback arrives on stderr, and "[stderr] ValueError" is not the error
  // message, it is the error message wearing a label.
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/^\[stderr\]\s?/, ""));
  const start = lines.findIndex((l) => /Traceback \(most recent call last\)/.test(l));
  if (start >= 0) {
    // A traceback runs from its header through the first line after it that is
    // not indented: the frame list is indented, that line is the exception
    // itself, and anything past it is Blender resuming its shutdown. Taking
    // the rest of the log instead would bury the one line worth reading.
    const rest = lines.slice(start + 1);
    const endRel = rest.findIndex((l) => l.trim() && !/^\s/.test(l));
    const body = (endRel >= 0 ? lines.slice(start, start + endRel + 2) : lines.slice(start))
      .join("\n").trimEnd();
    const summary = endRel >= 0
      ? rest[endRel].trim()
      : (body.split("\n").filter((l) => l.trim()).pop() || "python error").trim();
    return { failed: true, summary, detail: body };
  }
  const err = lines.find((l) => /^Error: /.test(l));
  if (err) return { failed: true, summary: err.trim(), detail: err.trim() };
  return { failed: false };
}

// ------------------------------------------------------------------ render ---

/**
 * Argument vector for a headless render.
 *
 * Order is not stylistic: Blender applies `-o`, `-F` and `-E` in the order it
 * reads them, so a `-f` placed before the output path renders to whatever the
 * .blend had saved instead.
 */
function renderArgs({ blend, output, frame, engine, format, samples } = {}) {
  if (!blend) throw new Error("render needs a .blend file");
  const argv = ["--background", path.resolve(blend)];
  if (engine) argv.push("--engine", engine);
  if (output) argv.push("--render-output", path.resolve(output));
  if (format) argv.push("--render-format", String(format).toUpperCase());
  if (samples != null) {
    argv.push("--python-expr",
      `import bpy;bpy.context.scene.cycles.samples=${Number(samples)};` +
      `bpy.context.scene.eevee.taa_render_samples=${Number(samples)}`);
  }
  argv.push("--render-frame", String(frame == null ? 1 : frame));
  return argv;
}

/**
 * The files a render actually produced.
 *
 * Blender decides the real filename itself — it appends the frame number and
 * the format's extension to whatever prefix it was given — so the only honest
 * way to report an output path is to look for what appeared.
 */
function renderedFiles(outputPrefix, since) {
  const abs = path.resolve(outputPrefix);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (base && !name.startsWith(base)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (since && st.mtimeMs < since - 1000) continue;
    out.push({ path: full, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = {
  find, installations, searchRoots, exeName, versionFromPath, parseVersion,
  bridgePort, bridgeCall, bridgeStatus,
  headlessArgs, cleanOutput, pythonError,
  renderArgs, renderedFiles,
  DEFAULT_PORT, IS_WIN,
};
