"use strict";
// Calls from agents to the phone (call_phone): the phone rings, says the agent's line out loud, listens, and
// sends back what the user said. One call at a time.
//
//   ringing --answer--> talking --reply--> waiting --say--> talking ... --end--> ended
//      \--decline / no answer--> declined | missed
//
// "talking" means the phone has the line (speaking, then listening); "waiting" means an answer is ready for
// the agent. Either side can end the call. Then the phone uploads two kinds of recording, made from one
// microphone stream at the same time: the whole call (conversation.wav) and each answer on its own
// (answer-1.wav, ...). They are saved with transcript.json in <hub>/calls/<id>/, private to this user;
// the newest KEEP_CALLS calls are kept.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const MAX_SAY = 1000;
const MAX_REPLY = 4000;
const MAX_TURNS = 64;
const RING_S = 45;
const TALK_MS = 3 * 60_000;      // the phone has the line this long before the call is dropped
const WAIT_MS = 5 * 60_000;      // an answer waits this long for the agent's next line
const MAX_CALL_MS = 15 * 60_000;
const MAX_FILE = 16 * 1024 * 1024;
const KEEP_CALLS = 20;
const FILE_RE = /^(conversation|answer-\d{1,2})\.wav$/;
const ENDED = ["ended", "declined", "missed"];

const err = (status, message) => Object.assign(new Error(message), { status });

class CallBox extends EventEmitter {
  /**
   * @param {object} o
   * @param {string}   o.dir     where recordings go (<hub>/calls)
   * @param {function} [o.allows] () => { ring, why }: HubSettings.phoneAllows (mute and hours)
   */
  constructor({ dir, allows = () => ({ ring: true }), now = Date.now } = {}) {
    super();
    this.setMaxListeners(0);
    this.dir = dir;
    this.allows = allows;
    this.now = now;
    this.calls = new Map();
  }

  /** The call that is ringing or under way, or null. */
  current() {
    for (const c of this.calls.values()) if (!ENDED.includes(c.status)) return this._public(c);
    return null;
  }

  start({ say, from } = {}) {
    if (typeof say !== "string" || !say.trim()) throw err(400, "say is required: what the phone says when the user answers");
    if (say.length > MAX_SAY) throw err(413, `say is too long (max ${MAX_SAY})`);
    const ok = this.allows();
    if (!ok.ring) throw err(409, `The phone was not rung: ${ok.why}.`);
    if (this.current()) throw err(429, "The phone is already in a call");
    const c = {
      id: crypto.randomBytes(8).toString("hex"), from: String(from || "an agent").slice(0, 60), status: "ringing",
      started: this.now(), turns: [{ who: "agent", text: say.trim() }], files: null, done: new Set(), why: null,
      version: 0, waiters: new Set(), timer: null,
    };
    this.calls.set(c.id, c);
    this._prune();
    this._set(c, "ringing", RING_S * 1000, () => this._end(c, "missed", "no answer"));
    this.emit("event", { type: "call", id: c.id, from: c.from, say: c.turns[0].text });
    return { id: c.id };
  }

  // ---- the phone ----

  answer(id) {
    const c = this._get(id, ["ringing"]);
    this._set(c, "talking", TALK_MS, () => this._end(c, "ended", "the phone stopped answering", true));
    return this._public(c);
  }

  decline(id) {
    const c = this._get(id, ["ringing"]);
    this._end(c, "declined", "the user declined");
    return this._public(c);
  }

  reply(id, text) {
    const c = this._get(id, ["talking"]);
    if (typeof text !== "string" || text.length > MAX_REPLY) throw err(400, "text required");
    if (c.turns.length >= MAX_TURNS) throw err(429, "This call is too long");
    const n = c.turns.filter((t) => t.who === "user").length + 1;
    c.turns.push({ who: "user", text: text.trim(), audio: `answer-${n}.wav` });
    this._set(c, "waiting", WAIT_MS, () => this._end(c, "ended", "the agent said nothing more", true));
    return this._public(c);
  }

  /** The phone hung up (or finished hanging up after the agent did), naming the recordings it will upload. */
  hangUp(id, files) {
    const c = this.calls.get(String(id));
    if (!c) throw err(404, "No such call");
    if (!Array.isArray(files) || files.length > MAX_TURNS + 1 || files.some((f) => typeof f !== "string" || !FILE_RE.test(f))) {
      throw err(400, "files must be the recordings' names");
    }
    if (c.files) return this._public(c);
    c.files = [...new Set(files)];
    if (!ENDED.includes(c.status)) this._end(c, "ended", "the user hung up");
    else this._changed(c);
    this._writeTranscript(c);
    return this._public(c);
  }

  /** A piece of a recording: appended in order; a piece the hub already has is accepted again (a retried request). */
  audio(id, { name, offset, data, last } = {}) {
    const c = this.calls.get(String(id));
    if (!c) throw err(404, "No such call");
    if (!c.files || !c.files.includes(name)) throw err(400, "Not a recording of this call");
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof data !== "string") throw err(400, "offset and data required");
    const buf = Buffer.from(data, "base64");
    const file = path.join(this._callDir(c), name);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first piece */ }
    if (offset + buf.length > MAX_FILE) throw err(413, "Recording too long");
    if (offset > size) throw err(409, `Expected offset ${size}`);
    if (offset === size && buf.length) fs.appendFileSync(file, buf, { mode: 0o600 });
    if (last === true) { c.done.add(name); this._changed(c); }
    return { size: Math.max(size, offset + buf.length), saved: this._saved(c) };
  }

  // ---- the agent ----

  say(id, { say, hangUp } = {}) {
    const c = this._get(id, ["waiting"]);
    if (typeof say !== "string" || !say.trim()) throw err(400, "say required");
    if (say.length > MAX_SAY) throw err(413, `say is too long (max ${MAX_SAY})`);
    c.turns.push({ who: "agent", text: say.trim() });
    this._set(c, "talking", TALK_MS, () => this._end(c, "ended", "the phone stopped answering", true));
    this.emit("event", { type: "call_say", id: c.id, say: say.trim(), hangUp: hangUp === true });
    return this._public(c);
  }

  /** The agent ends the call: the phone stops and uploads what it recorded. */
  end(id) {
    const c = this.calls.get(String(id));
    if (!c) throw err(404, "No such call");
    if (c.status === "ringing") this._end(c, "missed", "the agent hung up before the user answered");
    else if (!ENDED.includes(c.status)) this._end(c, "ended", "the agent hung up", true);
    return this._public(c);
  }

  /** Waits up to waitMs for the call to change after `version`. */
  async wait(id, version, waitMs) {
    const c = this.calls.get(String(id));
    if (!c) return null;
    if (c.version <= version && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); c.waiters.delete(done); resolve(); };
        const t = setTimeout(done, waitMs);
        c.waiters.add(done);
      });
    }
    return this._public(c);
  }

  // ---- inside ----

  _get(id, states) {
    const c = this.calls.get(String(id));
    if (!c) throw err(404, "No such call");
    if (!states.includes(c.status)) throw err(409, `The call is ${c.status}`);
    return c;
  }

  _set(c, status, ms, onTimeout) {
    c.status = status;
    clearTimeout(c.timer);
    const left = c.started + MAX_CALL_MS - this.now();
    c.timer = setTimeout(onTimeout, Math.max(0, Math.min(ms, left)));
    if (c.timer.unref) c.timer.unref();
    this._changed(c);
  }

  _end(c, status, why, tellPhone) {
    clearTimeout(c.timer);
    c.status = status;
    c.why = why;
    c.ended = this.now();
    if (tellPhone || status === "missed") this.emit("event", { type: "call_end", id: c.id, why });
    this._writeTranscript(c);
    this._changed(c);
  }

  _changed(c) {
    c.version++;
    for (const w of c.waiters) w();
    c.waiters.clear();
  }

  _saved(c) {
    return !!c.files && c.files.every((f) => c.done.has(f));
  }

  _callDir(c) {
    const d = path.join(this.dir, c.id);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  _writeTranscript(c) {
    try {
      const f = path.join(this._callDir(c), "transcript.json");
      fs.writeFileSync(f, JSON.stringify({ id: c.id, from: c.from, started: new Date(c.started).toISOString(), status: c.status, why: c.why, turns: c.turns, recordings: c.files || [] }, null, 2) + "\n", { mode: 0o600 });
    } catch { /* the transcript is also in the answer the agent gets */ }
  }

  /** Recordings are private: only the newest KEEP_CALLS calls stay on disk, and only the newest in memory. */
  _prune() {
    try {
      const dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name))
        .map((d) => ({ name: d.name, t: fs.statSync(path.join(this.dir, d.name)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const d of dirs.slice(KEEP_CALLS - 1)) fs.rmSync(path.join(this.dir, d.name), { recursive: true, force: true });
    } catch { /* no calls yet */ }
    for (const c of [...this.calls.values()].slice(0, -KEEP_CALLS)) this.calls.delete(c.id);
  }

  _public(c) {
    const d = path.join(this.dir, c.id);
    const last = c.turns[c.turns.length - 1];
    return {
      id: c.id, from: c.from, status: c.status, why: c.why, version: c.version,
      answer: c.status === "waiting" ? last.text : null,
      turns: c.turns.map((t) => ({ who: t.who, text: t.text })),
      saved: this._saved(c),
      folder: d,
      recordings: (c.files || []).filter((f) => c.done.has(f)).map((f) => path.join(d, f)),
    };
  }
}

module.exports = { CallBox, FILE_RE };
