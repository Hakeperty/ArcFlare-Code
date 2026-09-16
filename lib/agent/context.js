// Context budgeting.
//
// A local model's context is a hard wall and its prefill is slow, so the two
// jobs here are: never exceed the window, and disturb the *front* of the
// conversation as little as possible. llama.cpp caches the longest common
// prefix of a prompt; if we rewrite early messages, that cache is thrown away
// and the whole conversation is reprocessed. So compaction works strictly from
// the oldest reclaimable message forward, and leaves the system prompt and the
// most recent turns untouched.

const http = require("http");

/** Cheap token estimate. Good enough for budgeting; ~4 chars/token in code. */
function estimate(text) {
  if (!text) return 0;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return Math.ceil(s.length / 3.6);
}

function messageTokens(m) {
  let n = 4; // role + framing overhead
  if (typeof m.content === "string") n += estimate(m.content);
  else if (m.content) n += estimate(m.content);
  if (m.tool_calls) n += estimate(m.tool_calls);
  return n;
}

function totalTokens(messages) {
  return messages.reduce((a, m) => a + messageTokens(m), 0);
}

/** Exact count from the server when we can afford one round trip. */
function countTokens(port, text, timeout = 10000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: text });
    const req = http.request({
      host: "127.0.0.1", port, path: "/tokenize", method: "POST", timeout,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => {
        try {
          const j = JSON.parse(out);
          resolve(Array.isArray(j.tokens) ? j.tokens.length : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

/**
 * Shrink a conversation to fit `budget` tokens.
 *
 * Tool results are the bulk of a coding session and the least valuable to keep
 * verbatim, so they are truncated first, oldest first. Only if that is not
 * enough do whole turns get dropped, and the system prompt and the last
 * `keepRecent` messages are never touched.
 */
function compact(messages, budget, opts = {}) {
  const keepRecent = opts.keepRecent ?? 6;
  const stub = opts.stub ?? 220;
  const out = messages.map((m) => ({ ...m }));
  let used = totalTokens(out);
  if (used <= budget) return { messages: out, used, changed: false, actions: [] };

  const actions = [];
  const lastIdx = out.length - 1;
  const protectedFrom = Math.max(1, lastIdx - keepRecent + 1);

  // Pass 1: squeeze old tool results.
  for (let i = 1; i < protectedFrom && used > budget; i++) {
    const m = out[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    if (m.content.length <= stub) continue;
    const before = messageTokens(m);
    const dropped = m.content.length - stub;
    m.content = m.content.slice(0, stub) +
      `\n… [${dropped} characters trimmed to fit context; re-run the tool if you need them]`;
    used -= before - messageTokens(m);
    actions.push(`trimmed tool result #${i}`);
  }

  // Pass 2: drop whole old turns, oldest first.
  //
  // An assistant message and the tool results answering it are one unit. Drop
  // the call but keep its result and you get a `tool` message with nothing it
  // answers: llama-server accepts it (measured), but the model is handed a
  // result it never asked for, and stricter OpenAI-compatible servers reject
  // the request outright. So a dropped call takes its results with it, and the
  // bound is recomputed as the array shrinks rather than read from a stale
  // index.
  let i = 1;
  while (used > budget && i < Math.max(1, out.length - keepRecent)) {
    const m = out[i];
    if (m.role === "system") { i++; continue; }
    let span = 1;
    const ids = new Set((m.tool_calls || []).map((t) => t.id).filter(Boolean));
    if (m.tool_calls) {
      while (i + span < out.length && out[i + span].role === "tool" &&
             (!out[i + span].tool_call_id || ids.has(out[i + span].tool_call_id))) {
        span++;
      }
    }
    for (let k = 0; k < span; k++) used -= messageTokens(out[i + k]);
    out.splice(i, span);
    actions.push(span > 1
      ? `dropped an early call and its ${span - 1} result(s)`
      : "dropped an early message");
    // splice shifted everything left; do not advance i
  }

  // Whatever the passes above did, a tool result with no surviving call is
  // context spent on something the model cannot interpret. Drop any that
  // remain - compaction is running precisely because context is scarce.
  for (let j = out.length - 1; j >= 0; j--) {
    if (out[j].role !== "tool") continue;
    // One call can be answered by several results, so the owning assistant
    // sits before this run of tool messages, not necessarily right behind it.
    let k = j - 1;
    while (k >= 0 && out[k].role === "tool") k--;
    const call = out[k];
    const answered = call && call.role === "assistant" && call.tool_calls &&
      (!out[j].tool_call_id ||
        call.tool_calls.some((t) => t.id === out[j].tool_call_id));
    if (!answered) {
      used -= messageTokens(out[j]);
      out.splice(j, 1);
      actions.push("dropped an orphaned tool result");
    }
  }

  return { messages: out, used, changed: actions.length > 0, actions };
}

/**
 * How much room is left for generation.
 * Reserve headroom so a long reply cannot run into the wall mid-sentence.
 */
function planBudget(nCtx, reserveForReply = 4096) {
  const usable = Math.max(2048, nCtx - reserveForReply);
  return { nCtx, reserveForReply, promptBudget: usable };
}

module.exports = { estimate, messageTokens, totalTokens, countTokens, compact, planBudget };
