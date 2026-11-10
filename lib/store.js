// The ArcFlare Store: skills, MCP servers and models, in one place.
//
//   skills   instructions the agent loads when a task calls for them
//            (lib/agent/skills.js). Adding one copies its SKILL.md into
//            ~/.arcflare/skills.
//   mcp      servers that give the agent tools. Adding one writes its start
//            command into ~/.arcflare/mcp.json, which is where the agent, the
//            phone hub and the desktop app already look.
//   models   the hub (lib/hub.js): `arcflare store models` is `arcflare shop`.
//
// The catalogue ships with ArcFlare (lib/store), so the store works with no
// network, and is refreshed from arcflare.net/api/store when that answers.
//
// Adding a third-party MCP server means that the next agent session runs a
// program from npm or PyPI. The store never does that quietly: it shows the
// exact command, says who makes it, and asks.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const CACHE = path.join(HOME, "store.json");
const DIR = path.join(__dirname, "store");
const FRESH_MS = 6 * 60 * 60 * 1000;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// What a remote entry may ask to run. A store entry is a launcher and a package name, not a script.
const LAUNCHERS = new Set(["npx", "uvx", "node", "python", "python3", "docker"]);
const ARG = /^[\w@./:=+-]{1,200}$/;

function frontmatter(text) {
  return require("./agent/skills").parseFrontmatter(String(text || ""));
}

/** The catalogue that ships with ArcFlare: every skill with its text, every server. */
function bundled() {
  const cat = JSON.parse(fs.readFileSync(path.join(DIR, "catalog.json"), "utf8"));
  const skills = cat.skills.map((s) => {
    const text = fs.readFileSync(path.join(DIR, "skills", `${s.id}.md`), "utf8");
    const { meta } = frontmatter(text);
    return { ...s, name: meta.name || s.id, description: meta.description || "", text };
  });
  return { schema: cat.schema, updated: cat.updated, skills, mcp: cat.mcp };
}

/** One skill as the hub sent it, checked: an id, and a SKILL.md that says what it is. */
function cleanSkill(s) {
  if (!s || !ID.test(String(s.id || "")) || typeof s.text !== "string" || s.text.length > 40000) return null;
  const { meta, body } = frontmatter(s.text);
  if (!meta.description || !body.trim()) return null;
  return {
    id: s.id, name: meta.name || s.id, description: meta.description, text: s.text,
    category: typeof s.category === "string" ? s.category.slice(0, 24) : "other",
    uses: Array.isArray(s.uses) ? s.uses.filter((u) => ["web", "browser", "desktop", "machine"].includes(u)) : [],
  };
}

/** One server as the hub sent it, checked. ArcFlare's own carry no command: this program is the command. */
function cleanMcp(m) {
  if (!m || !ID.test(String(m.id || "")) || typeof m.name !== "string" || typeof m.description !== "string") return null;
  const out = { id: m.id, name: m.name.slice(0, 80), description: m.description.slice(0, 400), by: String(m.by || "").slice(0, 60), ours: m.ours === true };
  if (out.ours) {
    if (!/^arcflare(-(desktop|web|browser))?$/.test(m.id)) return null;
    out.part = ["desktop", "web", "browser"].includes(m.part) ? m.part : null;
    return out;
  }
  if (!LAUNCHERS.has(m.command) || !Array.isArray(m.args) || m.args.length > 12 || !m.args.every((a) => typeof a === "string" && ARG.test(a))) return null;
  out.command = m.command;
  out.args = m.args;
  out.needs = typeof m.needs === "string" ? m.needs.slice(0, 20) : m.command;
  if (m.argument && typeof m.argument.name === "string") out.argument = { name: m.argument.name.slice(0, 30), about: String(m.argument.about || "").slice(0, 120), required: m.argument.required === true };
  if (typeof m.homepage === "string" && /^https:\/\//.test(m.homepage)) out.homepage = m.homepage.slice(0, 300);
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * The catalogue and where it came from: { data, source }. Never throws for
 * being offline: the copy that ships with ArcFlare is always there.
 */
async function load({ cfg = {}, refresh = false, fetchImpl = globalThis.fetch, timeoutMs = 5000, file = CACHE } = {}) {
  const url = require("./hub").hubUrl(cfg);
  const cached = readJson(file);
  const ok = cached && cached.url === url && cached.data && Array.isArray(cached.data.skills) && Array.isArray(cached.data.mcp);
  if (!refresh && ok && Date.now() - Date.parse(cached.fetchedAt) < FRESH_MS) return { data: cached.data, source: "live", url };
  try {
    if (typeof fetchImpl !== "function") throw new Error("no fetch in this Node");
    const res = await fetchImpl(`${url}/api/store`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const data = {
      schema: 1, updated: String((j && j.updated) || ""),
      skills: ((j && j.skills) || []).map(cleanSkill).filter(Boolean),
      mcp: ((j && j.mcp) || []).map(cleanMcp).filter(Boolean),
    };
    if (!data.skills.length && !data.mcp.length) throw new Error("the store answered, but with nothing in it");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), url, data }) + "\n");
    } catch { /* a copy we cannot keep is only a fetch next time */ }
    return { data, source: "live", url };
  } catch (e) {
    if (ok) return { data: cached.data, source: "cache", url, error: e.message };
    return { data: bundled(), source: "bundled", url, error: e.message };
  }
}

// ------------------------------------------------------------------ skills ----

const skillsDir = (home = HOME) => path.join(home, "skills");

/** Is this store skill on this machine, and is it the store's copy (not one the user wrote under the same name)? */
function skillState(skill, { home = HOME } = {}) {
  const file = path.join(skillsDir(home), skill.id, "SKILL.md");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { installed: false, file }; }
  const mark = readJson(path.join(skillsDir(home), skill.id, ".store.json"));
  return { installed: true, file, fromStore: !!mark, current: text === skill.text };
}

/** Put a skill in ~/.arcflare/skills. A folder of the same name that the store did not put there is left alone. */
function addSkill(skill, { home = HOME, force = false } = {}) {
  const st = skillState(skill, { home });
  if (st.installed && !st.fromStore && !force) {
    throw new Error(`you already have a skill called ${skill.id} that did not come from the store; it is left as it is (${st.file})`);
  }
  const dir = path.join(skillsDir(home), skill.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), skill.text);
  fs.writeFileSync(path.join(dir, ".store.json"), JSON.stringify({ id: skill.id, from: "arcflare store", at: new Date().toISOString() }) + "\n");
  return { file: path.join(dir, "SKILL.md"), updated: st.installed };
}

/** Remove a skill the store installed. One the user wrote is not the store's to delete. */
function removeSkill(id, { home = HOME } = {}) {
  if (!ID.test(String(id))) return false;
  const dir = path.join(skillsDir(home), id);
  if (!readJson(path.join(dir, ".store.json"))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// --------------------------------------------------------------------- mcp ----

const mcpFile = (home = HOME) => path.join(home, "mcp.json");

function readMcp(home = HOME) {
  const j = readJson(mcpFile(home));
  const servers = (j && (j.mcpServers || j.servers)) || {};
  return { json: j && typeof j === "object" ? j : {}, servers: servers && typeof servers === "object" ? servers : {} };
}

/** How this program starts one of its own servers: `arcflare mcp [part]`, or this Node and the script when not on PATH. */
function ownSpec(part, { onPath = require("./mcp/apps").onPath } = {}) {
  const tail = part ? [part] : [];
  return onPath("arcflare")
    ? { command: "arcflare", args: ["mcp", ...tail] }
    : { command: process.execPath, args: [path.join(__dirname, "..", "bin", "arcflare-mcp.js"), ...tail] };
}

/** The command an entry would register, with the user's extra arguments (a folder, say). */
function mcpSpec(entry, extra = [], opts) {
  if (entry.ours) return ownSpec(entry.part, opts);
  return { command: entry.command, args: [...entry.args, ...extra.map(String)] };
}

/** Is this server in ~/.arcflare/mcp.json? */
function mcpState(entry, { home = HOME } = {}) {
  const cur = readMcp(home).servers[entry.id];
  return { installed: !!cur, spec: cur || null };
}

/**
 * Register a server in ~/.arcflare/mcp.json. Only this key is touched; the
 * rest of the file is kept as it is.
 */
function addMcp(entry, { home = HOME, extra = [], onPath } = {}) {
  if (!entry.ours && entry.argument && entry.argument.required && !extra.length) {
    throw new Error(`${entry.name} needs ${entry.argument.name}: ${entry.argument.about}`);
  }
  const { json } = readMcp(home);
  const key = json.mcpServers ? "mcpServers" : json.servers ? "servers" : "mcpServers";
  json[key] = json[key] && typeof json[key] === "object" ? json[key] : {};
  const spec = mcpSpec(entry, extra, onPath ? { onPath } : undefined);
  json[key][entry.id] = spec;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(mcpFile(home), JSON.stringify(json, null, 2) + "\n");
  return { file: mcpFile(home), spec };
}

function removeMcp(id, { home = HOME } = {}) {
  const { json } = readMcp(home);
  const key = json.mcpServers ? "mcpServers" : "servers";
  if (!json[key] || !(id in json[key])) return false;
  delete json[key][id];
  fs.writeFileSync(mcpFile(home), JSON.stringify(json, null, 2) + "\n");
  return true;
}

/** Words to find things by: every word must be somewhere in the id, name, description or category. */
function search(list, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((x) => {
    const hay = [x.id, x.name, x.description, x.category, x.by, ...(x.uses || [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

module.exports = {
  load, bundled, search, cleanSkill, cleanMcp,
  skillState, addSkill, removeSkill, skillsDir,
  mcpState, addMcp, removeMcp, mcpSpec, ownSpec, mcpFile,
  CACHE, ID,
};
