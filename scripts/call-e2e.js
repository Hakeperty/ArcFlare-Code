#!/usr/bin/env node
"use strict";
// End-to-end check of a call on this computer, with no phone: the real call code, the real speech model chosen in the
// hub (Qwen), and Whisper. A simulated phone answers, "speaks" a known sentence (made with the same voice model) and
// uploads it as the recording. Passes when Qwen made the agent's line and Whisper heard the sentence back.
//   node scripts/call-e2e.js        (stop the hub first, or leave the GPU to it: one speech job at a time)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { CallBox } = require("../lib/hub/calls");
const { HubSettings } = require("../lib/hub/settings");
const { createSpeech } = require("../lib/hub/speech");

const SAID = "Hello, this is Harry. I am testing the whisper model on my computer.";
const words = (t) => String(t).toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

(async () => {
  const hubDir = path.join(os.homedir(), ".arcflare", "hub");
  const voice = new HubSettings({ dir: hubDir }).phone().voice;
  if (!voice) throw new Error("no speech model is chosen in the hub (Tools on the phone)");
  log(`voice: ${voice.model}${voice.voice ? "/" + voice.voice : ""}${voice.instruct ? " · " + voice.instruct.slice(0, 50) + "…" : ""}`);

  const sp = createSpeech({ cfg: {}, getVoice: () => voice });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcflare-e2e-"));
  const box = new CallBox({ dir, synth: sp.synth, transcribe: sp.transcribe, speakMs: 300_000 });

  // 1. the agent's line, spoken by Qwen
  const { id } = box.start({ say: "Hey there, Harry. This is only a test. Say hello for me.", from: "e2e" });
  log("call started: status " + box.current().status);
  const part = await box.line(id, 0, 0, 300_000);
  if (!part || part.pending) throw new Error("Qwen did not make the agent's line");
  const agentWav = path.join(dir, id, "agent-0.wav");
  log(`PASS qwen: the agent's line is ${fs.statSync(agentWav).size} bytes (status ${box.current().status})`);
  if (box.current().status !== "ringing") throw new Error("the call should be ringing once the line is made");

  // 2. the simulated phone answers, "hears" the user, hangs up and uploads the recording
  box.answer(id);
  const userWav = path.join(dir, "user-says.wav");
  await sp.synth(SAID, userWav);
  box.reply(id, "(the phone's own recogniser heard something else)", "voice");
  box.hangUp(id, ["conversation.wav", "answer-1.wav"], true);
  const bytes = fs.readFileSync(userWav);
  for (const name of ["answer-1.wav", "conversation.wav"]) {
    for (let off = 0; off < bytes.length; off += 200_000) {
      box.audio(id, { name, offset: off, data: bytes.subarray(off, off + 200_000).toString("base64"), last: off + 200_000 >= bytes.length });
    }
  }
  log("recordings uploaded; waiting for whisper");

  // 3. Whisper hears it again
  const transcript = path.join(dir, id, "transcript.json");
  for (let i = 0; i < 120; i++) {
    const c = box.current() || box.history()[0];
    if (fs.existsSync(transcript) && /"whisper"/.test(fs.readFileSync(transcript, "utf8"))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const t = JSON.parse(fs.readFileSync(transcript, "utf8"));
  if (typeof t.whisper !== "string") throw new Error("whisper never wrote its text");
  const want = new Set(words(SAID)), got = words(t.whisper);
  const hit = got.filter((w) => want.has(w)).length / want.size;
  const perAnswer = (t.turns.find((x) => x.audio) || {}).whisper;
  log(`whisper (whole call): "${t.whisper}"`);
  log(`whisper (the answer): "${perAnswer}"`);
  log(`${hit >= 0.7 ? "PASS" : "FAIL"} whisper: ${Math.round(hit * 100)}% of the sentence heard back`);
  sp.pool.stopAll();
  process.exit(hit >= 0.7 && perAnswer ? 0 : 1);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
