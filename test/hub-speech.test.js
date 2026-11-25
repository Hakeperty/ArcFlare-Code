"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createSpeech } = require("../lib/hub/speech");

const pool = () => ({ stops: 0, runner() { return () => {}; }, stopAll() { this.stops++; } });

test("no speech model chosen: the line is left to the phone", async () => {
  const sp = createSpeech({ cfg: {}, getVoice: () => null, gen: { speak: async () => assert.fail("no model, no speech") }, pool: pool(), log() {} });
  assert.strictEqual(await sp.synth("hello", "x.wav"), false);
});

test("a crashed speech worker is stopped and the line is tried once more; a second crash is an error", async () => {
  const logs = [], p = pool();
  let calls = 0;
  const sp = createSpeech({ cfg: {}, getVoice: () => ({ model: "m" }), pool: p, log: (m) => logs.push(m),
    gen: { speak: async () => { if (++calls === 1) throw new Error("HIP error"); } } });
  assert.strictEqual(await sp.synth("hello", "x.wav"), true);
  assert.deepStrictEqual([calls, p.stops, logs.length], [2, 1, 1]);
  const bad = createSpeech({ cfg: {}, getVoice: () => ({ model: "m" }), pool: pool(), log() {}, gen: { speak: async () => { throw new Error("always"); } } });
  await assert.rejects(bad.synth("hello", "x.wav"), /always/);
});

test("speech jobs run one at a time, and the voice's tone and language reach the model", async () => {
  let running = 0, peak = 0;
  const seen = [];
  const gen = { speak: async (cfg, o) => { seen.push(o); running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; } };
  const sp = createSpeech({ cfg: {}, getVoice: () => ({ model: "m", instruct: "soft", lang: "English" }), gen, pool: pool(), log() {} });
  await Promise.all([sp.synth("a", "a.wav"), sp.synth("b", "b.wav"), sp.warm()]);
  assert.strictEqual(peak, 1);
  assert.deepStrictEqual([seen[0].instruct, seen[0].lang], ["soft", "English"]);
});

test("whisper stops the voice worker first and a failure is logged, not hidden", async () => {
  const logs = [], p = pool();
  const sp = createSpeech({ cfg: {}, getVoice: () => null, gen: {}, pool: p, log: (m) => logs.push(m), settleMs: 0, python: process.execPath });
  // node run as "python" on a script that is not whisper's: it exits with an error and prints no result
  await assert.rejects(sp.transcribe(["/no/such/file.wav"]));
  assert.ok(p.stops >= 1);
  assert.match(logs.join("\n"), /whisper failed/);
});
