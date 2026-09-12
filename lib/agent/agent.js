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

function buildSystem(opts) {
  const parts = [opts.systemPrompt || DEFAULT_SYSTEM];

  parts.push(`\nWorking directory: ${opts.cwd}`);

  if (opts.skillIndex && opts.skillIndex.length) {
    parts.push(
      `\n## Skills\n` +
      `Instructions available on demand. When one matches the task, call ` +
      `skill_load with its name before starting.\n` +
      opts.skillIndex.map((s) => `- ${s}`).join("\n"));
  }

  if (opts.mcpCount) {
    parts.push(
      `\n## MCP tools\n` +
      `${opts.mcpCount} tools are available from connected servers, but their ` +
      `schemas are not loaded. Call tool_search with keywords to get the ones ` +
      `you need, then invoke them with mcp_call.` +
      (opts.mcpIndexSample && opts.mcpIndexSample.length
        ? `\nServers: ${opts.mcpServers.join(", ")}`
        : ""));
  }

  return parts.join("\n");
}

/** Stream a chat completion, accumulating content and tool calls. */
function streamChat(port, body, onDelta, timeoutMs = 3600000, _retry = 0) {
  return new Promise((resolve, reject) => {
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
        if (res.statusCode >= 400) {
          return reject(new Error(`server returned ${res.statusCode}: ${content.slice(0, 300)}`));
        }
        resolve({
          content, reasoning, finish, timings,
          tool_calls: calls.filter(Boolean).filter((c) => c.function.name),
        });
      });
    });
    req.on("error", (e) => {
      // A connection dropped before any bytes arrived is safe to retry once.
      const transient = e.code === "ECONNRESET" || /socket hang up/i.test(e.message);
      if (transient && _retry < 2) {
        return setTimeout(
          () => streamChat(port, body, onDelta, timeoutMs, _retry + 1).then(resolve, reject),
          250 * (_retry + 1));
      }
      reject(new Error(`${e.message} (payload ${Buffer.byteLength(payload)} bytes, ` +
        `${(body.messages || []).length} messages)`));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("request timed out")); });
    req.end(payload);
  });
}

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
    this.temperature = o.temperature ?? 0.7;

    this.execute = tools.makeExecutor({
      cwd: this.cwd,
      mcp: this.mcp,
      skills: this.skills,
      approve: o.approve,
    });

    const skillIndex = require("./skills").index(this.skills);
    const mcpAll = this.mcp ? this.mcp.all() : [];
    this.system = buildSystem({
      cwd: this.cwd,
      systemPrompt: o.systemPrompt,
      skillIndex,
      mcpCount: mcpAll.length,
      mcpServers: this.mcp ? [...this.mcp.servers.keys()] : [],
      mcpIndexSample: mcpAll.slice(0, 5),
    });

    // Fixed for the life of the session: this is the cached prefix.
    this.toolSchemas = tools.SCHEMAS;
    this.messages = [{ role: "system", content: this.system }];
    this.stats = { steps: 0, toolCalls: 0, tokensOut: 0, tps: [] };
  }

  /** Tokens the fixed prefix costs — useful for showing the real budget. */
  overhead() {
    return ctxmod.estimate(this.system) + ctxmod.estimate(this.toolSchemas);
  }

  async send(userText) {
    this.messages.push({ role: "user", content: userText });
    return this.loop();
  }

  async loop() {
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
          top_p: 0.8,
          top_k: 20,
        }, (d) => this.onEvent(d));
      } catch (e) {
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
        const out = await this.execute(tc.function.name, args);
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
    }

    this.onEvent({ type: "error", text: `stopped after ${this.maxSteps} steps` });
    return { ok: false, error: "step limit reached", stats: this.stats };
  }
}

module.exports = { Agent, streamChat, buildSystem, DEFAULT_SYSTEM };
