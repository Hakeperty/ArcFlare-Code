// Opening things the way a person would: double-click a file, click an entry in
// the Start menu, follow a link.
//
// The hard part on Windows is that "the app" is rarely an exe on PATH. Chrome,
// Blender, VS Code and Steam games are Start-menu shortcuts pointing at paths
// nobody remembers, so a name like "blender" has to be resolved before it can
// be launched. The order below is PATH first (exact and fast), then shortcuts
// (what the user themselves would click).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Scanning the Start menu costs a few hundred stat calls; once a minute is
// plenty for something that changes when software is installed.
const CACHE_TTL_MS = 60000;
let cache = { at: 0, apps: null };

function startMenuRoots() {
  const roots = [];
  const add = (p) => { if (p && fs.existsSync(p)) roots.push(p); };
  if (IS_WIN) {
    add(path.join(process.env.ProgramData || "C:\\ProgramData",
      "Microsoft", "Windows", "Start Menu", "Programs"));
    add(path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs"));
    add(path.join(os.homedir(), "Desktop"));
    add(path.join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop"));
  } else if (IS_MAC) {
    add("/Applications");
    add(path.join(os.homedir(), "Applications"));
    add("/System/Applications");
  } else {
    add("/usr/share/applications");
    add(path.join(os.homedir(), ".local", "share", "applications"));
  }
  return roots;
}

function walk(dir, depth, out, limit) {
  if (depth < 0 || out.length >= limit) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // macOS bundles are directories, but they are the thing we want, not a
      // place to look inside.
      if (IS_MAC && e.name.endsWith(".app")) { out.push(full); continue; }
      walk(full, depth - 1, out, limit);
    } else if (IS_WIN ? /\.(lnk|url)$/i.test(e.name)
      : IS_MAC ? false
        : /\.desktop$/.test(e.name)) {
      out.push(full);
    }
  }
}

/** Everything the user could click on, as {name, path}. */
function installed() {
  if (cache.apps && Date.now() - cache.at < CACHE_TTL_MS) return cache.apps;
  const files = [];
  for (const root of startMenuRoots()) walk(root, 4, files, 4000);
  const seen = new Set();
  const apps = [];
  for (const f of files) {
    const name = path.basename(f).replace(/\.(lnk|url|desktop|app)$/i, "");
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({ name, path: f });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), apps };
  return apps;
}

/** Fuzzy search over installed applications. */
function search(query, limit = 20) {
  const q = String(query || "").trim().toLowerCase();
  const apps = installed();
  if (!q) return apps.slice(0, limit);
  const scored = [];
  for (const a of apps) {
    const n = a.name.toLowerCase();
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 60;
    else if (n.includes(q)) score = 40;
    else if (q.split(/\s+/).every((t) => n.includes(t))) score = 20;
    if (score) scored.push({ ...a, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, limit);
}

/**
 * An executable on PATH, or null.
 *
 * `where notepad` on a machine with Git for Windows answers with the MSYS shim
 * `…/git/usr/bin/notepad` before the real `notepad.exe` — an extensionless file
 * that CreateProcess cannot run at all, so the "found" program fails to spawn
 * with ENOENT. On Windows an entry Windows can actually execute wins.
 */
function onPath(name) {
  const r = spawnSync(IS_WIN ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const hits = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!hits.length) return null;
  if (!IS_WIN) return hits[0];
  return hits.find((h) => /\.(exe|com|bat|cmd)$/i.test(h)) || hits[0];
}

/**
 * Resolve an app name to something launchable.
 * Returns { target, how } where `how` explains which route was taken.
 */
function resolveApp(name) {
  const raw = String(name || "").trim().replace(/^"|"$/g, "");
  if (!raw) return null;

  if (path.isAbsolute(raw) && fs.existsSync(raw)) return { target: raw, how: "path" };

  const direct = onPath(raw) || (IS_WIN && !/\.\w+$/.test(raw) ? onPath(raw + ".exe") : null);
  if (direct) return { target: direct, how: "PATH" };

  const hits = search(raw, 5);
  if (hits.length) return { target: hits[0].path, how: "start menu", name: hits[0].name, alternatives: hits.slice(1, 4).map((h) => h.name) };

  if (IS_MAC) return { target: raw, how: "open -a" };
  return null;
}

/**
 * Refuse a string that would not survive cmd.exe's command line.
 *
 * `start` is a cmd builtin, so opening anything on Windows means handing cmd a
 * command *line* — and with windowsVerbatimArguments nothing escapes it on the
 * way. Inside double quotes cmd leaves `&`, `|` and `^` alone, so the only two
 * things that matter are a quote, which closes the string and lets whatever
 * follows run as a command, and a `%VAR%` pair, which cmd expands before it
 * parses. Both are rejected rather than escaped: there is no escape for a quote
 * that cmd and every shell behind it agree on, and no legitimate path or URL
 * needs either.
 */
function assertCmdSafe(value, what) {
  const v = String(value);
  if (v.includes('"')) {
    throw new Error(`${what} may not contain a double quote: it would end the quoted argument and run the rest as a command`);
  }
  if (/[\r\n\u0000]/.test(v)) {
    throw new Error(`${what} may not contain newlines or null bytes`);
  }
  const envPair = /%[A-Za-z_][A-Za-z0-9_()]*%/.exec(v);
  if (envPair) {
    throw new Error(`${what} may not contain ${envPair[0]}: cmd would expand it before parsing (percent-encoding like %20 is fine)`);
  }
  return v;
}

/**
 * Hand a file, folder or URL to the OS, exactly as a double-click would.
 * Returns immediately — the point is to open it, not to wait for it to close.
 */
function openWith(target, args = []) {
  if (IS_WIN) {
    assertCmdSafe(target, "target");
    args.forEach((a, i) => assertCmdSafe(a, `argument ${i + 1}`));
    // `start` is a cmd builtin, and its first quoted argument is the window
    // title — omitting the empty "" makes cmd swallow a quoted path as a title
    // and open nothing at all.
    const line = ["start", '""', `"${target}"`, ...args.map((a) => `"${a}"`)].join(" ");
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: "ignore",
    });
    // A child with nobody listening for `error` throws it as an uncaught
    // exception, which in a server means one bad path kills every session.
    child.on("error", () => {});
    child.unref();
    return { launcher: "cmd start", target };
  }
  const exe = IS_MAC ? "open" : "xdg-open";
  const argv = IS_MAC && args.length ? [target, "--args", ...args] : [target, ...args];
  const child = spawn(exe, argv, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return { launcher: exe, target };
}

/** Spawn detached, and report an immediate failure instead of throwing it. */
function trySpawn(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: "ignore", ...opts });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    // spawn() reports a bad executable asynchronously, so "did it start?" can
    // only be answered a tick later. Anything still alive then really started.
    const timer = setTimeout(() => { child.removeAllListeners("error"); child.unref(); resolve({ ok: true, pid: child.pid }); }, 250);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.code === "ENOENT" ? `cannot execute ${file}` : e.message });
    });
  });
}

/** Launch an application by name or path, with arguments. */
async function launch(name, args = []) {
  const found = resolveApp(name);
  if (!found) throw new Error(`no application matching "${name}" on PATH or in the start menu`);

  // A real executable can be spawned directly, which keeps the arguments
  // intact; a shortcut has to go through the shell that knows how to follow it.
  const isExe = /\.(exe|com|bat|cmd)$/i.test(found.target) || found.how === "PATH" || found.how === "path";
  if (isExe && !/\.(lnk|url)$/i.test(found.target) && fs.existsSync(found.target)) {
    const r = await trySpawn(found.target, args, { windowsHide: false });
    if (r.ok) return { ...found, launcher: "spawn", pid: r.pid };
    // Not executable after all (an MSYS shim, a script, a bundle): let the OS
    // decide how to open it rather than giving up.
    return { ...found, ...openWith(found.target, args), fallback: r.error };
  }
  if (IS_MAC && found.how === "open -a") {
    const r = await trySpawn("open", ["-a", name, ...(args.length ? ["--args", ...args] : [])]);
    if (r.ok) return { ...found, launcher: "open -a" };
    throw new Error(r.error);
  }
  return { ...found, ...openWith(found.target, args) };
}

module.exports = {
  installed, search, resolveApp, openWith, launch, trySpawn, onPath, startMenuRoots,
  assertCmdSafe,
};
