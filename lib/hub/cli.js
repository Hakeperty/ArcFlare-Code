// `arcflare phone`: the phone-and-laptop front door to agents running on this
// machine.
//
// The hub is a small web server that lives on the computer that owns the
// models. Your phone reaches it over the local network, so it works with the
// router unplugged from the internet. Nothing here talks to a relay: reaching
// it from outside the house is a separate, deliberate step (a VPN you already
// run, or a tunnel you start yourself), and the hub still demands a login when
// you do.
//
// Decisions that shape the file:
//
// Accounts are made here, at the keyboard, never over the network. There is no
// sign-up endpoint to find, so a stranger on the Wi-Fi has nothing to create.
//
// The hub binds the LAN but only answers private addresses. A port forwarded on
// the router by mistake gets refused at the socket, before anyone can try a
// password. `--allow-remote` exists for people who put their own TLS proxy in
// front, and says what it costs.
//
// Agents work only inside folders listed with `arcflare phone root add`, and
// every tool call asks the phone first. Auto mode cannot be switched on from
// the phone; it is a decision for the person at the machine.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const ui = require("../ui");
const { c } = ui;
const serve = require("../serve");
const models = require("../models");

const DEFAULT_PORT = 7878;
const TIERS = ["light", "standard", "hard"];

function hubDir() {
  return path.join(process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "hub");
}

// ------------------------------------------------------------------ input ----

/** Read a line without echoing it. Falls back to a plain prompt off a TTY. */
function askHidden(question) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY });
    if (!process.stdin.isTTY) return rl.question(question, (a) => { rl.close(); resolve(a); });
    // readline echoes through _writeToOutput; swallow everything after the prompt.
    let shown = false;
    rl._writeToOutput = (s) => { if (!shown) { out.write(s); shown = true; } };
    rl.question(question, (a) => { rl.close(); out.write("\n"); resolve(a); });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function newPassword(argv) {
  if (argv.includes("--password-stdin")) return readStdin();
  const a = await askHidden("  password (10+ characters): ");
  const b = await askHidden("  again: ");
  if (a !== b) throw new Error("the two passwords differ");
  return a;
}

// --------------------------------------------------------------- settings ----

function hubConfig(cfg) {
  const h = (cfg && cfg.hub) || {};
  return { port: h.port || DEFAULT_PORT, roots: h.roots || [], tiers: h.tiers || {}, allowedHosts: h.allowedHosts || [] };
}

function saveHub(patch) {
  const cfg = serve.loadConfig();
  serve.saveConfig({ ...cfg, hub: { ...(cfg.hub || {}), ...patch } });
}

function openAuth() {
  const { AuthStore } = require("./auth");
  fs.mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  return new AuthStore({ dir: hubDir() });
}

// ---------------------------------------------------------------- network ----

/** The addresses a phone on the same Wi-Fi would type. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// ------------------------------------------------------------------ model ----

/**
 * The real model backend: turn a tier into a loaded model on llama-server.
 *
 * One GPU holds one model at a time here, so a request for a different model
 * than the one loaded would restart the server under whichever agents are
 * mid-turn. Refuse that rather than break their turn; the person can stop the
 * other agent first.
 */
function makeBackend(getSupervisor) {
  const router = require("./router");
  let loaded = null; // { modelRef, port, servedId, ctx }
  let chain = Promise.resolve();

  return (tier) => {
    const run = chain.then(async () => {
      const cfg = serve.loadConfig();
      const all = models.discover({ meta: true });
      const { modelRef } = router.resolveModel(tier, cfg, all.map((m) => m.id));
      const model = models.resolve(all, modelRef);
      if (!model) {
        const e = new Error("no local model found — pull one with `arcflare pull`");
        e.code = "NO_MODEL";
        throw e;
      }
      if (loaded && loaded.modelRef === model.id) return loaded;

      const sup = getSupervisor && getSupervisor();
      // Swapping restarts llama-server under every agent that holds the loaded
      // model, idle ones included (their next turn would hit the wrong model).
      // An agent still booting has no model yet, and one of those is the caller.
      const live = sup ? sup.list().filter((a) => !["stopped", "error"].includes(a.status)) : [];
      const holders = loaded ? live.filter((a) => a.modelRef === loaded.modelRef).length : 0;
      const booting = live.filter((a) => !a.modelRef).length;
      if (loaded && (holders > 0 || booting > 1)) {
        const e = new Error(`another agent is using a different model; stop it before starting a ${tier} agent`);
        e.code = "MODEL_BUSY";
        throw e;
      }

      // prepareModel stops the running server first, so whatever was loaded is
      // gone even if the new load fails.
      loaded = null;
      const { contextChoices, prepareModel, planningBudget } = serve;
      const budget = await planningBudget(cfg);
      const { best } = contextChoices(model, budget);
      const prep = await prepareModel(cfg, model, best.ctx, best.cacheType);
      if (prep.failed) throw new Error(prep.error || "could not load the model");
      loaded = {
        modelRef: model.id, port: prep.port, model: prep.servedId, nCtx: prep.ctx,
        sampling: (models.loadMeta(model) || {}).sampling || null,
      };
      return loaded;
    });
    chain = run.catch(() => {});
    return run;
  };
}

// --------------------------------------------------------------- commands ----

async function userCommand(argv) {
  const auth = openAuth();
  const sub = argv[0];
  const name = argv[1];
  if (sub === "list" || !sub) {
    const rows = auth.listAccounts();
    if (!rows.length) console.log(`  ${c.dim("no accounts yet — arcflare phone user add <name>")}`);
    for (const a of rows) console.log(`  ${a.username}  ${c.dim(a.role)}  ${c.dim(a.created || "")}`);
    return;
  }
  if (!name) throw new Error(`usage: arcflare phone user ${sub} <name>`);
  if (sub === "add") {
    auth.createAccount(name, await newPassword(argv), { role: auth.hasAccounts() ? "user" : "owner" });
    console.log(`  ${c.green(ui.sym.ok)} account ${c.accent(name.toLowerCase())} created`);
    console.log(`  ${c.dim("start the hub with:")} arcflare phone`);
    return;
  }
  if (sub === "passwd") {
    auth.setPassword(name, await newPassword(argv));
    console.log(`  ${c.green(ui.sym.ok)} password changed — every device signed in as ${name} was signed out`);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    auth.deleteAccount(name);
    console.log(`  ${c.green(ui.sym.ok)} ${name} removed`);
    return;
  }
  throw new Error("arcflare phone user [list | add <name> | passwd <name> | rm <name>]");
}

function rootCommand(cfg, argv) {
  const h = hubConfig(cfg);
  const [sub, dir] = argv;
  if (!sub || sub === "list") {
    if (!h.roots.length) console.log(`  ${c.dim("no folders yet — agents cannot start. arcflare phone root add <folder>")}`);
    for (const r of h.roots) console.log(`  ${r}`);
    return;
  }
  const abs = dir ? fs.realpathSync(path.resolve(dir)) : null;
  if (sub === "add") {
    if (!abs) throw new Error("usage: arcflare phone root add <folder>");
    if (!fs.statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder`);
    if (abs === path.parse(abs).root || abs === os.homedir()) {
      throw new Error("pick a project folder, not the whole disk or your home folder");
    }
    saveHub({ roots: [...new Set([...h.roots, abs])] });
    console.log(`  ${c.green(ui.sym.ok)} agents may work in ${c.accent(abs)}`);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    saveHub({ roots: h.roots.filter((r) => r !== abs) });
    console.log(`  ${c.green(ui.sym.ok)} removed ${abs}`);
    return;
  }
  throw new Error("arcflare phone root [list | add <folder> | rm <folder>]");
}

function tierCommand(cfg, argv) {
  const h = hubConfig(cfg);
  let [sub, tier, ref] = argv;
  if (!sub || sub === "list") {
    for (const t of TIERS) console.log(`  ${t.padEnd(9)} ${h.tiers[t] || c.dim("(last used model)")}`);
    return;
  }
  if (sub === "set" && TIERS.includes(tier) && ref) {
    const hit = models.resolve(models.discover({}), ref);
    if (!hit) throw new Error(`no installed model matches "${ref}" — see: arcflare ls`);
    ref = hit.id;
    saveHub({ tiers: { ...h.tiers, [tier]: ref } });
    console.log(`  ${c.green(ui.sym.ok)} ${tier} agents use ${c.accent(ref)}`);
    return;
  }
  throw new Error("arcflare phone tier [list | set <light|standard|hard> <model>]");
}

async function startCommand(cfg, argv) {
  const { createHubServer } = require("./server");
  const { Supervisor } = require("./supervisor");
  const auth = openAuth();
  const h = hubConfig(cfg);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

  if (!auth.hasAccounts()) {
    throw new Error("no accounts yet. Create one here, at the keyboard: arcflare phone user add <name>");
  }
  const port = Number(flag("--port")) || h.port;
  const host = flag("--host") || (argv.includes("--local") ? "127.0.0.1" : "0.0.0.0");
  const allowRemote = argv.includes("--allow-remote");

  let tls = null;
  if (flag("--cert") && flag("--key")) {
    tls = { cert: fs.readFileSync(flag("--cert")), key: fs.readFileSync(flag("--key")) };
  }

  let supervisor;
  const backend = makeBackend(() => supervisor);
  supervisor = new Supervisor({ dir: hubDir(), roots: h.roots, backend });

  const hub = createHubServer({
    auth, supervisor, uiDir: path.join(__dirname, "ui"), tls,
    models: () => models.discover({}).map((m) => ({ id: m.id, size: m.size })),
    config: { allowRemote, allowedHosts: h.allowedHosts, roots: h.roots, secure: !!tls },
  });
  const where = await hub.listen({ port, host });

  const scheme = tls ? "https" : "http";
  const addrs = host === "0.0.0.0" ? lanAddresses() : [host];
  console.log("");
  console.log(ui.section("hub", `${auth.listAccounts().length} account(s)`));
  for (const a of addrs) console.log(`  ${c.dim("open on your phone")}  ${c.accent(`${scheme}://${a}:${where.port}`)}`);
  if (addrs[0] && !argv.includes("--no-qr")) {
    console.log("\n" + require("../rc").qrBlock(`${scheme}://${addrs[0]}:${where.port}`));
  }
  console.log(`  ${c.dim("works with no internet · answers only devices on your own network")}`);
  if (!h.roots.length) console.log(`  ${c.red("!")} no folders yet — add one: arcflare phone root add <folder>`);
  if (!tls && host !== "127.0.0.1") {
    console.log(`  ${c.red("!")} plain http: anyone on this Wi-Fi who can see the traffic can read it. Use a network you trust,`);
    console.log(`    or pass --cert/--key for https.`);
  }
  if (allowRemote) {
    console.log(`  ${c.red("!")} --allow-remote: public addresses are accepted. Put TLS in front, and use a long password.`);
  }
  console.log(`  ${c.dim("ctrl+c stops the hub and every agent it started")}\n`);

  const shutdown = async () => {
    try { await supervisor.stopAll(); } catch { /* going down anyway */ }
    try { await hub.close(); } catch { /* ditto */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function command(cfg, argv) {
  const sub = argv[1];
  try {
    if (sub === "user") return await userCommand(argv.slice(2));
    if (sub === "root" || sub === "roots") return rootCommand(cfg, argv.slice(2));
    if (sub === "tier" || sub === "tiers") return tierCommand(cfg, argv.slice(2));
    return await startCommand(cfg, argv.slice(sub === "start" ? 2 : 1));
  } catch (e) {
    console.error(`  ${c.red(ui.sym.fail || "✗")} ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { command, makeBackend, hubConfig, lanAddresses, hubDir, TIERS, DEFAULT_PORT };
