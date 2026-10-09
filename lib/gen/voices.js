// Saved voices: a reference clip and its transcript, kept under a name so a
// cloned voice can be reused without finding the file again.
//
//   ~/.arcflare/voices/<id>/voice.json   { id, name, text, lang, clip, seconds, created }
//   ~/.arcflare/voices/<id>/clip.wav     a copy, so moving the original breaks nothing
//
// Shared by `arcflare gen tts --clone <name>`, the MCP tool and the desktop
// app's voice studio. The clips are recordings of people, so nothing here
// sends them anywhere; they are read only by the local TTS worker.

const fs = require("fs");
const os = require("os");
const path = require("path");

function root() {
  return path.join(process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "voices");
}

const AUDIO = /\.(wav|mp3|flac|ogg|m4a)$/i;

/** `My Voice!` → `my-voice`. Ids are folder names, so nothing else gets in. */
function slug(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * Length of a PCM WAV in seconds, from its header, or null for anything else.
 * Walks the chunks rather than assuming a 44-byte header: recorders put LIST
 * and fact chunks before the data.
 */
function wavSeconds(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;
    let pos = 12;
    let byteRate = null;
    const size = fs.fstatSync(fd).size;
    const ch = Buffer.alloc(8);
    while (pos + 8 <= size) {
      fs.readSync(fd, ch, 0, 8, pos);
      const id = ch.toString("ascii", 0, 4);
      const len = ch.readUInt32LE(4);
      if (id === "fmt ") {
        const fmt = Buffer.alloc(12);
        fs.readSync(fd, fmt, 0, 12, pos + 8);
        byteRate = fmt.readUInt32LE(8);
      } else if (id === "data" && byteRate) {
        return Math.round((Math.min(len, size - pos - 8) / byteRate) * 100) / 100;
      }
      pos += 8 + len + (len % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function read(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "voice.json"), "utf8"));
    const clip = path.join(dir, path.basename(String(v.clip || "")));
    if (!v.id || !fs.existsSync(clip)) return null;
    return { ...v, clip, dir };
  } catch { return null; }
}

/** Every saved voice, newest first. */
function list() {
  let names = [];
  try { names = fs.readdirSync(root()); } catch { return []; }
  return names.map((n) => read(path.join(root(), n))).filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** A saved voice by id or name, or null. */
function get(name) {
  const id = slug(name);
  if (!id) return null;
  return read(path.join(root(), id));
}

/**
 * Save a clip under a name. `clip` is copied in. `replace` overwrites a voice
 * of the same name; otherwise that is an error, so a typo can't silently
 * replace someone's recording.
 */
function save({ name, clip, text = "", lang = null, replace = false }) {
  const id = slug(name);
  if (!id) throw new Error("give the voice a name (letters or digits)");
  if (!clip || !fs.existsSync(clip)) throw new Error(`no such clip: ${clip}`);
  if (!AUDIO.test(clip)) throw new Error("the clip must be audio: .wav, .mp3, .flac, .ogg or .m4a");
  const dir = path.join(root(), id);
  if (fs.existsSync(dir) && !replace) throw new Error(`a voice called "${id}" already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(clip).toLowerCase();
  for (const f of fs.readdirSync(dir)) if (f.startsWith("clip.")) fs.rmSync(path.join(dir, f), { force: true });
  const dest = path.join(dir, "clip" + ext);
  fs.copyFileSync(clip, dest);
  const v = {
    id,
    name: String(name).trim().slice(0, 60),
    text: String(text || "").trim(),
    lang: lang || null,
    clip: "clip" + ext,
    seconds: ext === ".wav" ? wavSeconds(dest) : null,
    created: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify(v, null, 2) + "\n");
  return read(dir);
}

/** Change a saved voice's transcript, language or display name. */
function update(name, { text, lang, label } = {}) {
  const v = get(name);
  if (!v) throw new Error(`no saved voice "${name}"`);
  const next = { id: v.id, name: label != null ? String(label).trim().slice(0, 60) || v.name : v.name,
    text: text != null ? String(text).trim() : v.text, lang: lang !== undefined ? lang || null : v.lang,
    clip: path.basename(v.clip), seconds: v.seconds, created: v.created };
  fs.writeFileSync(path.join(v.dir, "voice.json"), JSON.stringify(next, null, 2) + "\n");
  return read(v.dir);
}

function remove(name) {
  const v = get(name);
  if (!v) return false;
  fs.rmSync(v.dir, { recursive: true, force: true });
  return true;
}

/**
 * What to tell someone about a clip before cloning from it. Every cloning
 * model here wants a few seconds of one clear speaker; Kitten TTS 2 asks for
 * 5-30 s, and the rest work within that range too.
 */
function advice(seconds) {
  if (seconds == null) return null;
  if (seconds < 3) return "shorter than 3 s — most models need more to copy a voice";
  if (seconds < 5) return "short — 5 to 30 s of one speaker clones best";
  if (seconds > 30) return "longer than 30 s — trim it to the clearest 5-30 s";
  return null;
}

module.exports = { root, slug, list, get, save, update, remove, wavSeconds, advice };
