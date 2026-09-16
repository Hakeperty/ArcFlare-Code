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

// ---------------------------------------------------------------- auto mode --
//
// Every harness that runs tools has its own name for the same thing - do it
// without stopping to ask - and every one of them can be told at launch. That
// is where we want it: which commands a person is willing to wave through is
// their standing policy, and an argument we pass for one run cannot outlive the
// run. Nothing here writes an approval setting into anyone's config file.
//
// Each harness that has one carries an `auto` descriptor:
//
//   flags      what to pass on the command line
//   env        the same switch for a harness that has no flag to pass
//   conflicts  arguments that mean the user already answered, so we say nothing
//   label      what we actually do, shown in the menu
//   note       what auto mode costs, in that tool's own terms

/** Launch arguments that put a harness into auto mode. */
function autoArgs(auto, approve, extra = []) {
  if (!auto || !auto.flags || approve !== "yolo") return [];
  // An explicit approval argument from the user wins. They answered the
  // question themselves, and two answers on one command line is how you end up
  // running under the one you did not mean.
  const owned = new Set([...auto.flags, ...(auto.conflicts || [])]);
  if ((extra || []).some((a) => owned.has(String(a).split("=")[0]))) return [];
  return [...auto.flags];
}

/** Environment for a harness whose auto mode is a variable rather than a flag. */
function autoEnv(auto, approve) {
  if (!auto || !auto.env || approve !== "yolo") return {};
  return { ...auto.env };
}

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
  // opencode's own flag, in its own words: "auto-approve permissions that are
  // not explicitly denied". Anything denied in their config stays denied.
  auto: {
    label: "--auto",
    note: "approves anything not explicitly denied",
    flags: ["--auto"],
  },
  launch({ bin, args, approve }) {
    const extra = args || [];
    return spawn(bin, [...autoArgs(this.auto, approve, extra), ...extra],
      { stdio: "inherit", shell: process.platform === "win32" });
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
    text = text.replace(/^\s*model_auto_compact_token_limit\s*=.*$/gm, "");
    text = text.trimStart();

    const head =
      `model = "${model.id}"\n` +
      `model_provider = "arcflare"\n` +
      `model_context_window = ${ctx}\n` +
      // Codex has no metadata entry for a local model, so it falls back to a
      // compaction point meant for far smaller windows. Leave 20% headroom and
      // it compacts on our terms rather than the fallback's.
      `model_auto_compact_token_limit = ${Math.floor(ctx * 0.8)}\n`;
    const block =
      `\n[model_providers.arcflare]\n` +
      `name = "ArcFlare (local)"\n` +
      `base_url = "${BASE(port)}"\n` +
      // Codex 0.152+ dropped the chat wire API and refuses to load a config
      // that still asks for it. llama-server implements /v1/responses, so the
      // API Codex now requires is one we can actually serve.
      `wire_api = "responses"\n` +
      `env_key = "ARCFLARE_API_KEY"\n`;

    writeFile(file, head + (text ? "\n" + text.trim() + "\n" : "") + block);
    return { ok: true, notes: [`wrote ${file}`], file };
  },
  // Codex splits the question in two - an approval policy and a sandbox - and
  // `-a never` alone still runs every command inside the sandbox, where a write
  // outside the workspace fails instead of asking. Only the bypass flag means
  // what the menu says. It is a real sandbox on every platform Codex supports,
  // Windows included (`codex sandbox` runs under a restricted token there), so
  // this genuinely takes the walls down rather than just silencing a prompt.
  auto: {
    label: "--dangerously-bypass-approvals-and-sandbox",
    note: "and drops Codex's sandbox",
    flags: ["--dangerously-bypass-approvals-and-sandbox"],
    conflicts: ["-a", "--ask-for-approval", "-s", "--sandbox", "--approve-for-me"],
  },
  launch({ bin, args, port, approve }) {
    const extra = args || [];
    return spawn(bin, [...autoArgs(this.auto, approve, extra), ...extra], {
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

// Where `hermes desktop` leaves its packaged Electron app, derived from the
// CLI's own location. Finding nothing is not an error - it just means we let
// Hermes build rather than assert a layout we cannot see.
function desktopPrebuilt(bin) {
  const exe = bin || hermesBin();
  if (!exe) return false;
  const release = path.join(path.dirname(path.dirname(exe)),
    "hermes-agent", "apps", "desktop", "release");
  for (const n of ["win-unpacked", "linux-unpacked", "mac", "mac-arm64"]) {
    try {
      const d = path.join(release, n);
      if (fs.existsSync(d) && fs.readdirSync(d).length) return true;
    } catch { /* unreadable is the same as absent */ }
  }
  return false;
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
  configure({ port, model, apiKey, bin, cwd }) {
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
      // Where Hermes' tools actually operate. Neither the process working
      // directory nor `--in` moves them - the default `terminal.cwd: .`
      // resolves to the user's home, so `arcflare use hermes` inside a project
      // would otherwise hand you an agent editing files in ~. Re-pointed on
      // every `use`, so it tracks whichever project you ran it from.
      ["terminal.cwd", cwd || process.cwd()],
    ];
    let failed = 0;
    for (const [k, v] of pairs) if (!hermesSet(exe, k, v)) failed++;
    notes.push(failed
      ? `hermes config: ${pairs.length - failed}/${pairs.length} keys set`
      : `hermes config updated (${pairs.length} keys)`);
    return { ok: failed < pairs.length, notes };
  },
  // Hermes' own flag. Its hardline blocklist still refuses what it refuses -
  // `--yolo` skips the approval prompts, it does not unlock the commands the
  // tool will not run at all.
  auto: {
    label: "--yolo",
    note: "its hardline blocklist still applies",
    flags: ["--yolo"],
    conflicts: ["--safe-mode"],
  },
  launch({ bin, model, args, approve }) {
    const extra = args || [];
    // Scopes session restore to this project, so `--resume`/`-c` picks up the
    // work you did here rather than the last thing you touched anywhere.
    // Measured: this does NOT move where the tools operate - `terminal.cwd`,
    // set in configure() above, is the only thing that does.
    const where = extra.includes("--in") || extra.includes("--no-restore-cwd")
      ? []
      : ["--in", process.cwd()];
    const a = ["--provider", "arcflare", "-m", model.id, ...where,
      ...autoArgs(this.auto, approve, extra), ...extra];
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
  // Desktop has no --yolo to pass: in the app the switch is /yolo or the status
  // bar. HERMES_YOLO_MODE is the same switch thrown before the process starts -
  // `hermes desktop` hands its environment to Electron, Electron hands it to the
  // Python backend it spawns, and the backend freezes the value at import - so
  // the window opens already in auto mode rather than waiting to be toggled.
  auto: {
    label: "HERMES_YOLO_MODE=1",
    note: "the window opens with approvals off",
    env: { HERMES_YOLO_MODE: "1" },
  },
  launch({ bin, model, args, approve }) {
    const extra = args || [];
    // `hermes desktop` reinstalls workspace deps and rebuilds the Electron app
    // on every launch, silently, for minutes - even when the packaged app is
    // sitting right there. Skip it when we can see the built artefact; if we
    // cannot find it, let Hermes build as usual rather than guess.
    const skip = extra.includes("--skip-build") || extra.includes("--force-build") ||
      !desktopPrebuilt(bin) ? [] : ["--skip-build"];
    const a = ["desktop", ...skip, ...extra];
    return spawn(bin, a, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...autoEnv(this.auto, approve) },
    });
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

// The same thing `arcflare agent` runs, reachable from the menu. It is the one
// harness here whose tools ArcFlare runs itself, so its auto mode is a mode the
// agent is started in rather than an argument handed to someone else's binary.
const agent = {
  id: "agent",
  label: "ArcFlare agent",
  builtin: true,
  tools: true,
  auto: {
    label: "auto mode",
    note: "edits files, runs commands, opens apps",
  },
  detect() { return { installed: true, bin: null }; },
  configure() { return { ok: true, notes: [] }; },
  launch() { return null; },
};

const ALL = [chat, agent, opencode, hermes, hermesDesktop, codex];

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

module.exports = {
  list, byId, ALL, BASE, parseJsonc, backup, desktopPrebuilt, autoArgs, autoEnv,
};
