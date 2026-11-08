"use strict";
// Saved voices: a name for "speak like this clip" or "speak like this description", so a voice is set up
// once and used everywhere after (`arcflare say "..." --as narrator`).
//
// A voice is <home>/voices/<name>.json, plus <name>.<ext> when it was copied from a clip: the clip is
// copied in, so the voice keeps working after the original file moves. Nothing here runs a model; the
// voice just fills in --like / --ref-text / --describe / -m for gen.speak.

const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CLIP_EXT = new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a"]);
const MAX_CLIP = 50 * 1024 * 1024;

function dir() {
  return path.join(process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "voices");
}

function checkName(name) {
  const n = String(name || "").toLowerCase();
  if (!NAME_RE.test(n)) throw new Error("a voice name is 1-40 letters, digits, - or _, starting with a letter or digit");
  return n;
}

/**
 * Save a voice. Exactly one of `like` (a clip to copy) or `describe` (words) is required.
 * `model` pins the speech model; otherwise speaking picks one that can do it.
 */
function save(name, { like, refText, describe, model, overwrite = false } = {}) {
  const n = checkName(name);
  if (!!like === !!describe) throw new Error("give either --like clip.wav (copy a voice) or --describe \"...\" (make one), not both");
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `${n}.json`);
  if (fs.existsSync(file) && !overwrite) throw new Error(`there is already a voice "${n}"; add --force to replace it`);
  const v = { name: n, created: new Date().toISOString() };
  if (like) {
    const src = path.resolve(like);
    let st;
    try { st = fs.statSync(src); } catch { throw new Error(`no such clip: ${like}`); }
    const ext = path.extname(src).toLowerCase();
    if (!st.isFile() || !CLIP_EXT.has(ext)) throw new Error(`the clip must be an audio file (${[...CLIP_EXT].join(", ")})`);
    if (st.size > MAX_CLIP) throw new Error("that clip is too big; 3-10 seconds of clear speech is what cloning wants");
    // Remove an older clip of this name with another extension.
    for (const e of CLIP_EXT) { try { fs.unlinkSync(path.join(dir(), n + e)); } catch { /* none */ } }
    fs.copyFileSync(src, path.join(dir(), n + ext));
    v.clip = n + ext;
    if (refText) v.refText = String(refText).slice(0, 2000);
  } else {
    const d = String(describe).trim();
    if (!d || d.length > 1000) throw new Error("--describe takes 1-1000 characters");
    v.describe = d;
  }
  if (model) v.model = String(model);
  fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
  return v;
}

function get(name) {
  const n = checkName(name);
  let v;
  try { v = JSON.parse(fs.readFileSync(path.join(dir(), `${n}.json`), "utf8")); } catch {
    const have = list().map((x) => x.name);
    throw new Error(`no saved voice "${n}"` + (have.length ? `. Saved: ${have.join(", ")}` : `. Save one: arcflare voice save ${n} --like clip.wav`));
  }
  // The clip is always the one next to the file, whatever the JSON says.
  if (v.clip) v.clipPath = path.join(dir(), path.basename(String(v.clip)));
  return v;
}

function list() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names.sort()) {
    try { out.push(get(f.slice(0, -5))); } catch { /* a damaged or foreign file */ }
  }
  return out;
}

function remove(name) {
  const v = get(name);
  fs.unlinkSync(path.join(dir(), `${v.name}.json`));
  if (v.clipPath) { try { fs.unlinkSync(v.clipPath); } catch { /* already gone */ } }
  return true;
}

/** What a saved voice adds to a speak request: { ref, refText, instruct, model }. */
function toSpeak(v) {
  return {
    ref: v.clipPath || null,
    refText: v.refText || null,
    instruct: v.describe || null,
    model: v.model || null,
  };
}

module.exports = { save, get, list, remove, toSpeak, dir, NAME_RE };
