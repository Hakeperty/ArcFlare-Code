// Tests for `arcflare fit`.
//
// The measurement itself needs a GPU and several minutes, so what is tested
// here is everything around it: the arithmetic that says what fits, the probe
// grading, the rate maths that turns a stream into a number, and the ranking
// rule. Those are the parts that can be confidently wrong in silence — a
// benchmark that reports a number nobody can check is worse than no benchmark.

const test = require("node:test");
const assert = require("node:assert");

const fit = require("../lib/fit");

// Real shapes, same as the KV tests use.
const MOE = {
  arch: "qwen35moe", nLayer: 41, kvHeads: 2, headDimK: 256, headDimV: 256,
  trainCtx: 262144, fullAttnInterval: 4, nextnLayers: 1, quant: "Q5_K_M",
};
const GB = 1e9;
const model = (over = {}) => ({ id: "qwen:q5", size: 25 * GB, meta: MOE, ...over });

// ------------------------------------------------------------ static fit ----

test("a model with room to spare gets its full trained context", () => {
  const f = fit.staticFit(model(), 45 * GB);
  assert.strictEqual(f.verdict, "full");
  assert.strictEqual(f.maxCtx, 262144);
  assert.match(f.note, /full 256K context/);
});

test("weights that do not fit are called out, not shrunk into a context", () => {
  const f = fit.staticFit(model({ size: 44 * GB }), 20 * GB);
  assert.strictEqual(f.verdict, "no");
  assert.strictEqual(f.maxCtx, null);
  assert.match(f.note, /do not fit/);
});

test("a model that fits but cannot hold its trained context says how far it gets", () => {
  // 20 KiB/token, so 64K of context needs ~1.3 GB of cache.
  const f = fit.staticFit(model(), 25 * GB + fit.OVERHEAD + 1.4 * GB);
  assert.strictEqual(f.verdict, "ok");
  assert.ok(f.maxCtx >= 32768 && f.maxCtx < 262144, `got ${f.maxCtx}`);
});

test("barely any room left is 'tight' rather than a cheerful tick", () => {
  const f = fit.staticFit(model(), 25 * GB + fit.OVERHEAD + 0.3 * GB);
  assert.strictEqual(f.verdict, "tight");
  assert.ok(f.maxCtx < 32768);
});

test("a header too thin to compute from says so instead of guessing", () => {
  const f = fit.staticFit({ id: "x", size: GB, meta: { arch: "mystery" } }, 40 * GB);
  assert.strictEqual(f.verdict, "unknown");
  assert.match(f.note, /too incomplete/);
});

test("the overhead reserve is held back before any context is offered", () => {
  // Same device, same weights: the only difference is the reserve, and it has
  // to cost context rather than being quietly spent twice.
  const withReserve = fit.staticFit(model(), 30 * GB).maxCtx;
  const naive = require("../lib/gguf").maxContextFor(MOE, 30 * GB - 25 * GB, "f16");
  assert.ok(withReserve < naive, "the reserve must reduce the offered context");
});

// --------------------------------------------------------- the long prompt --

test("the nonce leads the prompt, or prefill measures a cache hit", () => {
  // llama.cpp reuses the cache for the longest unchanged prefix. A nonce at the
  // end leaves the prompt cached and prefill reads as thousands of tok/s.
  const p = fit.fillerPrompt(2048, "abc123");
  assert.ok(p.indexOf("abc123") < 40, "nonce must be in the first line");
  assert.notStrictEqual(fit.fillerPrompt(2048, "aaa"), fit.fillerPrompt(2048, "bbb"));
});

test("the needle is planted in the middle, not at either end", () => {
  const p = fit.fillerPrompt(4096, "n");
  const at = p.indexOf(fit.NEEDLE);
  assert.ok(at > 0, "needle must be present");
  const where = at / p.length;
  assert.ok(where > 0.4 && where < 0.8, `needle sat at ${(where * 100).toFixed(0)}%`);
});

test("the prompt is roughly the length it was asked for", () => {
  const tokens = fit.fillerPrompt(4096, "n").length / 4;
  assert.ok(tokens > 3000 && tokens < 6000, `about ${Math.round(tokens)} tokens`);
});

// ---------------------------------------------------------------- probes ----

const byName = (n) => fit.PROBES.find((p) => p.name === n);

test("the format probe wants the word, not a sentence around it", () => {
  assert.ok(byName("format").grade("Paris"));
  assert.ok(byName("format").grade("  Paris.  "));
  assert.ok(!byName("format").grade("The capital of France is Paris."));
});

test("the json probe accepts a fenced object and rejects a wrong one", () => {
  const g = byName("json").grade;
  assert.ok(g('{"sum": 13, "product": 42}'));
  assert.ok(g('```json\n{"sum": 13, "product": 42}\n```'));
  // A model that answers in strings has still emitted usable JSON.
  assert.ok(g('{"sum": "13", "product": "42"}'));
  assert.ok(!g('{"sum": 13, "product": 41}'));
  assert.ok(!g("sum is 13 and product is 42"));
});

test("the code probe runs the function rather than reading it", () => {
  const g = byName("code").grade;
  assert.ok(g("function add(a, b) { return a + b; }"));
  assert.ok(g("```js\nconst add = (a, b) => a + b;\n```"));
  // Reads like an adder, is not one: string concatenation returns "23".
  assert.ok(!g('function add(a, b) { return "" + a + b; }'));
  assert.ok(!g("function add(a, b) { return a - b; }"));
  assert.ok(!g("I would write a function that adds a and b."));
});

test("probe code cannot reach the machine it is graded on", () => {
  const g = byName("code").grade;
  // A fresh context has the language and nothing else. Each of these throws
  // inside the sandbox, which grades as a failure rather than as an exception
  // escaping into the CLI.
  assert.ok(!g("function add(a,b){ require('fs').writeFileSync('x','y'); return a+b; }"));
  assert.ok(!g("function add(a,b){ return process.pid; }"));
  assert.ok(!g("function add(a,b){ while (true) {} }")); // stopped by the timeout
});

test("recall passes only on the planted word", () => {
  assert.ok(fit.RECALL.grade(`The magic word is ${fit.NEEDLE}.`));
  assert.ok(!fit.RECALL.grade("The magic word is FLARE-1111."));
});

test("a model still thinking at the cap is not marked wrong", () => {
  // Counting this as a failure would rank thinking models below models that
  // answer badly but promptly, which is the opposite of what the probes are for.
  const j = fit.judge(byName("maths"), { content: "", finish: "length" });
  assert.strictEqual(j.pass, false);
  assert.strictEqual(j.truncated, true);

  const answered = fit.judge(byName("maths"), { content: "391", finish: "stop" });
  assert.strictEqual(answered.pass, true);
  assert.strictEqual(answered.truncated, false);
});

// ----------------------------------------------------------------- rates ----

test("the server's own timings win over the wall clock", () => {
  const res = {
    timings: { prompt_n: 4000, prompt_per_second: 350, predicted_n: 100, predicted_per_second: 54 },
    ttftMs: 12000, totalMs: 14000, deltas: 100,
  };
  assert.strictEqual(fit.prefillRate(res, 4000).tokPerSec, 350);
  assert.strictEqual(fit.prefillRate(res, 4000).from, "server");
  assert.strictEqual(fit.genRate(res).tokPerSec, 54);
});

test("without timings, prefill is prompt tokens over time to first token", () => {
  const res = { ttftMs: 10000, totalMs: 12000, deltas: 50 };
  const p = fit.prefillRate(res, 4000);
  assert.strictEqual(Math.round(p.tokPerSec), 400);
  assert.strictEqual(p.from, "wall");
});

test("the generation fallback excludes prefill, or a long prompt looks slow", () => {
  // 21 tokens, first at 10s, last at 12s: 20 tokens in 2s is 10 tok/s. Dividing
  // by the whole 12 seconds would report 1.75 and blame the model for the prompt.
  const res = { ttftMs: 10000, totalMs: 12000, deltas: 21 };
  assert.strictEqual(Math.round(fit.genRate(res).tokPerSec), 10);
});

test("a stream that produced nothing reports no rate rather than zero", () => {
  const empty = fit.genRate({ ttftMs: 5, totalMs: 5, deltas: 0 });
  assert.strictEqual(empty.tokPerSec, null);
  assert.strictEqual(fit.prefillRate({ ttftMs: 0 }, null).tokPerSec, null);
});

// --------------------------------------------------------------- ranking ----

const row = (id, gen, prefill, passed, total = 5, extra = {}) => ({
  id, ctx: 262144,
  gen: { tokPerSec: gen }, prefill: { tokPerSec: prefill },
  probes: { passed, total, failed: [], truncated: 0, detail: [] },
  ...extra,
});

test("the recommendation is gated on the probes, not traded against them", () => {
  const rows = [
    row("fast-but-broken", 90, 500, 3),
    row("slower-and-clean", 50, 300, 5),
  ];
  const r = fit.rank(rows);
  assert.strictEqual(r.fastest.row.id, "fast-but-broken", "fastest is still fastest");
  assert.strictEqual(r.recommended.row.id, "slower-and-clean");
  assert.match(r.why, /every probe/);
});

test("among models that all pass, the fastest wins", () => {
  const r = fit.rank([row("a", 40, 900, 5), row("b", 61, 200, 5), row("c", 55, 400, 5)]);
  assert.strictEqual(r.recommended.row.id, "b");
  assert.strictEqual(r.clean, 3);
  assert.strictEqual(r.prefill.row.id, "a");
});

test("when nothing passes everything, the report says so", () => {
  const r = fit.rank([row("a", 40, 100, 2), row("b", 80, 100, 4)]);
  assert.strictEqual(r.recommended.row.id, "b");
  assert.match(r.why, /nothing answered every probe/);
  assert.strictEqual(r.clean, 0);
});

test("probes outrank speed for 'most capable', and speed only breaks ties", () => {
  const r = fit.rank([row("a", 100, 100, 4), row("b", 30, 100, 5), row("c", 90, 100, 5)]);
  assert.strictEqual(r.quality.row.id, "c"); // 5 probes, and faster than b
});

test("a model that failed to load cannot win anything", () => {
  const rows = [{ id: "broken", error: "did not load" }, row("ok", 20, 100, 5)];
  const r = fit.rank(rows);
  assert.strictEqual(r.fastest.row.id, "ok");
  assert.strictEqual(r.recommended.row.id, "ok");
});

test("no usable rows ranks to nothing rather than inventing a winner", () => {
  assert.strictEqual(fit.rank([]), null);
  assert.strictEqual(fit.rank([{ id: "x", error: "boom" }]), null);
});

// ----------------------------------------------------------- bookkeeping ----

test("a measurement of a file that has since changed is flagged, not trusted", () => {
  const db = { rows: { "a:q5": { id: "a:q5", size: 100, gen: { tokPerSec: 50 } } } };
  const [same] = fit.rowsFor(db, [{ id: "a:q5", size: 100 }]);
  const [changed] = fit.rowsFor(db, [{ id: "a:q5", size: 200 }]);
  assert.strictEqual(same.stale, false);
  assert.strictEqual(changed.stale, true);
});

test("models with no measurement are simply absent", () => {
  const db = { rows: {} };
  assert.deepStrictEqual(fit.rowsFor(db, [{ id: "a", size: 1 }]), []);
});

// ------------------------------------------------------------ formatting ----

test("rates and durations read like measurements, not floats", () => {
  assert.strictEqual(fit.fmtRate(54.123), "54.1 tok/s");
  assert.strictEqual(fit.fmtRate(349.6), "350 tok/s");
  assert.strictEqual(fit.fmtRate(null), "—");
  assert.strictEqual(fit.fmtDuration(640), "640 ms");
  assert.strictEqual(fit.fmtDuration(18200), "18.2 s");
  assert.strictEqual(fit.fmtDuration(124000), "2m 04s");
  assert.strictEqual(fit.fmtDuration(undefined), "—");
});

test("columns line up and the last one is not padded", () => {
  const out = fit.columns([["a", "long-value", "x"], ["bbbb", "v", "y"]]);
  assert.strictEqual(out[0], "a     long-value  x");
  assert.strictEqual(out[1], "bbbb  v           y");
});

test("the measured table tells you how to fill it in when it is empty", () => {
  const text = fit.renderMeasured([]).join("\n");
  assert.match(text, /arcflare fit --run/);
});

// ------------------------------------------------------------- the whole ----

test("measure asks the right questions in the right order", async () => {
  const asked = [];
  const chat = async (port, body) => {
    const content = body.messages[0].content;
    asked.push({ content, max: body.max_tokens, temp: body.temperature });
    // Answer every probe correctly, so the sequence is what is under test.
    let answer = "OK";
    if (content.includes("capital of France")) answer = "Paris";
    else if (content.includes("JSON object")) answer = '{"sum":13,"product":42}';
    else if (content.includes("17 * 23")) answer = "391";
    else if (content.includes("function `add")) answer = "function add(a,b){return a+b;}";
    else if (content.includes("magic word")) answer = fit.NEEDLE;
    return {
      content: answer, finish: "stop", deltas: 10, ttftMs: 100, totalMs: 300,
      timings: { prompt_n: 4000, prompt_per_second: 350, predicted_n: 10, predicted_per_second: 55 },
    };
  };

  const row = await fit.measure({ port: 1, id: "m", chat, count: async () => 4000 });

  assert.strictEqual(asked.length, 7, "prefill, generation, four probes, recall");
  assert.strictEqual(asked[0].max, 1, "prefill asks for one token; it is not a generation test");
  assert.ok(asked[0].content.includes(fit.NEEDLE), "prefill carries the needle for recall to find");
  assert.ok(asked.every((a) => a.temp === 0), "temperature 0, or a re-run measures the dice");

  // Recall must reuse the same long prompt, both to be a long-context test and
  // to ride the cache the prefill step already paid for.
  const recall = asked[asked.length - 1];
  assert.ok(recall.content.startsWith(asked[0].content.slice(0, 200)));

  assert.strictEqual(row.prefill.tokPerSec, 350);
  assert.strictEqual(row.gen.tokPerSec, 55);
  assert.strictEqual(row.probes.passed, 5);
  assert.strictEqual(row.probes.total, 5);
  assert.deepStrictEqual(row.probes.failed, []);
});

test("quick mode measures less and says nothing it did not measure", async () => {
  const seen = [];
  const chat = async (port, body) => {
    seen.push(body.max_tokens);
    return { content: "no", finish: "stop", deltas: 2, ttftMs: 10, totalMs: 20 };
  };
  const row = await fit.measure({ port: 1, id: "m", quick: true, probes: false, chat,
    count: async () => 2000 });
  assert.strictEqual(seen.length, 2, "no probes were run");
  assert.strictEqual(row.probes, undefined, "so none are reported");
});

test("a model that answers nothing scores zero rather than throwing", async () => {
  const chat = async () => ({ content: "", finish: "length", deltas: 0, ttftMs: 50, totalMs: 50 });
  const row = await fit.measure({ port: 1, id: "m", chat, count: async () => 1000 });
  assert.strictEqual(row.probes.passed, 0);
  assert.strictEqual(row.probes.truncated, 5);
  assert.strictEqual(row.gen.tokPerSec, null);
});

test("'to spare' means after the cache, not before it", () => {
  // A 36 GB model at 256K on a 45 GB device has ~7.6 GB over the weights, but
  // 5.4 GB of that is the cache the same line is promising. Reporting the
  // pre-cache figure reads as headroom the model does not have.
  const f = fit.staticFit(model({ size: 36 * GB }), 45 * GB);
  assert.strictEqual(f.verdict, "full");
  assert.ok(f.kvBytes > 5e9 && f.kvBytes < 6e9, `cache was ${f.kvBytes}`);
  assert.ok(f.headroom < f.spare - 5e9, "headroom must exclude the cache");
  assert.match(f.note, /of cache, .* left over/);
});

test("running out of room buys one retry at triple the budget", async () => {
  // A cap that decides the verdict is measuring the cap. The first real run of
  // this scored three Qwen3.6 quants 4/5, all missing the same probe, because
  // they were still reasoning about `add(a, b)` when the tokens ran out.
  const caps = [];
  const chat = async (port, body) => {
    caps.push(body.max_tokens);
    const askedCode = body.messages[0].content.includes("function `add");
    if (askedCode && caps.filter((c) => c).length && body.max_tokens < 2000) {
      return { content: "", finish: "length", deltas: 700, ttftMs: 10, totalMs: 900 };
    }
    let answer = "OK";
    const q = body.messages[0].content;
    if (q.includes("capital of France")) answer = "Paris";
    else if (q.includes("JSON object")) answer = '{"sum":13,"product":42}';
    else if (q.includes("17 * 23")) answer = "391";
    else if (askedCode) answer = "const add = (a, b) => a + b;";
    else if (q.includes("magic word")) answer = fit.NEEDLE;
    return { content: answer, finish: "stop", deltas: 5, ttftMs: 10, totalMs: 50 };
  };

  const row = await fit.measure({ port: 1, id: "m", chat, count: async () => 4000 });
  assert.strictEqual(row.probes.passed, 5, "the retry is what counts, not the first try");
  const code = row.probes.detail.find((d) => d.name === "code");
  assert.strictEqual(code.retried, true);
  // The code probe starts with double the base cap, and the retry triples that.
  assert.ok(caps.includes(768 * 2), `first ask should be 1536, got ${caps.join(",")}`);
  assert.ok(caps.includes(768 * 2 * 3), "retry should be 4608");
});

test("a model still going after the retry is reported truncated, not passing", async () => {
  const chat = async () => ({ content: "", finish: "length", deltas: 99, ttftMs: 5, totalMs: 99 });
  const row = await fit.measure({ port: 1, id: "m", quick: true, chat, count: async () => 100 });
  assert.strictEqual(row.probes.passed, 0);
  assert.strictEqual(row.probes.truncated, 5);
  assert.ok(row.probes.detail.every((d) => d.retried), "each one got its second chance");
});
