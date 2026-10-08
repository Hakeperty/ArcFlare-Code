// File checkpoints for /undo.
//
// Before the agent's write_file or edit_file changes a file, the previous
// content (or the fact that the file did not exist) is kept, once per file per
// turn. /undo puts the files of the last turn — or the last N turns — back.
// Changes made by shell commands are not seen here; /undo says so.
//
// Kept in memory, and written to the session's folder so a resumed session can
// still undo. Big files and old turns are dropped to stay inside a size cap.

const fs = require("fs");
const path = require("path");

const MAX_FILE = 1024 * 1024;       // a file bigger than this isn't snapshotted
const MAX_TOTAL = 24 * 1024 * 1024; // all turns together
const MAX_TURNS = 50;

class Checkpoints {
  /** @param {{ file?: string }} o  where to persist (a JSON file), or nothing */
  constructor(o = {}) {
    this.file = o.file || null;
    this.turns = []; // [{ label, at, files: [{ path, existed, content (base64) | null, skipped? }] }]
    this.current = null;
  }

  /** Start a turn. Files changed until the next begin() belong to it. */
  begin(label) {
    this.current = { label: String(label || "").slice(0, 80), at: new Date().toISOString(), files: [] };
  }

  /** Close the turn; keep it only if it changed something. */
  end() {
    const t = this.current;
    this.current = null;
    if (!t || !t.files.length) return;
    this.turns.push(t);
    this.trim();
    this.save();
  }

  /** Remember `file` as it is now, unless this turn already has it. */
  record(file) {
    if (!this.current) this.begin("");
    const abs = path.resolve(file);
    if (this.current.files.some((f) => f.path === abs)) return;
    let existed = false;
    let content = null;
    let skipped = false;
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        existed = true;
        if (st.size > MAX_FILE) skipped = true;
        else content = fs.readFileSync(abs).toString("base64");
      }
    } catch { /* didn't exist */ }
    this.current.files.push({ path: abs, existed, content, ...(skipped ? { skipped: true } : {}) });
  }

  /** What undoing the last `n` turns would touch, newest turn first. */
  preview(n = 1) {
    return this.turns.slice(-n).reverse();
  }

  /**
   * Undo the last `n` turns, newest first, so each file ends up as it was
   * before the oldest of them. Returns { restored, removed, skipped, turns }.
   */
  undo(n = 1) {
    const turns = this.turns.splice(Math.max(0, this.turns.length - n));
    const out = { restored: [], removed: [], skipped: [], turns: turns.length };
    for (const t of turns.reverse()) {
      for (const f of t.files) {
        try {
          if (f.skipped) { out.skipped.push(f.path); continue; }
          if (!f.existed) {
            if (fs.existsSync(f.path)) { fs.rmSync(f.path, { force: true }); out.removed.push(f.path); }
            continue;
          }
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.writeFileSync(f.path, Buffer.from(f.content, "base64"));
          out.restored.push(f.path);
        } catch {
          out.skipped.push(f.path);
        }
      }
    }
    // A file restored by an older turn may also be listed by a newer one.
    out.restored = [...new Set(out.restored)].filter((p) => !out.removed.includes(p));
    out.removed = [...new Set(out.removed)];
    this.save();
    return out;
  }

  get count() { return this.turns.length; }

  trim() {
    while (this.turns.length > MAX_TURNS) this.turns.shift();
    const size = () => this.turns.reduce((s, t) => s + t.files.reduce((a, f) => a + (f.content ? f.content.length : 0), 0), 0);
    while (this.turns.length > 1 && size() > MAX_TOTAL) this.turns.shift();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ turns: this.turns }));
    } catch { /* undo still works in memory */ }
  }

  static load(file) {
    const cp = new Checkpoints({ file });
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(j.turns)) cp.turns = j.turns;
    } catch { /* nothing saved yet */ }
    return cp;
  }
}

module.exports = { Checkpoints, MAX_FILE, MAX_TOTAL };
