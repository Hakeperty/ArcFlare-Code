// `arcflare uninstall`: remove ArcFlare and everything it put on the machine.
//
// Deleting is the one thing that cannot be taken back, so this is built as a
// survey first and an action second: every path, every size, shown before
// anything moves, and nothing outside a short list of places ArcFlare itself
// created. Two things are deliberately left alone unless asked:
//
//   * downloaded models outside ~/.arcflare. They sit in llama.cpp's cache or
//     folders you chose, other tools read them, and they are tens of GB you
//     would download again. They are listed with their sizes, not deleted.
//   * other programs' config files. ArcFlare added a provider to OpenCode and
//     Codex; rewriting those files on the way out is how unrelated settings
//     get lost. They are listed, with the backups ArcFlare made before its
//     first edit.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";

/** Bytes under a path. Never throws: a file it cannot read counts as zero. */
function sizeOf(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.isSymbolicLink()) continue;          // never follow a link out of the tree
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(cur); } catch { continue; }
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      total += st.size;
    }
  }
  return total;
}

/**
 * Whether a directory is safe to treat as ArcFlare's home. ARCFLARE_HOME can
 * point anywhere, so "delete ARCFLARE_HOME" must refuse a home directory, a
 * drive root, or a folder with nothing of ArcFlare's in it.
 */
function looksLikeArcflareHome(dir) {
  const abs = path.resolve(dir);
  if (abs === path.parse(abs).root) return false;
  if (abs === path.resolve(os.homedir())) return false;
  if (!fs.existsSync(abs)) return false;
  if (path.basename(abs).toLowerCase() === ".arcflare") return true;
  const ours = ["config.json", "models.ini", "server.log", "fit.json", "gen", "rc.json", "update.json"];
  return ours.filter((f) => fs.existsSync(path.join(abs, f))).length >= 2;
}

/**
 * What uninstalling would touch. Pure: reads the disk, changes nothing.
 * `opts.home` / `opts.models` / `opts.harnesses` are injectable for tests.
 */
function survey(opts = {}) {
  const home = opts.home || process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
  const plan = { home, homeOk: looksLikeArcflareHome(home), remove: [], keep: [], configs: [], install: null };

  if (fs.existsSync(home)) {
    let names = [];
    try { names = fs.readdirSync(home); } catch { /* unreadable: nothing listed */ }
    for (const n of names) {
      const p = path.join(home, n);
      const item = { path: p, bytes: sizeOf(p), what: describe(n) };
      // ~/.arcflare/models holds GGUFs `arcflare pull` downloaded: models,
      // treated like the external ones — kept unless asked.
      if (n === "models" && !opts.withModels) plan.keep.push({ ...item, why: "downloaded models (--models to delete)" });
      else plan.remove.push(item);
    }
  }

  // Models elsewhere: listed, never deleted by this command.
  for (const root of opts.modelRoots || []) {
    if (path.resolve(root).startsWith(path.resolve(home) + path.sep)) continue;
    if (!fs.existsSync(root)) continue;
    plan.keep.push({ path: root, bytes: sizeOf(root), why: "model cache shared with llama.cpp — delete it yourself if you want the space" });
  }

  for (const h of opts.harnesses || []) {
    let file;
    try { file = h.configFile && h.configFile(); } catch { file = null; }
    if (!file || !fs.existsSync(file)) continue;
    let mentions = false;
    try { mentions = /arcflare/i.test(fs.readFileSync(file, "utf8")); } catch { /* unreadable */ }
    if (!mentions) continue;
    const bak = file + ".arcflare-bak";
    plan.configs.push({ label: h.label, file, backup: fs.existsSync(bak) ? bak : null });
  }

  plan.install = opts.install || null;
  plan.totalBytes = plan.remove.reduce((n, i) => n + i.bytes, 0);
  return plan;
}

function describe(name) {
  return ({
    gen: "3D and speech: Python envs, model code, generator weights",
    models: "downloaded models",
    voices: "saved voice clips for cloning",
    "config.json": "settings",
    "models.ini": "server presets",
    "rc.json": "remote-control key",
    "oauth.json": "MCP sign-in tokens",
    "server.log": "server log",
    "hub.json": "hub cache",
  })[name] || "cache / state";
}

/** Remove a path, retrying briefly: Windows holds a file a moment after a process exits. */
function rm(p) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return null; } catch (e) {
      if (i === 4) return e.message;
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]);
    }
  }
  return null;
}

/**
 * Carry out a survey's plan. Returns what failed, path by path. The CLI's own
 * files go last and, on Windows, after this process has exited: npm cannot
 * replace the arcflare.cmd that is running this very command, and cmd.exe
 * reads a batch file as it goes.
 */
function execute(plan, { log = () => {}, removeCli = true, npm } = {}) {
  if (!plan.homeOk && plan.remove.length) {
    throw new Error(`${plan.home} does not look like an ArcFlare folder — refusing to delete it`);
  }
  const failed = [];
  for (const item of plan.remove) {
    log(item.path);
    const err = rm(item.path);
    if (err) failed.push({ path: item.path, error: err });
  }
  // The home folder itself, once empty (it is kept if models were kept).
  try { if (fs.existsSync(plan.home) && !fs.readdirSync(plan.home).length) fs.rmdirSync(plan.home); } catch { /* not empty */ }

  if (removeCli && plan.install && npm) {
    const { cmd, args } = npm(["rm", "-g", "arcflare"]);
    if (IS_WIN) {
      // A fixed command line with no user input in it: wait for this process
      // to exit, then remove the global package and its shims.
      const quoted = [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
      const child = spawn("cmd.exe", ["/d", "/c", `ping -n 3 127.0.0.1 >nul & ${quoted} >nul 2>&1`], {
        detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      });
      child.unref();
    } else {
      const r = spawnSync(cmd, args, { stdio: "ignore" });
      if (r.status !== 0) failed.push({ path: "npm global package", error: `npm exited ${r.status}` });
    }
  }
  return failed;
}

module.exports = { survey, execute, sizeOf, looksLikeArcflareHome, describe };
