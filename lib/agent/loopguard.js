// The loop guard: stop a local model paying for the same thought twice.
//
// Small thinking models fail in two cheap-to-spot ways. They go round one
// thought ("2 + 2 = 4. Let me check again. 2 + 2 = 4.") until the reply budget
// is gone, and they make the same call again hoping for a different result.
// Neither needs a second model to notice: the text repeats, the call repeats.
//
// ThinkWatch reads reasoning as it streams and says when to cut it. CallWatch
// counts identical calls with identical results inside one turn. The agent
// loop decides what to do about either; nothing here touches the conversation.

const crypto = require("crypto");

/** Lower case, one space between words: what makes two thoughts "the same". */
function norm(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Does the text end in the same passage `reps` times in a row? Returns the
 * passage, or "". Only whole repeats count, so a list of similar lines is not
 * a loop but the same line three times is.
 */
function periodicTail(text, { minPeriod = 24, maxPeriod = 400, reps = 3 } = {}) {
  const s = String(text);
  const top = Math.min(maxPeriod, Math.floor(s.length / reps));
  for (let p = minPeriod; p <= top; p++) {
    const unit = s.slice(s.length - p);
    let same = true;
    for (let k = 2; k <= reps && same; k++) {
      if (s.slice(s.length - k * p, s.length - (k - 1) * p) !== unit) same = false;
    }
    // A run of one character ("......") repeats at every length; that is padding, not a thought.
    if (same && new Set(unit).size > 4) return unit;
  }
  return "";
}

// A sentence said this many times in one stretch of thinking is a circle.
// Short ones ("2 + 2 = 4") are allowed more, because short true things recur.
const LONG = 24, LONG_TIMES = 4;
const SHORT = 8, SHORT_TIMES = 6;

/** Watches one stretch of reasoning. feed() returns null, or why to stop. */
class ThinkWatch {
  /** @param {number} capTokens  stop after about this many tokens of thinking; 0 for no cap */
  constructor({ capTokens = 0 } = {}) {
    this.capChars = capTokens > 0 ? capTokens * 4 : 0;
    this.chars = 0;
    this.tail = "";        // normalised, for the periodic check
    this.pending = "";     // the sentence still being written
    this.seen = new Map();
    this.sinceCheck = 0;
    this.tripped = null;
  }

  feed(text) {
    if (this.tripped || !text) return this.tripped;
    const t = String(text);
    this.chars += t.length;

    // Sentences, counted as they complete.
    this.pending += t;
    const parts = this.pending.split(/[.!?]+\s+|\n+/);
    this.pending = parts.pop() || "";
    for (const raw of parts) {
      const s = norm(raw).replace(/^(?:[-*•]|\d+[.)])\s*/, "");
      if (s.length < SHORT) continue;
      const n = (this.seen.get(s) || 0) + 1;
      this.seen.set(s, n);
      if (n >= (s.length >= LONG ? LONG_TIMES : SHORT_TIMES)) {
        return (this.tripped = { kind: "think-loop", detail: s.slice(0, 80), chars: this.chars });
      }
    }

    // The same passage back to back, sentence marks or not. Checked every so often, not per token.
    this.tail = (this.tail + t.toLowerCase().replace(/\s+/g, " ")).slice(-1400);
    this.sinceCheck += t.length;
    if (this.sinceCheck >= 200) {
      this.sinceCheck = 0;
      const unit = periodicTail(this.tail);
      if (unit) return (this.tripped = { kind: "think-loop", detail: unit.trim().slice(0, 80), chars: this.chars });
    }

    if (this.capChars && this.chars > this.capChars) {
      return (this.tripped = { kind: "think-cap", detail: "", chars: this.chars });
    }
    return null;
  }
}

// Calls that only look. Asking one of these twice with nothing changed in between gives the same answer.
const READS = new Set(["read_file", "list_dir", "glob", "grep", "skill_load", "tool_search"]);
const RUNS_BEFORE_STUB = 2;   // a look is run twice; the third identical look is answered from memory
const SAME_BEFORE_NOTE = 3;   // anything else is always run, and told on the third identical result
const STILL_IN_VIEW = 8;      // ...but only while the earlier result is this few calls back: older ones may have been compacted away

/** JSON with object keys in order, so {a, b} and {b, a} are one call. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const callKey = (name, args) => `${name}\0${stable(args)}`;
const digest = (s) => crypto.createHash("sha1").update(String(s ?? "")).digest("hex");

/** Counts identical calls inside one turn. */
class CallWatch {
  constructor() {
    this.calls = new Map();   // key -> { n, sum, epoch, tick }
    this.epoch = 0;           // goes up whenever something that can change the world runs
    this.tick = 0;            // goes up with every call that ran
  }

  /** Before running: returns a short answer to give instead, or null to run the call. */
  before(name, args) {
    const e = this.calls.get(callKey(name, args));
    if (!READS.has(name)) return null;
    if (!e || e.epoch !== this.epoch || e.n < RUNS_BEFORE_STUB || this.tick - e.tick > STILL_IN_VIEW) return null;
    e.n++;
    return `[ArcFlare: not run. You have made this exact call ${e.n - 1} times and nothing has changed since, ` +
      `so the result is the one you already have. Use it, or do something different.]`;
  }

  /** After running: returns the output, with a note added when it is the same result again. */
  after(name, args, out) {
    if (!READS.has(name)) this.epoch++;
    this.tick++;
    const key = callKey(name, args);
    const sum = digest(out);
    const e = this.calls.get(key);
    const n = e && e.sum === sum ? e.n + 1 : 1;
    this.calls.set(key, { n, sum, epoch: this.epoch, tick: this.tick });
    if (READS.has(name) || n < SAME_BEFORE_NOTE) return { out, repeated: false };
    return {
      repeated: true,
      out: String(out ?? "") +
        `\n\n[ArcFlare: this exact call has now given this exact result ${n} times. Running it again will not ` +
        `change it. Change something first, try a different approach, or report what you found.]`,
    };
  }
}

// What the model is told when its thinking is cut. Short: it is paid for in tokens too.
const NUDGE = {
  "think-loop": "[ArcFlare: you were repeating the same thought, so thinking was stopped. Do not work it out again. " +
    "Take what you already concluded and act on it now: make one tool call that tests it, or give your answer.]",
  "think-cap": "[ArcFlare: you thought for a long time without acting, so thinking was stopped. " +
    "Act on your best idea now: make one tool call that tests it, or give your answer and say what you are unsure of.]",
};

/** Default thinking cap for a context window: an eighth of it, between 1024 and 4096 tokens. */
function defaultCap(nCtx) {
  return Math.max(1024, Math.min(4096, Math.floor((nCtx || 32768) / 8)));
}

/** The guard's settings from options and the environment. `enabled: false` turns all of it off. */
function settings(o = {}, env = process.env) {
  const off = o.loopGuard === false || /^(0|off|false|no)$/i.test(String(env.ARCFLARE_LOOP_GUARD || ""));
  const envCap = env.ARCFLARE_THINK_CAP === undefined || env.ARCFLARE_THINK_CAP === "" ? NaN : Number(env.ARCFLARE_THINK_CAP);
  const cap = Number.isFinite(o.thinkCap) ? o.thinkCap : Number.isFinite(envCap) ? envCap : defaultCap(o.nCtx);
  return { enabled: !off, thinkCap: Math.max(0, Math.floor(cap)) };
}

module.exports = { ThinkWatch, CallWatch, periodicTail, norm, callKey, defaultCap, settings, NUDGE, READS };
