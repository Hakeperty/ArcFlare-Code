// `arcflare phone`: the phone-and-laptop front door to agents running on this
// machine.
//
// The hub is a small web server that lives on the computer that owns the
// models. Your phone reaches it over the local network, so it works with the
// router unplugged from the internet. Nothing talks to a relay until you run
// `arcflare phone relay on`: then paired phones can reach the hub through
// arcflare.net, end-to-end encrypted to keys on this machine (TUNNEL.md), and
// the hub still demands the same login.
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
  return {
    port: h.port || DEFAULT_PORT, roots: h.roots || [], tiers: h.tiers || {}, allowedHosts: h.allowedHosts || [],
    relay: h.relay && typeof h.relay === "object" ? h.relay : null,
  };
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

// ------------------------------------------------------------------ relay ----
//
// Reaching the hub from outside the house goes through the arcflare.net relay,
// end-to-end encrypted to keys this machine holds (lib/hub/TUNNEL.md). It is
// off until `arcflare phone relay on`, and each phone is paired by scanning a
// QR shown here and confirming a six-digit code here, at the keyboard.

function openTunnelStore() {
  const { TunnelStore } = require("./tunnel");
  fs.mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  return new TunnelStore({ dir: hubDir() });
}

function relaySetting(cfg) {
  const r = hubConfig(cfg).relay;
  return { on: !!(r && r.on === true), url: (r && r.url) || require("../rc").relayUrl(cfg) };
}

/** Short fingerprint of the hub key, for checking against the app by eye. */
function keyFingerprint(pub) {
  const hex = require("crypto").createHash("sha256").update(pub).digest("hex").slice(0, 20);
  return hex.match(/.{4}/g).join(" ");
}

function askYes(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(String(a).trim())); });
  });
}

function findDevice(store, idOrPrefix) {
  const want = String(idOrPrefix || "");
  if (want.length < 4) throw new Error("give the device id (or at least its first 4 characters) — see: arcflare phone devices");
  const hits = store.listDevices().filter((d) => d.id === want || d.id.startsWith(want));
  if (!hits.length) return null;
  if (hits.length > 1) throw new Error(`"${want}" matches more than one device; give more of the id`);
  return hits[0];
}

/** End every login session that was made through this device's tunnel. */
function revokeTunnelSessions(deviceId) {
  const auth = openAuth();
  let n = 0;
  for (const a of auth.listAccounts()) {
    for (const s of auth.listSessions(a.username)) {
      if (s.ip === `relay:${deviceId}` && auth.revokeSession(a.username, s.id)) n++;
    }
  }
  return n;
}

function relayCommand(cfg, argv) {
  const { checkRelayUrl } = require("./tunnel");
  const [sub, url] = argv;
  const cur = relaySetting(cfg);
  if (!sub || sub === "status") {
    console.log(`  relay: ${cur.on ? c.green("on") : "off"}  ${c.dim(cur.url)}`);
    if (!cur.on) console.log(`  ${c.dim("the hub answers only your own network. To reach it from anywhere: arcflare phone relay on")}`);
    return;
  }
  if (sub === "on") {
    const u = checkRelayUrl(url || cur.url);
    const store = openTunnelStore();
    store.keys();
    saveHub({ relay: { on: true, url: u } });
    console.log(`  ${c.green(ui.sym.ok)} relay: on  ${c.dim(u)}`);
    console.log(`  ${c.dim("traffic is end-to-end encrypted: the relay cannot read it or your password")}`);
    console.log(`  ${c.dim("restart the hub (arcflare phone), then pair a phone: arcflare phone pair")}`);
    return;
  }
  if (sub === "off") {
    saveHub({ relay: { on: false, url: cur.url } });
    console.log(`  ${c.green(ui.sym.ok)} relay: off — the hub answers only your own network after a restart`);
    console.log(`  ${c.dim("paired phones stay paired; revoke one with: arcflare phone devices revoke <id>")}`);
    return;
  }
  throw new Error("arcflare phone relay [status | on [https://relay] | off]");
}

async function pairCommand(cfg, argv) {
  const { pairingLink, checkRelayUrl, LIMITS } = require("./tunnel");
  const store = openTunnelStore();
  const rs = relaySetting(cfg);
  const relay = checkRelayUrl(rs.url);
  const room = store.room();
  const p = store.createPairing();
  const addr = lanAddresses()[0];
  const lan = argv.includes("--no-lan") || !addr ? null : `http://${addr}:${hubConfig(cfg).port}`;
  const link = pairingLink({ relay, roomId: room.roomId, hubPub: room.hubPub, secret: p.secret, lan });

  console.log("");
  console.log(ui.section("pair a phone", "scan with the ArcFlare app"));
  if (!argv.includes("--no-qr")) {
    try { console.log("\n" + require("../rc").qrBlock(link)); } catch { console.log(`  ${c.dim("(link too long for a QR here — paste it into the app)")}`); }
  }
  console.log(`  ${c.dim("link")}     ${link}`);
  console.log(`  ${c.dim("hub key")}  ${keyFingerprint(room.hubPub)}`);
  console.log(`  ${c.dim("works once, for " + Math.round(LIMITS.pairTtlMs / 60000) + " minutes · treat it like a password until then")}`);
  console.log(rs.on
    ? `  relay: ${c.green("on")}  ${c.dim(relay + " · the hub (arcflare phone) must be running to finish pairing")}`
    : `  relay: off  ${c.dim("— pairing finishes only through the relay: arcflare phone relay on, then arcflare phone")}`);
  if (argv.includes("--no-wait")) return;

  // Wait for the phone, then confirm the code here, at the keyboard.
  let stop = false;
  const cancel = () => { stop = true; store.takePairing(p.pid); console.log(`\n  ${c.dim("pairing cancelled")}`); process.exit(130); };
  process.once("SIGINT", cancel);
  console.log(`\n  ${c.dim("waiting for the phone… (ctrl+c cancels)")}`);
  let dev = null;
  while (!stop && Date.now() < p.expires + 5000) {
    dev = store.listDevices().find((d) => d.pairing === p.pid);
    if (dev) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.removeListener("SIGINT", cancel);
  if (!dev) {
    console.log(`  ${c.red("!")} the pairing expired — run arcflare phone pair again`);
    process.exitCode = 1;
    return;
  }
  const code = `${dev.sas.slice(0, 3)} ${dev.sas.slice(3)}`;
  console.log(`\n  a phone answered: ${c.accent(dev.label)}`);
  console.log(`  confirmation code: ${c.bold(code)}`);
  if (!process.stdin.isTTY) {
    console.log(`  ${c.dim("check the phone shows the same code, then: arcflare phone devices approve " + dev.id + " --yes")}`);
    return;
  }
  if (await askYes(`  does the phone show ${code}? [y/N] `)) {
    if (!store.approve(dev.id)) {
      console.log(`  ${c.red("!")} could not approve: the pairing is gone (expired or revoked) — run arcflare phone pair again`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${c.green(ui.sym.ok)} paired ${c.accent(dev.label)} ${c.dim("(" + dev.id + ")")} — sign in on the phone as usual`);
  } else {
    store.revoke(dev.id);
    console.log(`  ${c.red("!")} not paired. If you did not scan this code just now, someone else has the QR: run arcflare phone pair again.`);
    process.exitCode = 1;
  }
}

async function devicesCommand(argv) {
  const store = openTunnelStore();
  const [sub, id] = argv.filter((a) => !a.startsWith("--"));
  const yes = argv.includes("--yes");
  if (!sub || sub === "list") {
    const rows = store.listDevices();
    if (!rows.length) console.log(`  ${c.dim("no paired phones — arcflare phone pair")}`);
    for (const d of rows) {
      const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "never");
      const state = d.approved ? c.green("paired") : c.red(`waiting for confirmation (code ${d.sas})`);
      console.log(`  ${d.id}  ${c.accent(d.label)}  ${state}  ${c.dim("paired " + when(d.pairedAt) + " · last seen " + when(d.lastSeen))}`);
    }
    return;
  }
  if (sub === "revoke" || sub === "rm" || sub === "remove") {
    const d = findDevice(store, id);
    const devId = d ? d.id : String(id);
    const had = store.revoke(devId);
    const n = revokeTunnelSessions(devId);
    if (!had && !n) throw new Error(`no paired device ${id}`);
    console.log(`  ${c.green(ui.sym.ok)} ${d ? d.label : devId} can no longer reach this hub` + (n ? ` · ${n} sign-in(s) ended` : ""));
    console.log(`  ${c.dim("a running hub cuts it off within seconds; pair it again with arcflare phone pair")}`);
    return;
  }
  if (sub === "approve") {
    const d = findDevice(store, id);
    if (!d) throw new Error(`no paired device ${id}`);
    if (d.approved) { console.log(`  ${c.dim(d.label + " is already paired")}`); return; }
    const code = `${d.sas.slice(0, 3)} ${d.sas.slice(3)}`;
    console.log(`  ${c.accent(d.label)} (${d.id})`);
    console.log(`  confirmation code: ${c.bold(code)}`);
    if (process.stdin.isTTY) {
      if (!yes && !(await askYes(`  does ${d.label} show ${code}? [y/N] `))) {
        store.revoke(d.id);
        console.log(`  ${c.red("!")} not paired`);
        return;
      }
    } else if (!yes) {
      // Nobody is here to compare the code: approving blind would defeat the confirmation.
      console.log(`  ${c.red("!")} not approved: no terminal to confirm on. Check the phone shows ${code}, then run this again with --yes`);
      process.exitCode = 1;
      return;
    }
    if (!store.approve(d.id)) {
      console.log(`  ${c.red("!")} could not approve: ${d.label} is gone (expired or revoked) — run arcflare phone pair again`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${c.green(ui.sym.ok)} paired ${c.accent(d.label)}`);
    return;
  }
  throw new Error("arcflare phone devices [list | approve <id> [--yes] | revoke <id>]");
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
  let tun = null;
  const rs = relaySetting(cfg);
  if (rs.on) {
    const { HubTunnel, sanitizeLabel } = require("./tunnel");
    const store = openTunnelStore();
    try {
      tun = new HubTunnel({ store, relay: rs.url, dispatch: hub.dispatchTunnel, auth });
    } catch (e) {
      // A damaged state file: no tunnel, the LAN carries on, nothing is overwritten.
      console.log(`  ${c.red("!")} relay NOT started: ${e.message}`);
    }
    if (tun) {
      tun.on("status", (t) => console.log(`  ${c.dim("⇄ relay: " + t)}`));
      tun.on("paired", (d) => console.log(`  ${c.dim("⇄")} a phone answered a pairing QR: ${sanitizeLabel(d.label)} — confirm code ${d.sas} where you ran arcflare phone pair`));
      tun.on("revoked", (id) => console.log(`  ${c.dim("⇄ device " + id + " revoked and disconnected")}`));
      await tun.start();
      const n = store.listDevices().filter((d) => d.approved).length;
      console.log(`  relay: ${c.green("on")}  ${c.dim(rs.url + " · end-to-end encrypted · " + n + " paired phone(s) · arcflare phone pair to add one")}`);
    }
  } else {
    console.log(`  relay: off  ${c.dim("— to reach the hub from anywhere: arcflare phone relay on")}`);
  }
  console.log(`  ${c.dim("ctrl+c stops the hub and every agent it started")}\n`);

  const shutdown = async () => {
    try { if (tun) await tun.stop(); } catch { /* going down anyway */ }
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
    if (sub === "pair") return await pairCommand(cfg, argv.slice(2));
    if (sub === "devices" || sub === "device") return await devicesCommand(argv.slice(2));
    if (sub === "relay") return relayCommand(cfg, argv.slice(2));
    if (sub === "root" || sub === "roots") return rootCommand(cfg, argv.slice(2));
    if (sub === "tier" || sub === "tiers") return tierCommand(cfg, argv.slice(2));
    return await startCommand(cfg, argv.slice(sub === "start" ? 2 : 1));
  } catch (e) {
    console.error(`  ${c.red(ui.sym.fail || "✗")} ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { command, makeBackend, hubConfig, lanAddresses, hubDir, TIERS, DEFAULT_PORT };
