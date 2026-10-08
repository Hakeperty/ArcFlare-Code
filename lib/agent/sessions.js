// Saved agent sessions: ~/.arcflare/sessions/<id>.json, written after every
// turn, so a closed terminal or a crash loses at most the turn in progress.
// `arcflare agent --resume` / `--continue` and /resume bring one back.
//
// The system message is not trusted from disk: a resumed session gets today's
// prompt (project notes may have changed), with the saved conversation after it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_SESSIONS = 200;

function dir() {
  return path.join(process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "sessions");
}

/** Sortable and readable: 20261008-1432-a1b2c3. */
function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-` +
    crypto.randomBytes(3).toString("hex");
}

const fileFor = (id) => path.join(dir(), `${id}.json`);
const folderFor = (id) => path.join(dir(), id);

/** The first thing the user asked, as a title. */
function titleOf(messages) {
  const first = (messages || []).find((m) => m.role === "user" && typeof m.content === "string");
  return first ? first.content.replace(/\s+/g, " ").trim().slice(0, 80) : "(empty)";
}

/** Write a session. Conversations with no user message are not worth keeping. */
function save(s) {
  const conversation = (s.messages || []).filter((m) => m.role !== "system");
  if (!conversation.some((m) => m.role === "user")) return null;
  const now = new Date().toISOString();
  const doc = {
    id: s.id,
    cwd: s.cwd,
    model: s.model || null,
    modelRef: s.modelRef || null,
    title: titleOf(conversation),
    created: s.created || now,
    updated: now,
    messages: conversation,
  };
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = fileFor(s.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, fileFor(s.id));
  return doc;
}

function load(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), "utf8")); } catch { return null; }
}

/** Summaries, newest first; `cwd` limits to sessions started in that folder. */
function list(opts = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith(".json")); } catch { return []; }
  const want = opts.cwd ? path.resolve(opts.cwd).toLowerCase() : null;
  const out = [];
  for (const n of names) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir(), n), "utf8")); } catch { continue; }
    if (want && path.resolve(j.cwd || "").toLowerCase() !== want) continue;
    out.push({
      id: j.id, cwd: j.cwd, model: j.model, modelRef: j.modelRef, title: j.title,
      created: j.created, updated: j.updated,
      turns: (j.messages || []).filter((m) => m.role === "user").length,
    });
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/** An id, a unique prefix of one, or null. */
function find(idOrPrefix) {
  if (!idOrPrefix) return null;
  const direct = load(idOrPrefix);
  if (direct) return direct;
  const hits = list().filter((s) => s.id.startsWith(idOrPrefix));
  return hits.length === 1 ? load(hits[0].id) : null;
}

/** Keep the newest MAX_SESSIONS; remove the rest and their undo folders. */
function prune(max = MAX_SESSIONS) {
  const all = list();
  for (const s of all.slice(max)) {
    try { fs.rmSync(fileFor(s.id), { force: true }); } catch {}
    try { fs.rmSync(folderFor(s.id), { recursive: true, force: true }); } catch {}
  }
}

function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

module.exports = { dir, newId, save, load, list, find, prune, titleOf, folderFor, fileFor, ago, MAX_SESSIONS };
