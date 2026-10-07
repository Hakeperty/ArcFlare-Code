// `arcflare report`: send a bug, complaint or idea to the list the site keeps
// (arcflare.net/report). The same limits as the site, checked here first so a
// rejected report is caught before anything is sent.

const os = require("os");

const SITE = () => (process.env.ARCFLARE_SITE || "https://arcflare.net").replace(/\/+$/, "");
const ISSUES = "https://github.com/Hakeperty/ArcFlare-Code/issues/new";
const KINDS = ["bug", "complaint", "idea", "other"];
const WHERES = ["cli", "desktop", "website", "other"];
const LIMITS = { title: [4, 120], body: [10, 5000], contact: [0, 120] };

function osName() {
  const name = { win32: "Windows", darwin: "macOS", linux: "Linux" }[process.platform] || process.platform;
  return `${name} ${os.release()} ${process.arch}`.slice(0, 60);
}

/** A clean payload, or an error message. */
function validate(r) {
  const p = {
    kind: String(r.kind || "bug").toLowerCase(),
    where: String(r.where || "cli").toLowerCase(),
    title: String(r.title || "").trim(),
    body: String(r.body || "").trim(),
    version: String(r.version || "").slice(0, 40) || undefined,
    os: String(r.os || osName()).slice(0, 60),
    contact: String(r.contact || "").trim() || undefined,
  };
  if (!KINDS.includes(p.kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
  if (!WHERES.includes(p.where)) return { error: `where must be one of ${WHERES.join(", ")}` };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const n = (p[k] || "").length;
    if (n < min) return { error: `${k} needs at least ${min} characters` };
    if (n > max) return { error: `${k} is too long (max ${max})` };
  }
  return { payload: p };
}

/** POST it. Resolves { ok, error?, fallback }; never rejects. */
async function send(payload, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const fallback = ISSUES;
  try {
    const res = await fetchImpl(`${SITE()}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "arcflare-cli" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j.error || `HTTP ${res.status}`, fallback };
    // The site couldn't store it and handed back a pre-filled GitHub issue.
    if (j.fallback === "github" && typeof j.issue === "string") return { ok: false, issue: j.issue, fallback: j.issue };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "timed out" : e.message, fallback };
  }
}

/** One line for the terminal describing what send() did, given a colour helper. */
function outcome(r, c) {
  if (r.ok) return `${c.green("✓")} report sent — thank you`;
  if (r.issue) return `${c.accent("→")} almost there: open this to submit it on GitHub (everything is filled in)
    ${r.issue}`;
  return `${c.red("✗")} couldn't send (${r.error}) · open an issue instead: ${r.fallback}`;
}

module.exports = { validate, send, outcome, osName, KINDS, WHERES, LIMITS, ISSUES, SITE };
