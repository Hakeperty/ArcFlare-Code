"use strict";
// The speech work of calls: the agent's lines spoken by a local model (Qwen3-TTS) and the recording heard again by
// Whisper. Both run on the same iGPU, and two ROCm processes at once crash each other ("HIP error: unspecified launch
// failure"), so every job goes through one queue, and Qwen's worker is stopped while Whisper runs.

const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

/**
 * @param {object} o
 * @param {object}   o.cfg        ArcFlare's config (lib/serve loadConfig)
 * @param {function} o.getVoice   () => { model, voice?, instruct?, lang? } | null: the voice chosen on the phone, read each time
 * @param {function} [o.log]      where failures go (the hub's console)
 * @param {object}   [o.gen]      lib/gen (tests inject a fake)
 * @param {object}   [o.pool]     a ResidentPool (lib/gen/resident.js)
 * @param {string}   [o.whisperModel]
 * @param {number}   [o.settleMs] wait after stopping Qwen's worker so its GPU memory is free before Whisper starts
 */
function createSpeech({ cfg, getVoice, log = console.error, gen = require("../gen"), pool = new (require("../gen/resident").ResidentPool)(),
  whisperModel = process.env.ARCFLARE_WHISPER || "openai/whisper-large-v3", settleMs = 2000, python = null } = {}) {
  let tail = Promise.resolve();
  const onGpu = (fn) => { const r = tail.then(fn, fn); tail = r.then(() => {}, () => {}); return r; };
  const first = (e) => String(e && e.message).split("\n")[0];

  const speak = (v, text, out, signal) => gen.speak(cfg, { model: v.model, voice: v.voice || undefined, instruct: v.instruct || undefined,
    lang: v.lang || undefined, text, out, runner: pool.runner(), signal });

  /** async (text, file, signal) => true when the line was written, false when no speech model is chosen (the phone speaks it). */
  const synth = (text, out, signal) => onGpu(async () => {
    const v = getVoice();
    if (!v) return false;
    // A crashed speech worker is not used again: the line is tried once more on a fresh one.
    for (let attempt = 0; ; attempt++) {
      try { await speak(v, text, out, signal); return true; } catch (e) {
        log(`  ! call voice (${v.model}) failed: ${first(e)}${e.stderr ? " | " + String(e.stderr).split("\n").slice(-3).join(" | ") : ""}`);
        pool.stopAll();
        if (attempt === 1 || (signal && signal.aborted)) throw e;
      }
    }
  });

  /** Loads the voice model now: a cold Qwen takes ~35 s and the phone only waits ~10 s for the first line of a call. */
  function warm() {
    const v = getVoice();
    if (!v) return Promise.resolve();
    return onGpu(() => speak(v, "Hello.", path.join(os.tmpdir(), "arcflare-warm.wav"))).catch((e) => log(`  ! speech model warm-up failed: ${first(e)}`));
  }

  /** async (files) => { file: text }: Whisper on recordings, then Qwen is loaded again. */
  const transcribe = (files) => onGpu(async () => {
    pool.stopAll();
    await new Promise((r) => setTimeout(r, settleMs));
    const env = path.join(os.homedir(), ".arcflare", "gen", "envs", "qwen-tts");
    const py = python || (process.platform === "win32" ? path.join(env, "Scripts", "python.exe") : path.join(env, "bin", "python"));
    return new Promise((resolve, reject) => {
      execFile(py, [path.join(__dirname, "..", "gen", "whisper.py"), whisperModel, ...files], { maxBuffer: 8 << 20, timeout: 10 * 60_000 }, (e, out) => {
        const i = String(out).lastIndexOf("@@JSON@@");
        if (e || i < 0) { log(`  ! whisper failed: ${e ? first(e) : "no result"}`); return reject(e || new Error("whisper gave no result")); }
        resolve(JSON.parse(String(out).slice(i + 8)));
      });
    });
  }).finally(() => { warm(); });

  return { synth, transcribe, warm, pool };
}

module.exports = { createSpeech };
