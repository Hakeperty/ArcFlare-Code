// The agent loop.
//
// Everything here is shaped by one fact: the model is running on your own GPU
// at tens of tokens a second, and llama.cpp will reuse its prompt cache only
// for the longest unchanged prefix. So the prompt is built to be *append-only*:
// a fixed system message, a fixed tool array, and a conversation that only ever
// grows at the end. Discovered MCP tools and skill bodies arrive as tool
// results rather than being spliced into the prefix, because editing the prefix
// throws away the cache and re-reads the whole session.

const http = require("http");
const tools = require("./tools");

// Node 19+ turns on keep-alive in the global agent. llama.cpp's router closes
// idle upstream sockets, so a pooled socket is often already dead by the next
// turn and the reuse surfaces as "socket hang up". Localhost connection setup
// is free, so take a fresh socket every time.
const AGENT = new http.Agent({ keepAlive: false, maxSockets: 8 });
const ctxmod = require("./context");
const { resultToText } = require("./mcp");

const DEFAULT_SYSTEM = `You are ArcFlare, a coding agent running on a local model.

Work directly. Use tools rather than describing what you would do. Prefer
reading a file over guessing its contents, and prefer one targeted edit over
rewriting a file.

Keep replies short. The user sees your tool calls, so do not narrate them.`;

/**
 * The system prompt as named sections, so /context can say what each costs.
 * Order is fixed: base, project notes, skills, MCP — all stable for a session.
 */
function systemSections(opts) {
  const sec = { base: (opts.systemPrompt || DEFAULT_SYSTEM) + `\n\nWorking directory: ${opts.cwd}`, notes: "", skills: "", mcp: "" };

  if (opts.projectNotes && opts.projectNotes.trim()) {
    sec.notes =
      `## Project notes\n` +
      `Instructions this repository keeps for coding agents. Follow them.\n\n` +
      opts.projectNotes.trim();
  }

  if (opts.skillIndex && opts.skillIndex.length) {
    sec.skills = (
      `## Skills\n` +
      `Instructions available on demand. When one matches the task, call ` +
      `skill_load with its name before starting.\n` +
      opts.skillIndex.map((s) => `- ${s}`).join("\n"));
  }

  if (opts.mcpCount) {
    sec.mcp = (
      `## MCP tools\n` +
      `${opts.mcpCount} tools are available from connected servers, but their ` +
      `schemas are not loaded. Call tool_search with keywords to get the ones ` +
      `you need, then invoke them with mcp_call.` +
      (opts.mcpIndexSample && opts.mcpIndexSample.length
        ? `\nServers: ${opts.mcpServers.join(", ")}`
        : ""));
  }

  return sec;
}

function buildSystem(opts) {
  const sec = systemSections(opts);
  return [sec.base, sec.notes, sec.skills, sec.mcp].filter(Boolean).join("\n\n");
}

/** Stream a chat completion, accumulating content and tool calls. */
function streamChat(port, body, onDelta, timeoutMs = 3600000, _retry = 0, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError({ content: "", reasoning: "" }));
    let partial = { content: "", reasoning: "" };
    const payload = JSON.stringify({ ...body, stream: true });
    if (process.env.ARCFLARE_DEBUG) {
      try {
        require("fs").writeFileSync(
          require("path").join(require("os").tmpdir(), "arcflare-last-request.json"), payload);
      } catch {}
    }
    const req = http.request({
      host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
      timeout: timeoutMs,
      agent: AGENT,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "close",
      },
    }, (res) => {
      let buf = "";
      let content = "";
      let reasoning = "";
      const calls = [];
      let finish = null;
      let timings = null;

      partial = { get content() { return content; }, get reasoning() { return reasoning; } };
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") continue;
          let j;
          try { j = JSON.parse(raw); } catch { continue; }
          if (j.timings) timings = j.timings;
          const ch = j.choices && j.choices[0];
          if (!ch) continue;
          if (ch.finish_reason) finish = ch.finish_reason;
          const d = ch.delta || {};
          if (d.reasoning_content) {
            reasoning += d.reasoning_content;
            if (onDelta) onDelta({ type: "reasoning", text: d.reasoning_content });
          }
          if (d.content) {
            content += d.content;
            if (onDelta) onDelta({ type: "content", text: d.content });
          }
          for (const tc of d.tool_calls || []) {
            const idx = tc.index ?? 0;
            calls[idx] = calls[idx] || { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) calls[idx].id = tc.id;
            if (tc.function) {
              if (tc.function.name) calls[idx].function.name += tc.function.name;
              if (tc.function.arguments) calls[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      });
      res.on("end", () => {
        if (signal && signal.aborted) return;
        if (res.statusCode >= 400) {
          return reject(new Error(`server returned ${res.statusCode}: ${content.slice(0, 300)}`));
        }
        resolve({
          content, reasoning, finish, timings,
          tool_calls: calls.filter(Boolean).filter((c) => c.function.name),
        });
      });
    });
    // Ctrl+C: drop the connection (llama.cpp stops generating when the client
    // goes away) and hand back what had streamed so far.
    const onAbort = () => { req.destroy(); reject(abortError({ content: partial.content, reasoning: partial.reasoning })); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => { if (signal) signal.removeEventListener("abort", onAbort); });
    req.on("error", (e) => {
      if (signal && signal.aborted) return;
      // A connection dropped before any bytes arrived is safe to retry once.
      const transient = e.code === "ECONNRESET" || /socket hang up/i.test(e.message);
      if (transient && _retry < 2) {
        return setTimeout(
          () => streamChat(port, body, onDelta, timeoutMs, _retry + 1, signal).then(resolve, reject),
          250 * (_retry + 1));
      }
      reject(new Error(`${e.message} (payload ${Buffer.byteLength(payload)} bytes, ` +
        `${(body.messages || []).length} messages)`));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("request timed out")); });
    req.end(payload);
  });
}

function abortError(partial) {
  const e = new Error("interrupted");
  e.name = "AbortError";
  e.partial = partial;
  return e;
}

const INTERRUPTED_NOTE = "[interrupted by the user]";

class Agent {
  /**
   * @param {object} o
   * @param {number} o.port        llama-server port
   * @param {string} o.model       served model id
   * @param {string} o.cwd
   * @param {object} o.mcp         McpRegistry or null
   * @param {Array}  o.skills      discovered skills
   * @param {number} o.nCtx        context window
   * @param {function} o.onEvent   UI callback
   * @param {function} o.approve   async (kind, detail) => boolean
   * @param {string}   [o.projectNotes]  AGENTS.md and friends, for the prompt
   * @param {object}   [o.checkpoints]   a Checkpoints, to make edits undoable
   */
  constructor(o) {
    this.port = o.port;
    this.model = o.model;
    this.cwd = o.cwd || process.cwd();
    this.mcp = o.mcp || null;
    this.skills = o.skills || [];
    this.nCtx = o.nCtx || 32768;
    this.onEvent = o.onEvent || (() => {});
    this.maxSteps = o.maxSteps || 40;
    // Qwen3-class models publish the sampling they were tuned for, and their
    // thinking and non-thinking presets differ (top_p 0.95 vs 0.8). These
    // models think, so the non-thinking preset costs output quality. Prefer
    // what the file declares; fall back only when it declares nothing.
    const rec = o.sampling || {};
    this.temperature = o.temperature ?? rec.temperature ?? 0.7;
    this.topP = rec.top_p ?? 0.8;
    this.topK = rec.top_k ?? 20;
    this.minP = rec.min_p;

    this.checkpoints = o.checkpoints || null;
    this.pendingNote = "";
    this._ctl = null;

    this.execute = tools.makeExecutor({
      cwd: this.cwd,
      mcp: this.mcp,
      skills: this.skills,
      approve: o.approve,
      // Read through `this`, so /clear or /resume can swap the checkpoints.
      onBeforeWrite: (f) => { if (this.checkpoints) this.checkpoints.record(f); },
    });

    this._systemOpts = {
      cwd: this.cwd,
      systemPrompt: o.systemPrompt,
      projectNotes: o.projectNotes || "",
      skillIndex: require("./skills").index(this.skills),
      mcpCount: this.mcp ? this.mcp.all().length : 0,
      mcpServers: this.mcp ? [...this.mcp.servers.keys()] : [],
      mcpIndexSample: this.mcp ? this.mcp.all().slice(0, 5) : [],
    };
    this.system = buildSystem(this._systemOpts);

    // Fixed for the life of the session: this is the cached prefix.
    this.toolSchemas = tools.SCHEMAS;
    this.messages = [{ role: "system", content: this.system }];
    this.stats = { steps: 0, toolCalls: 0, tokensOut: 0, tps: [] };
  }

  /** Is a turn running? */
  get busy() { return !!this._ctl; }

  /** Stop the turn in progress (Ctrl+C). Safe to call when idle. */
  abort() {
    if (this._ctl) this._ctl.abort();
  }

  /**
   * Start over: an empty conversation after a freshly built prefix (project
   * notes are re-read by the caller and passed in). The one moment the prefix
   * may change, since the cache is being thrown away anyway.
   */
  reset(opts = {}) {
    if (opts.projectNotes !== undefined) this._systemOpts.projectNotes = opts.projectNotes;
    this.system = buildSystem(this._systemOpts);
    this.messages = [{ role: "system", content: this.system }];
    this.pendingNote = "";
    this.stats = { steps: 0, toolCalls: 0, tokensOut: 0, tps: [] };
  }

  /** Continue a saved conversation after today's prefix. */
  loadConversation(messages) {
    this.messages = [{ role: "system", content: this.system }, ...(messages || []).filter((m) => m.role !== "system")];
  }

  /** The conversation without the system message, for saving. */
  conversation() {
    return this.messages.slice(1);
  }

  /** Token cost of each part of the prompt, for /context. */
  usage() {
    const sec = systemSections(this._systemOpts);
    return {
      system: ctxmod.estimate(sec.base),
      notes: sec.notes ? ctxmod.estimate(sec.notes) : 0,
      skills: sec.skills ? ctxmod.estimate(sec.skills) : 0,
      mcp: sec.mcp ? ctxmod.estimate(sec.mcp) : 0,
      tools: ctxmod.estimate(this.toolSchemas),
      conversation: ctxmod.totalTokens(this.messages.slice(1)),
      window: this.nCtx,
    };
  }

  /** Tokens the fixed prefix costs — useful for showing the real budget. */
  overhead() {
    return ctxmod.estimate(this.system) + ctxmod.estimate(this.toolSchemas);
  }

  async send(userText) {
    // Something the model should know but nobody said, e.g. an /undo.
    const text = this.pendingNote ? `${this.pendingNote}\n\n${userText}` : userText;
    this.pendingNote = "";
    this.messages.push({ role: "user", content: text });
    this._ctl = new AbortController();
    try {
      return await this.loop(this._ctl.signal);
    } finally {
      this._ctl = null;
    }
  }

  async loop(signal = null) {
    const budget = ctxmod.planBudget(this.nCtx).promptBudget;

    for (let step = 0; step < this.maxSteps; step++) {
      this.stats.steps++;

      // Keep the conversation inside the window, disturbing the front last.
      const fit = ctxmod.compact(this.messages, budget - this.overhead());
      if (fit.changed) {
        this.messages = fit.messages;
        this.onEvent({ type: "compact", actions: fit.actions });
      }

      let res;
      try {
        res = await streamChat(this.port, {
          model: this.model,
          messages: this.messages,
          tools: this.toolSchemas,
          tool_choice: "auto",
          temperature: this.temperature,
          top_p: this.topP,
          top_k: this.topK,
          ...(this.minP === undefined ? {} : { min_p: this.minP }),
        }, (d) => this.onEvent(d), undefined, 0, signal);
      } catch (e) {
        if (e.name === "AbortError") {
          // Keep what was said so far, marked, so the next turn makes sense.
          const said = (e.partial && e.partial.content) || "";
          this.messages.push({ role: "assistant", content: said ? `${said}\n\n${INTERRUPTED_NOTE}` : INTERRUPTED_NOTE });
          this.onEvent({ type: "interrupted" });
          return { ok: false, aborted: true, stats: this.stats };
        }
        this.onEvent({ type: "error", text: e.message });
        return { ok: false, error: e.message };
      }

      if (res.timings && res.timings.predicted_per_second) {
        this.stats.tps.push(res.timings.predicted_per_second);
      }
      this.stats.tokensOut += res.timings ? (res.timings.predicted_n || 0) : 0;

      const assistant = { role: "assistant", content: res.content || "" };
      if (res.tool_calls.length) assistant.tool_calls = res.tool_calls;
      this.messages.push(assistant);

      if (!res.tool_calls.length) {
        this.onEvent({ type: "done", text: res.content });
        return { ok: true, content: res.content, stats: this.stats };
      }

      // Independent calls run together; the model gets them back in order.
      const results = await Promise.all(res.tool_calls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); }
        catch { return { tc, out: "ERROR: arguments were not valid JSON" }; }
        this.onEvent({ type: "tool", name: tc.function.name, args });
        this.stats.toolCalls++;
        const out = await this.execute(tc.function.name, args, { signal });
        this.onEvent({ type: "tool_result", name: tc.function.name, out });
        return { tc, out };
      }));

      for (const { tc, out } of results) {
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id || tc.function.name,
          content: String(out ?? ""),
        });
      }

      // Interrupted while tools ran: every call has its answer (some of them
      // "interrupted"), and an assistant line closes the turn so the next user
      // message follows an assistant one, as every chat template expects.
      if (signal && signal.aborted) {
        this.messages.push({ role: "assistant", content: INTERRUPTED_NOTE });
        this.onEvent({ type: "interrupted" });
        return { ok: false, aborted: true, stats: this.stats };
      }
    }

    this.onEvent({ type: "error", text: `stopped after ${this.maxSteps} steps` });
    return { ok: false, error: "step limit reached", stats: this.stats };
  }
}

module.exports = { Agent, streamChat, buildSystem, systemSections, DEFAULT_SYSTEM, INTERRUPTED_NOTE };
