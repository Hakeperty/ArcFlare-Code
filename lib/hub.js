// The model hub, for `arcflare shop`.
//
// The catalogue lives on the website (arcflare.net/api/hub). The shop reads it
// from three places, in order, and always says which one it used:
//
//   live      fetched just now (or within the last six hours, from the cache)
//   cache     an older copy in ~/.arcflare/hub.json, because the site did not answer
//   bundled   lib/hub-snapshot.json, shipped with the CLI, for a machine that has
//             never been online
//
// A shop that showed nothing offline would be no use on exactly the machines
// that need to be told what fits before they go and download it somewhere else.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const CACHE = path.join(HOME, "hub.json");
const SNAPSHOT = path.join(__dirname, "hub-snapshot.json");
const DEFAULT_HUB = "https://arcflare.net";
const FRESH_MS = 6 * 60 * 60 * 1000;

function hubUrl(cfg = {}) {
  return String(process.env.ARCFLARE_HUB || cfg.hub || DEFAULT_HUB).replace(/\/+$/, "");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function valid(data) {
  return data && Array.isArray(data.models) && data.models.length > 0;
}

/**
 * The catalogue and where it came from: { data, source, url, age }.
 * Never throws for being offline; throws only if no copy exists anywhere,
 * which a released CLI cannot hit because the snapshot ships with it.
 */
async function load({ cfg = {}, refresh = false, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const url = hubUrl(cfg);
  const cached = readJson(CACHE);
  const cacheOk = cached && valid(cached.data) && cached.url === url;
  const age = cacheOk ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;

  if (!refresh && cacheOk && age < FRESH_MS) return { data: cached.data, source: "live", url, age };

  try {
    if (typeof fetchImpl !== "function") throw new Error("no fetch in this Node");
    const res = await fetchImpl(`${url}/api/hub`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!valid(data)) throw new Error("the hub answered, but not with a model list");
    try {
      fs.mkdirSync(HOME, { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), url, data }) + "\n");
    } catch { /* a cache we cannot write is only a slower next time */ }
    return { data, source: "live", url, age: 0 };
  } catch (e) {
    if (cacheOk) return { data: cached.data, source: "cache", url, age, error: e.message };
    const snap = readJson(SNAPSHOT);
    if (valid(snap)) return { data: snap, source: "bundled", url, age: null, error: e.message };
    throw new Error(`the hub at ${url} is unreachable (${e.message}) and there is no saved copy`);
  }
}

// ------------------------------------------------------------------- helpers ----

/** "~6 GB" -> 6, "~0.5 GB" -> 0.5; null when a card does not say. */
function vramGb(v) {
  const m = /([\d.]+)\s*GB/i.exec(String(v || ""));
  return m ? Number(m[1]) : null;
}

/**
 * fits | tight | no | unknown, against free device memory in GB. The same
 * thresholds as the website's fit check, so the two never disagree about one
 * model on one machine.
 */
function fit(model, freeGb) {
  const need = vramGb(model.vram);
  if (need === null || !freeGb) return "unknown";
  if (need <= freeGb * 0.85) return "fits";
  if (need <= freeGb) return "tight";
  return "no";
}

function search(models, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return models;
  const words = s.split(/\s+/);
  return models
    .map((m) => {
      const hay = [m.name, m.slug, m.author, m.category, ...(m.tags || []), m.description].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      // Name hits first, then tag/category hits, then description-only.
      const score = words.reduce((n, w) =>
        n + (m.name.toLowerCase().includes(w) ? 4 : 0) +
        ((m.tags || []).includes(w) || m.category.toLowerCase() === w ? 2 : 0), 0);
      return { m, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name))
    .map((x) => x.m);
}

function bySlug(models, slug) {
  const s = String(slug || "").toLowerCase();
  return models.find((m) => m.slug === s) ||
    models.find((m) => m.name.toLowerCase() === s) ||
    models.find((m) => m.slug.replace(/[-.]/g, "") === s.replace(/[-.]/g, "")) || null;
}

/**
 * What installing a model means, from its hub command: a GGUF to pull, a
 * generator to set up, or nothing yet. Commands the CLI does not have are
 * reported as such rather than run.
 */
function installPlan(model) {
  const run = String(model.run || "");
  const pull = /^arcflare pull (\S+)/.exec(run);
  if (model.runnable !== false && pull) return { kind: "pull", ref: pull[1], argv: ["pull", pull[1]] };
  const gen = /^arcflare gen (?:3d|tts)\b.*?-m (\S+)/.exec(run);
  if (model.runnable !== false && gen) return { kind: "gen", id: gen[1], argv: ["gen", "setup", gen[1]], use: run };
  return { kind: "none" };
}

function ageText(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

module.exports = {
  load, hubUrl, vramGb, fit, search, bySlug, installPlan, ageText,
  CACHE, SNAPSHOT, DEFAULT_HUB, FRESH_MS,
};
