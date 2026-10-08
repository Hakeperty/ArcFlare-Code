// `arcflare fit` — which of the models you already have actually runs best here.
//
// Two questions that cost wildly different amounts to answer. What *fits* is
// arithmetic over a GGUF header and the free VRAM: every model, in a few
// milliseconds, without loading anything. What *runs best* can only be answered
// by loading each model and timing it, which costs minutes per model and evicts
// whatever was resident. So `fit` answers the first every time and the second
// only when asked, then remembers it — a number that took four minutes to
// measure should not have to be measured again to be read.
//
// What is measured: time to load, prefill throughput on a 4k prompt the cache
// has never seen, generation throughput, and five probes.
//
// What is *not* measured is quality in any general sense. Five probes cannot
// rank models on how well they write code, and pretending otherwise would be
// the most useful-looking and least true thing this file could do. They catch
// something narrower and still worth catching: a model that has stopped doing
// the things a harness needs of it — obeying an exact output format, emitting
// clean JSON, arithmetic, writing a function that actually runs, and finding a
// fact 4k tokens back. A model that fails those is unusable at any speed, which
// is why the recommendation is *gated* on them rather than scored against them.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");

const gguf = require("./gguf");
const ui = require("./ui");

const { c } = ui;
const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const RESULTS = path.join(HOME, "fit.json");
const SCHEMA = 1;

// llama.cpp's router closes idle upstream sockets, so a pooled socket is often
// already dead by the next request — the same lesson the agent learned as
// "socket hang up" on every turn after the first.
const AGENT = new http.Agent({ keepAlive: false, maxSockets: 4 });

// ---------------------------------------------------------------- static ----

// Weights are not the whole cost of a loaded model: compute buffers, the
// physical batch and the runtime itself want their share before the KV cache
// gets any. The same 1.5 GB the context picker holds back, for the same reason.
const OVERHEAD = 1.5e9;

/**
 * What a model would do on this device, from its header alone.
 *
 * Deliberately pessimistic in one direction only: it reports the context the
 * arithmetic supports, and the loader still verifies by loading. Predicting
 * "fits" and meeting ErrorOutOfDeviceMemory is a worse failure than predicting
 * "tight" and finding it comfortable.
 */
function staticFit(model, budgetBytes, opts = {}) {
  const meta = model.meta || {};
  const cacheType = opts.cacheType || "f16";
  const perTok = gguf.kvBytesPerToken(meta, cacheType);
  const trainCtx = meta.trainCtx || null;
  const spare = budgetBytes - model.size - OVERHEAD;
  const maxCtx = perTok && spare > 0 ? gguf.maxContextFor(meta, spare, cacheType) : null;

  let verdict;
  if (spare <= 0) verdict = "no";
  else if (!perTok || !trainCtx || !maxCtx) verdict = "unknown";
  else if (maxCtx >= trainCtx) verdict = "full";
  else if (maxCtx >= 32768) verdict = "ok";
  else verdict = "tight";

  // What the cache for that context actually costs, and what is left after it.
  // Reporting the room *before* the KV cache as "to spare" reads as headroom
  // the model does not have: on a 36 GB Q8 at 256K, 5.4 GB of that spare is
  // already spoken for by the cache the same line just promised.
  const kvBytes = perTok && maxCtx ? perTok * maxCtx : null;
  const headroom = kvBytes == null ? null : Math.max(0, spare - kvBytes);

  return {
    id: model.id,
    size: model.size,
    trainCtx,
    perTok,
    maxCtx,
    kvBytes,
    headroom,
    spare: Math.max(0, spare),
    verdict,
    note: staticNote(verdict, maxCtx, trainCtx, kvBytes, headroom),
  };
}

function staticNote(verdict, maxCtx, trainCtx, kvBytes, headroom) {
  switch (verdict) {
    case "no": return "weights alone do not fit";
    case "full": return `full ${ui.fmtTokens(trainCtx)} context — ` +
      `${ui.fmtBytes(kvBytes)} of cache, ${ui.fmtBytes(headroom)} left over`;
    case "ok": return `up to ${ui.fmtTokens(maxCtx)} of ${ui.fmtTokens(trainCtx)}`;
    case "tight": return `only ${ui.fmtTokens(maxCtx)} — little room left`;
    default: return "header too incomplete to say";
  }
}

// ---------------------------------------------------------------- probes ----

// Planted in the long prompt and asked for afterwards. A model that prefills 4k
// tokens quickly and cannot then tell you what was in them has not read them.
const NEEDLE = "FLARE-7742";

function stripFence(text) {
  const m = /```[a-z0-9]*\r?\n([\s\S]*?)```/i.exec(text || "");
  return m ? m[1] : (text || "");
}

/**
 * The first balanced {...} in the text, parsed.
 *
 * Brace counting ignores braces inside strings, which for a two-key object is a
 * distinction without a difference — a model whose answer needs the subtlety
 * has already failed the probe it was being asked.
 */
function firstJson(text) {
  const src = stripFence(text);
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Does the model's `add` actually add?
 *
 * Run in a fresh V8 context, which has the language built-ins and nothing else:
 * no require, no process, no timers, no filesystem. The snippet can compute and
 * that is all, and the timeout ends a loop that otherwise never would. Grading
 * by looking for `a + b` in the text instead would pass a function that returns
 * a string, and fail one that is merely written differently.
 */
function runsAdd(text) {
  const code = stripFence(text);
  if (!/\badd\b/.test(code)) return false;
  try {
    const sandbox = vm.createContext(Object.create(null));
    vm.runInContext(
      `${code}\n;globalThis.__out = [add(2, 3), add(-1, 1), add(0.5, 0.25)];`,
      sandbox,
      { timeout: 1000, displayErrors: false },
    );
    const out = sandbox.__out;
    return Array.isArray(out) && out[0] === 5 && out[1] === 0 && out[2] === 0.75;
  } catch {
    return false;
  }
}

// How much room a probe gets, relative to the run's cap. Writing a function is
// the one that reliably needs more: measured on three Qwen3.6 quants, all three
// were still thinking about `add(a, b)` at 768 tokens while answering every
// other probe inside it.
const PROBES = [
  {
    name: "format",
    why: "obeys an exact output shape",
    prompt: "Reply with exactly one word and nothing else: the capital of France.",
    grade: (t) => /^\W*paris\b/i.test(String(t).trim()),
  },
  {
    name: "json",
    why: "emits clean JSON — what every tool call is made of",
    prompt: 'Return only a JSON object, with no prose and no code fence, with ' +
      'keys "sum" and "product" holding those operations applied to 7 and 6.',
    grade: (t) => {
      const j = firstJson(t);
      return Boolean(j) && Number(j.sum) === 13 && Number(j.product) === 42;
    },
  },
  {
    name: "maths",
    why: "arithmetic it cannot pattern-match",
    prompt: "What is 17 * 23? Reply with the number only.",
    grade: (t) => /\b391\b/.test(String(t)),
  },
  {
    name: "code",
    why: "writes a function that runs",
    prompt: "Write a JavaScript function `add(a, b)` that returns their sum. " +
      "Output only the code.",
    budget: 2,
    grade: runsAdd,
  },
];

/** The fifth probe. It needs the long prompt, so it is run separately. */
const RECALL = {
  name: "recall",
  why: "can still find one line 4k tokens back",
  grade: (t) => String(t).includes(NEEDLE),
};

/**
 * A long prompt the prompt cache has never seen.
 *
 * The nonce goes first on purpose. llama.cpp reuses its cache for the longest
 * unchanged *prefix*, so a nonce at the end would leave the whole prompt cached
 * and measure prefill at a few thousand tokens a second — a beautiful number
 * that measures nothing. The needle sits about 60% in, away from both ends,
 * where a model cannot find it without having read the middle.
 */
function fillerPrompt(approxTokens, nonce) {
  const line = "The supply run left at dawn and the crates were counted twice before loading. ";
  const perLine = Math.ceil(line.length / 4); // ~4 characters to a token
  const lines = Math.max(8, Math.ceil(approxTokens / perLine));
  const at = Math.floor(lines * 0.6);
  const out = [`Session ${nonce}. Read the following log, then answer the question after it.`, ""];
  for (let i = 0; i < lines; i++) {
    out.push(i === at
      ? `Entry ${i}: the magic word is ${NEEDLE}, recorded by the quartermaster.`
      : `Entry ${i}: ${line}`);
  }
  return out.join("\n");
}

// ------------------------------------------------------------- measuring ----

/**
 * One streamed completion, timed.
 *
 * llama.cpp reports its own `timings` in the stream, measured inside the server
 * and free of HTTP overhead, so those win wherever they are present. The wall
 * clock is kept as the fallback for builds that send none: time to first token
 * is the prefill, and everything after it is generation.
 */
function streamChat(port, body, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...body, stream: true });
    const t0 = Date.now();
    let ttftMs = null;
    let deltas = 0;
    let content = "";
    let reasoning = "";
    let finish = null;
    let timings = null;

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
          const ch = (j.choices || [])[0];
          if (!ch) continue;
          if (ch.finish_reason) finish = ch.finish_reason;
          const d = ch.delta || {};
          const piece = d.content || d.reasoning_content || "";
          if (piece) {
            // The first token out is the end of prefill. Reasoning counts: the
            // GPU did the same work to produce it.
            if (ttftMs == null) ttftMs = Date.now() - t0;
            deltas++;
          }
          if (d.content) content += d.content;
          if (d.reasoning_content) reasoning += d.reasoning_content;
        }
      });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`server returned ${res.statusCode}`));
        }
        resolve({
          content, reasoning, finish, timings, deltas,
          ttftMs: ttftMs == null ? Date.now() - t0 : ttftMs,
          totalMs: Date.now() - t0,
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timed out")); });
    req.end(payload);
  });
}

/** Prefill rate: the server's own timings if it sent any, the wall clock if not. */
function prefillRate(res, promptTokens) {
  const t = (res && res.timings) || {};
  if (t.prompt_n && t.prompt_per_second) {
    return { tokPerSec: t.prompt_per_second, tokens: t.prompt_n, from: "server" };
  }
  if (t.prompt_n && t.prompt_ms) {
    return { tokPerSec: (t.prompt_n / t.prompt_ms) * 1000, tokens: t.prompt_n, from: "server" };
  }
  if (promptTokens && res && res.ttftMs > 0) {
    return { tokPerSec: (promptTokens / res.ttftMs) * 1000, tokens: promptTokens, from: "wall" };
  }
  return { tokPerSec: null, tokens: promptTokens || null, from: null };
}

/**
 * Generation rate.
 *
 * The wall-clock fallback divides by the time *after* the first token, not by
 * the whole request: folding prefill into a generation number makes a model
 * that was given a long prompt look slow at generating, which is a different
 * fact about a different thing.
 */
function genRate(res) {
  const t = (res && res.timings) || {};
  if (t.predicted_n && t.predicted_per_second) {
    return { tokPerSec: t.predicted_per_second, tokens: t.predicted_n, from: "server" };
  }
  if (t.predicted_n && t.predicted_ms) {
    return { tokPerSec: (t.predicted_n / t.predicted_ms) * 1000, tokens: t.predicted_n, from: "server" };
  }
  const after = res ? res.totalMs - res.ttftMs : 0;
  if (res && res.deltas > 1 && after > 0) {
    return { tokPerSec: ((res.deltas - 1) / after) * 1000, tokens: res.deltas, from: "wall" };
  }
  return { tokPerSec: null, tokens: (res && res.deltas) || null, from: null };
}

/** Ask the server to count tokens, for builds that report no timings. */
function tokenize(port, text, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ content: text });
    const req = http.request({
      host: "127.0.0.1", port, path: "/tokenize", method: "POST",
      timeout: timeoutMs,
      agent: AGENT,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "close",
      },
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
    req.end(payload);
  });
}

/**
 * Measure one model that is already loaded and serving.
 *
 * `chat` is injectable so the whole sequence can be tested without a GPU: what
 * gets asked and how the answers are judged is the interesting logic here, and
 * it should not take 30 GB of weights to exercise it.
 */
async function measure(opts) {
  const {
    port, id, quick = false, probes = true,
    chat = streamChat, count = tokenize, onStep = () => {},
  } = opts;

  const row = { id, at: Date.now(), quick };
  const cap = quick ? 256 : 768;
  const nonce = Math.random().toString(36).slice(2, 10);
  const long = fillerPrompt(quick ? 2048 : 4096, nonce);

  // 1. Prefill, on a prompt nothing has cached.
  onStep("prefill");
  const pre = await chat(port, {
    model: id,
    messages: [{ role: "user", content: `${long}\n\nReply with the single word OK.` }],
    max_tokens: 1,
    temperature: 0,
  });
  let promptTokens = (pre.timings && pre.timings.prompt_n) || null;
  if (!promptTokens) promptTokens = await count(port, long);
  row.prefill = prefillRate(pre, promptTokens);
  row.ttftMs = pre.ttftMs;

  // 2. Generation. Temperature 0, so a second run measures the machine rather
  //    than the dice.
  onStep("generation");
  const gen = await chat(port, {
    model: id,
    messages: [{ role: "user", content:
      "Write one plain paragraph about why local inference is useful. No lists, no headings." }],
    max_tokens: quick ? 96 : 192,
    temperature: 0,
  });
  row.gen = genRate(gen);

  // 3. Probes.
  if (probes) {
    const run = (probe, content) => askProbe(chat, port, id, probe, content, cap);
    const results = [];
    for (const p of PROBES) {
      onStep(`probe ${p.name}`);
      results.push(await run(p, p.prompt));
    }
    // Recall rides on the long prompt, which step 1 left in the cache — so it
    // costs generation only, not another 4k of prefill.
    onStep("probe recall");
    results.push(await run(RECALL,
      `${long}\n\nWhat is the magic word? Reply with it and nothing else.`));
    row.probes = summarise(results);
  }
  return row;
}

/**
 * Ask one probe, and give a model that ran out of room a second chance.
 *
 * These models think before they answer, and thinking is charged to the same
 * budget as the answer. The first run of this measured three Qwen3.6 quants at
 * 4 of 5 probes, all three missing the same one — not because they cannot write
 * `add(a, b)` but because 768 tokens ran out while they were still reasoning
 * about it. A cap that decides the verdict is measuring the cap.
 *
 * So truncation buys one retry at triple the room. That makes the cap a
 * decision about how long the run takes rather than about what it concludes,
 * and a model that is still going after three times the budget has told us
 * something real about itself.
 */
async function askProbe(chat, port, id, probe, content, cap) {
  const budget = Math.round(cap * (probe.budget || 1));
  const first = await chat(port, {
    model: id,
    messages: [{ role: "user", content }],
    max_tokens: budget,
    temperature: 0,
  });
  const verdict = judge(probe, first);
  if (!verdict.truncated) return verdict;

  const again = await chat(port, {
    model: id,
    messages: [{ role: "user", content }],
    max_tokens: budget * 3,
    temperature: 0,
  });
  return { ...judge(probe, again), retried: true, firstBudget: budget };
}

/**
 * Judge one probe answer.
 *
 * A model still mid-thought when it hit the cap did not fail the probe, it ran
 * out of room — a different thing, reported as a different thing. Scoring it as
 * a failure would quietly rank thinking models below models that answer badly
 * but promptly.
 */
function judge(probe, res) {
  const text = (res && res.content) || "";
  const truncated = Boolean(res && res.finish === "length" && !text.trim());
  return {
    name: probe.name,
    why: probe.why,
    pass: truncated ? false : Boolean(probe.grade(text)),
    truncated,
    answer: text.trim().slice(0, 120),
  };
}

function summarise(results) {
  return {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    truncated: results.filter((r) => r.truncated).length,
    failed: results.filter((r) => !r.pass).map((r) => r.name),
    detail: results,
  };
}

// --------------------------------------------------------------- ranking ----

const usable = (r) => Boolean(r && !r.error && r.gen && typeof r.gen.tokPerSec === "number");

function bestBy(rows, value) {
  let best = null;
  for (const r of rows) {
    const v = value(r);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!best || v > best.value) best = { row: r, value: v };
  }
  return best;
}

/**
 * Winners per axis, and one recommendation.
 *
 * The recommendation is a rule, not a score: of the models that answered every
 * probe, the fastest at generating. Weighting tokens per second against a
 * five-probe pass rate would produce a single number that looks authoritative
 * and encodes nothing but the weights whoever wrote it happened to pick — and
 * it would cheerfully recommend a model that cannot emit JSON on the grounds
 * that it cannot emit JSON quickly. When nothing passes everything the rule
 * says so, rather than promoting the least-bad model in silence.
 */
function rank(rowList) {
  const rows = (rowList || []).filter(usable);
  if (!rows.length) return null;

  const fastest = bestBy(rows, (r) => r.gen.tokPerSec);
  const prefill = bestBy(rows, (r) => r.prefill && r.prefill.tokPerSec);
  const context = bestBy(rows, (r) => r.ctx);
  // Probes first, speed only to break a tie between equals.
  const quality = bestBy(rows, (r) => (r.probes ? r.probes.passed * 1e6 + r.gen.tokPerSec : null));

  const clean = rows.filter((r) => r.probes && r.probes.passed === r.probes.total);
  const recommended = clean.length
    ? bestBy(clean, (r) => r.gen.tokPerSec)
    : bestBy(rows, (r) => (r.probes ? r.probes.passed * 1e6 : 0) + r.gen.tokPerSec);

  return {
    fastest, prefill, context, quality, recommended,
    clean: clean.length,
    why: clean.length
      ? `fastest of the ${clean.length} that answered every probe`
      : "nothing answered every probe — this is the closest, on probes then speed",
  };
}

// ----------------------------------------------------------- persistence ----

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
    if (j && j.schema === SCHEMA && j.rows) return j;
  } catch { /* nothing measured yet is the normal case, not an error */ }
  return { schema: SCHEMA, at: null, rows: {} };
}

function save(db) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(RESULTS, JSON.stringify({ ...db, schema: SCHEMA }, null, 2) + "\n");
    return true;
  } catch { return false; }
}

function record(db, row) {
  db.rows[row.id] = row;
  db.at = Date.now();
  return db;
}

/** Measurements for the models that still exist, flagged if the file changed. */
function rowsFor(db, models) {
  const out = [];
  for (const m of models) {
    const r = db.rows[m.id];
    if (!r) continue;
    // A file that changed size is a different model wearing the same name.
    out.push({ ...r, stale: typeof r.size === "number" && r.size !== m.size });
  }
  return out;
}

function clear() {
  try { fs.unlinkSync(RESULTS); return true; } catch { return false; }
}

// ------------------------------------------------------------ formatting ----

function fmtRate(n, unit = "tok/s") {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${unit}`;
}

function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

/** Left-aligned columns sized to their contents. Colour is applied afterwards. */
function columns(rows) {
  if (!rows.length) return [];
  const w = [];
  for (const r of rows) {
    r.forEach((cell, i) => { w[i] = Math.max(w[i] || 0, String(cell).length); });
  }
  return rows.map((r) => r
    .map((cell, i) => (i === r.length - 1 ? String(cell) : String(cell).padEnd(w[i])))
    .join("  "));
}

const MARKS = {
  full: () => c.green("+"),
  ok: () => c.green("+"),
  tight: () => c.accent("!"),
  no: () => c.red("x"),
  unknown: () => c.dim("."),
};

function renderStatic(fits, budget, extra = "") {
  const lines = [
    ui.section("what fits", ui.fmtBytes(budget) + " free" + (extra ? " · " + extra : "")),
    "",
  ];
  const body = columns(fits.map((f) => [
    f.id,
    ui.fmtBytes(f.size),
    f.perTok ? `${Math.round(f.perTok / 1024)} KiB/tok` : "—",
    f.maxCtx ? ui.fmtTokens(f.maxCtx) : "—",
    f.note,
  ]));
  fits.forEach((f, i) => {
    const mark = (MARKS[f.verdict] || MARKS.unknown)();
    const cells = body[i].split("  ");
    lines.push(`  ${mark} ${c.accent(cells[0])}  ${c.dim(cells.slice(1).join("  "))}`);
  });
  return lines;
}

function renderMeasured(rows) {
  if (!rows.length) {
    return ["", `  ${c.dim("nothing measured yet — ")}${c.accent("arcflare fit --run")}` +
      `${c.dim(" loads each model and times it")}`];
  }
  const sorted = [...rows].sort((a, b) =>
    ((b.gen && b.gen.tokPerSec) || 0) - ((a.gen && a.gen.tokPerSec) || 0));
  const lines = ["", ui.section("what runs best", sorted.length + " measured"), ""];
  const body = columns(sorted.map((r) => [
    r.id,
    fmtDuration(r.loadMs),
    r.prefill ? fmtRate(r.prefill.tokPerSec) : "—",
    r.gen ? fmtRate(r.gen.tokPerSec) : "—",
    r.probes ? `${r.probes.passed}/${r.probes.total} probes` : "—",
    r.ctx ? ui.fmtTokens(r.ctx) + " ctx" : "—",
  ]));
  sorted.forEach((r, i) => {
    const cells = body[i].split("  ");
    const flag = r.error ? c.red("  failed") : r.stale ? c.dim("  (file changed)") : "";
    lines.push(`  ${c.accent(cells[0])}  ${c.dim(cells.slice(1).join("  "))}${flag}`);
    if (r.error) {
      lines.push(`    ${c.red(String(r.error).slice(0, 100))}`);
    } else if (r.probes && r.probes.failed.length) {
      const why = r.probes.failed.map((n) => {
        const d = r.probes.detail && r.probes.detail.find((x) => x.name === n);
        return d && d.truncated ? `${n} (hit the cap, still thinking)` : n;
      });
      lines.push(`    ${c.dim("missed: " + why.join(", "))}`);
    }
  });
  return lines;
}

function renderVerdict(rows) {
  const r = rank(rows);
  if (!r) return [];
  const lines = ["", ui.section("verdict"), ""];
  const line = (label, best, suffix) => {
    if (!best) return;
    lines.push(`  ${c.dim(label.padEnd(14))}${c.accent(best.row.id)}  ${c.dim(suffix(best))}`);
  };
  line("fastest", r.fastest, (b) => `${fmtRate(b.value)} generating`);
  line("best prefill", r.prefill, (b) => `${fmtRate(b.value)} reading a prompt`);
  line("most context", r.context, (b) => `${ui.fmtTokens(b.value)} loaded`);
  line("most capable", r.quality, (b) =>
    b.row.probes ? `${b.row.probes.passed} of ${b.row.probes.total} probes` : "");
  if (r.recommended) {
    lines.push("");
    lines.push(`  ${c.green("❯")} ${c.bold("use")}         ${c.accent(r.recommended.row.id)}`);
    lines.push(`    ${c.dim(r.why)}`);
    lines.push(`    ${c.dim("arcflare run " + r.recommended.row.id)}`);
  }
  return lines;
}

module.exports = {
  staticFit, PROBES, RECALL, NEEDLE, fillerPrompt, firstJson, stripFence, runsAdd,
  judge, summarise, measure, streamChat, tokenize, prefillRate, genRate,
  rank, load, save, record, rowsFor, clear,
  fmtRate, fmtDuration, columns, renderStatic, renderMeasured, renderVerdict,
  RESULTS, OVERHEAD,
};
