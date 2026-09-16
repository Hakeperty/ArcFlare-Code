// Process supervision: run a command to completion, or start one and leave it
// running while you poke at it.
//
// The background half is the reason this file exists. A dev server, a game, a
// watch-mode build and a REPL all share one property: they never exit, so the
// usual "run it and read the output" shape deadlocks. Here a started process
// gets an id, its output lands in a ring buffer, and the caller comes back for
// logs, sends it input, or kills it.

const { spawn, spawnSync } = require("child_process");
const path = require("path");

const IS_WIN = process.platform === "win32";

// Per-process output kept in memory. Generous enough for a build log, small
// enough that twenty forgotten servers cannot eat the machine.
const BUFFER_BYTES = 256 * 1024;
const MAX_PROCS = 24;

// ------------------------------------------------------------------ shell ----

let bashPath;
/** Git Bash is present on most Windows dev boxes; find it once. */
function findBash() {
  if (bashPath !== undefined) return bashPath;
  const probe = spawnSync(IS_WIN ? "where" : "which", ["bash"], { encoding: "utf8" });
  const hit = String(probe.stdout || "").split(/\r?\n/).map((s) => s.trim())
    .filter(Boolean)
    // The WSL stub in System32 is not a shell we can run a build in.
    .filter((p) => !/System32[\\/]bash\.exe$/i.test(p))[0];
  bashPath = hit || null;
  return bashPath;
}

// Windows console tools whose arguments are /switches. Git Bash rewrites
// anything starting with a slash into a Windows path before the program sees
// it, so these have to go through cmd.
const WINDOWS_SWITCH_TOOLS =
  /^(taskkill|tasklist|sc|reg|netsh|wmic|schtasks|icacls|robocopy|xcopy|shutdown|net|dism|sfc|where|attrib|cmdkey|driverquery|powercfg|bcdedit)\b/i;

/**
 * Turn a shell name into something spawnable.
 *
 * `auto` on Windows prefers bash, and that is a considered choice rather than
 * taste: a model writing `npm ci && npm test` is writing POSIX, and Windows
 * PowerShell 5.1 has no `&&` at all — it fails with a parser error that reads
 * like a broken build. cmd and bash both understand it.
 */
function resolveShell(kind, command) {
  const k = (kind || "auto").toLowerCase();
  if (k === "none") return null;

  const bash = (exe) => ({ exe, args: ["-c", command], label: "bash" });
  const cmd = () => ({
    exe: process.env.ComSpec || "cmd.exe",
    // Quoted whole, verbatim: this is what Node's own shell:true does, and it
    // is the only form that survives &&, |, and quotes inside the command.
    args: ["/d", "/s", "/c", `"${command}"`],
    label: "cmd",
    verbatim: true,
  });
  const pwsh = (exe, label) => ({
    exe,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    label,
  });

  if (!IS_WIN) {
    if (k === "bash") return bash("bash");
    return { exe: "/bin/sh", args: ["-c", command], label: "sh" };
  }
  switch (k) {
    case "bash": return bash(findBash() || "bash");
    case "cmd": return cmd();
    case "powershell": return pwsh("powershell.exe", "powershell");
    case "pwsh": return pwsh("pwsh.exe", "pwsh");
    default: {
      // One exception to preferring bash: Git Bash rewrites anything that looks
      // like a POSIX path, so `taskkill /IM node.exe` arrives as
      // `taskkill C:/Program Files/Git/IM node.exe` and fails on its own
      // argument. Windows tools that take /switches go through cmd instead.
      if (WINDOWS_SWITCH_TOOLS.test(String(command).trim()) && /\s\/[A-Za-z?]/.test(command)) {
        return cmd();
      }
      const b = findBash();
      return b ? bash(b) : cmd();
    }
  }
}

// ------------------------------------------------------------------ kills ----

/**
 * Kill a process and everything it started.
 *
 * `npm start` is a shell that spawns node that spawns a bundler; killing the
 * shell leaves the port bound and the next run fails with EADDRINUSE. So:
 * taskkill /T on Windows, process-group signal on POSIX.
 */
function killTree(pid, signal = "SIGTERM") {
  if (!pid) return false;
  if (IS_WIN) {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"],
      { encoding: "utf8", windowsHide: true });
    return r.status === 0;
  }
  try { process.kill(-pid, signal); return true; }
  catch {
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

// -------------------------------------------------------------------- env ----

// Markers a parent process set for *its* children, which mean something wrong
// two levels down. NODE_TEST_CONTEXT is the one that bites: inherit it and a
// project's `node --test` quietly skips every file with "run() is being called
// recursively", so a test suite reports a clean pass having run nothing.
const STRIP_ENV = ["NODE_TEST_CONTEXT"];

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return { ...env, ...(extra || {}) };
}

// ----------------------------------------------------------------- buffer ----

class Ring {
  constructor(limit = BUFFER_BYTES) {
    this.limit = limit;
    this.chunks = [];
    this.bytes = 0;
    this.dropped = 0;
  }
  push(stream, text) {
    if (!text) return;
    this.chunks.push({ stream, text, at: Date.now() });
    this.bytes += Buffer.byteLength(text);
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const gone = this.chunks.shift();
      const n = Buffer.byteLength(gone.text);
      this.bytes -= n;
      this.dropped += n;
    }
  }
  /** @param {"merged"|"stdout"|"stderr"} stream */
  text(stream = "merged") {
    const keep = this.chunks.filter((ch) =>
      stream === "merged" || (stream === "stdout" ? ch.stream === "out" : ch.stream === "err"));
    if (stream !== "merged") return keep.map((ch) => ch.text).join("");
    // Merged output interleaves in arrival order, with stderr marked so a
    // reader can tell a warning from a result.
    let out = "";
    for (const ch of keep) {
      if (ch.stream !== "err") { out += ch.text; continue; }
      if (out && !out.endsWith("\n")) out += "\n";
      out += "[stderr] " + ch.text.replace(/\n(?=.)/g, "\n[stderr] ");
    }
    return out;
  }
}

function tailLines(text, n) {
  if (!n || n <= 0) return text;
  const lines = String(text).split(/\r?\n/);
  if (lines.length <= n) return text;
  return `… ${lines.length - n} earlier lines\n` + lines.slice(-n).join("\n");
}

// ------------------------------------------------------------- supervisor ----

class Supervisor {
  constructor(o = {}) {
    this.procs = new Map();
    this.nextId = 1;
    this.maxProcs = o.maxProcs || MAX_PROCS;
    this.bufferBytes = o.bufferBytes || BUFFER_BYTES;
  }

  _spawn({ command, exe, args, cwd, env, shell, detach }) {
    const sh = exe ? null : resolveShell(shell, command);
    const file = exe || (sh ? sh.exe : null);
    const argv = exe ? (args || []) : (sh ? sh.args : []);
    if (!file) throw new Error("nothing to run: pass a command, or exe with shell:none");

    const child = spawn(file, argv, {
      cwd: cwd || process.cwd(),
      env: childEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: sh ? !!sh.verbatim : undefined,
      // A group leader on POSIX so the whole tree can be signalled later. On
      // Windows detaching would hand the child its own console, which breaks
      // stdin, so taskkill /T does that job instead.
      detached: !IS_WIN && !!detach,
    });
    return { child, shellLabel: sh ? sh.label : "none", file, argv };
  }

  /** Run to completion. Resolves with output and exit status; never rejects. */
  run({ command, exe, args, cwd, env, shell, timeout_ms, input }) {
    const started = Date.now();
    let s;
    try { s = this._spawn({ command, exe, args, cwd, env, shell, detach: true }); }
    catch (e) { return Promise.resolve({ ok: false, error: e.message, output: "" }); }

    const ring = new Ring(this.bufferBytes);
    const timeout = Math.min(Math.max(Number(timeout_ms) || 180000, 1000), 1800000);

    return new Promise((resolve) => {
      let done = false;
      let timedOut = false;

      s.child.stdout.setEncoding("utf8");
      s.child.stderr.setEncoding("utf8");
      s.child.stdout.on("data", (d) => ring.push("out", d));
      s.child.stderr.on("data", (d) => ring.push("err", d));
      if (input != null) { try { s.child.stdin.write(input); } catch {} }
      try { s.child.stdin.end(); } catch {}

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(s.child.pid, "SIGKILL");
      }, timeout);

      const finish = (code, signal, error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          ok: !error && !timedOut && code === 0,
          code: code == null ? null : code,
          signal: signal || null,
          timedOut,
          error: error || null,
          durationMs: Date.now() - started,
          shell: s.shellLabel,
          cwd: cwd || process.cwd(),
          command: command || [s.file, ...s.argv].join(" "),
          output: ring.text("merged"),
          stdout: ring.text("stdout"),
          stderr: ring.text("stderr"),
          dropped: ring.dropped,
        });
      };

      // `exit` says the process is gone; `close` says its pipes are too, and
      // those are not the same event. Kill a tree on Windows and a surviving
      // grandchild can hold the inherited stdout handle open indefinitely — so
      // waiting for `close` hangs a command that has already finished. Take
      // `exit`, give the pipes a moment to flush what is still in flight, and
      // let `close` finish early when it does arrive.
      let exited = null;
      s.child.on("exit", (code, signal) => {
        exited = { code, signal };
        setTimeout(() => finish(code, signal, null), 200);
      });
      s.child.on("close", (code, signal) => finish(
        exited ? exited.code : code, exited ? exited.signal : signal, null));
      s.child.on("error", (e) => finish(null, null, e.message));
    });
  }

  /** Start and leave running. Returns the record synchronously. */
  start({ command, exe, args, cwd, env, shell, name }) {
    const live = [...this.procs.values()].filter((p) => p.exitedAt == null);
    if (live.length >= this.maxProcs) {
      throw new Error(`too many background processes (${live.length}); stop some first`);
    }
    const s = this._spawn({ command, exe, args, cwd, env, shell, detach: true });
    const id = "p" + this.nextId++;
    const rec = {
      id,
      name: name || (command ? String(command).slice(0, 60) : path.basename(s.file)),
      command: command || [s.file, ...s.argv].join(" "),
      shell: s.shellLabel,
      cwd: cwd || process.cwd(),
      pid: s.child.pid,
      startedAt: Date.now(),
      exitedAt: null,
      code: null,
      signal: null,
      error: null,
      ring: new Ring(this.bufferBytes),
      child: s.child,
      waiters: [],
    };

    const wake = () => { rec.waiters = rec.waiters.filter((w) => !w(rec)); };
    s.child.stdout.setEncoding("utf8");
    s.child.stderr.setEncoding("utf8");
    s.child.stdout.on("data", (d) => { rec.ring.push("out", d); wake(); });
    s.child.stderr.on("data", (d) => { rec.ring.push("err", d); wake(); });
    s.child.on("error", (e) => { rec.error = e.message; rec.exitedAt = Date.now(); wake(); });
    // See run(): `exit` is when the process died, `close` only when its pipes
    // did. Reporting a killed server as "still running" because a grandchild
    // holds a handle would be a lie with consequences — the next thing anyone
    // does is try to bind the port it was holding.
    const ended = (code, signal) => {
      if (rec.exitedAt != null) return wake();
      rec.code = code;
      rec.signal = signal;
      rec.exitedAt = Date.now();
      wake();
    };
    s.child.on("exit", ended);
    s.child.on("close", ended);

    this.procs.set(id, rec);
    return rec;
  }

  get(id) {
    const rec = this.procs.get(id);
    if (!rec) throw new Error(`no process "${id}" — call ps to see what is running`);
    return rec;
  }

  logs(id, { stream = "merged", tail = 120, grep } = {}) {
    const rec = this.get(id);
    let text = rec.ring.text(stream);
    if (grep) {
      let re;
      try { re = new RegExp(grep, "i"); } catch (e) { throw new Error("bad grep pattern: " + e.message); }
      text = text.split(/\r?\n/).filter((l) => re.test(l)).join("\n");
    }
    return { rec, text: tailLines(text, tail), dropped: rec.ring.dropped };
  }

  write(id, text, { newline = true } = {}) {
    const rec = this.get(id);
    if (rec.exitedAt != null) throw new Error(`process "${id}" has already exited`);
    rec.child.stdin.write(newline && !/\n$/.test(text) ? text + "\n" : text);
    return rec;
  }

  stop(id, { signal = "SIGTERM" } = {}) {
    const rec = this.get(id);
    if (rec.exitedAt != null) return { rec, alreadyExited: true };
    killTree(rec.pid, signal);
    return { rec, alreadyExited: false };
  }

  /** Resolve when test(rec) holds, or when new output makes it hold, or on timeout. */
  waitFor(id, test, timeoutMs = 30000) {
    const rec = this.get(id);
    if (test(rec)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
        return true;
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      rec.waiters.push((r) => (test(r) ? done(true) : false));
    });
  }

  list() {
    return [...this.procs.values()].map((p) => ({
      id: p.id,
      name: p.name,
      pid: p.pid,
      cwd: p.cwd,
      command: p.command,
      running: p.exitedAt == null,
      code: p.code,
      uptimeMs: (p.exitedAt || Date.now()) - p.startedAt,
      bytes: p.ring.bytes,
    }));
  }

  /** Reap finished records, keeping the most recent few for inspection. */
  sweep(keep = 8) {
    const dead = [...this.procs.values()]
      .filter((p) => p.exitedAt != null)
      .sort((a, b) => a.exitedAt - b.exitedAt);
    for (const p of dead.slice(0, Math.max(0, dead.length - keep))) this.procs.delete(p.id);
  }

  /** Nothing we started outlives us. */
  stopAll() {
    for (const p of this.procs.values()) {
      if (p.exitedAt == null) killTree(p.pid, "SIGKILL");
    }
  }
}

module.exports = {
  Supervisor, Ring, resolveShell, killTree, findBash, tailLines, childEnv, IS_WIN,
};
