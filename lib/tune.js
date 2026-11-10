// `arcflare tune` — find this machine's fastest settings by measuring them.
//
// ArcFlare's defaults were measured on one machine (a Strix Halo on Vulkan).
// The physical batch that buys +39% there is not the best one on an Arc card, a
// CUDA card, Apple's Metal or a CPU, and the thread count llama.cpp picks is
// not always the best on a chip with two kinds of core. No table of per-vendor
// constants would stay true across drivers and llama.cpp builds, so this does
// what `arcflare fit` does for models: load, time, remember.
//
// Only settings that leave the model's output alone are tried - batch size,
// thread count, which llama.cpp build runs it. They change how fast the same
// tokens arrive, never which tokens. Nothing that trades quality for speed
// (smaller quants, a quantised KV cache, less context) is on the table.
//
// The rule for choosing is a workload, stated in the output: the time to read a
// prompt and write a reply of a typical agent turn. And a setting has to earn
// its place - within 3% of what is already in use counts as noise, and the
// setting in use stays.

const fs = require("fs");
const os = require("os");
const path = require("path");

const fit = require("./fit");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const FILE = path.join(HOME, "tune.json");
const SCHEMA = 1;

// What a turn costs. An agent's turn re-reads only what changed since the last
// one, which is short; --long tunes for pasting whole files instead.
const WORKLOADS = {
  agent: { name: "agent", read: 2048, write: 300, says: "a typical agent turn: 2K tokens read, 300 written" },
  long: { name: "long", read: 8192, write: 300, says: "long prompts: 8K tokens read, 300 written" },
};

const MARGIN = 0.03;

// ------------------------------------------------------------ persistence ----

function load(file = FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && j.schema === SCHEMA && j.models) return j;
  } catch { /* never tuned is the normal case */ }
  return { schema: SCHEMA, models: {} };
}

function save(db, file = FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...db, schema: SCHEMA }, null, 2) + "\n");
    return true;
  } catch { return false; }
}

function clear(file = FILE) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** A build's identity: a new llama.cpp at the same path is a different engine. */
function exeStamp(exe) {
  if (!exe) return null;
  try { return `${exe}:${Math.round(fs.statSync(exe).mtimeMs)}`; } catch { return `${exe}:0`; }
}

function record(db, model, exe, result) {
  db.models[model.id] = { size: model.size, exe: exeStamp(exe), at: Date.now(), ...result };
  return db;
}

/**
 * The measured settings for this model on this engine: { ubatch?, threads? },
 * or null. A model file that changed size, or an engine that was replaced or
 * swapped for another backend, was not what was measured, so it gets none.
 */
function tunedFor(model, exe, file = FILE) {
  if (!model || !model.id) return null;
  const row = load(file).models[model.id];
  if (!row) return null;
  if (typeof row.size === "number" && typeof model.size === "number" && row.size !== model.size) return null;
  if (row.exe && row.exe !== exeStamp(exe)) return null;
  const out = {};
  if (Number.isFinite(row.ubatch) && row.ubatch >= 64) out.ubatch = row.ubatch;
  if (Number.isFinite(row.threads) && row.threads >= 1) out.threads = row.threads;
  return Object.keys(out).length ? out : null;
}

// ------------------------------------------------------------- candidates ----

/** Batch sizes to try, the one in use first so it is the baseline. */
function batchCandidates(current, sizes = [512, 1024, 2048]) {
  const out = [current, ...sizes.filter((n) => n !== current)];
  return out.map((ubatch) => ({ ubatch, threads: null, label: `batch ${ubatch}` }));
}

/**
 * Thread counts worth timing against llama.cpp's own choice.
 *
 * Threads decide speed when the CPU does the arithmetic. With every layer on a
 * GPU one thread feeds it and the count hardly matters, so these are only tried
 * for a CPU build (or when asked). The performance-core count is the one that
 * most often beats the default, on chips where the default counts every core.
 */
function threadCandidates(cpu, ubatch) {
  const out = [];
  const add = (n, why) => {
    if (Number.isFinite(n) && n >= 1 && !out.some((c) => c.threads === n)) {
      out.push({ ubatch, threads: n, label: `${n} threads (${why})` });
    }
  };
  // Without two kinds of core, llama.cpp's default is already the physical
  // core count, and there is nothing else worth a model load to try.
  if (!cpu || !cpu.hybrid) return out;
  add(cpu.performance, "performance cores");
  add(cpu.physical, "every core");
  return out;
}

// ---------------------------------------------------------------- scoring ----

/** Seconds for one turn of the workload at a row's measured rates, or null. */
function turnSeconds(row, workload = WORKLOADS.agent) {
  const pre = row && row.prefill && row.prefill.tokPerSec;
  const gen = row && row.gen && row.gen.tokPerSec;
  if (!(pre > 0) || !(gen > 0)) return null;
  return workload.read / pre + workload.write / gen;
}

/**
 * The row to use. `rows[0]` is the baseline (what is in use now); another row
 * replaces it only by beating it by more than the margin.
 * Returns { best, baseline, gain } - gain is the fraction of turn time saved.
 */
function pickBest(rows, workload = WORKLOADS.agent, margin = MARGIN) {
  const timed = rows.map((r) => ({ r, s: r.error ? null : turnSeconds(r, workload) }));
  const base = timed[0] && timed[0].s != null ? timed[0] : null;
  let best = base;
  for (const t of timed) {
    if (t.s == null) continue;
    if (!best) { best = t; continue; }
    const bar = best === base ? best.s * (1 - margin) : best.s;
    if (t.s < bar) best = t;
  }
  if (!best) return { best: null, baseline: base && base.r, gain: 0 };
  return { best: best.r, baseline: base && base.r, gain: base && best !== base ? 1 - best.s / base.s : 0 };
}

// -------------------------------------------------------------- measuring ----

/**
 * Time one loaded model: read a prompt nothing has cached, then write.
 *
 * Two readings of each, the better one kept. The first request after a load
 * also pays for whatever the backend sets up lazily (Vulkan compiles pipelines
 * on first use), and a background task can slow any single run; neither is a
 * property of the setting being measured, and both only ever make it look
 * slower, so the faster reading is the truer one.
 */
async function measure({ port, id, workload = WORKLOADS.agent, chat = fit.streamChat, count = fit.tokenize, runs = 2 }) {
  let prefill = null;
  let gen = null;
  for (let i = 0; i < runs; i++) {
    const nonce = Math.random().toString(36).slice(2, 10);
    const long = fit.fillerPrompt(workload.read, nonce);
    const pre = await chat(port, {
      model: id,
      messages: [{ role: "user", content: `${long}\n\nReply with the single word OK.` }],
      max_tokens: 1, temperature: 0,
    });
    let tokens = (pre.timings && pre.timings.prompt_n) || null;
    if (!tokens) tokens = await count(port, long);
    const p = fit.prefillRate(pre, tokens);
    if (p.tokPerSec && (!prefill || p.tokPerSec > prefill.tokPerSec)) prefill = p;

    const out = await chat(port, {
      model: id,
      messages: [{ role: "user", content:
        "Write one plain paragraph about why local inference is useful. No lists, no headings." }],
      max_tokens: 128, temperature: 0,
    });
    const g = fit.genRate(out);
    if (g.tokPerSec && (!gen || g.tokPerSec > gen.tokPerSec)) gen = g;
  }
  return { prefill: prefill || { tokPerSec: null }, gen: gen || { tokPerSec: null } };
}

/**
 * Run a list of candidates through `loadAndMeasure` and choose.
 *
 * loadAndMeasure(candidate) -> { prefill, gen } | { error }. It owns loading:
 * a candidate that did not load as asked (the batch was cut to make it fit)
 * must come back as an error, because timing a different setting under this
 * one's name would poison the choice.
 */
async function runCandidates(cands, loadAndMeasure, { workload = WORKLOADS.agent, onRow = () => {} } = {}) {
  const rows = [];
  for (const cand of cands) {
    let row;
    try { row = { ...cand, ...(await loadAndMeasure(cand)) }; }
    catch (e) { row = { ...cand, error: e.message || String(e) }; }
    row.seconds = row.error ? null : turnSeconds(row, workload);
    rows.push(row);
    onRow(row);
  }
  return { rows, ...pickBest(rows, workload) };
}

module.exports = {
  FILE, WORKLOADS, MARGIN,
  load, save, clear, record, tunedFor, exeStamp,
  batchCandidates, threadCandidates, turnSeconds, pickBest, measure, runCandidates,
};
