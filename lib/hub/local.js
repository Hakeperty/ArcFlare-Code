"use strict";
// The hub's local API: how agents on THIS computer (Claude Code, Codex, ArcFlare's own, anything that speaks
// MCP through `arcflare mcp`) reach the phone and the local models.
//
//   POST /api/local/ask             { question, options?, from?, timeoutSec? } -> { id }   (asks the phone)
//   GET  /api/local/ask/<id>?wait=N  -> { status: "pending" | "answered" | "expired" | "cancelled", answer? }
//   POST /api/local/notify          { title, body, kind? }                    -> { ok, sound }   (a notice on the phone)
//   POST /api/local/call            { say, at? }                              -> { id }   (rings the phone; lib/hub/calls.js)
//                                   with at ("HH:MM" or an ISO time): rings then, one-way -> { id, at, folder }
//   GET  /api/local/call/<id>?after=V&wait=N -> the call: { status, answer, turns, saved, recordings, version }
//   POST /api/local/call/<id>/say   { say, hangUp? }                          -> the call
//   POST /api/local/call/<id>/end   -> the call
//   GET  /api/local/models          -> { models: [{ id, size }], loaded }
//   POST /api/local/generate        { prompt, system?, model?, maxTokens? }   -> { model, text, reasoning? }
//   POST /api/local/unload          -> { stopped, model }
//
// Who may call it: only this computer (the socket's own loopback address; a tunnel or LAN peer gets 404) and
// only with the bearer token the hub writes to <hub>/local-token (0600) at start. No cookie, so no CSRF.
// The token file is the same trust boundary as the rest of ~/.arcflare: whoever can read it is already the user.
//
// Phone side (signed-in sessions, server.js): GET /api/questions, POST /api/questions/<id>/answer,
// and "question" / "notice" events on the dashboard stream.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { EventEmitter } = require("events");

const MAX_PENDING = 20;
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 8;
const MAX_OPTION = 100;
const MAX_ANSWER = 2000;
const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 3600;
const KEEP_RESOLVED_MS = 10 * 60_000;
// Each kind has its own sound on the phone (NotifierPlugin.java).
const NOTICE_KINDS = ["info", "commit", "push", "done", "failed"];

function ensureToken(hubDir) {
  const f = path.join(hubDir, "local-token");
  try {
    const t = fs.readFileSync(f, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch { /* make one */ }
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  const t = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(f, t + "\n", { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* Windows */ }
  return t;
}

function readToken(hubDir) {
  try {
    const t = fs.readFileSync(path.join(hubDir, "local-token"), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch { return null; }
}

function isLoopback(addr) {
  const a = String(addr || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function sameToken(given, want) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(want || ""));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

/** Questions agents ask the phone. Emits { type: "question" | "question_resolved" | "notice", ... }. */
class QuestionBox extends EventEmitter {
  /** allows(): { sound } from HubSettings.phoneAllows: muted, or outside the user's hours, means no sound. */
  constructor({ now = Date.now, allows = () => ({ sound: true }) } = {}) {
    super();
    this.setMaxListeners(0);
    this.now = now;
    this.allows = allows;
    this.items = new Map(); // id -> { id, question, options, from, created, expires, status, answer, waiters }
  }

  _sweep() {
    const t = this.now();
    for (const q of this.items.values()) {
      if (q.status === "pending" && t >= q.expires) this._resolve(q, "expired");
      else if (q.status !== "pending" && t - (q.resolvedAt || 0) > KEEP_RESOLVED_MS) this.items.delete(q.id);
    }
  }

  ask({ question, options, from, timeoutSec } = {}) {
    this._sweep();
    if (typeof question !== "string" || !question.trim()) throw Object.assign(new Error("question required"), { status: 400 });
    if (question.length > MAX_QUESTION) throw Object.assign(new Error(`question too long (max ${MAX_QUESTION})`), { status: 413 });
    if (options !== undefined && (!Array.isArray(options) || options.length > MAX_OPTIONS || options.some((o) => typeof o !== "string" || !o.trim() || o.length > MAX_OPTION))) {
      throw Object.assign(new Error(`options must be up to ${MAX_OPTIONS} short strings`), { status: 400 });
    }
    if ([...this.items.values()].filter((q) => q.status === "pending").length >= MAX_PENDING) {
      throw Object.assign(new Error("too many unanswered questions on the phone"), { status: 429 });
    }
    const secs = Math.min(MAX_TIMEOUT_S, Math.max(10, Number.isFinite(timeoutSec) ? Math.floor(timeoutSec) : DEFAULT_TIMEOUT_S));
    const q = {
      id: crypto.randomBytes(8).toString("hex"), question: question.trim(), options: (options || []).map((o) => o.trim()),
      from: clip(from || "an agent", 60), created: this.now(), expires: this.now() + secs * 1000,
      status: "pending", answer: null, waiters: new Set(),
    };
    this.items.set(q.id, q);
    this.emit("event", { type: "question", ...this._public(q), sound: this.allows().sound });
    return { id: q.id, expiresInSec: secs };
  }

  _public(q) {
    return { id: q.id, question: q.question, options: q.options, from: q.from, created: q.created, expires: q.expires, status: q.status, answer: q.answer };
  }

  pending() {
    this._sweep();
    return [...this.items.values()].filter((q) => q.status === "pending").map((q) => this._public(q));
  }

  get(id) {
    this._sweep();
    const q = this.items.get(String(id));
    return q ? this._public(q) : null;
  }

  answer(id, text) {
    this._sweep();
    const q = this.items.get(String(id));
    if (!q) throw Object.assign(new Error("No such question"), { status: 404 });
    if (q.status !== "pending") throw Object.assign(new Error(`Already ${q.status}`), { status: 409 });
    // Free text is allowed even when options were offered: the user may want to say something else.
    if (typeof text !== "string" || !text.trim() || text.length > MAX_ANSWER) throw Object.assign(new Error("answer required"), { status: 400 });
    q.answer = text.trim();
    this._resolve(q, "answered");
    return this._public(q);
  }

  cancel(id) {
    const q = this.items.get(String(id));
    if (q && q.status === "pending") this._resolve(q, "cancelled");
  }

  _resolve(q, status) {
    q.status = status;
    q.resolvedAt = this.now();
    for (const w of q.waiters) w();
    q.waiters.clear();
    this.emit("event", { type: "question_resolved", id: q.id, status, answer: q.answer });
  }

  /** Wait up to waitMs for the question to leave "pending". */
  async wait(id, waitMs) {
    const q = this.items.get(String(id));
    if (!q) return null;
    if (q.status === "pending" && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); q.waiters.delete(done); resolve(); };
        const t = setTimeout(done, Math.min(waitMs, Math.max(0, q.expires - this.now()) + 50));
        q.waiters.add(done);
      });
    }
    return this.get(id);
  }

  notice({ title, body, kind } = {}) {
    if (typeof title !== "string" || !title.trim()) throw Object.assign(new Error("title required"), { status: 400 });
    if (kind !== undefined && !NOTICE_KINDS.includes(kind)) throw Object.assign(new Error(`kind is one of ${NOTICE_KINDS.join(", ")}`), { status: 400 });
    const sound = this.allows().sound;
    this.emit("event", { type: "notice", title: clip(title.trim(), 80), body: clip(body, 300), kind: kind || "info", sound });
    return { ok: true, sound };
  }
}

/**
 * Calls the running hub's /api/local as this computer's user (the MCP tools, `arcflare phone notify`).
 * Throws a sentence that says what to do when the hub is not running.
 */
async function callHub(method, p, body, timeoutMs = 30000) {
  const home = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
  let run, token;
  try { run = JSON.parse(fs.readFileSync(path.join(home, "hub", "running.json"), "utf8")); } catch { run = null; }
  try { token = fs.readFileSync(path.join(home, "hub", "local-token"), "utf8").trim(); } catch { token = null; }
  if (!run || !Number.isInteger(run.port) || !token) throw new Error("the ArcFlare hub is not running on this computer. Start it with: arcflare phone");
  // The token goes only to the hub itself. A running.json left by a killed hub
  // names a port anyone on this computer could now be listening on.
  const notRunning = new Error("the ArcFlare hub is not running on this computer (stale record). Start it with: arcflare phone");
  if (!Number.isInteger(run.pid)) throw notRunning;
  try { process.kill(run.pid, 0); } catch (e) { if (!e || e.code !== "EPERM") throw notRunning; }
  // Checked on every system that can say who is listening (null: this one cannot, so the pid check above stands alone).
  const owners = require("../mcp/procs").portListeners(run.port, { includeSelf: true });
  if (owners && !owners.includes(run.pid)) throw notRunning;
  const scheme = run.tls ? "https" : "http";
  let res;
  try {
    res = await fetch(`${scheme}://127.0.0.1:${run.port}${p}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`the ArcFlare hub did not answer (${e.message}). Is it running? arcflare phone`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `hub answered ${res.status}`);
  return j;
}

/**
 * The /api/local handler. deps: { token, questions, models(), backend (with .status/.unload), fetch, readJson, sendJson }.
 * Call only after the caller checked loopback + not-tunnel + token (see server.js).
 */
function makeLocalApi(deps) {
  const { questions, calls, models, backend, readJson, sendJson } = deps;
  const fetchFn = deps.fetch || globalThis.fetch;
  const err = (status, message) => Object.assign(new Error(message), { status });
  const jobs = new Map(); // generation jobs: id -> job
  const MAX_JOBS = 4;
  const KEEP_JOB_MS = 30 * 60_000;
  const MAX_JOB_CHARS = 2_000_000;

  function sweepJobs() {
    const t = Date.now();
    for (const j of jobs.values()) if (j.status !== "running" && t - (j.ended || t) > KEEP_JOB_MS) jobs.delete(j.id);
  }

  async function runJob(job, { modelRef, system, prompt, maxTokens }) {
    try {
      const be = await backend(modelRef ? { modelRef } : {});
      job.model = be.modelRef;
      const s = be.sampling || {};
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      const r = await fetchFn(`http://127.0.0.1:${be.port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: job.abort.signal,
        body: JSON.stringify({
          model: be.model, messages, max_tokens: maxTokens, stream: true,
          ...(typeof s.temperature === "number" ? { temperature: s.temperature } : {}),
          ...(typeof s.top_p === "number" ? { top_p: s.top_p } : {}),
          ...(typeof s.top_k === "number" ? { top_k: s.top_k } : {}),
        }),
      });
      if (!r.ok) throw new Error(`the model server answered ${r.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
          const c = j && j.choices && j.choices[0];
          if (!c) continue;
          if (c.delta && typeof c.delta.content === "string") job.text += c.delta.content;
          if (c.delta && typeof c.delta.reasoning_content === "string") job.reasoning += c.delta.reasoning_content;
          if (c.finish_reason) job.finish = c.finish_reason;
        }
        if (job.text.length + job.reasoning.length > MAX_JOB_CHARS) { job.abort.abort(); job.finish = "cut"; break; }
      }
      job.status = "done";
    } catch (e) {
      if (job.abort.signal.aborted) { job.status = "done"; job.finish = job.finish || "stopped"; }
      else { job.status = "error"; job.error = String((e && e.message) || e).slice(0, 300); }
    }
    job.ended = Date.now();
    for (const w of job.waiters) w();
    job.waiters.clear();
  }

  return async function localApi(req, res, pathname, query) {
    const method = req.method;
    let body = {};
    if (method === "POST") body = await readJson(req);
    let m;
    if (pathname === "/api/local/ask" && method === "POST") {
      return sendJson(res, 200, questions.ask({ question: body.question, options: body.options, from: body.from, timeoutSec: body.timeoutSec }));
    }
    if ((m = pathname.match(/^\/api\/local\/ask\/([0-9a-f]{16})$/)) && method === "GET") {
      const w = Math.min(25, Math.max(0, parseInt(query.get("wait") || "0", 10) || 0));
      req.socket.setTimeout(0);
      const q = await questions.wait(m[1], w * 1000);
      if (!q) throw err(404, "No such question");
      return sendJson(res, 200, { status: q.status, answer: q.answer, question: q.question });
    }
    if ((m = pathname.match(/^\/api\/local\/ask\/([0-9a-f]{16})$/)) && method === "DELETE") {
      questions.cancel(m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (calls && pathname === "/api/local/call" && method === "POST") {
      if (body.at !== undefined) return sendJson(res, 200, calls.schedule({ say: body.say, from: body.from, at: body.at }));
      return sendJson(res, 200, calls.start({ say: body.say, from: body.from }));
    }
    if (calls && (m = pathname.match(/^\/api\/local\/call\/([0-9a-f]{16})(?:\/(say|end))?$/))) {
      if (!m[2] && method === "GET") {
        const w = Math.min(25, Math.max(0, parseInt(query.get("wait") || "0", 10) || 0));
        const after = parseInt(query.get("after") || "-1", 10);
        req.socket.setTimeout(0);
        const c = await calls.wait(m[1], Number.isFinite(after) ? after : -1, w * 1000);
        if (!c) throw err(404, "No such call");
        return sendJson(res, 200, c);
      }
      if (m[2] === "say" && method === "POST") return sendJson(res, 200, calls.say(m[1], { say: body.say, hangUp: body.hangUp }));
      if (m[2] === "end" && method === "POST") return sendJson(res, 200, calls.end(m[1]));
    }
    if (pathname === "/api/local/notify" && method === "POST") {
      return sendJson(res, 200, questions.notice({ title: body.title, body: body.body, kind: body.kind }));
    }
    if (pathname === "/api/local/models" && method === "GET") {
      const st = backend && backend.status ? await backend.status() : { modelRef: null, running: false };
      return sendJson(res, 200, { models: (models() || []).map((x) => ({ id: x.id, size: x.size })), loaded: st.modelRef });
    }
    if (pathname === "/api/local/unload" && method === "POST") {
      if (!backend || !backend.unload) throw err(404, "Not found");
      return sendJson(res, 200, await backend.unload());
    }
    if (pathname === "/api/local/generate" && method === "POST") {
      if (typeof body.prompt !== "string" || !body.prompt.trim()) throw err(400, "prompt required");
      if (body.prompt.length > 400000) throw err(413, "prompt too long");
      if (body.system !== undefined && (typeof body.system !== "string" || body.system.length > 20000)) throw err(400, "bad system");
      let modelRef;
      if (body.model !== undefined && body.model !== null && body.model !== "") {
        if (typeof body.model !== "string" || !(models() || []).some((x) => x.id === body.model)) throw err(400, "That model is not on this computer");
        modelRef = body.model;
      }
      const maxTokens = Math.min(131072, Math.max(16, parseInt(body.maxTokens, 10) || 4096));
      // A job, not one long request: a big answer can take many minutes, longer than an HTTP client waits for
      // headers. POST returns { id } at once; GET /api/local/generate/<id>?wait=25 collects it.
      sweepJobs();
      if ([...jobs.values()].filter((j) => j.status === "running").length >= MAX_JOBS) throw err(429, "too many generations running");
      const job = { id: crypto.randomBytes(8).toString("hex"), status: "running", text: "", reasoning: "", model: null, finish: null, error: null, started: Date.now(), abort: new AbortController(), waiters: new Set() };
      jobs.set(job.id, job);
      runJob(job, { modelRef, system: body.system, prompt: body.prompt, maxTokens });
      return sendJson(res, 200, { id: job.id });
    }
    if ((m = pathname.match(/^\/api\/local\/generate\/([0-9a-f]{16})$/)) && (method === "GET" || method === "DELETE")) {
      const job = jobs.get(m[1]);
      if (!job) throw err(404, "No such job");
      if (method === "DELETE") { job.abort.abort(); return sendJson(res, 200, { ok: true }); }
      const w = Math.min(25, Math.max(0, parseInt(query.get("wait") || "0", 10) || 0));
      req.socket.setTimeout(0);
      if (job.status === "running" && w) {
        await new Promise((resolve) => { const done = () => { clearTimeout(t); job.waiters.delete(done); resolve(); }; const t = setTimeout(done, w * 1000); job.waiters.add(done); });
      }
      return sendJson(res, 200, {
        status: job.status, model: job.model, chars: job.text.length,
        ...(job.status === "running" ? {} : { text: job.text, ...(job.reasoning ? { reasoning: job.reasoning } : {}), finish: job.finish, error: job.error }),
      });
    }
    throw err(404, "Not found");
  };
}

module.exports = { ensureToken, readToken, isLoopback, sameToken, QuestionBox, makeLocalApi, callHub, NOTICE_KINDS };
