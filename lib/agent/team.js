// Team mode: one agent, three roles, all on this computer.
//
//   lead     the agent's own model. The only one that edits files and runs commands.
//   swarm    a small model that takes read-only jobs in parallel (map the repo, find call sites, check a
//            diff) through the `delegate` tool, so the lead's context stays small.
//   advisor  a stronger model that never writes code. It reads the session and gives advice at three
//            checkpoints: before the lead starts a task, when the same error comes back twice, and before
//            the lead says it is done. The lead can also call it with `ask_advisor`.
//
// The lead keeps the main model server. Swarm and advisor share a second llama-server (the "helper"),
// which holds one of them at a time and swaps when the other is needed. That is the price of Team mode:
// a swap is several seconds, and an advisor read is tens of seconds, so answers are slower. The phone
// says so before Team mode is turned on.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const READ_ONLY = ["read_file", "list_dir", "glob", "grep"];
const MAX_JOBS = 4;
const SWARM_SLOT_CTX = 12288;
const ADVISOR_CTX = 24576;
const DIGEST_CHARS = 60000;          // about 15k tokens of session for the advisor to read
const LGTM = /^\s*(LGTM|looks good|all good)\b/i;

const SWARM_SYSTEM =
  "You are a fast read-only helper for a coding agent. You can read files, list folders, glob and grep, " +
  "nothing else. Use those tools to look: never ask for files or paths, nobody will answer. Do exactly the job " +
  "you are given, then answer in plain text: short, concrete, with file paths and line numbers. No advice beyond " +
  "the job. If you could not find something, say so plainly.";

const ADVISOR_SYSTEM =
  "You are the advisor to a coding agent (the lead). You never write code and never run anything; the lead " +
  "applies your advice. You see the session so far: the person's request, what the lead said, its tool calls " +
  "and their results. Be specific and brief: at most 8 short bullet points, each naming a file, a step or a " +
  "risk. Check claims against the tool results: an edit that returned ERROR did not happen.";

const ADVICE_ASK = {
  plan: "The lead is about to start this task. Give a short plan: the order of steps, the files likely involved, " +
    "and the traps to avoid. Task:\n",
  error: "The lead hit the same error twice. Say why it keeps failing and what to do differently. The error:\n",
  done: "The lead says the task is done. Check the session: did every edit and command the lead relies on " +
    "actually succeed, and is the person's request fully met? If yes, reply with exactly LGTM. If not, list " +
    "what is missing or wrong.",
  ask: "The lead asks you:\n",
};

const def = (name, description, properties, required) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

const SCHEMAS = [
  def("delegate",
    "Hand read-only jobs to fast helper models that run in parallel: mapping a folder, finding where something " +
    "is defined or called, reading several files and summarising them, checking code for a problem. Each job " +
    "gets a fresh helper that can read, list, glob and grep. They cannot edit or run anything. Up to 4 jobs.", {
      jobs: { type: "array", items: { type: "string" }, description: "One self-contained instruction per job" },
    }, ["jobs"]),
  def("ask_advisor",
    "Ask the advisor, a stronger model that reads this whole session, for advice. It never writes code. Use it " +
    "when you are unsure how to proceed. It is slow (up to a minute), so not for routine steps.", {
      question: { type: "string" },
    }, ["question"]),
];

/* ------------------------------------------------------------ picking --- */

function configFile(home) { return path.join(home || path.join(os.homedir(), ".arcflare"), "team.json"); }

function loadConfig(home) {
  try { return JSON.parse(fs.readFileSync(configFile(home), "utf8")) || {}; } catch { return {}; }
}

function saveConfig(cfg, home) {
  const f = configFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
}

const GB = 1e9;
// GPU memory a helper model needs: its weights plus a q8 cache and compute buffers.
const HELPER_EXTRA = 2.5 * GB;
const LEAD_MIN_KV = 4 * GB;          // what the lead keeps for its own cache when memory is shared
function helperNeed(m) { return m ? Number(m.size) + HELPER_EXTRA : 0; }

/**
 * Choose swarm and advisor from the installed models. A set choice (team.json) wins when installed. Otherwise
 * the swarm is the biggest model up to 7 GB (small enough to answer fast), and the advisor the biggest up to
 * 14 GB that is not the lead. With `maxBytes` (the GPU memory left beside the lead) only models that fit are
 * chosen automatically: a helper that does not fit pushes the lead out of memory mid-answer.
 */
function pick(all, leadRef, cfg = {}, maxBytes = Infinity) {
  const byId = (id) => all.find((m) => m.id === id) || null;
  const usable = all.filter((m) => m.file && Number(m.size) > 0 && m.id !== leadRef && !m.mmprojOnly &&
    !BAD.has(m.id) && helperNeed(m) <= maxBytes);
  const ranked = (max, min = 0) => usable.filter((m) => m.size <= max && m.size >= min).sort((a, b) => b.size - a.size);
  const uniq = (xs) => xs.filter((m, i) => m && xs.findIndex((y) => y && y.id === m.id) === i);
  // Candidates in order: a set choice, then the automatic ones. A model that will not load is skipped for the next.
  const swarms = uniq([byId(cfg.swarm), ...ranked(7 * GB, 1.5 * GB), ...ranked(1.5 * GB)]);
  const advisors = uniq([byId(cfg.advisor), ...ranked(14 * GB, 7 * GB + 1), ...swarms]);
  const swarm = swarms[0] || null;
  const advisor = advisors[0] || null;
  return { swarm, advisor, swarms, advisors, reserve: Math.max(helperNeed(swarm), helperNeed(advisor)) };
}

// Models this llama-server could not load (an Ollama-only format, a too-new architecture), for this process's life.
const BAD = new Set();

/** GPU memory to leave free beside a lead of `leadSize` bytes when the budget is `budget`. */
function helperRoom(budget, leadSize) { return Math.max(0, budget - Number(leadSize || 0) - LEAD_MIN_KV - 1.5 * GB); }

/* ------------------------------------------------------- helper server --- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function healthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b).status === "ok"); } catch { resolve(false); } });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** A second llama-server for the helpers. Holds one model at a time; use() swaps when asked for another. */
class HelperServer {
  constructor({ exe, logFile, spawnImpl = spawn, readyMs = 300000 } = {}) {
    this.exe = exe;
    this.logFile = logFile || path.join(os.tmpdir(), "arcflare-team-helper.log");
    this.spawnImpl = spawnImpl;
    this.readyMs = readyMs;
    this.cur = null;        // { id, port, child, slots }
    this.chain = Promise.resolve();
  }

  /** The port of a server holding `model` with `slots` parallel slots of `ctx` tokens each. */
  use(model, { ctx, slots = 1, onLoad } = {}) {
    const run = this.chain.then(async () => {
      if (this.cur && this.cur.id === model.id && this.cur.slots >= slots && this.cur.child.exitCode === null && await healthy(this.cur.port)) {
        return this.cur.port;
      }
      this._kill();
      if (!this.exe) throw Object.assign(new Error("llama-server was not found for the team helpers"), { code: "NO_ENGINE" });
      if (onLoad) onLoad(model);
      const port = await freePort();
      const out = fs.openSync(this.logFile, "a");
      const args = ["-m", model.file, "--host", "127.0.0.1", "--port", String(port), "-c", String(ctx * slots),
        "-np", String(slots), "-ngl", "99", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--no-webui"];
      const child = this.spawnImpl(this.exe, args, { stdio: ["ignore", out, out], windowsHide: true });
      try { fs.closeSync(out); } catch { /* the child holds it */ }
      this.cur = { id: model.id, port, child, slots };
      const t0 = Date.now();
      while (Date.now() - t0 < this.readyMs) {
        if (child.exitCode !== null) break;
        if (await healthy(port)) return port;
        await new Promise((r) => setTimeout(r, 400));
      }
      this._kill();
      throw Object.assign(new Error(`the helper model ${model.id} did not start (see ${this.logFile})`), { code: "HELPER_DOWN" });
    });
    this.chain = run.catch(() => {});
    return run;
  }

  _kill() {
    if (this.cur && this.cur.child && this.cur.child.exitCode === null) { try { this.cur.child.kill(); } catch { /* gone */ } }
    this.cur = null;
  }

  stop() { this._kill(); }
}

/* ---------------------------------------------------------------- team --- */

/** Squeeze the session into text the advisor can read: newest kept whole, oldest dropped first. */
function digest(messages, limit = DIGEST_CHARS) {
  const lines = [];
  for (const m of messages || []) {
    if (!m || m.role === "system") continue;
    if (m.role === "user") lines.push(`PERSON: ${String(m.content || "").slice(0, 4000)}`);
    else if (m.role === "assistant") {
      if (m.content) lines.push(`LEAD: ${String(m.content).slice(0, 3000)}`);
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        lines.push(`LEAD CALLS ${fn.name}(${String(fn.arguments || "").slice(0, 600)})`);
      }
    } else if (m.role === "tool") lines.push(`RESULT: ${String(m.content || "").slice(0, 1500)}`);
  }
  let out = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length + lines[i].length + 1 > limit) { out = "[earlier session left out]\n" + out; break; }
    out = lines[i] + "\n" + out;
  }
  return out.trim();
}

class Team {
  /**
   * @param {object} o
   * @param {object} o.helper     HelperServer (shared by every Team agent on the hub)
   * @param {object} o.swarm      model record { id, file, size }
   * @param {object} o.advisor    model record
   * @param {string} o.cwd
   * @param {string[]} [o.roots]
   * @param {function} [o.onEvent]    team progress: { type: "team", role, phase, ... }
   * @param {function} [o.chat]       streamChat (tests inject)
   * @param {function} [o.makeHelper] (opts) => agent-like, for swarm jobs (tests inject)
   */
  constructor(o) {
    this.helper = o.helper;
    this.swarm = o.swarm;
    this.advisor = o.advisor;
    this.swarms = o.swarms && o.swarms.length ? o.swarms : [o.swarm];
    this.advisors = o.advisors && o.advisors.length ? o.advisors : [o.advisor, o.swarm];
    this.cwd = o.cwd;
    this.roots = o.roots || [o.cwd];
    this.onEvent = o.onEvent || (() => {});
    this.chat = o.chat || require("./agent").streamChat;
    this.makeHelper = o.makeHelper || ((h) => new (require("./agent").Agent)(h));
    this.errors = new Map();
    this.schemas = SCHEMAS;
  }

  /** Load the first candidate for a role that works; a model that fails to load is skipped from then on. */
  async _load(role, opts) {
    const list = role === "swarm" ? this.swarms : this.advisors;
    let last = null;
    for (const m of list) {
      if (!m || BAD.has(m.id)) continue;
      try {
        const port = await this.helper.use(m, { ...opts, onLoad: (x) => this._say(role, "loading", { model: x.id, kind: opts.kind }) });
        this[role] = m;
        return port;
      } catch (e) {
        last = e;
        if (e.code !== "HELPER_DOWN" && e.code !== undefined) break;   // no engine at all: trying others will not help
        BAD.add(m.id);
      }
    }
    throw last || new Error("no helper model could be loaded");
  }

  _say(role, phase, extra = {}) { try { this.onEvent({ type: "team", role, phase, ...extra }); } catch { /* not ours */ } }

  /** Tool calls: `delegate` and `ask_advisor`. Anything else is not ours (undefined). */
  async run(name, args, { signal, messages } = {}) {
    if (name === "delegate") return this.delegate(args && args.jobs, signal);
    if (name === "ask_advisor") {
      const q = String((args && args.question) || "").trim();
      if (!q) return "ERROR: question is empty";
      return this.advise("ask", q, messages, signal);
    }
    return undefined;
  }

  async delegate(jobs, signal) {
    const list = (Array.isArray(jobs) ? jobs : [jobs]).map((j) => String(j || "").trim()).filter(Boolean).slice(0, MAX_JOBS);
    if (!list.length) return "ERROR: give at least one job";
    let port;
    try {
      port = await this._load("swarm", { ctx: SWARM_SLOT_CTX, slots: MAX_JOBS });
    } catch (e) { return `ERROR: helpers unavailable (${e.message}); do the job yourself`; }
    this._say("swarm", "start", { jobs: list.map((j) => j.slice(0, 160)), model: this.swarm.id });
    const t0 = Date.now();
    const answers = await Promise.all(list.map(async (job, i) => {
      const h = this.makeHelper({
        port, model: this.swarm.id, cwd: this.cwd, roots: this.roots, nCtx: SWARM_SLOT_CTX, maxSteps: 10,
        toolNames: READ_ONLY, approve: async () => false,
        systemPrompt: `${SWARM_SYSTEM}

The project folder is ${this.cwd}. Relative paths start there; begin with list_dir or glob.`,
        sampling: { temperature: 0.3, top_p: 0.9 }, noThink: true,
      });
      const stop = () => { try { h.abort(); } catch { /* done */ } };
      if (signal) signal.addEventListener("abort", stop, { once: true });
      try {
        let r = await h.send(job);
        // Small models sometimes stop after their tool calls without a word: ask once for the answer.
        if (r && r.ok && !String(r.content || "").trim()) r = await h.send("Give your answer to the job now, in plain text.");
        const text = (r && r.content) || (r && r.error ? `ERROR: ${r.error}` : "(no answer)");
        this._say("swarm", "job", { index: i, ok: !!(r && r.ok) });
        return `### Job ${i + 1}: ${job.slice(0, 200)}\n${String(text).slice(0, 4000)}`;
      } catch (e) {
        return `### Job ${i + 1}: ${job.slice(0, 200)}\nERROR: ${e.message}`;
      } finally { if (signal) signal.removeEventListener("abort", stop); }
    }));
    this._say("swarm", "done", { ms: Date.now() - t0 });
    return answers.join("\n\n");
  }

  /** One advisor read. Returns its advice as text ("" when it could not be reached). */
  async advise(kind, text, messages, signal) {
    let port;
    // A model that will not load (memory, a format this engine cannot read) is skipped for the next candidate.
    try { port = await this._load("advisor", { ctx: ADVISOR_CTX, slots: 1, kind }); }
    catch (e) { this._say("advisor", "error", { kind, text: e.message }); return ""; }
    this._say("advisor", "start", { kind, model: this.advisor.id });
    const t0 = Date.now();
    const session = digest(messages);
    const ask = ADVICE_ASK[kind] + (text ? String(text).slice(0, 4000) : "");
    try {
      const res = await this.chat(port, {
        model: this.advisor.id,
        messages: [
          { role: "system", content: ADVISOR_SYSTEM },
          { role: "user", content: `The session so far:\n\n${session || "(nothing yet)"}\n\n---\n${ask}` },
        ],
        temperature: 0.4, top_p: 0.9, max_tokens: 6000, repeat_penalty: 1,
      }, null, 600000, 0, signal);
      const advice = String(res.content || "").trim();
      this._say("advisor", "done", { kind, ms: Date.now() - t0, text: advice.slice(0, 1500) });
      return advice;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      this._say("advisor", "error", { kind, text: e.message });
      return "";
    }
  }

  /** Checkpoint 1: before the lead starts a task. Returns a note to add to the person's message, or "". */
  async beforeTurn(text, messages, signal) {
    const advice = await this.advise("plan", text, messages, signal);
    return advice ? `[Advisor's plan, advice only; you decide and you do the work:\n${advice}]` : "";
  }

  /** Checkpoint 2: the same error twice. Returns a note to add to the tool results, or "". */
  async afterTools(results, messages, signal) {
    let repeated = null;
    for (const { name, out } of results) {
      const s = String(out || "");
      if (!s.startsWith("ERROR")) continue;
      const key = `${name}:${s.slice(0, 200)}`;
      const n = (this.errors.get(key) || 0) + 1;
      this.errors.set(key, n);
      if (n === 2) repeated = `${name}: ${s.slice(0, 1000)}`;
    }
    if (!repeated) return "";
    const advice = await this.advise("error", repeated, messages, signal);
    return advice ? `[Advisor, on the repeated error:\n${advice}]` : "";
  }

  /** Checkpoint 3: before done. Returns what to tell the lead, or "" when the advisor is satisfied. */
  async beforeDone(messages, signal) {
    const advice = await this.advise("done", "", messages, signal);
    if (!advice || LGTM.test(advice)) return "";
    return "[Advisor's review before you finish; fix what is real, then finish and say what you changed:\n" + advice + "]";
  }
}

module.exports = { BAD, Team, HelperServer, pick, helperRoom, helperNeed, digest, loadConfig, saveConfig, configFile, SCHEMAS, READ_ONLY, MAX_JOBS };
