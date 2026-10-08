// Project notes: the instructions a repository keeps for coding agents.
//
// AGENTS.md is the shared convention; ARCFLARE.md is ours; CLAUDE.md is read
// only when a directory has neither, since plenty of repos already keep one.
// They are read from the working directory and from the git root above it,
// capped, and placed in the system prompt once per session, so they sit in the
// cached prefix instead of being re-sent every turn.

const fs = require("fs");
const path = require("path");

const PRIMARY = ["AGENTS.md", "ARCFLARE.md"];
const FALLBACK = ["CLAUDE.md"];
const PER_FILE = 8 * 1024;
const TOTAL = 16 * 1024;

/** The nearest directory at or above `dir` holding a .git entry, or null. */
function gitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function readCapped(file, cap) {
  const buf = fs.readFileSync(file);
  const truncated = buf.length > cap;
  // Cut on a line boundary so a half line doesn't read as an instruction.
  let text = buf.subarray(0, cap).toString("utf8");
  if (truncated) {
    const nl = text.lastIndexOf("\n");
    if (nl > cap / 2) text = text.slice(0, nl);
    text += "\n… [truncated]";
  }
  return { text, bytes: buf.length, truncated };
}

/**
 * Notes for `cwd`: { text, files: [{ name, path, bytes, truncated }] }.
 * The git root's notes come first (repo-wide), then the working directory's
 * (more specific). `text` is "" when there are none.
 */
function load(cwd, opts = {}) {
  const perFile = opts.perFile || PER_FILE;
  const total = opts.total || TOTAL;
  const dirs = [];
  const root = gitRoot(cwd);
  if (root) dirs.push(root);
  const here = path.resolve(cwd);
  if (!dirs.includes(here)) dirs.push(here);

  const found = [];
  for (const dir of dirs) {
    const primary = PRIMARY.map((n) => path.join(dir, n)).filter((f) => isFile(f));
    const files = primary.length ? primary : FALLBACK.map((n) => path.join(dir, n)).filter((f) => isFile(f));
    found.push(...files);
  }

  const files = [];
  const parts = [];
  let used = 0;
  for (const f of found) {
    const room = total - used;
    if (room < 256) break;
    let r;
    try { r = readCapped(f, Math.min(perFile, room)); } catch { continue; }
    if (!r.text.trim()) continue;
    used += Buffer.byteLength(r.text);
    const rel = path.relative(here, f).replace(/\\/g, "/") || path.basename(f);
    files.push({ name: rel, path: f, bytes: r.bytes, truncated: r.truncated });
    parts.push(`### ${rel}\n${r.text.trim()}`);
  }
  return { text: parts.join("\n\n"), files };
}

function isFile(f) {
  try { return fs.statSync(f).isFile(); } catch { return false; }
}

/** "AGENTS.md (1.2 KB), ../AGENTS.md (3 KB)" for the start-up line. */
function describe(files) {
  return files.map((f) => `${f.name} (${fmtKB(f.bytes)}${f.truncated ? ", truncated" : ""})`).join(", ");
}

function fmtKB(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

module.exports = { load, describe, gitRoot, PER_FILE, TOTAL };
