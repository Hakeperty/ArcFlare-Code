#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const registry = require("../lib/registry");
const store = require("../lib/store");
const engine = require("../lib/engine");
const ui = require("../lib/ui");
const { c } = ui;

const VERSION = require("../package.json").version;
const isWin = process.platform === "win32";

function humanBytes(n) {
  if (!n) return "0B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)}${u[i]}`;
}

/** Download a model's GGUF via the engine, with a live progress bar. */
async function downloadModel(url) {
  let lastPct = -1;
  await engine.download(url, (done, total) => {
    if (!total) return;
    const pct = Math.floor((done / total) * 100);
    if (pct === lastPct) return;
    lastPct = pct;
    const width = 20;
    const filled = Math.round((pct / 100) * width);
    const bar = c.accent("█".repeat(filled)) + c.dim("░".repeat(width - filled));
    process.stdout.write(
      `\r  ${bar} ${String(pct).padStart(3)}%  ${c.dim(humanBytes(done) + "/" + humanBytes(total))}   `,
    );
  });
  process.stdout.write("\n");
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

async function cmdPull(name) {
  const m = resolve(name);
  if (!m) return notFound(name), process.exit(1);
  console.log();
  if (!m.gguf) {
    if (!m.installed) store.install(metadataOf(m));
    console.log(`  ${c.green("✓")} ${c.bold(m.slug)} added ${c.dim("(listed for discovery — no local engine build yet)")}\n`);
    return;
  }
  if (engine.isDownloaded(m.gguf)) {
    console.log(`  ${c.green("✓")} ${c.bold(m.slug)} is already downloaded.\n`);
  } else {
    console.log(`  pulling ${c.bold(m.slug)} ${c.dim("(" + engine.fileNameFromUrl(m.gguf) + ")")}`);
    await downloadModel(m.gguf);
    console.log(`  ${c.green("✓")} pulled ${c.bold(m.slug)}\n`);
  }
  store.install({ ...metadataOf(m), gguf: m.gguf, file: engine.localPathFor(m.gguf) });
}

function metadataOf(m) {
  return {
    slug: m.slug, base: m.base, sizes: m.sizes, size: m.size,
    author: m.author, license: m.license, category: m.category,
  };
}

async function cmdRun(name, prompt) {
  let m = resolve(name);
  if (!m) return notFound(name), process.exit(1);
  console.log();
  console.log(`  ${c.accent("❯")} arcflare run ${c.bold(name)}`);

  // No local engine build for this model -> demo.
  if (!m.gguf) {
    if (!m.installed) {
      store.install(metadataOf(m));
      m = resolve(name);
    }
    store.touch(m.slug);
    console.log(`  ${c.green("✓")} ${c.bold(m.slug)} ready  ${c.dim(`(${m.author} · ${m.license})`)}`);
    console.log(`  ${c.dim("No local build for this model yet — runnable today:")} ${c.cyan("qwen2.5")}, ${c.cyan("llama3.2")}, ${c.cyan("gemma2")}, ${c.cyan("mistral")}, ${c.cyan("deepseek-r1")}, ${c.cyan("qwen2.5-coder")}.`);
    if (prompt) return void console.log(`\n  ${c.dim(m.slug + ":")} ${demoReply(prompt, m)}\n`);
    return demoChat(m);
  }

  // Ensure the GGUF is downloaded, then run it with ArcFlare's engine.
  if (!engine.isDownloaded(m.gguf)) {
    console.log(`  pulling ${c.bold(m.slug)} ${c.dim("(" + engine.fileNameFromUrl(m.gguf) + ")")}`);
    await downloadModel(m.gguf);
  }
  store.install({ ...metadataOf(m), gguf: m.gguf, file: engine.localPathFor(m.gguf) });
  store.touch(m.slug);
  console.log(`  ${c.dim("loading " + m.slug + " — first load can take a few seconds...")}\n`);
  await liveChat(m, engine.localPathFor(m.gguf), prompt);
}

/** Real streaming chat with ArcFlare's engine, applying the model's SYSTEM prompt. */
async function liveChat(m, modelPath, prompt) {
  let session;
  try {
    session = await engine.createSession(modelPath, m.system || undefined);
  } catch (e) {
    console.log(`  ${c.red("failed to load model:")} ${e.message}\n`);
    process.exit(1);
  }

  async function ask(text) {
    process.stdout.write(`  ${c.dim(m.slug + ":")} `);
    await session.prompt(text, (tok) => process.stdout.write(tok));
    process.stdout.write("\n\n");
  }

  if (prompt) {
    await ask(prompt);
    await session.dispose();
    return;
  }
  console.log(c.dim(`  Chatting with ${c.bold(m.slug)} — type a message, or /bye to exit.\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.accent("› ") });
  rl.prompt();
  rl.on("line", async (line) => {
    const t = line.trim();
    if (t === "/bye" || t === "/exit") return rl.close();
    if (t) {
      rl.pause();
      try { await ask(t); } catch (e) { console.log(`  ${c.red("error:")} ${e.message}`); }
      rl.resume();
    }
    rl.prompt();
  });
  rl.on("close", async () => {
    await session.dispose().catch(() => {});
    console.log(c.dim("\n  Bye! ✦"));
    process.exit(0);
  });
  await new Promise(() => {});
}

function demoReply(input, m) {
  const sys = m.system ? c.dim(`[sys: ${m.system.slice(0, 30)}…] `) : "";
  return `${sys}(demo) no local build for ${m.slug} yet — I'd answer "${input.slice(0, 36)}${input.length > 36 ? "…" : ""}" here.`;
}

function demoChat(m) {
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
  if (!name) return console.log(`\n  ${c.red("✗")} usage: arcflare create <name> --from <base> [--system "..."]\n                 arcflare create <name> -f Modelfile\n`);

  // From a Modelfile: arcflare create mybot -f Modelfile
  const file = flags.file || flags.f;
  if (file && typeof file === "string") {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return console.log(`\n  ${c.red("✗")} cannot read Modelfile: ${file}\n`);
    }
    const mf = parseModelfile(text);
    const base = mf.base ? registry.find(mf.base) || store.get(mf.base) : null;
    if (!base) return console.log(`\n  ${c.red("✗")} Modelfile needs a valid ${c.bold("FROM <base>")} line.\n`);
    store.install({ slug: name, base: base.slug || mf.base, sizes: base.sizes, size: base.size, author: "you", license: "custom", category: base.category });
    store.setConfig(name, { system: mf.system, params: mf.params });
    console.log(`\n  ${c.green("✓")} created ${c.bold(name)} ${c.dim("from " + (base.slug || mf.base) + " (Modelfile)")}`);
    console.log(`  ${c.dim("Run it:")} ${c.accent("arcflare run " + name)}\n`);
    return;
  }

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

// ---- serve / ps / stop ----------------------------------------------------
const DEFAULT_PORT = Number(process.env.ARCFLARE_PORT || 11435);

function cmdServe(flags) {
  const http = require("http");
  const port = Number(flags.port || DEFAULT_PORT);
  const host = flags.host || "127.0.0.1";

  const send = (res, code, body, asText) => {
    res.writeHead(code, {
      "content-type": asText ? "text/plain" : "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(asText ? String(body) : JSON.stringify(body, null, 2));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let d = "";
      req.on("data", (ch) => (d += ch));
      req.on("end", () => {
        try {
          resolve(d ? JSON.parse(d) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const p = req.url.split("?")[0];
    const log = (code) => console.log(`  ${c.dim(new Date().toISOString().slice(11, 19))} ${req.method} ${p} ${code === 200 ? c.green(code) : c.dim(code)}`);
    try {
      if (req.method === "GET" && p === "/") return send(res, 200, "ArcFlare is running", true), log(200);
      if (req.method === "GET" && p === "/api/tags") return send(res, 200, { models: store.listInstalled() }), log(200);
      if (req.method === "GET" && p === "/api/registry") return send(res, 200, { models: registry.models }), log(200);
      if (req.method === "POST" && p === "/api/pull") {
        const { name } = await readBody(req);
        const m = resolve(name);
        if (!m) return send(res, 404, { error: "model not found" }), log(404);
        if (!m.installed) store.install({ slug: m.slug, base: m.base, sizes: m.sizes, size: m.size, author: m.author, license: m.license, category: m.category });
        return send(res, 200, { status: "success", model: store.get(m.slug) }), log(200);
      }
      if (req.method === "POST" && p === "/api/show") {
        const { name } = await readBody(req);
        const m = resolve(name);
        return m ? (send(res, 200, m), log(200)) : (send(res, 404, { error: "model not found" }), log(404));
      }
      if (req.method === "POST" && p === "/api/create") {
        const { name, from, system } = await readBody(req);
        const base = from ? registry.find(from) || store.get(from) : null;
        if (!name || !base) return send(res, 400, { error: "need name + valid 'from'" }), log(400);
        store.install({ slug: name, base: base.slug || from, sizes: base.sizes, size: base.size, author: "you", license: "custom", category: base.category });
        if (system) store.setConfig(name, { system });
        return send(res, 200, { status: "success", model: store.get(name) }), log(200);
      }
      if (req.method === "POST" && (p === "/api/generate" || p === "/api/chat")) {
        const body = await readBody(req);
        const m = resolve(body.model);
        if (!m) return send(res, 404, { error: "model not found" }), log(404);
        store.touch(m.slug);
        // Build chat messages (apply the model's SYSTEM prompt).
        const messages = [];
        if (m.system) messages.push({ role: "system", content: m.system });
        if (p === "/api/chat" && Array.isArray(body.messages)) {
          messages.push(...body.messages);
        } else {
          messages.push({ role: "user", content: body.prompt || "" });
        }
        if (m.gguf && engine.isDownloaded(m.gguf)) {
          const text = await engine.chatOnce(engine.localPathFor(m.gguf), messages);
          return send(res, 200, { model: m.slug, response: text, message: { role: "assistant", content: text }, done: true }), log(200);
        }
        const text = m.gguf
          ? `(not downloaded — run: arcflare pull ${m.slug})`
          : demoReply(body.prompt || (body.messages && body.messages.at(-1)?.content) || "", m);
        return send(res, 200, { model: m.slug, response: text, message: { role: "assistant", content: text }, done: true }), log(200);
      }
      if (req.method === "DELETE" && p === "/api/delete") {
        const { name } = await readBody(req);
        const ok = store.remove(String(name || "").split(":")[0]);
        return send(res, ok ? 200 : 404, { status: ok ? "success" : "not found" }), log(ok ? 200 : 404);
      }
      send(res, 404, { error: "unknown endpoint" });
      log(404);
    } catch (e) {
      send(res, 500, { error: e.message });
      log(500);
    }
  });

  server.on("error", (e) => {
    console.error(`  ${c.red("serve error:")} ${e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(ui.banner());
    console.log(`  ${c.green("●")} ArcFlare API on ${c.accent(`http://${host}:${port}`)}\n`);
    console.log(`  ${c.dim("GET  /api/tags          list installed models")}`);
    console.log(`  ${c.dim("POST /api/pull          { name }")}`);
    console.log(`  ${c.dim("POST /api/generate      { model, prompt }")}`);
    console.log(`  ${c.dim("POST /api/chat          { model, messages }")}`);
    console.log(`  ${c.dim("POST /api/create        { name, from, system }")}`);
    console.log(`  ${c.dim("DELETE /api/delete      { name }")}\n`);
    console.log(`  ${c.dim("Ctrl-C to stop.")}\n`);
  });
  return new Promise(() => {});
}

function cmdPs(flags) {
  const http = require("http");
  const port = Number(flags.port || DEFAULT_PORT);
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/tags", timeout: 1500 }, (res) => {
      let d = "";
      res.on("data", (ch) => (d += ch));
      res.on("end", () => {
        try {
          const models = (JSON.parse(d).models || []);
          console.log(`\n  ${c.green("●")} ArcFlare server running on ${c.accent(":" + port)}  ${c.dim(`(${models.length} models)`)}`);
          for (const m of models) console.log(`  ${c.accent(m.slug.padEnd(22))}${c.dim(String(m.size || ""))}`);
          console.log();
        } catch {
          console.log(`\n  ${c.dim("server responded unexpectedly")}\n`);
        }
        resolve();
      });
    });
    req.on("error", () => {
      console.log(`\n  ${c.dim("No ArcFlare server running. Start one with")} ${c.cyan("arcflare serve")}\n`);
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      console.log(`\n  ${c.dim("No ArcFlare server running. Start one with")} ${c.cyan("arcflare serve")}\n`);
      resolve();
    });
  });
}

function cmdStop() {
  console.log(`\n  ${c.dim("ArcFlare runs models on demand — nothing stays loaded to stop.")}`);
  console.log(`  ${c.dim("Stop a running API server with Ctrl-C in its terminal.")}\n`);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const isFlag = a.startsWith("--") || (a.startsWith("-") && a.length > 1 && isNaN(Number(a)));
    if (isFlag) {
      const key = a.replace(/^--?/, "");
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
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
    ["serve", "start the local HTTP API (default :11435)"],
    ["ps", "show the running server + its models"],
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
    case "serve": return cmdServe(flags);
    case "ps": return cmdPs(flags);
    case "stop": return cmdStop();
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
