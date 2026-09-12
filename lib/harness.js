// Harness integration: detect the coding agents installed on this machine,
// point them at ArcFlare's OpenAI-compatible endpoint, and launch them.
//
// Rules of engagement for other people's config files:
//   * back up before the first write
//   * prefer the tool's own config command over editing its file by hand
//   * only touch the keys we own; never rewrite the whole document

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const EXE = process.platform === "win32" ? ".exe" : "";
const HOME = os.homedir();

function which(cmd) {
  const w = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(w, [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || null;
}

function firstExisting(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = file + ".arcflare-bak";
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Strip // and /* *​/ comments so JSONC can go through JSON.parse. */
function parseJsonc(text) {
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g,
      (m, g) => (g ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

const BASE = (port) => `http://127.0.0.1:${port}/v1`;

// ---------------------------------------------------------------- opencode --

const opencode = {
  id: "opencode",
  label: "OpenCode",
  detect() {
    const bin = which("opencode") ||
      firstExisting(path.join(process.env.LOCALAPPDATA || "", "hermes", "node", "opencode" + EXE));
    return { installed: Boolean(bin), bin };
  },
  configFile() {
    const dir = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
    return firstExisting(
      path.join(dir, "opencode", "opencode.jsonc"),
      path.join(dir, "opencode", "opencode.json"),
    ) || path.join(dir, "opencode", "opencode.json");
  },
  configure({ port, model, ctx, apiKey }) {
    const file = this.configFile();
    const notes = [];
    let cfg = {};
    if (fs.existsSync(file)) {
      try { cfg = parseJsonc(fs.readFileSync(file, "utf8")); }
      catch (e) { return { ok: false, notes: [`could not parse ${file}: ${e.message}`] }; }
      backup(file);
    }
    cfg.$schema = cfg.$schema || "https://opencode.ai/config.json";
    cfg.provider = cfg.provider || {};
    const models = {};
    models[model.id] = {
      name: `${model.label} (ArcFlare)`,
      tool_call: true,
      limit: { context: ctx, output: Math.min(32768, Math.floor(ctx / 4)) },
    };
    cfg.provider.arcflare = {
      npm: "@ai-sdk/openai-compatible",
      name: "ArcFlare (local)",
      options: { baseURL: BASE(port), apiKey: apiKey || "arcflare" },
      models,
    };
    cfg.model = `arcflare/${model.id}`;
    // .jsonc and .json both parse as JSON once written plainly.
    writeFile(file, JSON.stringify(cfg, null, 2) + "\n");
    notes.push(`wrote ${file}`);
    return { ok: true, notes, file };
  },
  launch({ bin, args }) {
    return spawn(bin, args || [], { stdio: "inherit", shell: process.platform === "win32" });
  },
};

// ------------------------------------------------------------------- codex --

const codex = {
  id: "codex",
  label: "Codex CLI",
  detect() {
    const bin = which("codex");
    return { installed: Boolean(bin), bin };
  },
  configFile() {
    return path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml");
  },
  configure({ port, model, ctx }) {
    const file = this.configFile();
    let text = "";
    if (fs.existsSync(file)) {
      text = fs.readFileSync(file, "utf8");
      backup(file);
    }
    // Drop any block we previously wrote, then re-add it.
    text = text.replace(/\n*\[model_providers\.arcflare\][^\[]*/g, "\n");
    text = text.replace(/^\s*model\s*=.*$/gm, "");
    text = text.replace(/^\s*model_provider\s*=.*$/gm, "");
    text = text.replace(/^\s*model_context_window\s*=.*$/gm, "");
    text = text.trimStart();

    const head =
      `model = "${model.id}"\n` +
      `model_provider = "arcflare"\n` +
      `model_context_window = ${ctx}\n`;
    const block =
      `\n[model_providers.arcflare]\n` +
      `name = "ArcFlare (local)"\n` +
      `base_url = "${BASE(port)}"\n` +
      `wire_api = "chat"\n` +
      `env_key = "ARCFLARE_API_KEY"\n`;

    writeFile(file, head + (text ? "\n" + text.trim() + "\n" : "") + block);
    return { ok: true, notes: [`wrote ${file}`], file };
  },
  launch({ bin, args, port }) {
    return spawn(bin, args || [], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ARCFLARE_API_KEY: process.env.ARCFLARE_API_KEY || "arcflare" },
    });
  },
};

// ------------------------------------------------------------------ hermes --

function hermesBin() {
  return which("hermes") ||
    firstExisting(path.join(process.env.LOCALAPPDATA || "", "hermes", "bin", "hermes" + EXE));
}

function hermesSet(bin, key, value) {
  const r = spawnSync(bin, ["config", "set", key, String(value), "--force"],
    { encoding: "utf8", shell: process.platform === "win32" });
  return r.status === 0;
}

const hermes = {
  id: "hermes",
  label: "Hermes",
  detect() {
    const bin = hermesBin();
    return { installed: Boolean(bin), bin };
  },
  configure({ port, model, apiKey, bin }) {
    const exe = bin || hermesBin();
    if (!exe) return { ok: false, notes: ["hermes not found"] };
    const notes = [];
    // Use Hermes' own config command rather than editing its YAML by hand.
    const pairs = [
      ["providers.arcflare.base_url", BASE(port)],
      ["providers.arcflare.api", BASE(port)],
      ["providers.arcflare.default_model", model.id],
      ["providers.arcflare.model", model.id],
      ["providers.arcflare.discover_models", "true"],
      ["model.provider", "arcflare"],
      ["model.base_url", BASE(port)],
      ["model.api_key", apiKey || "arcflare"],
      ["model.default", model.id],
    ];
    let failed = 0;
    for (const [k, v] of pairs) if (!hermesSet(exe, k, v)) failed++;
    notes.push(failed
      ? `hermes config: ${pairs.length - failed}/${pairs.length} keys set`
      : `hermes config updated (${pairs.length} keys)`);
    return { ok: failed < pairs.length, notes };
  },
  launch({ bin, model, args }) {
    const a = ["--provider", "arcflare", "-m", model.id, ...(args || [])];
    return spawn(bin, a, { stdio: "inherit", shell: process.platform === "win32" });
  },
};

const hermesDesktop = {
  ...hermes,
  id: "hermes-desktop",
  label: "Hermes Desktop",
  detect() {
    const bin = hermesBin();
    return { installed: Boolean(bin), bin, note: "launches `hermes desktop`" };
  },
  launch({ bin, model, args }) {
    const a = ["desktop", ...(args || [])];
    return spawn(bin, a, { stdio: "inherit", shell: process.platform === "win32" });
  },
};

// ------------------------------------------------------------------- plain --

const chat = {
  id: "chat",
  label: "ArcFlare chat",
  builtin: true,
  detect() { return { installed: true, bin: null }; },
  configure() { return { ok: true, notes: [] }; },
  launch() { return null; }, // handled by the CLI itself
};

const ALL = [chat, opencode, hermes, hermesDesktop, codex];

function list() {
  return ALL.map((h) => {
    let d = { installed: false };
    try { d = h.detect(); } catch {}
    return { ...h, ...d, harness: h };
  });
}

function byId(id) {
  return ALL.find((h) => h.id === id) || null;
}

module.exports = { list, byId, ALL, BASE, parseJsonc, backup };
