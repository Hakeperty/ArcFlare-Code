// Which model for which task.
//
// The hub can run an agent on one of three tiers: "light" (small, fast),
// "standard", and "hard" (the strongest model, which is scarce: slow, large,
// maybe the only thing that fits the GPU one at a time). The whole point of the
// router is that cheap work must never land on the hard tier by accident, so
// the rules are deliberately lopsided:
//
//   - "hard" is reached only by an explicit hint, or by text that scores above
//     a high threshold on several hardness signals. One scary word is not
//     enough ("architecture" alone scores 3, the bar is 6).
//   - Light is chosen for obviously small jobs; everything else is standard.
//   - When a tier's model is not configured or not installed, resolution falls
//     DOWN (hard -> standard -> light) and never up: a missing small model must
//     not silently burn the big one.
//
// Pure and deterministic on purpose: no model call, no clock, no randomness, so
// the choice is explainable ("reason") and testable.

const TIERS = ["light", "standard", "hard"];
const HARD_THRESHOLD = 6;

// [pattern, weight]. Weights add up; no single signal reaches the bar (one stays below it).
const HARD_SIGNALS = [
  [/\b(hardest|most difficult|extremely hard|very hard)\b/i, 5],
  [/\bsecurity (audit|review|assessment)\b|\bthreat model\b|\bpen-?test\b/i, 4],
  [/\brace conditions?\b|\bdeadlocks?\b|\bdata races?\b/i, 4],
  [/\b(multi|many)[- ]?(file|module|package|service)s?\b.*\brefactor|\brefactor\b.*\b(across|throughout|whole|entire)\b/i, 4],
  [/\b(re-?architect|re-?design)\b|\barchitecture\b/i, 3],
  [/\bmemory leak\b|\bheisenbug\b|\bflaky\b/i, 3],
  [/\b(migrate|port|rewrite)\b.*\b(entire|whole|all of)\b/i, 3],
  [/\b(whole|entire) (code ?base|repo(sitory)?|project|system)\b/i, 2],
  [/\broot cause\b|\bconcurrency\b|\bdistributed\b|\bperformance regression\b/i, 2],
];

const LIGHT_SIGNALS = [
  /\btypos?\b/i, /\brename\b/i, /\breadme\b/i, /\bcomments?\b/i, /\bformat(ting)?\b/i,
  /\bwhitespace\b/i, /\bone[- ]liner\b|\bone line\b/i, /\bbump\b.*\bversion\b/i,
  /\b(list|show|print|what is|where is)\b/i,
];

function norm(h) {
  const t = String(h || "").toLowerCase();
  return TIERS.includes(t) ? t : null;
}

/** Pick a tier for a task. `hint` may force one; only "hard" needs to be asked for. */
function classify(text, { hint } = {}) {
  const t = String(text || "");
  const h = norm(hint);
  if (h) return { tier: h, reason: `hint: ${h}`, score: h === "hard" ? HARD_THRESHOLD : 0 };

  let score = 0;
  const hits = [];
  for (const [re, w] of HARD_SIGNALS) {
    if (re.test(t)) { score += w; hits.push(re.source.slice(0, 24)); }
  }
  // Very long, detailed requests are a little harder; capped so length alone
  // can never get anyone to the hard tier.
  score += Math.min(1, Math.floor(t.length / 1500));

  if (score >= HARD_THRESHOLD) return { tier: "hard", reason: "hardness signals: " + hits.join(", "), score };

  const light = LIGHT_SIGNALS.some((re) => re.test(t));
  if (score < 2 && ((light && t.length < 400) || t.trim().length < 40)) {
    return { tier: "light", reason: "small task", score };
  }
  return { tier: "standard", reason: "default", score };
}

const ref = (m) => (m && typeof m === "object" ? m.id || m.ref || m.modelRef : m);

/**
 * Map a tier to a model reference. `available` (optional) lists installed
 * models as strings or {id}; when given, a configured model must be in it.
 */
function resolveModel(tier, cfg = {}, available) {
  const want = norm(tier) || "standard";
  const tiers = (cfg && cfg.hub && cfg.hub.tiers) || {};
  const have = Array.isArray(available) && available.length ? new Set(available.map(ref)) : null;
  const ok = (r) => !!r && (!have || have.has(r));

  for (let i = TIERS.indexOf(want); i >= 0; i--) {
    const t = TIERS[i];
    if (ok(tiers[t])) {
      return i === TIERS.indexOf(want)
        ? { tier: t, modelRef: tiers[t] }
        : { tier: t, modelRef: tiers[t], downgradedFrom: want };
    }
  }
  // Tiers are configured but nothing at or below the wanted one is installed:
  // say so rather than quietly hand a cheap task the strongest model.
  if (cfg && cfg.hub && cfg.hub.tiers && TIERS.some((t) => cfg.hub.tiers[t])) {
    return { tier: want, modelRef: null };
  }
  // No tiers set up (one model on the machine): the user's last model, else whatever is installed.
  const fallback = (cfg && ok(cfg.lastModel) ? cfg.lastModel : null) || (Array.isArray(available) && available.length ? ref(available[0]) : null);
  return { tier: want, modelRef: fallback || null };
}

module.exports = { classify, resolveModel, TIERS, HARD_THRESHOLD };
