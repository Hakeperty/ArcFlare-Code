"use strict";
// Plain chat with a local model, like ChatGPT or Claude: no tools, no folder,
// just a conversation, saved on this computer.
//
// A chat is a JSON file under <hub>/chats/<id>.json. Sending a message loads
// the chosen model (the same loader agents use, so one model is resident at a
// time), streams the answer from llama-server's OpenAI-compatible endpoint, and
// emits events the server forwards to the phone over SSE:
//   { type: "chat", chatId, seq, kind: "start" | "load" | "delta" | "reasoning" | "done" | "error" | "stopped", text?, error? }
// "load" carries the model-loading progress (phase, stage, pct, elapsedMs, estMs, size, ctx); "done" and "stopped"
// carry stats { tokens, tps, ttftMs, promptTokens, promptTps, loadMs, totalMs } when the server reported them.
// stop(id) aborts the request to llama-server, so generation stops at once.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const MAX_CHATS = 500;
const MAX_MESSAGE = 32000;          // characters in one user message
const MAX_MESSAGES = 1000;          // per chat
const MAX_ANSWER = 400000;          // characters of one answer kept (a runaway model is cut off)
const RING = 4000;                  // events kept per chat for SSE replay
const ID_RE = /^[0-9a-f]{16}$/;

function newId() { return crypto.randomBytes(8).toString("hex"); }

class ChatManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string}   o.dir       state folder (chats go in <dir>/chats)
   * @param {function} o.backend   async ({ modelRef }) => { port, model, nCtx, modelRef, sampling }
   * @param {function} [o.models]  () => [{ id }] installed models, to validate a choice
   * @param {function} [o.fetch]
   * @param {function} [o.now]
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(0);
    this.dir = path.join(o.dir, "chats");
    this.backend = o.backend;
    this.models = o.models || (() => []);
    this.fetch = o.fetch || globalThis.fetch;
    this.now = o.now || Date.now;
    this.running = new Map(); // id -> { abort: AbortController }
    this.rings = new Map();   // id -> { seq, events: [] }
  }

  // ------------------------------------------------------------- storage --

  _file(id) {
    if (!ID_RE.test(String(id))) throw Object.assign(new Error("No such chat"), { status: 404 });
    return path.join(this.dir, `${id}.json`);
  }

  _read(id) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(this._file(id), "utf8")); } catch (e) {
      if (e.status) throw e;
      throw Object.assign(new Error("No such chat"), { status: 404 });
    }
    return doc;
  }

  _write(doc) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this._file(doc.id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  _snap(doc, full) {
    const s = {
      id: doc.id, title: doc.title, model: doc.model || null, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      status: this.running.has(doc.id) ? "generating" : "idle", count: doc.messages.length,
    };
    // Where the event stream stands: an idle chat resumes after seq; one still answering replays from
    // its last "start" so the partial answer is drawn once (it is not in messages yet).
    const r = this.rings.get(doc.id);
    s.seq = r ? r.seq : 0;
    s.startSeq = r ? r.lastStart || 0 : 0;
    if (full) s.messages = doc.messages;
    return s;
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)); } catch { return []; }
    const out = [];
    for (const n of names) {
      try { out.push(this._snap(this._read(n.slice(0, 16)), false)); } catch { /* skip a damaged file */ }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) { return this._snap(this._read(id), true); }

  _checkModel(model) {
    if (model == null || model === "") return null;
    if (typeof model !== "string" || model.length > 300) throw Object.assign(new Error("Bad model"), { status: 400 });
    const ids = (this.models() || []).map((m) => m.id);
    if (!ids.includes(model)) throw Object.assign(new Error("That model is not on this computer"), { status: 400 });
    return model;
  }

  create({ model, title } = {}) {
    if (this.list().length >= MAX_CHATS) throw Object.assign(new Error("Too many chats; delete some first"), { status: 409 });
    const t = new Date(this.now()).toISOString();
    const doc = {
      v: 1, id: newId(), title: typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : "New chat",
      model: this._checkModel(model), createdAt: t, updatedAt: t, messages: [],
    };
    this._write(doc);
    return this._snap(doc, true);
  }

  remove(id) {
    this.stop(id);
    try { fs.unlinkSync(this._file(id)); } catch (e) { if (e.status) throw e; }
    this.rings.delete(id);
    return { ok: true };
  }

  rename(id, title) {
    const doc = this._read(id);
    if (typeof title !== "string" || !title.trim()) throw Object.assign(new Error("Title required"), { status: 400 });
    doc.title = title.trim().slice(0, 80);
    this._write(doc);
    return this._snap(doc, false);
  }

  // -------------------------------------------------------------- events --

  _emit(chatId, kind, extra = {}) {
    let r = this.rings.get(chatId);
    if (!r) { r = { seq: 0, events: [] }; this.rings.set(chatId, r); }
    const ev = { type: "chat", chatId, seq: ++r.seq, kind, ...extra };
    if (kind === "start") r.lastStart = ev.seq;
    r.events.push(ev);
    if (r.events.length > RING) r.events.splice(0, r.events.length - RING);
    this.emit("event", ev);
    return ev;
  }

  history(id, after = 0) {
    const r = this.rings.get(id);
    return r ? r.events.filter((e) => e.seq > after) : [];
  }

  // ----------------------------------------------------------- generation --

  /** Add a user message and start the answer. Resolves once generation has started (not finished). */
  async send(id, text, { model } = {}) {
    if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("Message required"), { status: 400 });
    if (text.length > MAX_MESSAGE) throw Object.assign(new Error(`Message too long (max ${MAX_MESSAGE} characters)`), { status: 413 });
    if (this.running.has(id)) throw Object.assign(new Error("Still answering; stop it first"), { status: 409 });
    const doc = this._read(id);
    if (doc.messages.length >= MAX_MESSAGES) throw Object.assign(new Error("This chat is full; start a new one"), { status: 409 });
    const chosen = this._checkModel(model) || doc.model;
    doc.model = chosen;
    doc.messages.push({ role: "user", content: text, at: new Date(this.now()).toISOString() });
    if (doc.title === "New chat") doc.title = text.trim().replace(/\s+/g, " ").slice(0, 60);
    doc.updatedAt = new Date(this.now()).toISOString();
    this._write(doc);
    const abort = new AbortController();
    this.running.set(id, { abort });
    this._emit(id, "start", { model: chosen });
    this._generate(doc, abort).catch(() => { /* reported as an event */ });
    return this._snap(doc, false);
  }

  stop(id) {
    const r = this.running.get(id);
    if (!r) return false;
    r.stopped = true;
    r.abort.abort();
    return true;
  }

  stopAll() {
    let n = 0;
    for (const id of [...this.running.keys()]) if (this.stop(id)) n++;
    return n;
  }

  /** Trim the history to fit the context: newest messages first, roughly 3 characters per token. */
  _fit(messages, nCtx) {
    const budget = Math.max(2000, Math.floor((nCtx || 8192) * 3 * 0.75));
    const out = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const len = String(m.content || "").length;
      if (out.length && used + len > budget) break;
      out.unshift({ role: m.role, content: m.content });
      used += len;
    }
    return out;
  }

  async _generate(doc, abort) {
    const id = doc.id;
    const rt = this.running.get(id);
    let answer = "", reasoning = "", error = null;
    const t0 = this.now();
    let loadMs = null, tGen = null, tFirst = null, chunks = 0, timings = null, usage = null;
    try {
      const be = await this.backend({ modelRef: doc.model || undefined }, {
        onProgress: (p) => {
          if (rt.stopped || !p) return;
          if (p.phase === "loaded") loadMs = p.elapsedMs;
          this._emit(id, "load", {
            phase: p.phase, stage: p.stage || null, reason: p.reason || null, model: p.model || null,
            size: p.size || 0, ctx: p.ctx || 0, pct: p.pct, elapsedMs: p.elapsedMs, estMs: p.estMs || 0,
          });
        },
      });
      tGen = this.now();
      if (rt.stopped) throw Object.assign(new Error("stopped"), { name: "AbortError" });
      if (!doc.model && be.modelRef) {
        // Remember what "default" turned out to be.
        doc.model = be.modelRef;
      }
      const s = be.sampling || {};
      const body = {
        model: be.model, stream: true, stream_options: { include_usage: true },
        messages: this._fit(doc.messages, be.nCtx),
        ...(typeof s.temperature === "number" ? { temperature: s.temperature } : {}),
        ...(typeof s.top_p === "number" ? { top_p: s.top_p } : {}),
        ...(typeof s.top_k === "number" ? { top_k: s.top_k } : {}),
      };
      const res = await this.fetch(`http://127.0.0.1:${be.port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal,
      });
      if (!res.ok) throw new Error(`the model server answered ${res.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          if (j && j.timings && typeof j.timings === "object") timings = j.timings;
          if (j && j.usage && typeof j.usage === "object") usage = j.usage;
          const d = j && j.choices && j.choices[0] && j.choices[0].delta;
          if (!d) continue;
          if ((d.reasoning_content || d.content) && tFirst === null) tFirst = this.now();
          if (d.reasoning_content || d.content) chunks++;
          if (typeof d.reasoning_content === "string" && d.reasoning_content) {
            reasoning += d.reasoning_content;
            this._emit(id, "reasoning", { text: d.reasoning_content });
          }
          if (typeof d.content === "string" && d.content) {
            answer += d.content;
            this._emit(id, "delta", { text: d.content });
          }
          if (answer.length + reasoning.length > MAX_ANSWER) { abort.abort(); break; }
        }
      }
    } catch (e) {
      if (!(e && e.name === "AbortError") && !rt.stopped) error = (e && e.code === "MODEL_BUSY") ? e.message : (e && e.message) || "generation failed";
    }
    const stopped = !!rt.stopped;
    this.running.delete(id);
    const stats = this._stats({ t0, tGen, tFirst, chunks, timings, usage, loadMs });
    // Save what we have, even when stopped or cut off.
    let cur;
    try { cur = this._read(id); } catch { cur = null; } // deleted meanwhile
    if (cur) {
      if (answer || reasoning) {
        cur.messages.push({ role: "assistant", content: answer, ...(reasoning ? { reasoning } : {}), model: doc.model, at: new Date(this.now()).toISOString(), ...(stopped ? { stopped: true } : {}), ...(stats ? { stats } : {}) });
      }
      cur.model = doc.model;
      cur.updatedAt = new Date(this.now()).toISOString();
      this._write(cur);
    }
    if (error) this._emit(id, "error", { error: String(error).slice(0, 300) });
    else this._emit(id, stopped ? "stopped" : "done", stats ? { stats } : {});
  }

  /** Speed numbers for one answer: the server's own timings when it sends them, else counted here. */
  _stats({ t0, tGen, tFirst, chunks, timings, usage, loadMs }) {
    if (tGen === null || (!chunks && !timings)) return null;
    const end = this.now();
    const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
    const t = timings || {};
    const u = usage || {};
    const tokens = num(t.predicted_n) ?? num(u.completion_tokens) ?? chunks;
    const genMs = tFirst !== null ? Math.max(1, end - tFirst) : null;
    let tps = num(t.predicted_per_second);
    if (tps === null && genMs && tokens > 1) tps = (tokens - 1) / (genMs / 1000);
    const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
    return {
      tokens,
      tps: r1(tps),
      ttftMs: tFirst !== null ? tFirst - tGen : null,
      promptTokens: num(t.prompt_n) ?? num(u.prompt_tokens),
      promptTps: r1(num(t.prompt_per_second)),
      loadMs: num(loadMs),
      totalMs: end - t0,
    };
  }
}

module.exports = { ChatManager, MAX_MESSAGE };
