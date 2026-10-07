// `arcflare harness update <id|all>`: bring the coding agents themselves up to
// date, each with the updater its own makers ship.
//
// Planning is separate from running so it can be tested and printed: every
// command is shown before it starts, and none of them goes through a shell.

const { spawn, spawnSync } = require("child_process");
const { npmCommand } = require("./update");

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
}

/** Was this binary installed by Homebrew? Then Homebrew should update it. */
function viaBrew(bin) {
  return /[\\/](Cellar|homebrew|linuxbrew)[\\/]/i.test(String(bin || ""));
}

/**
 * The npm prefix a package was installed into, judged from its binary: npm's
 * global layout is <prefix>/node_modules/<pkg> beside the shim on Windows and
 * <prefix>/lib/node_modules/<pkg> above bin/ elsewhere. Null if it is not an
 * npm install. A harness bundled with another tool (OpenCode inside Hermes'
 * own node folder) is updated where it lives, not into the global prefix.
 */
function npmPrefixFor(bin, pkg, exists = require("fs").existsSync) {
  const path = require("path");
  const dir = path.dirname(String(bin || ""));
  if (exists(path.join(dir, "node_modules", ...pkg.split("/")))) return dir;
  const up = path.dirname(dir);
  if (exists(path.join(up, "lib", "node_modules", ...pkg.split("/")))) return up;
  return null;
}

function npmPlan(pkg, prefix) {
  const args = ["install", "-g", `${pkg}@latest`, ...(prefix ? ["--prefix", prefix] : [])];
  return { cmd: "npm", args, show: `npm ${args.join(" ")}` };
}

/**
 * What would update `id`, given where its binary is. Returns
 * { cmd, args, show } to run, or { skip } with the reason.
 */
function plan(id, bin, exists) {
  if (id === "chat" || id === "agent") return { skip: "built in — arcflare update covers it" };
  if (id === "hermes-desktop") return { skip: "part of Hermes — update hermes" };
  if (!bin) return { skip: "not installed" };
  switch (id) {
    case "codex":
      if (viaBrew(bin)) return { cmd: "brew", args: ["upgrade", "codex"], show: "brew upgrade codex" };
      return npmPlan("@openai/codex", npmPrefixFor(bin, "@openai/codex", exists));
    case "opencode": {
      if (viaBrew(bin)) return { cmd: "brew", args: ["upgrade", "opencode"], show: "brew upgrade opencode" };
      const prefix = npmPrefixFor(bin, "opencode-ai", exists);
      if (prefix) return npmPlan("opencode-ai", prefix);
      return { cmd: bin, args: ["upgrade"], show: "opencode upgrade" };
    }
    case "hermes":
      return { cmd: bin, args: ["update"], show: "hermes update" };
    case "claude":
      return { cmd: bin, args: ["update"], show: "claude update" };
    default:
      return { skip: "no known updater" };
  }
}

/** Every harness ArcFlare knows plus Claude Code, with its binary if found. */
function targets() {
  const harness = require("./harness");
  const rows = harness.list().map((h) => ({ id: h.id, label: h.label, bin: h.bin || null }));
  rows.push({ id: "claude", label: "Claude Code", bin: which("claude") });
  return rows;
}

/**
 * Spawn without a shell. A Windows .cmd/.bat shim cannot be spawned directly,
 * so it goes through cmd.exe with the path quoted and arguments that are
 * constants from plan() — nothing a config file or a person typed.
 */
function runPlan(p, { stdio = "inherit" } = {}) {
  let cmd = p.cmd;
  let args = p.args;
  let extra = {};
  if (process.platform === "win32" && cmd !== "npm" && !/\.(exe|cmd|bat)$/i.test(cmd)) {
    // `where` can list npm's extensionless sh shim first; use its .cmd/.exe twin.
    const fs = require("fs");
    cmd = [".exe", ".cmd"].map((e) => cmd + e).find((p) => fs.existsSync(p)) || cmd;
  }
  if (cmd === "npm") {
    const n = npmCommand(args);
    cmd = n.cmd; args = n.args; extra.shell = n.shell;
  } else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    args = ["/d", "/s", "/c", `""${cmd}" ${p.args.join(" ")}"`];
    cmd = process.env.ComSpec || "cmd.exe";
    extra.windowsVerbatimArguments = true;
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio, windowsHide: true, ...extra });
    child.on("error", (e) => resolve({ code: -1, error: e.message }));
    child.on("close", (code) => resolve({ code }));
  });
}

module.exports = { plan, targets, runPlan, viaBrew, npmPrefixFor };
