#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const registry = require("../lib/registry");
const store = require("../lib/store");
const ui = require("../lib/ui");
const { c } = ui;

const VERSION = require("../package.json").version;
const isWin = process.platform === "win32";

function hasOllama() {
  return spawnSync(isWin ? "where" : "which", ["ollama"], { stdio: "ignore" }).status === 0;
}

function timeAgo(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Resolve a name to an entry from the local store (installed) or registry. */
function resolve(name) {
  if (!name) return null;
  const key = String(name).split(":")[0];
  const installed = store.get(key);
  if (installed) return { ...installed, installed: true };
  const reg = registry.find(key);
  if (reg) return { ...reg, base: reg.slug, size: reg.sizes[0], installed: false };
  return null;
}

function notFound(name) {
  console.log(`\n  ${c.red("✗")} model ${c.bold(name)} not found.`);
  const guess = registry.search(String(name).split(":")[0]).slice(0, 3);
  if (guess.length)
    console.log(`  ${c.dim("Did you mean:")} ${guess.map((m) => c.accent(m.slug)).join(", ")}`);
  console.log(`  ${c.dim("Try")} ${c.cyan("arcflare search <q>")} ${c.dim("or")} ${c.cyan("arcflare list")}\n`);
}

async function installFlow(entry) {
  await ui.step("Pulling manifest...");
  await ui.progress("Downloading weights", 1200);
  await ui.step("Verifying digest...");
  store.install({
    slug: entry.slug,
    base: entry.base || entry.slug,
    sizes: entry.sizes,
    size: entry.size,
    author: entry.author,
    license: entry.license,
    category: entry.category,
  });
}

async function cmdPull(name) {
  const m = resolve(name);
  if (!m) return notFound(name), process.exit(1);
  console.log();
  if (m.installed) {
    console.log(`  ${c.green("✓")} ${c.bold(m.slug)} is already installed — up to date.\n`);
    return;
  }
  await installFlow(m);
  console.log(`  ${c.green("✓")} pulled ${c.bold(m.slug)}\n`);
}

async function cmdRun(name, prompt) {
  let m = resolve(name);
  if (!m) return notFound(name), process.exit(1);
  console.log();
  console.log(`  ${c.accent("❯")} arcflare run ${c.bold(name)}`);
  if (!m.installed) {
    await installFlow(m);
    m = resolve(name);
  }
  store.touch(m.slug);
  console.log(`  ${c.green("✓")} ${c.bold(m.slug)} ready  ${c.dim(`(${m.author} · ${m.license})`)}`);
  console.log();

  const backend = hasOllama() && !["Image", "Audio"].includes(m.category);
  if (backend) {
    console.log(c.dim("  Starting via the Ollama backend...\n"));
    const args = ["run", m.base || m.slug];
    if (prompt) args.push(prompt);
    const r = spawnSync("ollama", args, { stdio: "inherit", shell: isWin });
    process.exit(r.status == null ? 0 : r.status);
  }
  if (prompt) {
    console.log(`  ${c.dim(m.slug + ":")} ${demoReply(prompt, m)}\n`);
    return;
  }
  await demoChat(m);
}

function demoReply(input, m) {
  const sys = m.system ? c.dim(`[sys: ${m.system.slice(0, 30)}…] `) : "";
  return `${sys}(demo) install Ollama for real inference — I'd answer "${input.slice(0, 36)}${input.length > 36 ? "…" : ""}" here.`;
}

function demoChat(m) {
  console.log(c.dim("  No local backend detected (install Ollama for real inference)."));
  if (m.system) console.log(c.dim(`  System: ${m.system}`));
  console.log(c.dim(`  Demo chat with ${c.bold(m.slug)} — type a message, or /bye to exit.\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.accent("› ") });
  rl.prompt();
  rl.on("line", (line) => {
    const t = line.trim();
    if (t === "/bye" || t === "/exit") return rl.close();
    if (t) console.log(`  ${c.dim(m.slug + ":")} ${demoReply(t, m)}\n`);
    rl.prompt();
  });
  rl.on("close", () => {
    console.log(c.dim("\n  Bye! ✦"));
    process.exit(0);
  });
  return new Promise(() => {});
}

function cmdList() {
  const items = store.listInstalled();
  console.log();
  if (!items.length) {
    console.log(`  ${c.dim("No models installed. Pull one with")} ${c.cyan("arcflare pull qwen2.5")}\n`);
    return;
  }
  console.log(`  ${c.bold("NAME".padEnd(22) + "SIZE".padEnd(9) + "USED")}`);
  for (const m of items) {
    console.log(`  ${c.accent(m.slug.padEnd(22))}${c.dim(String(m.size).padEnd(9))}${c.dim(timeAgo(m.lastUsed || m.installedAt))}`);
  }
  console.log(`\n  ${c.dim(`${items.length} installed · stored in ${store.DIR}`)}\n`);
}

function cmdSearch(query) {
  const results = registry.search(query);
  console.log();
  if (!results.length) return console.log(`  ${c.dim("No matches for")} "${query}".\n`);
  for (const m of results) {
    const mark = store.get(m.slug) ? c.green(" ✓") : "";
    console.log(`  ${c.accent(m.slug.padEnd(22))}${c.dim(m.description)}${mark}`);
  }
  console.log(`\n  ${c.dim("Run")} ${c.cyan("arcflare run <name>")}\n`);
}

function cmdShow(name) {
  const m = resolve(name);
  if (!m) return notFound(name), process.exit(1);
  console.log();
  console.log(`  ${c.bold(m.slug)}  ${c.dim("by " + m.author)}  ${m.installed ? c.green("[installed]") : c.dim("[not installed]")}`);
  if (m.description) console.log(`  ${m.description}`);
  console.log(`  ${c.dim("Category:")} ${m.category}`);
  console.log(`  ${c.dim("License: ")} ${m.license}`);
  if (m.sizes) console.log(`  ${c.dim("Tags:    ")} ${m.sizes.map((s) => c.cyan(`${m.slug}:${s}`)).join("  ")}`);
  if (m.base && m.base !== m.slug) console.log(`  ${c.dim("Base:    ")} ${m.base}`);
  if (m.system) console.log(`  ${c.dim("System:  ")} ${m.system}`);
  if (m.params && Object.keys(m.params).length)
    console.log(`  ${c.dim("Params:  ")} ${Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`\n  ${c.dim("Run it:")} ${c.accent("arcflare run " + m.slug)}\n`);
}

function cmdRm(name) {
  const key = String(name || "").split(":")[0];
  const ok = store.remove(key);
  console.log();
  console.log(ok ? `  ${c.green("✓")} removed ${c.bold(key)}` : `  ${c.dim(key + " is not installed")}`);
  console.log();
}

// ---- Modelfile (edit / create) -------------------------------------------
function modelfileText(m) {
  return [
    `# Modelfile for ${m.slug}`,
    `FROM ${m.base || m.slug}`,
    `SYSTEM ${m.system || "You are a helpful assistant."}`,
    `PARAMETER temperature ${m.params && m.params.temperature != null ? m.params.temperature : 0.7}`,
    "",
  ].join("\n");
}

function parseModelfile(text) {
  const out = { system: "", params: {}, base: null };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const kw = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (kw === "FROM") out.base = rest.split(":")[0];
    else if (kw === "SYSTEM") out.system = rest;
    else if (kw === "PARAMETER") {
      const [k, v] = rest.split(/\s+/);
      if (k) out.params[k] = isNaN(Number(v)) ? v : Number(v);
    }
  }
  return out;
}

function cmdEdit(name) {
  let m = resolve(name);
  if (!m) return notFound(name), process.exit(1);
  if (!m.installed) {
    store.install({ slug: m.slug, base: m.base, sizes: m.sizes, size: m.size, author: m.author, license: m.license, category: m.category });
    m = resolve(name);
  }
  const tmp = path.join(os.tmpdir(), `arcflare-${m.slug}-${process.pid}.Modelfile`);
  fs.writeFileSync(tmp, modelfileText(m));
  const editor = process.env.EDITOR || process.env.VISUAL || (isWin ? "notepad" : "nano");
  if (!process.stdout.isTTY) {
    console.log(`\n  ${c.dim("(no TTY) current Modelfile:")}\n`);
    console.log(fs.readFileSync(tmp, "utf8"));
    fs.unlinkSync(tmp);
    return;
  }
  console.log(`\n  ${c.dim(`opening ${m.slug} in ${editor}…`)}`);
  spawnSync(editor, [tmp], { stdio: "inherit", shell: isWin });
  const parsed = parseModelfile(fs.readFileSync(tmp, "utf8"));
  store.setConfig(m.slug, { system: parsed.system, params: parsed.params, base: parsed.base || m.base });
  try { fs.unlinkSync(tmp); } catch {}
  console.log(`  ${c.green("✓")} saved ${c.bold(m.slug)} ${c.dim("(SYSTEM + parameters)")}\n`);
}

function cmdCreate(name, flags) {
  if (!name) return console.log(`\n  ${c.red("✗")} usage: arcflare create <name> --from <base> [--system "..."]\n`);
  const baseName = flags.from;
  const base = baseName ? registry.find(baseName) || store.get(baseName) : null;
  if (!base) return console.log(`\n  ${c.red("✗")} need a valid --from base model (see ${c.cyan("arcflare list")}/${c.cyan("search")})\n`);
  store.install({ slug: name, base: base.slug || baseName, sizes: base.sizes, size: base.size, author: "you", license: "custom", category: base.category });
  if (flags.system) store.setConfig(name, { system: flags.system });
  console.log(`\n  ${c.green("✓")} created ${c.bold(name)} ${c.dim("from " + (base.slug || baseName))}`);
  console.log(`  ${c.dim("Edit it:")} ${c.accent("arcflare edit " + name)}   ${c.dim("Run it:")} ${c.accent("arcflare run " + name)}\n`);
}

function cmdCp(src, dst) {
  const m = store.get(String(src || "").split(":")[0]);
  if (!m) return console.log(`\n  ${c.red("✗")} ${src} is not installed (only installed models can be copied)\n`);
  if (!dst) return console.log(`\n  ${c.red("✗")} usage: arcflare cp <source> <dest>\n`);
  store.install({ slug: dst, base: m.base, size: m.size, author: m.author, license: m.license, category: m.category });
  store.setConfig(dst, { system: m.system, params: m.params });
  console.log(`\n  ${c.green("✓")} copied ${c.bold(src)} → ${c.bold(dst)}\n`);
}

function cmdPush(name) {
  console.log();
  console.log(`  ${c.accent("❯")} arcflare push ${c.bold(name || "<model>")}`);
  console.log(`  ${c.dim("Publishing to the ArcFlare hub is coming soon.")}`);
  console.log(`  ${c.dim("Share your Modelfile at")} ${c.cyan("https://github.com/Hakeperty/ArcFlare-Code")}\n`);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function help() {
  console.log(ui.banner());
  console.log(`  ${c.bold("Usage:")} arcflare <command> [args]\n`);
  const rows = [
    ["run <model> [prompt]", "run a model (auto-pulls if needed)"],
    ["pull <model>", "download a model into the local store"],
    ["list", "list installed models"],
    ["search <query>", "search the model registry"],
    ["show <model>", "show model details + config"],
    ["edit <model>", "edit a model's Modelfile (system, params)"],
    ["create <name> --from <base>", "make a custom model"],
    ["cp <src> <dst>", "copy an installed model"],
    ["rm <model>", "remove an installed model"],
    ["push <model>", "publish a model (coming soon)"],
    ["help / version", "show help / version"],
  ];
  for (const [cmd, desc] of rows) console.log(`  ${c.accent(cmd.padEnd(30))}${c.dim(desc)}`);
  console.log(`\n  ${c.dim("Backend:")} delegates to ${c.bold("Ollama")} when installed, else a demo chat.`);
  console.log(`  ${c.dim("Example:")} ${c.cyan("arcflare run qwen2.5")}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (cmd) {
    case "run": return cmdRun(positional[0], positional.slice(1).join(" ") || null);
    case "pull": return cmdPull(positional[0]);
    case "list": case "ls": return cmdList();
    case "search": return cmdSearch(positional[0]);
    case "show": return cmdShow(positional[0]);
    case "edit": return cmdEdit(positional[0]);
    case "create": return cmdCreate(positional[0], flags);
    case "cp": return cmdCp(positional[0], positional[1]);
    case "rm": case "remove": return cmdRm(positional[0]);
    case "push": return cmdPush(positional[0]);
    case "path": return console.log(store.DIR);
    case "version": case "-v": case "--version": return console.log(`arcflare v${VERSION}`);
    case undefined: case "help": case "-h": case "--help": return help();
    default:
      console.log(`\n  ${c.red("✗")} unknown command: ${c.bold(cmd)}`);
      return help();
  }
}

main().catch((e) => {
  console.error(c.red("error:"), e.message);
  process.exit(1);
});
