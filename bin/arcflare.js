#!/usr/bin/env node
"use strict";

const readline = require("readline");
const { spawnSync } = require("child_process");
const registry = require("../lib/registry");
const ui = require("../lib/ui");
const { c } = ui;

const VERSION = require("../package.json").version;
const isWin = process.platform === "win32";

function hasOllama() {
  const probe = spawnSync(isWin ? "where" : "which", ["ollama"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function notFound(name) {
  console.log(`\n  ${c.red("✗")} model ${c.bold(name)} not found in the registry.`);
  const guess = registry.search(String(name).split(":")[0]).slice(0, 3);
  if (guess.length) {
    console.log(`  ${c.dim("Did you mean:")} ${guess.map((m) => c.accent(m.slug)).join(", ")}`);
  }
  console.log(`  ${c.dim("Run")} ${c.cyan("arcflare list")} ${c.dim("to see everything.")}\n`);
}

async function run(model) {
  const m = registry.find(model);
  if (!m) {
    notFound(model);
    process.exit(1);
  }
  console.log();
  console.log(`  ${c.accent("❯")} arcflare run ${c.bold(model)}`);
  await ui.step("Pulling manifest...");
  await ui.progress("Downloading weights", 1200);
  await ui.step("Loading into memory...");
  console.log(
    `  ${c.green("✓")} ${c.bold(m.slug)} is ready  ${c.dim(`(${m.author} · ${m.license})`)}`,
  );
  console.log();

  const backendOk = hasOllama() && !["Image", "Audio"].includes(m.category);
  if (backendOk) {
    console.log(c.dim("  Starting via the Ollama backend...\n"));
    const r = spawnSync("ollama", ["run", model], {
      stdio: "inherit",
      shell: isWin,
    });
    process.exit(r.status == null ? 0 : r.status);
  }
  await demoChat(m);
}

function demoReply(input, m) {
  const replies = [
    `(demo) I'd answer that here. Install a local backend to chat with ${m.slug} for real.`,
    `(demo) ${m.slug} would respond to "${input.slice(0, 40)}${input.length > 40 ? "…" : ""}" — try a real backend for live output.`,
    `(demo) Nice prompt! This build streams canned replies; wire up Ollama for actual inference.`,
  ];
  return replies[input.length % replies.length];
}

function demoChat(m) {
  console.log(c.dim("  No local backend detected (install Ollama for real inference)."));
  console.log(c.dim(`  Demo chat with ${c.bold(m.slug)} — type a message, or /bye to exit.\n`));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.accent("› "),
  });
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

async function pull(model) {
  const m = registry.find(model);
  if (!m) {
    notFound(model);
    process.exit(1);
  }
  console.log();
  await ui.step("Pulling manifest...");
  await ui.progress("Downloading weights", 1400);
  console.log(`  ${c.green("✓")} pulled ${c.bold(m.slug)}\n`);
}

function list() {
  console.log();
  console.log(`  ${c.bold("NAME".padEnd(22))}${c.bold("CATEGORY".padEnd(12))}${c.bold("LICENSE")}`);
  for (const m of registry.models) {
    console.log(
      `  ${c.accent(m.slug.padEnd(22))}${c.dim(m.category.padEnd(12))}${m.license}`,
    );
  }
  console.log(`\n  ${c.dim(`${registry.models.length} models. Run`)} ${c.cyan("arcflare run <name>")}\n`);
}

function search(query) {
  const results = registry.search(query);
  console.log();
  if (!results.length) {
    console.log(`  ${c.dim("No models match")} "${query}".\n`);
    return;
  }
  for (const m of results) {
    console.log(`  ${c.accent(m.slug.padEnd(22))}${c.dim(m.description)}`);
  }
  console.log();
}

function show(model) {
  const m = registry.find(model);
  if (!m) {
    notFound(model);
    process.exit(1);
  }
  console.log();
  console.log(`  ${c.bold(m.slug)}  ${c.dim("by " + m.author)}`);
  console.log(`  ${m.description}`);
  console.log(`  ${c.dim("Category:")} ${m.category}`);
  console.log(`  ${c.dim("License: ")} ${m.license}`);
  console.log(`  ${c.dim("Tags:    ")} ${m.sizes.map((s) => c.cyan(`${m.slug}:${s}`)).join("  ")}`);
  console.log(`\n  ${c.dim("Run it:")} ${c.accent("arcflare run " + m.slug)}\n`);
}

function push(arg) {
  console.log();
  console.log(`  ${c.accent("❯")} arcflare push ${c.bold(arg || "<model>")}`);
  console.log(`  ${c.dim("Publishing to the ArcFlare hub is coming soon.")}`);
  console.log(`  ${c.dim("For now, share your model card at")} ${c.cyan("https://github.com/Hakeperty/ArcFlare-Code")}\n`);
}

function help() {
  console.log(ui.banner());
  console.log(`  ${c.bold("Usage:")} arcflare <command> [model]\n`);
  const rows = [
    ["run <model>", "pull (if needed) and run a model"],
    ["pull <model>", "download a model"],
    ["list", "list available models"],
    ["search <query>", "search the registry"],
    ["show <model>", "show model details"],
    ["push <model>", "publish a model (coming soon)"],
    ["help", "show this help"],
    ["version", "print the version"],
  ];
  for (const [cmd, desc] of rows) {
    console.log(`  ${c.accent(cmd.padEnd(18))}${c.dim(desc)}`);
  }
  console.log(`\n  ${c.dim("Example:")} ${c.cyan("arcflare run qwen2.5")}\n`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      return run(arg);
    case "pull":
      return pull(arg);
    case "list":
    case "ls":
      return list();
    case "search":
      return search(arg);
    case "show":
      return show(arg);
    case "push":
      return push(arg);
    case "version":
    case "-v":
    case "--version":
      return console.log(`arcflare v${VERSION}`);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return help();
    default:
      console.log(`\n  ${c.red("✗")} unknown command: ${c.bold(cmd)}`);
      return help();
  }
}

main().catch((e) => {
  console.error(c.red("error:"), e.message);
  process.exit(1);
});
