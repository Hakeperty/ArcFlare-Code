// Runs local coding agents for the hub, in-process.
//
// The hub lets a phone drive agents that live on the computer. This file is the
// part that owns them: it validates where an agent may work, starts and stops
// them, keeps their event history for late-joining browsers, and turns every
// tool approval into a question somebody has to answer.
//
// Decisions worth knowing:
//
//   Folders are an allowlist. An agent's cwd must resolve (symlinks and ../
//   included) to somewhere inside one of the configured roots, checked again at
//   start, because a link can be swapped after create.
//
//   Approval is always "ask". Every bash/MCP call becomes an "approval" event
//   and waits for approve(); no answer within approveTimeoutMs is a deny, and
//   stop() denies everything pending. Nothing in the API can turn approvals
//   off. The only bypass is the `trusted` constructor flag, which the host CLI
//   sets deliberately and a remote caller cannot reach.
//
//   No model is started here. The model backend is injected (`backend(tier)`
//   returns a port/model), and so is the agent factory (`makeAgent`), which is
//   how tests run without a GPU. The real factory requires lib/agent lazily.
//
//   One turn at a time per agent. A second wake while a turn runs is rejected
//   with code "BUSY" rather than queued: a phone user should see that the agent
//   is occupied, not have messages pile up behind a long turn.
//
//   start()/wake() return as soon as the turn is under way (status "running"),
//   not when it ends: an HTTP request must not hang for minutes. Follow it
//   through events, or await whenIdle(id).
//
// State: <dir>/agents.json (atomic, 0600) holds the agent records; conversations
// live in lib/agent/sessions so `arcflare agent --resume` can open them too.
// After a restart every agent is "stopped" (its process is gone); waking one
// resumes its saved conversation.

const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sessions = require("../agent/sessions");
const router = require("./router");

const RING = 2000;
const TIERS = router.TIERS;

function homeDir() {
  return process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * The real agent: tools, skills, project notes and undo checkpoints, as
 * lib/agent/run.js builds them. MCP is left out for now.
 */
function defaultMakeAgent(o) {
  const { Agent } = require("../agent/agent");
  const skills = require("../agent/skills").discover(o.cwd);
  const notes = require("../agent/notes").load(o.cwd);
  const { Checkpoints } = require("../agent/checkpoints");
  return new Agent({
    port: o.port, model: o.model, cwd: o.cwd, nCtx: o.nCtx, sampling: o.sampling || null,
    skills, projectNotes: notes.text, mcp: null,
    checkpoints: Checkpoints.load(path.join(sessions.folderFor(o.sessionId), "checkpoints.json")),
    approve: o.approve, onEvent: o.onEvent,
  });
}

class Supervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {string}   [o.dir]       state folder (default <home>/hub)
   * @param {string[]} o.roots       absolute folders agents may work in
   * @param {function} o.backend     async (tier) => {port, model, nCtx, modelRef, sampling}
   * @param {number}   [o.approveTimeoutMs]
   * @param {function} [o.now]
   * @param {function} [o.makeAgent] (opts) => agent-like; tests inject a fake
   * @param {boolean}  [o.trusted]   host-only: approve everything without asking
   */
  constructor(o = {}) {
    super();
    this.dir = o.dir || path.join(homeDir(), "hub");
    this.roots = (o.roots || []).map(String);
    this.backend = o.backend || null;
    this.approveTimeoutMs = o.approveTimeoutMs ?? 300000;
    this.now = o.now || Date.now;
    this.makeAgent = o.makeAgent || defaultMakeAgent;
    this.trusted = o.trusted === true;
    this.file = path.join(this.dir, "agents.json");
    this.agents = new Map();   // id -> record (persisted)
    this.rt = new Map();       // id -> runtime (agent, approvals, ring, turn)
    this._load();
  }

  // ------------------------------------------------------------- persistence --

  _load() {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return; }
    for (const r of (doc && doc.agents) || []) {
      if (!r || typeof r.id !== "string") continue;
      // Whatever it was doing, the process that did it is gone.
      this.agents.set(r.id, { ...r, status: "stopped" });
    }
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ agents: [...this.agents.values()] }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }

  _touch(rec) { rec.updatedAt = new Date(this.now()).toISOString(); }

  // ---------------------------------------------------------------- reading --

  _snap(rec) {
    const rt = this.rt.get(rec.id);
    const first = rt && rt.approvals.size ? rt.approvals.values().next().value : null;
    return {
      id: rec.id, name: rec.name, cwd: rec.cwd, tier: rec.tier, modelRef: rec.modelRef || null,
      status: rec.status, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      lastText: rec.lastText || "",
      pendingApproval: first ? { id: first.id, kind: first.kind, detail: first.detail } : null,
      turns: rec.turns || 0,
    };
  }

  list() {
    return [...this.agents.values()]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((r) => this._snap(r));
  }

  get(id) {
    const r = this.agents.get(id);
    return r ? this._snap(r) : null;
  }

  _rec(id) {
    const r = this.agents.get(id);
    if (!r) throw fail("NOT_FOUND", "no such agent");
    return r;
  }

  history(id, afterSeq = 0) {
    this._rec(id);
    const rt = this.rt.get(id);
    const ring = rt ? rt.ring : (this._cold.get(id) || []);
    return ring.filter((e) => e.seq > afterSeq);
  }

  // ----------------------------------------------------------------- events --

  // History must outlive stop(): keep the ring of a stopped agent here.
  get _cold() { return this.__cold || (this.__cold = new Map()); }

  _emit(id, type, data = {}) {
    const rt = this.rt.get(id);
    const ring = rt ? rt.ring : (this._cold.get(id) || this._cold.set(id, []).get(id));
    const seqs = this._seq || (this._seq = new Map());
    const seq = (seqs.get(id) || 0) + 1;
    seqs.set(id, seq);
    const ev = { seq, t: this.now(), type, ...data };
    ring.push(ev);
    if (ring.length > RING) ring.splice(0, ring.length - RING);
    this.emit("event", { agentId: id, ...ev });
    return ev;
  }

  _setStatus(rec, status) {
    if (rec.status === status) return;
    rec.status = status;
    this._touch(rec);
    this._emit(rec.id, "status", { status });
  }

  // ------------------------------------------------------------------ roots --

  /** Real path of `cwd` if it is a directory inside a root; throws BAD_CWD otherwise. */
  _checkCwd(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw fail("BAD_CWD", "folder must be an absolute path");
    let real;
    try {
      real = fs.realpathSync(cwd);
      if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    } catch { throw fail("BAD_CWD", "folder does not exist"); }
    for (const root of this.roots) {
      let r;
      try { r = fs.realpathSync(root); } catch { continue; }
      const rel = path.relative(r, real);
      if (rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))) return real;
    }
    throw fail("BAD_CWD", "folder is outside the allowed roots");
  }

  // ---------------------------------------------------------------- lifecycle --

  create({ name, cwd, tier, task } = {}) {
    const real = this._checkCwd(cwd);
    if (tier !== undefined && tier !== null && !TIERS.includes(tier)) throw fail("BAD_TIER", "unknown tier");
    const nm = String(name || path.basename(real)).trim().slice(0, 80) || path.basename(real);
    const t = task ? String(task).slice(0, 20000) : "";
    // No tier asked for: let the router decide, which never picks "hard" for ordinary work.
    const chosen = tier || router.classify(t).tier;
    const now = new Date(this.now()).toISOString();
    const rec = {
      id: crypto.randomBytes(6).toString("hex"), name: nm, cwd: real, tier: chosen,
      modelRef: null, status: "stopped", createdAt: now, updatedAt: now,
      lastText: "", turns: 0, sessionId: sessions.newId(new Date(this.now())),
      sessionCreated: now, task: t || undefined,
    };
    this.agents.set(rec.id, rec);
    this._save();
    this._emit(rec.id, "status", { status: "stopped" });
    return this._snap(rec);
  }

  async start(id, { task } = {}) {
    const rec = this._rec(id);
    if (!this.rt.has(id)) await this._boot(rec);
    else if (this.rt.get(id).booting) await this.rt.get(id).booting;
    const first = task !== undefined ? task : rec.task;
    if (first) {
      delete rec.task;
      this._save();
      this._beginTurn(rec, String(first));
    }
    return this._snap(rec);
  }

  async wake(id, text) {
    const rec = this._rec(id);
    if (typeof text !== "string" || !text.trim()) throw fail("BAD_REQUEST", "message is empty");
    const rt = this.rt.get(id);
    if (rt && rt.booting) await rt.booting;
    else if (!rt) await this._boot(rec);
    this._beginTurn(rec, text);
    return this._snap(rec);
  }

  /** Build the agent for a stopped record. Concurrent callers share one boot. */
  async _boot(rec) {
    const rt = { agent: null, approvals: new Map(), ring: this._cold.get(rec.id) || [],
      turn: null, stopping: false, booting: null };
    this._cold.delete(rec.id);
    this.rt.set(rec.id, rt);
    rt.booting = (async () => {
      this._setStatus(rec, "starting");
      try {
        rec.cwd = this._checkCwd(rec.cwd);
        if (!this.backend) throw fail("NO_BACKEND", "no model backend configured");
        const b = await this.backend(rec.tier);
        if (!b) throw fail("NO_BACKEND", "no model available for this tier");
        rec.modelRef = b.modelRef || b.model || null;
        const agent = this.makeAgent({
          port: b.port, model: b.model, nCtx: b.nCtx, sampling: b.sampling, cwd: rec.cwd,
          sessionId: rec.sessionId,
          approve: (kind, detail) => this._ask(rec, rt, kind, detail),
          onEvent: (ev) => this._onAgentEvent(rec, ev),
        });
        const doc = sessions.load(rec.sessionId);
        if (doc && doc.messages && doc.messages.length) agent.loadConversation(doc.messages);
        if (rt.stopping) return;       // stop() arrived while the backend was loading
        rt.agent = agent;
        this._setStatus(rec, "idle");
      } catch (e) {
        this.rt.delete(rec.id);
        this._cold.set(rec.id, rt.ring);
        this._setStatus(rec, "error");
        this._emit(rec.id, "error", { text: e.code === "BAD_CWD" || e.code === "NO_BACKEND" ? e.message : "could not start the agent" });
        throw e;
      } finally { rt.booting = null; }
    })();
    await rt.booting;
    if (rt.stopping) throw fail("STOPPED", "agent was stopped");
  }

  _beginTurn(rec, text) {
    const rt = this.rt.get(rec.id);
    if (!rt || !rt.agent) throw fail("NOT_RUNNING", "agent is not running");
    if (rt.turn || rt.agent.busy) throw fail("BUSY", "agent is busy with another turn");
    this._setStatus(rec, "running");
    rec.lastText = "";
    rt.turn = this._runTurn(rec, rt, text).finally(() => { if (this.rt.get(rec.id) === rt) rt.turn = null; });
  }

  async _runTurn(rec, rt, text) {
    const agent = rt.agent;
    this._emit(rec.id, "user", { text });
    let res = null, err = null;
    try {
      if (agent.checkpoints && agent.checkpoints.begin) agent.checkpoints.begin(text);
      res = await agent.send(text);
    } catch (e) { err = e; }
    finally { try { if (agent.checkpoints && agent.checkpoints.end) agent.checkpoints.end(); } catch {} }
    this._saveSession(rec, agent);
    if (rt.stopping || this.rt.get(rec.id) !== rt) return;   // stop() owns the wrap-up
    rec.turns = (rec.turns || 0) + 1;
    const ok = !err && (!res || res.ok !== false);
    const out = res && typeof res.content === "string" ? res.content : "";
    if (err) this._emit(rec.id, "error", { text: "the turn failed" });
    if (out) rec.lastText = out.slice(0, 500);
    this._emit(rec.id, "turn_end", { ok, ...(out ? { text: out.slice(0, 20000) } : {}) });
    this._setStatus(rec, "idle");
    this._touch(rec);
    this._save();
  }

  _saveSession(rec, agent) {
    try {
      sessions.save({
        id: rec.sessionId, cwd: rec.cwd, model: agent.model || null, modelRef: rec.modelRef,
        created: rec.sessionCreated, messages: agent.conversation(),
      });
    } catch { /* a full disk should not end the agent */ }
  }

  /** Agent events in, hub events out (shape shared with the /rc relay). */
  _onAgentEvent(rec, ev) {
    if (ev.type === "tool_result") {
      const out = String(ev.out || "");
      return this._emit(rec.id, "tool_result", { name: ev.name, line: out.split("\n")[0].slice(0, 200), error: out.startsWith("ERROR") });
    }
    const m = require("../rc").toRemote(ev);
    if (!m || m.type === "note") return;
    const { type, ...rest } = m;
    if (type === "tool_result") return;
    this._emit(rec.id, type, rest);
  }

  async stop(id) {
    const rec = this._rec(id);
    const rt = this.rt.get(id);
    if (!rt) { if (rec.status !== "stopped") this._setStatus(rec, "stopped"); return this._snap(rec); }
    rt.stopping = true;
    this._denyAll(rec, rt, "stopped");       // unblock tools waiting on a human first
    if (rt.agent) rt.agent.abort();
    const turn = rt.turn;
    if (turn) {
      let t;
      await Promise.race([turn, new Promise((r) => { t = setTimeout(r, 5000); })]);
      clearTimeout(t);
    }
    if (rt.booting) await rt.booting.catch(() => {});
    if (rt.agent) this._saveSession(rec, rt.agent);
    this.rt.delete(id);
    this._cold.set(id, rt.ring);
    this._setStatus(rec, "stopped");
    this._save();
    return this._snap(rec);
  }

  async remove(id) {
    this._rec(id);
    await this.stop(id);
    this.agents.delete(id);
    this._cold.delete(id);
    if (this._seq) this._seq.delete(id);
    this._save();
  }

  async stopAll() {
    await Promise.all([...this.rt.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  /** Resolves when the agent's current turn (if any) is over. */
  async whenIdle(id) {
    this._rec(id);
    const rt = this.rt.get(id);
    if (rt && rt.booting) await rt.booting.catch(() => {});
    if (rt && rt.turn) await rt.turn;
  }

  // -------------------------------------------------------------- approvals --

  _ask(rec, rt, kind, detail) {
    if (this.trusted) return Promise.resolve(true);
    if (rt.stopping) return Promise.resolve(false);
    const id = crypto.randomBytes(6).toString("hex");
    const shown = String(detail).slice(0, 2000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this._settle(rec, rt, id, false, "timed out"), this.approveTimeoutMs);
      rt.approvals.set(id, { id, kind: String(kind), detail: shown, timer, resolve });
      this._setStatus(rec, "waiting_approval");
      this._emit(rec.id, "approval", { id, kind: String(kind), detail: shown });
    });
  }

  _settle(rec, rt, approvalId, allow, reason) {
    const p = rt.approvals.get(approvalId);
    if (!p) return false;
    rt.approvals.delete(approvalId);
    clearTimeout(p.timer);
    this._emit(rec.id, "approval_resolved", { id: approvalId, allow, ...(reason ? { reason } : {}) });
    if (!rt.approvals.size && rec.status === "waiting_approval") if (!rt.stopping) this._setStatus(rec, "running");
    p.resolve(allow);
    return true;
  }

  _denyAll(rec, rt, reason) {
    for (const id of [...rt.approvals.keys()]) this._settle(rec, rt, id, false, reason);
  }

  approve(id, approvalId, allow) {
    const rec = this._rec(id);
    const rt = this.rt.get(id);
    if (!rt) return false;
    return this._settle(rec, rt, String(approvalId), allow === true, allow === true ? undefined : "denied");
  }
}

module.exports = { Supervisor, defaultMakeAgent, RING };
