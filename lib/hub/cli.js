// `arcflare phone`: the phone-and-laptop front door to agents running on this
// machine.
//
// The hub is a small web server that lives on the computer that owns the
// models. Your phone reaches it over the local network, so it works with the
// router unplugged from the internet: the app runs the encrypted tunnel over
// the hub's own LAN mailbox (`arcflare phone lan`, on by default; TUNNEL.md
// section 16). Nothing talks to the internet relay until you run
// `arcflare phone relay on`: then paired phones can also reach the hub through
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

// The running hub leaves <hub>/running.json (pid, port, host, its node.exe), so `arcflare phone pair`,
// a separate process, puts the port the hub really listens on in the link (not the configured
// default when the hub was started with --port) and can say when no hub is running at all.
// Without it the phone only ever reports "did not answer in time".
const runningFile = () => path.join(hubDir(), "running.json");

function markRunning(info) {
  try { fs.writeFileSync(runningFile(), JSON.stringify({ v: 1, pid: process.pid, exe: process.execPath, ...info }) + "\n", { mode: 0o600 }); } catch { /* informational */ }
}

function unmarkRunning() {
  try { const r = JSON.parse(fs.readFileSync(runningFile(), "utf8")); if (r.pid === process.pid) fs.unlinkSync(runningFile()); } catch { /* not ours or gone */ }
}

/** The live hub's record, or null if there is none or its process is gone. */
function runningHub() {
  let r;
  try { r = JSON.parse(fs.readFileSync(runningFile(), "utf8")); } catch { return null; }
  if (!r || !Number.isInteger(r.pid) || !Number.isInteger(r.port)) return null;
  try { process.kill(r.pid, 0); } catch (e) { if (!e || e.code !== "EPERM") return null; }
  return r;
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
  // Windows PowerShell 5.1 prefixes text piped to a native program with a UTF-8 BOM; left in, it becomes
  // part of the password and the password as typed never signs in.
  return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").replace(/\r?\n$/, "");
}

async function newPassword(argv) {
  if (argv.includes("--password-stdin")) return readStdin();
  const a = await askHidden("  password (10+ characters): ");
  const b = await askHidden("  again: ");
  if (a !== b) throw new Error("the two passwords differ");
  return a;
}

// --------------------------------------------------------------- settings ----

// The default workspace: a folder agents can always use, so starting one never depends on remembering a
// path. Created when the hub starts; `arcflare phone workspace <folder>` moves it.
function defaultWorkspace() {
  return path.join(os.homedir(), "ArcFlare-Workspace");
}

function hubConfig(cfg) {
  const h = (cfg && cfg.hub) || {};
  const workspace = typeof h.workspace === "string" && h.workspace ? h.workspace : defaultWorkspace();
  return {
    port: h.port || DEFAULT_PORT, workspace,
    // The workspace is always allowed, first; the folders added by hand follow.
    roots: [...new Set([workspace, ...(h.roots || [])])], extraRoots: h.roots || [],
    tiers: h.tiers || {}, allowedHosts: h.allowedHosts || [],
    relay: h.relay && typeof h.relay === "object" ? h.relay : null,
    lan: h.lan && typeof h.lan === "object" ? h.lan : null,
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

// The default way in from anywhere is ArcFlare Connect: a free Cloudflare quick tunnel that this computer opens
// itself (lib/hub/cftunnel.js). Nobody else runs a server for it and nothing is stored anywhere but here. The
// arcflare.net relay is still there for anyone who turns it on by name (arcflare phone relay on https://...).
function relaySetting(cfg) {
  const r = hubConfig(cfg).relay;
  if (!r || typeof r !== "object") return { on: true, cloudflare: true, byDefault: true, url: require("../rc").relayUrl(cfg) };
  const cloudflare = !!(r.on === true && r.mode === "cloudflare");
  return { on: r.on === true, cloudflare, url: r.url || require("../rc").relayUrl(cfg) };
}

/** Where a running hub writes its current Cloudflare address (lib/hub/cftunnel.js). */
const cfUrlFile = () => path.join(hubDir(), "cloudflare-url.json");
// The cloudflared that outlives a hub restart, so the phone's internet address stays the same.
const cfKeepFile = () => path.join(hubDir(), "cloudflared.json");

// -------------------------------------------------------------------- lan ----
//
// The hub's own mailbox on its LAN listener (TUNNEL.md section 16): the same
// encrypted tunnel as the relay, carried over the home network, no internet
// needed, pairing included. It answers only private peers and carries
// ciphertext. Default: on when the hub binds a non-loopback host, off with
// --local; `arcflare phone lan on|off` makes it explicit.

function lanSetting(cfg) {
  const l = hubConfig(cfg).lan;
  const explicit = !!(l && typeof l.on === "boolean");
  return { explicit, on: explicit ? l.on : null };
}

function lanCommand(cfg, argv) {
  const [sub] = argv;
  const cur = lanSetting(cfg);
  if (!sub || sub === "status") {
    const word = !cur.explicit ? "default (on unless the hub is started with --local)" : cur.on ? c.green("on") : "off";
    console.log(`  lan tunnel: ${word}`);
    console.log(`  ${c.dim("phones on your Wi-Fi reach the hub through its own encrypted mailbox, no internet needed")}`);
    console.log(`  ${c.dim("it answers only private addresses and carries ciphertext only (lib/hub/TUNNEL.md, section 16)")}`);
    return;
  }
  if (sub === "on" || sub === "off") {
    if (sub === "on") openTunnelStore().keys();
    saveHub({ lan: { on: sub === "on" } });
    console.log(`  ${c.green(ui.sym.ok)} lan tunnel: ${sub} ${c.dim("— takes effect when the hub (arcflare phone) is restarted")}`);
    if (sub === "on") console.log(`  ${c.dim("pair a phone with: arcflare phone pair")}`);
    return;
  }
  throw new Error("arcflare phone lan [status | on | off]");
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

async function relayCommand(cfg, argv) {
  const { checkRelayUrl } = require("./tunnel");
  const [sub, url] = argv;
  const cur = relaySetting(cfg);
  if (!sub || sub === "status") {
    if (cur.cloudflare) {
      const u = require("./cftunnel").currentUrl(cfUrlFile());
      console.log(`  ArcFlare Connect: ${c.green("on")}${cur.byDefault ? c.dim(" (default)") : ""}  ${c.dim(u ? u + " (changes when the hub restarts)" : "the address appears when the hub (arcflare phone) is running")}`);
      return;
    }
    console.log(`  relay: ${cur.on ? c.green("on") : "off"}  ${c.dim(cur.url)}`);
    if (!cur.on) console.log(`  ${c.dim("the hub answers only your own network. To reach it from anywhere: arcflare phone relay on")}`);
    return;
  }
  if (sub === "install") return await installCloudflared();
  if (sub === "cloudflare" || (sub === "on" && !url)) {
    const store = openTunnelStore();
    store.keys();
    saveHub({ relay: { on: true, mode: "cloudflare", url: cur.url } });
    const found = require("./cftunnel").findCloudflared();
    console.log(`  ${c.green(ui.sym.ok)} ArcFlare Connect: on  ${c.dim("a free Cloudflare tunnel this computer opens itself: no relay server, nothing stored elsewhere")}`);
    if (!found) console.log(`  ${c.red("!")} it needs Cloudflare's cloudflared: arcflare phone connect install`);
    console.log(`  ${c.dim("restart the hub (arcflare phone); phones get the new address the next time they connect, or pair again")}`);
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
    // A cloudflared kept running between hub restarts goes too.
    if (require("./cftunnel").stopKept(cfKeepFile())) console.log(`  ${c.green(ui.sym.ok)} stopped the Cloudflare tunnel`);
    console.log(`  ${c.green(ui.sym.ok)} relay: off — the hub answers only your own network after a restart`);
    console.log(`  ${c.dim("paired phones stay paired; revoke one with: arcflare phone devices revoke <id>")}`);
    return;
  }
  throw new Error("arcflare phone connect [status | on | off | install]   (or: arcflare phone relay on https://<relay>)");
}

/** Install Cloudflare's cloudflared for this user (no admin): Cloudflare's own release, checksum-verified. */
async function installCloudflared() {
  const cf = require("./cftunnel");
  const have = cf.findCloudflared();
  if (have) { console.log(`  ${c.green(ui.sym.ok)} cloudflared is already installed  ${c.dim(have)}`); return; }
  try {
    const exe = await cf.installPortable({ log: (t) => console.log(`  ${c.dim(t)}`) });
    console.log(`  ${c.green(ui.sym.ok)} cloudflared installed (checksum verified)  ${c.dim(exe)}`);
    console.log(`  ${c.dim("restart the hub: arcflare phone")}`);
  } catch (e) {
    console.log(`  ${c.red("!")} could not install cloudflared: ${e.message}`);
    console.log(`  ${c.dim("get it from Cloudflare: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")}`);
  }
}

async function pairCommand(cfg, argv) {
  const { pairingLink, checkRelayUrl, checkPairingLanUrl, isLanHost, LIMITS } = require("./tunnel");
  const store = openTunnelStore();
  const rs = relaySetting(cfg);
  const ls = lanSetting(cfg);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const room = store.room();
  // The hub's own mailbox base URL: where a phone on the home network sends and
  // collects ciphertext. Not a page to open.
  const lanOn = !argv.includes("--no-lan") && ls.on !== false;
  // Only a home-network address is any use to a phone on the Wi-Fi, and only one is allowed in a link. A computer
  // whose own address is public (a server, a VPS: the usual Linux case) has no such path, and that is not an error:
  // it pairs over the internet alone.
  const allAddrs = lanAddresses();
  const addr = allAddrs.find((a) => isLanHost(a));
  const live = runningHub();
  const port = Number(flag("--port")) || (live && live.port) || hubConfig(cfg).port;
  const lanBase = !lanOn ? null
    : flag("--lan-url") ? checkPairingLanUrl(flag("--lan-url"))
      : addr ? checkPairingLanUrl(`http://${addr}:${port}`) : null;
  // Asked now, answered while the phone is scanned: Windows Firewall silently dropping the phone.
  const fwCheck = lanBase && process.platform === "win32"
    ? require("./winfw").checkFirewall({ address: new URL(lanBase).hostname, exe: (live && live.exe) || process.execPath, port: Number(new URL(lanBase).port) }).catch(() => null)
    // Linux has no prompt to answer: firewalld or ufw just drops the phone. Ask them.
    : lanBase && process.platform === "linux"
      ? require("./linuxfw").checkFirewall({ address: new URL(lanBase).hostname, port: Number(new URL(lanBase).port) }).catch(() => null)
      : Promise.resolve(null);
  // The internet relay when it is on; otherwise the LAN mailbox is the only
  // way in, and r (and rm) still go in the link so the pairing record is complete.
  let relay = rs.on ? checkRelayUrl(rs.url) : lanBase;
  if (rs.cloudflare) {
    // ArcFlare Connect's address exists only while the hub runs. Without it, pair over the home network: the phone
    // asks the hub for the internet address the first time it connects (GET /api/where) and keeps it.
    const u = require("./cftunnel").currentUrl(cfUrlFile());
    relay = u ? checkRelayUrl(u) : lanBase;
  }
  if (!relay) {
    // ArcFlare Connect is on but has no address: it exists only while the hub runs, and here there is no home network to fall back on.
    if (rs.cloudflare) {
      throw new Error("no way for a phone to reach this hub yet: this computer has no home-network address" +
        (allAddrs.length ? ` (its address, ${allAddrs[0]}, is a public one)` : "") +
        ", and ArcFlare Connect has an address only while the hub is running. " +
        (live ? "The hub is running but its Cloudflare tunnel is not up: look at the hub's output for the reason" : "Start the hub first (arcflare phone), then run this again"));
    }
    throw new Error("no way for a phone to reach this hub: " + (lanOn ? "no network address found (give one with --lan-url http://<ip>:<port>)" : "turn one on: arcflare phone lan on (same Wi-Fi) or arcflare phone relay on (from anywhere)"));
  }
  const p = store.createPairing();
  const link = pairingLink({ relay, roomId: room.roomId, hubPub: room.hubPub, secret: p.secret, lan: lanBase });

  console.log("");
  console.log(ui.section("pair a phone", "scan with the ArcFlare app"));
  if (!argv.includes("--no-qr")) {
    try { console.log("\n" + require("../rc").qrBlock(link)); } catch { console.log(`  ${c.dim("(link too long for a QR here — paste it into the app)")}`); }
  }
  console.log(`  ${c.dim("link")}     ${link}`);
  console.log(`  ${c.dim("hub key")}  ${keyFingerprint(room.hubPub)}`);
  console.log(`  ${c.dim("works once, for " + Math.round(LIMITS.pairTtlMs / 60000) + " minutes · treat it like a password until then")}`);
  console.log(lanBase
    ? `  lan: ${c.green("on")}  ${c.dim(lanBase + " · encrypted end to end, works with no internet · the hub (arcflare phone) must be running, not --local")}`
    : lanOn && allAddrs.length
      ? `  lan: none  ${c.dim("— this computer's address (" + allAddrs[0] + ") is not a home-network one, so the phone pairs over the internet")}`
      : `  lan: off  ${c.dim("— same-Wi-Fi path: arcflare phone lan on")}`);
  if (lanBase) {
    const others = lanAddresses().filter((a) => !lanBase.includes(a));
    if (others.length) console.log(`  ${c.dim("phone can't connect? this computer also has " + others.join(", ") + " — pick the one on the phone's Wi-Fi: arcflare phone pair --lan-url http://<that>:" + hubConfig(cfg).port)}`);
    if (process.platform === "win32") console.log(`  ${c.dim("Windows: allow Node.js through the firewall on Private networks when it asks, or the phone cannot reach the hub")}`);
    if (!live) console.log(`  ${c.red("!")} no hub is running on this computer: start it first (arcflare phone), or the phone will only report a timeout`);
    else if (["127.0.0.1", "::1", "localhost"].includes(live.host)) console.log(`  ${c.red("!")} the running hub is bound to this computer only (--local): a phone cannot reach it. Restart it without --local`);
  }
  const fw = await fwCheck;
  if (fw) {
    // A firewall whose rules could not be read is a possibility, said quietly; one that was read is a fact.
    console.log(fw.certain === false ? `  ${c.dim(ui.sym.dot + " " + fw.reason)}` : `  ${c.red("!")} ${fw.reason}`);
    console.log(`    ${c.dim((fw.certain === false ? "if so: " : "fix: ") + fw.fix)}`);
  }
  console.log(rs.cloudflare
    ? `  ArcFlare Connect: ${c.green("on")}  ${c.dim(relay !== lanBase ? relay + " · from anywhere" : "the phone gets the internet address the first time it connects")}`
    : rs.on
      ? `  relay: ${c.green("on")}  ${c.dim(relay + " · the hub (arcflare phone) must be running to finish pairing")}`
      : `  relay: off  ${c.dim("— from outside the house: arcflare phone connect on")}`);
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

/**
 * The addresses a phone on the same Wi-Fi would type, best guess first.
 *
 * A computer often has several: the real Wi-Fi or cable, plus virtual adapters
 * (WSL and Hyper-V, Docker, VirtualBox, VMware, VPNs) that a phone can never
 * reach. Taking the first one in the list paired phones to an address on the
 * wrong network. Link-local 169.254.x.x (no DHCP) is never useful, and the
 * common home ranges beat 172.16/12, where Docker and WSL live.
 */
function rankLanAddresses(ifaces) {
  const virtual = /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|vmnet|docker|veth|br-|virbr|utun|tun\d|tap|tailscale|zerotier|loopback|bluetooth/i;
  const real = /wi-?fi|wlan|wlp|wireless|ethernet|^en\d|^eth\d|^eno|^enp/i;
  const rows = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family !== "IPv4" || i.internal || /^169\.254\./.test(i.address)) continue;
      let score = 0;
      if (virtual.test(name)) score -= 10;
      if (real.test(name)) score += 5;
      if (/^(192\.168|10)\./.test(i.address)) score += 3;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) score -= 1;
      rows.push({ address: i.address, name, score });
    }
  }
  return rows.sort((a, b) => b.score - a.score);
}

function lanAddresses() {
  return rankLanAddresses(os.networkInterfaces()).map((r) => r.address);
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
function makeBackend(getSupervisor, deps = {}) {
  const router = require("./router");
  const engine = deps.engine || require("../engine");
  let loaded = null; // { modelRef, port, servedId, ctx }
  let chain = Promise.resolve();

  // How long each model took to load last time, so the phone's loading bar can show real progress. Before the
  // first load of a model, guess from its size.
  const timesFile = deps.timesFile || null; // the hub passes <hub>/load-times.json; tests keep it in memory
  let loadTimes = {};
  try { if (timesFile) loadTimes = JSON.parse(fs.readFileSync(timesFile, "utf8")) || {}; } catch { loadTimes = {}; }
  const estimateMs = (model) => {
    const t = Number(loadTimes[model.id]);
    if (t > 0) return t;
    return 4000 + Math.round((Number(model.size) || 8e9) / 1e6); // about 1 GB/s plus engine start
  };
  const recordMs = (id, ms) => {
    loadTimes[id] = Math.round(ms);
    if (!timesFile) return;
    try { fs.writeFileSync(timesFile, JSON.stringify(loadTimes), { mode: 0o600 }); } catch { /* best effort */ }
  };
  // Elapsed / estimate -> percent: linear to 90%, then creeps toward 99% so a slow load never looks finished.
  const pctFor = (el, est) => {
    const p = el / Math.max(1, est);
    return Math.round(p < 1 ? p * 90 : 90 + 9 * (1 - Math.exp(-(p - 1) * 2)));
  };

  // `arg` is a tier ("light" | "standard" | "hard", for agents) or { modelRef } (a model the user picked, for chat;
  // without a modelRef, the standard tier's model). `opts.onProgress` hears about a load while it happens:
  //   { phase: "loading", stage: "starting" | "weights" | "retry", model, size, ctx, pct, elapsedMs, estMs }
  //   { phase: "loaded", model, ctx, pct: 100, elapsedMs }
  const backend = (arg, opts = {}) => {
    const report = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const tier = typeof arg === "string" ? arg : "standard";
    const run = chain.then(async () => {
      const cfg = serve.loadConfig();
      const all = models.discover({ meta: true });
      const picked = arg && typeof arg === "object" && typeof arg.modelRef === "string" ? arg.modelRef : null;
      const { modelRef } = picked ? { modelRef: picked } : router.resolveModel(tier, cfg, all.map((m) => m.id));
      const model = models.resolve(all, modelRef);
      if (!model) {
        const e = new Error("no local model found — pull one with `arcflare pull`");
        e.code = "NO_MODEL";
        throw e;
      }
      // Team mode: leave GPU memory for the helper models. `opts.team(budget, model)` picks them for this budget
      // and says how much they need; a lead loaded earlier with less room left is loaded again.
      const wantRoom = typeof opts.reserveFor === "function";
      if (loaded && loaded.modelRef === model.id && (!wantRoom || (loaded.reserve || 0) > 0)) {
        // The cache only says what WE loaded. If the server has since died (a crash, `arcflare stop`), handing out
        // its address would send the agent to nothing: check, and load again when it is gone.
        let up = false;
        try { up = !!(await engine.status(loaded.port)).running; } catch { up = false; }
        if (up) return loaded;
        loaded = null;
      }

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
      const measured = await planningBudget(cfg);
      const reserve = wantRoom ? Math.max(0, Number(opts.reserveFor(measured, model)) || 0) : 0;
      const budget = measured - reserve;
      const { best } = contextChoices(model, budget);
      const t0 = Date.now();
      const est = estimateMs(model);
      const p = { stage: "starting", ctx: best.ctx, reason: null };
      const tick = () => {
        if (!report) return;
        const elapsedMs = Date.now() - t0;
        try {
          report({ phase: "loading", stage: p.stage, reason: p.reason, model: model.id, size: Number(model.size) || 0,
            ctx: p.ctx, pct: pctFor(elapsedMs, est), elapsedMs, estMs: est });
        } catch { /* a listener's problem is not the load's */ }
      };
      tick();
      const timer = report ? setInterval(tick, 700) : null;
      if (timer && timer.unref) timer.unref();
      let prep;
      try {
        prep = await prepareModel(cfg, model, best.ctx, best.cacheType, {
          onProgress: (ev) => {
            if (!ev) return;
            if (ev.stage === "server-starting") p.stage = "starting";
            else if (ev.stage === "loading") { p.stage = "weights"; if (ev.ctx) p.ctx = ev.ctx; }
            else if (ev.stage === "retry") { p.stage = "retry"; p.reason = ev.reason || null; if (ev.ctx) p.ctx = ev.ctx; }
          },
        });
      } finally {
        if (timer) clearInterval(timer);
      }
      if (prep.failed) throw new Error(prep.error || "could not load the model");
      const tookMs = Date.now() - t0;
      recordMs(model.id, tookMs);
      if (report) { try { report({ phase: "loaded", model: model.id, ctx: prep.ctx, pct: 100, elapsedMs: tookMs }); } catch { /* ignore */ } }
      loaded = {
        modelRef: model.id, port: prep.port, model: prep.servedId, nCtx: prep.ctx, reserve,
        sampling: (models.loadMeta(model) || {}).sampling || null,
      };
      return loaded;
    });
    chain = run.catch(() => {});
    return run;
  };
  /** What is loaded now: { modelRef, running } (running = the server process answers). */
  backend.status = async () => {
    if (!loaded) return { modelRef: null, running: false };
    let up = false;
    try { up = !!(await engine.status(loaded.port)).running; } catch { up = false; }
    return { modelRef: up ? loaded.modelRef : null, running: up };
  };
  /** Stop the model server (frees the GPU). Queued behind any load in progress. */
  backend.unload = () => {
    const run = chain.then(() => { const was = loaded && loaded.modelRef; loaded = null; const stopped = engine.stop(); return { stopped, modelRef: was || null }; });
    chain = run.catch(() => {});
    return run;
  };
  return backend;
}

// --------------------------------------------------------------- commands ----

/** `arcflare phone app [status | publish <apk> --version-code N [--version-name S]]`: the update phones install. */
function appCommand(argv) {
  const au = require("./appupdate");
  const sub = argv[0];
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (!sub || sub === "status") {
    const m = au.info(hubDir());
    if (!m) console.log(`  ${c.dim("no app update published. Build one, then: arcflare phone app publish <apk> --version-code N")}`);
    else console.log(`  app update: ${c.accent(m.versionName)} ${c.dim(`(code ${m.versionCode}, ${(m.size / 1048576).toFixed(1)} MB, sha256 ${m.sha256.slice(0, 16)}…)`)}`);
    return;
  }
  if (sub === "publish") {
    const apk = argv[1];
    if (!apk || apk.startsWith("--")) throw new Error("usage: arcflare phone app publish <apk> --version-code N [--version-name S]");
    const m = au.publish(hubDir(), path.resolve(apk), { versionCode: Number(opt("--version-code")), versionName: opt("--version-name") });
    console.log(`  ${c.green(ui.sym.ok)} published ${c.accent(m.versionName)} ${c.dim(`(code ${m.versionCode}, sha256 ${m.sha256.slice(0, 16)}…)`)}`);
    console.log(`  ${c.dim("signed-in phones see it on the Devices screen (App update). Android installs it only if it is signed with the same key as the installed app.")}`);
    return;
  }
  throw new Error("arcflare phone app [status | publish <apk> --version-code N [--version-name S]]");
}

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

/** Make sure the workspace folder exists. Returns its real path. */
function ensureWorkspace(h) {
  fs.mkdirSync(h.workspace, { recursive: true });
  return fs.realpathSync(h.workspace);
}

function workspaceCommand(cfg, argv) {
  const h = hubConfig(cfg);
  const dir = argv[0];
  if (!dir) {
    console.log(`  workspace  ${c.accent(ensureWorkspace(h))}`);
    console.log(`  ${c.dim("agents started from the phone work here unless you pick another folder;")}`);
    console.log(`  ${c.dim("a name typed on the phone becomes a project folder inside it. Move it: arcflare phone workspace <folder>")}`);
    return;
  }
  const abs = path.resolve(dir);
  if (abs === path.parse(abs).root || abs === os.homedir()) throw new Error("pick a folder for projects, not the whole disk or your home folder");
  fs.mkdirSync(abs, { recursive: true });
  saveHub({ workspace: fs.realpathSync(abs) });
  console.log(`  ${c.green(ui.sym.ok)} workspace is now ${c.accent(fs.realpathSync(abs))} ${c.dim("(restart the hub to apply)")}`);
}

function rootCommand(cfg, argv) {
  const h = hubConfig(cfg);
  const [sub, dir] = argv;
  if (!sub || sub === "list") {
    console.log(`  ${h.workspace} ${c.dim("(workspace, always allowed)")}`);
    for (const r of h.extraRoots) if (r !== h.workspace) console.log(`  ${r}`);
    return;
  }
  const abs = dir ? fs.realpathSync(path.resolve(dir)) : null;
  if (sub === "add") {
    if (!abs) throw new Error("usage: arcflare phone root add <folder>");
    if (!fs.statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder`);
    if (abs === path.parse(abs).root || abs === os.homedir()) {
      throw new Error("pick a project folder, not the whole disk or your home folder");
    }
    saveHub({ roots: [...new Set([...h.extraRoots, abs])] });
    console.log(`  ${c.green(ui.sym.ok)} agents may work in ${c.accent(abs)}`);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    if (abs === fs.realpathSync(h.workspace)) throw new Error("that is the workspace; move it with arcflare phone workspace <folder>");
    saveHub({ roots: h.extraRoots.filter((r) => r !== abs) });
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
  const backend = makeBackend(() => supervisor, { timesFile: path.join(hubDir(), "load-times.json") });
  const { McpHub } = require("./mcphub");
  // ArcFlare's own web and desktop servers are offered alongside the configured ones, off until switched on.
  const mcp = new McpHub({ dir: hubDir(), builtins: true });
  const workspace = ensureWorkspace(h);
  // What the phone chose and the hub remembers: which Arc its chats and agents run under.
  const { HubSettings } = require("./settings");
  const settings = new HubSettings({ dir: hubDir() });
  // The Arcs' full instructions come from the hub site; fetched in the background, the built-in ones serve meanwhile.
  require("../arcs").sync({ cfg }).catch(() => {});
  supervisor = new Supervisor({ dir: hubDir(), roots: h.roots, backend, mcp, arc: () => settings.arc() });
  const { ChatManager } = require("./chat");
  const chats = new ChatManager({ dir: hubDir(), backend, models: () => models.discover({}), arc: () => settings.arc() });
  // Agents on this computer (via `arcflare mcp`) reach the phone and the local models through /api/local.
  const L = require("./local");
  const questions = new L.QuestionBox({ allows: () => settings.phoneAllows() });
  const local = {
    token: L.ensureToken(hubDir()),
    questions,
    api: L.makeLocalApi({
      questions, backend, models: () => models.discover({}),
      // Only reached after the token check: big prompts (local_generate) are allowed, 2 MB.
      readJson: (req) => require("./server").readJson(req, undefined, 2 * 1024 * 1024), sendJson: require("./server").sendJson,
    }),
  };

  // The tunnel's carriers: the hub's own LAN mailbox and/or the internet relay.
  // Built before the server so the server can mount the mailbox; a damaged state
  // file means no tunnel at all (the LAN web UI carries on, nothing is overwritten).
  const loopbackHost = ["127.0.0.1", "::1", "localhost"].includes(host);
  const rs0 = relaySetting(cfg);
  // --local (this computer only) also keeps the default internet way in closed; turning it on by name still works.
  const rs = rs0.byDefault && loopbackHost ? { ...rs0, on: false, cloudflare: false } : rs0;
  const ls = lanSetting(cfg);
  const lanOn = ls.explicit ? ls.on : !loopbackHost;
  let hub = null, tun = null, mailbox = null, cf = null;
  const store = rs.on || lanOn ? openTunnelStore() : null;
  if (store) {
    try {
      const { HubTunnel } = require("./tunnel");
      const { createLanRelay } = require("./lanrelay");
      // Cloudflare mode: the mailbox is the way in from anywhere too, so it exists even with the LAN off.
      if (lanOn || rs.cloudflare) mailbox = createLanRelay({ roomId: store.room().roomId });
      tun = new HubTunnel({
        store, relay: rs.on && !rs.cloudflare ? rs.url : null, local: mailbox ? mailbox.local : null, auth,
        localServesNet: rs.cloudflare,
        dispatch: (req, res, ctx) => hub.dispatchTunnel(req, res, ctx),
      });
    } catch (e) {
      if (mailbox) mailbox.close();
      mailbox = null;
      tun = null;
      console.log(`  ${c.red("!")} tunnel NOT started: ${e.message}`);
    }
  }

  hub = createHubServer({
    auth, supervisor, uiDir: path.join(__dirname, "ui"), tls, lanRelay: lanOn ? mailbox : null,
    // Told to paired phones (over the tunnel only) so they follow the Cloudflare address across restarts.
    publicRelayUrl: () => (cf ? cf.current : null),
    appUpdates: require("./appupdate").forHub(hubDir()),
    chats,
    mcp,
    settings,
    local,
    ai: {
      status: () => backend.status(),
      // Chat's Stop: end every chat answer (they all share the one model) and
      // unload it. Agents keep running; their next request loads it again.
      unload: async () => {
        const chatsStopped = chats.stopAll();
        const r = await backend.unload();
        const oneTime = chats.purgeOneTime();          // the model is stopped: one-time chats go with it
        return { ok: true, chats: chatsStopped, server: r.stopped, model: r.modelRef, oneTimeChatsDeleted: oneTime };
      },
      // "Stop AI": every chat answer, every agent, then the model server itself (frees the GPU).
      stop: async () => {
        const chatsStopped = chats.stopAll();
        const live = supervisor.list().filter((a) => !["stopped", "error"].includes(a.status)).length;
        await supervisor.stopAll();                    // one-time agents are deleted as they stop
        const r = await backend.unload();
        const oneTime = chats.purgeOneTime();
        return { ok: true, chats: chatsStopped, agents: live, server: r.stopped, model: r.modelRef, oneTimeChatsDeleted: oneTime };
      },
    },
    models: () => models.discover({}).map((m) => ({ id: m.id, size: m.size })),
    config: { allowRemote, allowedHosts: h.allowedHosts, roots: h.roots, workspace, secure: !!tls },
  });
  const where = await hub.listen({ port, host });
  markRunning({ port: where.port, host, tls: !!tls });
  process.on("exit", unmarkRunning);

  const scheme = tls ? "https" : "http";
  const addrs = host === "0.0.0.0" ? lanAddresses() : [host];
  console.log("");
  console.log(ui.section("hub", `${auth.listAccounts().length} account(s)`));
  for (const a of addrs) console.log(`  ${c.dim("open in a browser")}  ${c.accent(`${scheme}://${a}:${where.port}`)}`);
  if (addrs[0] && !argv.includes("--no-qr")) {
    console.log("\n" + require("../rc").qrBlock(`${scheme}://${addrs[0]}:${where.port}`));
  }
  console.log(`  ${c.dim("works with no internet · answers only devices on your own network")}`);
  console.log(`  workspace: ${workspace} ${c.dim("· agents from the phone work here; more folders: arcflare phone root add <folder>")}`);
  if (!tls && host !== "127.0.0.1") {
    console.log(`  ${c.red("!")} plain http: anyone on this Wi-Fi who can see the traffic can read it. Use a network you trust,`);
    console.log(`    or pass --cert/--key for https.`);
  }
  if (allowRemote) {
    console.log(`  ${c.red("!")} --allow-remote: public addresses are accepted. Put TLS in front, and use a long password.`);
  }
  if (tun) {
    const { sanitizeLabel } = require("./tunnel");
    tun.on("status", (t) => console.log(`  ${c.dim("⇄ relay: " + t)}`));
    tun.on("paired", (d) => console.log(`  ${c.dim("⇄")} a phone answered a pairing QR: ${sanitizeLabel(d.label)} — confirm code ${d.sas} where you ran arcflare phone pair`));
    tun.on("revoked", (id) => console.log(`  ${c.dim("⇄ device " + id + " revoked and disconnected")}`));
    await tun.start();
  }
  const paired = store && tun ? store.listDevices().filter((d) => d.approved).length : 0;
  if (mailbox && lanOn) {
    const base = addrs[0] ? `${scheme}://${addrs[0]}:${where.port}` : `${scheme}://localhost:${where.port}`;
    console.log(`  lan tunnel: ${c.green("on")}  ${c.dim(base + " · encrypted end to end, no internet needed · " + paired + " paired phone(s) · arcflare phone pair to add one")}`);
    if (loopbackHost) console.log(`  ${c.dim("(the hub is bound to this computer only, so only this computer can use the LAN tunnel)")}`);
  } else {
    console.log(`  lan tunnel: off  ${c.dim("— phones on your Wi-Fi: arcflare phone lan on")}`);
  }
  if (tun && rs.cloudflare && mailbox) {
    try {
      cf = await require("./cftunnel").startCloudflare({
        mailbox, roomId: store.room().roomId, file: cfUrlFile(), keepFile: cfKeepFile(),
        log: (t) => console.log(`  ${c.dim("⇄ cloudflare: " + t)}`),
        onUrl: (u) => console.log(`  ${c.dim("⇄ cloudflare address: " + u)}`),
      });
      console.log(`  ArcFlare Connect: ${c.green("on")}  ${c.dim(cf.url + " · from anywhere, free, through Cloudflare · end-to-end encrypted · " + paired + " paired phone(s)")}`);
    } catch (e) {
      console.log(`  ${c.red("!")} ArcFlare Connect NOT started: ${e.message}`);
      if (e.code === "NO_CLOUDFLARED") console.log(`    ${c.dim("install it: arcflare phone connect install · or stay on your home network: arcflare phone connect off")}`);
      // The address existed but nothing was behind it: say that phones at home are unaffected, and where the detail is.
      if (e.code === "CF_NOT_CONNECTED") console.log(`    ${c.dim("phones on your home network still work · cloudflared's own log: " + cfKeepFile().replace(/\.json$/, ".log"))}`);
    }
  } else if (tun && rs.on) {
    console.log(`  relay: ${c.green("on")}  ${c.dim(rs.url + " · end-to-end encrypted · " + paired + " paired phone(s)")}`);
  } else {
    console.log(`  relay: off  ${c.dim("— to reach the hub from anywhere: arcflare phone relay on")}`);
  }
  console.log(`  ${c.dim("ctrl+c stops the hub and every agent it started")}\n`);

  const shutdown = async () => {
    try { if (tun) await tun.stop(); } catch { /* going down anyway */ }
    // Leave cloudflared running: the next hub start reuses its address, so phones away from home still find it.
    try { if (cf) cf.close({ keep: true }); } catch { /* ditto */ }
    try { if (mailbox) mailbox.close(); } catch { /* ditto */ }
    try { await supervisor.stopAll(); } catch { /* going down anyway */ }
    try { mcp.stopAll(); } catch { /* ditto */ }
    try { await hub.close(); } catch { /* ditto */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// `arcflare phone mute [on|off]`, `arcflare phone hours 07:00-23:00`: when agents may ring the phone or make it
// sound. Written to <hub>/settings.json, which a running hub reads again on every call and notice.
function phoneSettingsCommand(sub, argv) {
  const { HubSettings } = require("./settings");
  const s = new HubSettings({ dir: hubDir() });
  if (sub === "mute" && argv[0] !== undefined) {
    if (argv[0] !== "on" && argv[0] !== "off") throw new Error("arcflare phone mute [on | off]");
    s.setPhone({ muted: argv[0] === "on" });
  }
  if (sub === "hours") {
    const m = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(argv[0] || "");
    if (!m) throw new Error("arcflare phone hours <from>-<until>, for example 07:00-23:00");
    s.setPhone({ from: m[1], until: m[2] });
  }
  const p = s.phone();
  console.log(`  calls and sounds from agents: ${p.muted ? c.red("muted") : c.green("on")}  ${c.dim(`from ${p.from} until ${p.until}; outside those hours the phone does not ring and notices arrive silently`)}`);
}

// `arcflare phone notify [--kind commit|push|done|failed|info] <title> [body]`: for git hooks and scripts.
async function notifyCommand(argv) {
  const i = argv.indexOf("--kind");
  const kind = i >= 0 ? argv[i + 1] : undefined;
  const rest = i >= 0 ? argv.filter((_, j) => j !== i && j !== i + 1) : argv;
  if (!rest[0]) throw new Error("arcflare phone notify [--kind commit|push|done|failed|info] <title> [body]");
  const r = await require("./local").callHub("POST", "/api/local/notify", { title: rest[0], body: rest.slice(1).join(" "), kind });
  console.log(`  ${c.green(ui.sym.ok || "ok")} sent${r.sound === false ? c.dim(" without sound (muted, or outside your hours)") : ""}`);
}

async function command(cfg, argv) {
  const sub = argv[1];
  try {
    if (sub === "user") return await userCommand(argv.slice(2));
    if (sub === "pair") return await pairCommand(cfg, argv.slice(2));
    if (sub === "devices" || sub === "device") return await devicesCommand(argv.slice(2));
    if (sub === "relay" || sub === "connect") return relayCommand(cfg, argv.slice(2));
    if (sub === "lan") return lanCommand(cfg, argv.slice(2));
    if (sub === "root" || sub === "roots") return rootCommand(cfg, argv.slice(2));
    if (sub === "workspace") return workspaceCommand(cfg, argv.slice(2));
    if (sub === "tier" || sub === "tiers") return tierCommand(cfg, argv.slice(2));
    if (sub === "app") return appCommand(argv.slice(2));
    if (sub === "mute" || sub === "hours") return phoneSettingsCommand(sub, argv.slice(2));
    if (sub === "notify") return await notifyCommand(argv.slice(2));
    return await startCommand(cfg, argv.slice(sub === "start" ? 2 : 1));
  } catch (e) {
    console.error(`  ${c.red(ui.sym.fail || "✗")} ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { command, makeBackend, hubConfig, lanAddresses, rankLanAddresses, hubDir, TIERS, DEFAULT_PORT };
