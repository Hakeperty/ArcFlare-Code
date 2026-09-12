// Skills: reusable instruction bundles, loaded only when they are needed.
//
// A skill is a directory containing SKILL.md with YAML-ish frontmatter:
//
//   ---
//   name: deploy
//   description: How to deploy this project and roll back a bad release
//   ---
//   ...the actual instructions...
//
// The model sees only `name: description` for each skill — roughly 15 tokens
// each — and pulls a full body (often 1000+ tokens) only when it decides the
// skill applies. On a local model that difference is the whole budget.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");

function skillRoots(cwd = process.cwd()) {
  const out = [];
  const add = (p) => {
    if (p && fs.existsSync(p) && !out.includes(p)) out.push(p);
  };
  add(path.join(cwd, ".arcflare", "skills"));
  add(path.join(cwd, ".claude", "skills"));      // reuse what is already there
  add(path.join(HOME, "skills"));
  add(path.join(os.homedir(), ".claude", "skills"));
  return out;
}

/** Parse the leading `---` frontmatter block. Values are treated as strings. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Discover skills without reading their bodies into memory. */
function discover(cwd = process.cwd()) {
  const found = [];
  const seen = new Set();
  for (const root of skillRoots(cwd)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(root, e.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      // Read only the head of the file: frontmatter lives at the top.
      let head = "";
      try {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        head = buf.toString("utf8", 0, n);
      } catch { continue; }
      const { meta } = parseFrontmatter(head);
      const name = meta.name || e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({
        name,
        description: meta.description || "",
        dir: path.join(root, e.name),
        file,
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** One line per skill — what the model sees up front. */
function index(skills) {
  return skills.map((s) => `${s.name}: ${String(s.description).slice(0, 140)}`);
}

/** Load a skill body on demand. */
function load(skills, name) {
  const s = skills.find((x) => x.name === name) ||
    skills.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!s) return null;
  let text = "";
  try { text = fs.readFileSync(s.file, "utf8"); } catch { return null; }
  const { body } = parseFrontmatter(text);
  // List sibling files so the skill can point at scripts and references.
  let files = [];
  try {
    files = fs.readdirSync(s.dir).filter((f) => f !== "SKILL.md");
  } catch {}
  return { ...s, body: body.trim(), files };
}

module.exports = { discover, index, load, parseFrontmatter, skillRoots, HOME };
