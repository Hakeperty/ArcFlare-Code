// Updates: noticing there is one, and installing it — with or without a network.
//
// The check never costs anything you would notice. It runs at most every
// twelve hours, in a detached child process, with a short timeout, and writes
// its answer to ~/.arcflare/update.json. The next time ArcFlare starts it reads
// that file and, if something newer exists, says so in one line. Offline, the
// check fails quietly and the cache simply stays as it was: an unreachable
// GitHub is not news, and it is certainly not an error worth printing.
//
// Installing has three routes, because ArcFlare arrives two ways and some
// machines never see the internet:
//
//   a git clone (`npm link`)   git pull --ff-only, in the install directory
//   npm install -g github:…    npm install -g again from the same place
//   offline                    --from <folder|.tgz>: a copy carried over on a
//                              stick, made on a connected machine with --pack
//
// There are no dependencies to fetch, which is what makes the last one work: a
// tarball of the repo *is* the whole program.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const CACHE = path.join(HOME, "update.json");
const ROOT = path.join(__dirname, "..");
const PKG = require("../package.json");
const REPO = "Hakeperty/ArcFlare-Code";
const BRANCH = "main";
const RAW_PKG = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

// ----------------------------------------------------------------- versions ----

/** -1, 0 or 1. Pre-release tags sort before the release they precede. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v || "0").replace(/^v/, "").split("-");
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre || "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** How this copy was installed, which decides how it is updated. */
function installKind(root = ROOT) {
  return fs.existsSync(path.join(root, ".git")) ? "git" : "npm";
}

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: opts.cwd || ROOT, encoding: "utf8", timeout: opts.timeout || 15000, windowsHide: true });
}

// -------------------------------------------------------------------- cache ----

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}

function writeCache(c) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 2) + "\n");
  } catch { /* a cache we cannot write is a check we do again next time */ }
}

function disabled(cfg = {}) {
  return process.env.ARCFLARE_NO_UPDATE_CHECK === "1" || cfg.updateCheck === false || process.env.CI === "true";
}

// -------------------------------------------------------------------- check ----

/**
 * Ask the network what the latest version is. Resolves to a cache record and
 * never rejects: being offline is a normal state, recorded as one.
 *
 * Two questions, because a version number alone misses work pushed without a
 * bump. The published package.json gives the version for everyone; a git
 * install also compares commits, and counts itself current only when the
 * remote head is something it already contains — so a developer ahead of
 * main is not told to "update" backwards.
 */
async function check({ fetchImpl = globalThis.fetch, root = ROOT, timeoutMs = TIMEOUT_MS } = {}) {
  const rec = { checkedAt: new Date().toISOString(), current: PKG.version, kind: installKind(root) };
  try {
    const res = await fetchImpl(RAW_PKG, { signal: AbortSignal.timeout(timeoutMs), headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();
    rec.latest = remote.version;
    rec.available = compareVersions(remote.version, PKG.version) > 0;
  } catch (e) {
    rec.offline = true;
    rec.error = e.name === "TimeoutError" ? "timed out" : e.message;
  }

  if (rec.kind === "git" && !rec.offline) {
    const ls = git(["ls-remote", "origin", `refs/heads/${BRANCH}`], { cwd: root, timeout: timeoutMs + 4000 });
    const sha = ls.status === 0 ? (ls.stdout.split(/\s/)[0] || "") : "";
    if (sha) {
      rec.remoteSha = sha;
      // Known and already contained in HEAD: current (or ahead). Unknown to
      // this clone, or known but not an ancestor: there is something to pull.
      const known = git(["cat-file", "-e", `${sha}^{commit}`], { cwd: root }).status === 0;
      const contained = known && git(["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root }).status === 0;
      rec.behind = !contained;
      if (rec.behind) rec.available = true;
    }
  }
  return rec;
}

/**
 * Refresh the cache in the background if it is stale. Detached and unref'd,
 * so a slow network never holds the prompt up and a closed terminal does not
 * leave anything waiting on it.
 */
function refreshInBackground(cfg = {}) {
  if (disabled(cfg)) return false;
  const c = readCache();
  if (c.checkedAt && Date.now() - Date.parse(c.checkedAt) < CHECK_EVERY_MS) return false;
  try {
    // Mark the attempt first, so a dozen arcflare commands started in the same
    // minute do not each launch a check.
    writeCache({ ...c, checkedAt: new Date().toISOString(), pending: true });
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "arcflare.js"), "update", "--check-quiet"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The one-line notice, or null. Reads the cache only — never the network. */
function notice(cfg = {}) {
  if (disabled(cfg)) return null;
  const c = readCache();
  if (!c.available) return null;
  // The cache can outlive the update that answered it.
  if (c.latest && compareVersions(c.latest, PKG.version) <= 0 && !c.behind) return null;
  if (c.behind && c.kind === "git" && c.remoteSha) {
    const now = git(["merge-base", "--is-ancestor", c.remoteSha, "HEAD"]);
    if (now.status === 0) return null;
  }
  const what = c.latest && compareVersions(c.latest, PKG.version) > 0
    ? `${PKG.version} → ${c.latest}`
    : "new commits on main";
  return { text: `Update available: ${what}`, latest: c.latest, behind: !!c.behind };
}

// ------------------------------------------------------------------ install ----

/**
 * How to run npm without a shell. On Windows `npm` is a .cmd file, which Node
 * will only spawn through cmd.exe — where arguments are concatenated rather
 * than escaped, so a path with a space in it breaks. npm's own entry script,
 * run by this Node, sidesteps that; the shell is only the fallback.
 */
function npmCommand(args) {
  if (process.platform !== "win32") return { cmd: "npm", args, shell: false };
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli, ...args], shell: false };
  return { cmd: "npm", args: args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, "")}"` : a)), shell: true };
}

function run(cmd, args, opts = {}) {
  let shell = false;
  if (cmd === "npm") ({ cmd, args, shell } = npmCommand(args));
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT, stdio: opts.quiet ? "pipe" : "inherit", windowsHide: true, shell,
    });
    let out = "";
    if (child.stdout) child.stdout.on("data", (d) => { out += d; });
    if (child.stderr) child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function versionAt(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version; } catch { return null; }
}

/**
 * Install the update. `from` is an offline source: a folder holding a copy of
 * the repo, or a tarball made by `arcflare update --pack`.
 *
 * Returns { ok, from, to, message }. Never restarts anything itself — a REPL
 * holding a session open should finish it on the code it started with.
 */
async function apply({ from, log = console.log, root = ROOT } = {}) {
  const before = versionAt(root);
  const kind = installKind(root);

  if (from) {
    const src = path.resolve(from);
    if (!fs.existsSync(src)) return { ok: false, message: `no such file or folder: ${src}` };
    const isDir = fs.statSync(src).isDirectory();
    if (isDir && !fs.existsSync(path.join(src, "package.json"))) {
      return { ok: false, message: `${src} is not an ArcFlare folder (no package.json)` };
    }
    if (isDir) {
      const name = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).name;
      if (name !== PKG.name) return { ok: false, message: `${src} holds "${name}", not ${PKG.name}` };
    }

    if (kind === "git" && isDir && fs.existsSync(path.join(src, ".git"))) {
      // A clone carried over on a stick: pull from it exactly as from GitHub.
      log(`  pulling from ${src}`);
      const r = await run("git", ["pull", "--ff-only", src, BRANCH], { cwd: root });
      if (r.code !== 0) return { ok: false, message: "git pull failed — local changes in the way? (see above)" };
    } else if (kind === "git") {
      return {
        ok: false,
        message: "this copy is a git clone; give it a folder that is also a clone, or install the tarball " +
          `globally instead: npm install -g "${src}"`,
      };
    } else {
      // `npm install -g <folder>` links the folder rather than copying it, and
      // a link into a USB stick stops working when the stick comes out. So a
      // folder is packed first and the tarball installed.
      let tgz = src;
      if (isDir) {
        log(`  packing ${src}`);
        tgz = await pack(fs.mkdtempSync(path.join(os.tmpdir(), "arcflare-update-")), src);
      }
      log(`  installing ${tgz}`);
      // Zero dependencies, so this touches no registry: offline works.
      const r = await run("npm", ["install", "-g", "--offline", "--no-audit", "--no-fund", tgz]);
      if (r.code !== 0) return { ok: false, message: "npm install failed (see above)" };
    }
  } else if (kind === "git") {
    const dirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd: root });
    if (dirty.stdout && dirty.stdout.trim()) {
      log(`  note: you have local changes; git will refuse if they conflict`);
    }
    log(`  git pull --ff-only (${root})`);
    const r = await run("git", ["pull", "--ff-only", "origin", BRANCH], { cwd: root });
    if (r.code !== 0) return { ok: false, offlineHint: true, message: "git pull failed — offline, or local commits diverge (see above)" };
  } else {
    log(`  npm install -g github:${REPO}`);
    const r = await run("npm", ["install", "-g", "--no-audit", "--no-fund", `github:${REPO}`]);
    if (r.code !== 0) return { ok: false, offlineHint: true, message: "npm install failed — offline? (see above)" };
  }

  const after = kind === "git" ? versionAt(root) : null;
  writeCache({ checkedAt: new Date().toISOString(), current: after || before, available: false, kind });
  return { ok: true, from: before, to: after, message: after && after !== before ? `${before} → ${after}` : "up to date" };
}

/**
 * Make an offline update: a tarball of this install, to carry to a machine
 * with no network and give to `arcflare update --from`.
 */
async function pack(outDir = process.cwd(), root = ROOT) {
  const r = await run("npm", ["pack", "--pack-destination", path.resolve(outDir)], { cwd: root, quiet: true });
  if (r.code !== 0) throw new Error("npm pack failed: " + r.out.trim().split("\n").pop());
  const name = r.out.trim().split(/\r?\n/).filter((l) => /\.tgz$/.test(l.trim())).pop();
  if (!name) throw new Error("npm pack produced no tarball");
  return path.join(path.resolve(outDir), name.trim());
}

module.exports = {
  compareVersions, installKind, check, refreshInBackground, notice, apply, pack,
  readCache, writeCache, disabled, CACHE, RAW_PKG, ROOT,
};
