// Regression tests for the independent security review of the relay tunnel
// (M1, L1 to L7 and the info items). Each fails against the pre-fix code.

const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const H = require("./_tunnel-harness");
const { I, TC, HubTunnel, TunnelStore, fs, path, os, nodeCrypto, tunnel } = H;
const T = tunnel.T;

let x25519 = true;
test.before(async () => {
  try {
    const k = await globalThis.crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    await globalThis.crypto.subtle.exportKey("raw", k.publicKey);
  } catch { x25519 = false; }
});
const needX = (t) => { if (!x25519) { t.skip("no X25519 in WebCrypto here"); return false; } return true; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "robust-"));
const CH = "A".repeat(22);
const resetFrame = () => { const b = Buffer.alloc(18); b[0] = 1; b[1] = T.RESET; nodeCrypto.randomBytes(16).copy(b, 2); return b; };
const unknownData = () => { const b = Buffer.alloc(42); b[0] = 1; b[1] = T.DATA; nodeCrypto.randomBytes(16).copy(b, 2); return I.b64u(b); };
const hang = (init) => new Promise((_, rej) => init.signal && init.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
const ok = () => new Response('{"ok":true}');
function fakeSession(hub, extra = {}) {
  const now = hub.now();
  const s = {
    sid: nodeCrypto.randomBytes(16), ch: "B".repeat(22), deviceId: "d", label: "x", alive: true,
    recv: { n: 0 }, send: { k: Buffer.alloc(32, 1), n: 0, sinceRekey: 0, rekeyedAt: now, rekey() { this.rekeyedAt = hub.now(); } },
    created: now, lastRx: now, reqs: new Map(), refused: new Map(), maxReqId: 0, ...extra,
  };
  s.key = I.b64u(s.sid);
  hub.sessions.set(s.key, s);
  return s;
}
const newHub = (o = {}) => new HubTunnel({ store: new TunnelStore({ dir: tmp() }), relay: H.RELAY, dispatch() {}, ...o });

// ------------------------------------------------------------------ M1 ----

test("M1: unknown-session RESETs share one global budget (10/s), whatever the channel", () => {
  let t = 1e6;
  const hub = newHub({ now: () => t });
  for (let i = 0; i < 5000; i++) hub.receive(i % 2 ? CH : "C".repeat(22), unknownData());
  assert.strictEqual(hub.outbox.length, 10);
  t += 1000;
  for (let i = 0; i < 5000; i++) hub.receive(CH, unknownData());
  assert.strictEqual(hub.outbox.length, 20);
});

test("M1: the outbox is capped by frame count and bytes for every frame type, and is not re-filtered per frame", () => {
  const hub = newHub({ limits: { outboxFrames: 20, outboxBytes: 1e9 } });
  const ref = hub.outbox;
  for (let i = 0; i < 100; i++) hub._queue(CH, resetFrame());
  assert.strictEqual(hub.outbox.length, 20);
  assert.strictEqual(hub.outbox, ref, "dropping a new RESET must not rebuild the queue");
  const hub2 = newHub({ limits: { outboxBytes: 240 } }); // 24 chars per RESET
  for (let i = 0; i < 100; i++) hub2._queue(CH, resetFrame());
  assert.strictEqual(hub2.outbox.length, 10);
  assert.strictEqual(hub2.outBytes, 240);
});

function replyHub(replies) {
  let n = 0;
  const fetch = (url, init) => {
    if (init.method === "PUT") return Promise.resolve(ok());
    if (init.method === "GET") return n < replies.length ? Promise.resolve(replies[n++]()) : hang(init);
    return Promise.resolve(ok());
  };
  const hub = newHub({ fetch, pollWaitSec: 1, now: undefined });
  hub.received = 0;
  hub.receive = () => { hub.received++; };
  return hub;
}
const json = (o) => () => new Response(JSON.stringify(o), { status: 200 });

test("M1: a relay reply over 3 MB is refused unparsed; more than 256 frames per poll are ignored (hub)", async () => {
  const frame = { seq: 1, ch: CH, c: "AAAA" };
  const hub = replyHub([json({ frames: [frame], head: 1, pad: "x".repeat(4 * 1024 * 1024) })]);
  await hub.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(hub.received, 0, "oversized reply must not be parsed");
  await hub.stop();

  const many = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, ch: CH, c: "AAAA" }));
  const hub2 = replyHub([json({ frames: many, head: 1000 })]);
  await hub2.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(hub2.received, 256);
  assert.strictEqual(hub2.after, 256, "the rest stay on the relay for the next poll");
  await hub2.stop();
});

test("M1: the same two caps on the phone side (Mailbox)", async () => {
  const run = async (body) => {
    let n = 0, got = 0;
    const fetch = (u, init) => (n++ === 0 ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 })) : hang(init));
    const mb = new TC._internal.Mailbox({ relay: H.RELAY, room: "r", token: "t", fetch, waitSec: 1, onFrame: async () => { got++; } });
    mb.start();
    await new Promise((r) => setTimeout(r, 150));
    mb.stop();
    return got;
  };
  assert.strictEqual(await run({ frames: [{ seq: 1, c: "AAAA" }], pad: "x".repeat(4 * 1024 * 1024) }), 0);
  assert.strictEqual(await run({ frames: Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, c: "AAAA" })) }), 256);
});

// ------------------------------------------------------------------ L1 ----

test("L1: sent frames are removed by sequence, never by count; outBytes stays exact", async () => {
  let release;
  const fetch = async (url, init) => {
    if (init.method === "PUT") return ok();
    if (init.method === "GET") return hang(init);
    await new Promise((r) => { release = r; });
    return ok();
  };
  const hub = newHub({ fetch, limits: { outboxBytes: 64 * 1024 } });
  await hub.start();
  const s = fakeSession(hub);
  for (let i = 0; i < 10; i++) hub._send(s, { t: "data", id: 1, d: "x".repeat(600) });
  await new Promise((r) => setTimeout(r, 20)); // first batch is now held in flight
  for (let i = 0; i < 3000; i++) hub._queue(CH, resetFrame()); // overflow: DATA shed while the POST is out
  const queued = hub.outbox.length;
  assert.ok(queued > 0);
  release();
  await new Promise((r) => setTimeout(r, 30));
  const size = hub.outbox.reduce((n, f) => n + f.c.length, 0);
  assert.strictEqual(hub.outBytes, size);
  assert.ok(hub.outBytes >= 0);
  assert.ok(hub.outbox.length >= queued - hub.limits.batchFrames && hub.outbox.length <= queued, "only frames that were in the batch may go");
  hub.active = false; release && release();
  await hub.stop().catch(() => {});
});

// ------------------------------------------------------------------ L2 ----

test("L2: requests refused up front (404, 405, 429) do not kill the session when their body follows", async (t) => {
  if (!needX(t)) return;
  const env = await H.setup({ limits: { reqsPerSession: 1 } });
  try {
    const device = await H.pairAndApprove(env);
    const tun = await TC.connect(device, env.opts);
    await H.login(tun);
    const body = { headers: { "content-type": "application/json" }, body: "{}" };
    assert.strictEqual((await tun.request("POST", "/not-api", body)).status, 404);
    assert.strictEqual((await tun.request("TRACE", "/api/me", body)).status, 405);
    const es = tun.eventSource("/api/events");
    await new Promise((r, j) => { es.onopen = r; es.onerror = j; });
    assert.strictEqual((await tun.request("POST", "/api/me", body)).status, 429);
    es.close();
    assert.strictEqual(env.hub.sessions.size, 1, "session survived");
    assert.strictEqual((await tun.request("GET", "/api/me")).status, 200);
    assert.ok(!env.logs.some((l) => /BAD_ID/.test(l)));
  } finally { await env.close(); }
});

// ------------------------------------------------------------------ L3 ----

test("L3: a revoked device's very next frame is refused, before any housekeeping", async (t) => {
  if (!needX(t)) return;
  const env = await H.setup();
  try {
    const device = await H.pairAndApprove(env);
    const tun = await TC.connect(device, env.opts);
    const csrf = (await H.login(tun)).json().csrf;
    env.hub._housekeeping = () => {};
    env.store.revoke(device.deviceId); // as the CLI does, from another process
    const r = await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "after-revoke", cwd: "/tmp" }) }).then((x) => x.status, (e) => e.code);
    assert.notStrictEqual(r, 201);
    assert.strictEqual(env.supervisor.created, 0);
    assert.strictEqual(env.hub.sessions.size, 0);
  } finally { await env.close(); }
});

// ------------------------------------------------------------------ L4 ----

test("L4: replayed handshakes (after a restart) open nothing and evict no real session", async (t) => {
  if (!needX(t)) return;
  const env = await H.setup({ limits: { sessionsPerDevice: 2 } });
  try {
    const device = await H.pairAndApprove(env);
    const hs1s = [];
    env.relay.hooks.toHub = (ch, c) => { if (Buffer.from(c, "base64url")[1] === 1) hs1s.push({ ch, c }); return [c]; };
    for (let i = 0; i < 4; i++) { const x = await TC.connect(device, env.opts); x.close(); }
    env.relay.hooks.toHub = null;
    await new Promise((r) => setTimeout(r, 200));
    const real = await TC.connect(device, env.opts);
    assert.strictEqual((await real.request("GET", "/api/me")).status, 401);
    assert.strictEqual(env.hub.sessions.size, 1);
    env.hub.seenE.clear(); // what a restart does
    for (const h of hs1s) env.hub.receive(h.ch, h.c);
    assert.strictEqual(env.hub.sessions.size, 1, "replays are not sessions");
    assert.strictEqual((await real.request("GET", "/api/me")).status, 401, "the real session still works");
  } finally { await env.close(); }
});

// ------------------------------------------------------------------ L5 ----

test("L5: the hub and the CLI cannot lose each other's devices.json updates", async () => {
  const dir = tmp();
  new TunnelStore({ dir }).addDevice({ id: "seed", pub: "x", approved: true, pairedAt: Date.now() });
  const code = `const {TunnelStore}=require(${JSON.stringify(path.resolve(__dirname, "../lib/hub/tunnel"))});
    const s=new TunnelStore({dir:process.argv[1]});const p=process.argv[2];
    for(let i=0;i<120;i++)s._mutateDevices(d=>{d[p+i]={id:p+i,approved:true,pairedAt:Date.now()};});`;
  const run = (p) => new Promise((res) => spawn(process.execPath, ["-e", code, dir, p], { stdio: "inherit" }).on("exit", res));
  await Promise.all([run("a"), run("b")]);
  const devs = new TunnelStore({ dir }).devices();
  assert.strictEqual(Object.keys(devs).length, 1 + 240, "no update lost");
});

test("L5: a lock file whose delete is still pending (Windows EPERM) is waited for, not fatal", { skip: process.platform !== "win32" && "Windows-only error code" }, () => {
  const dir = tmp();
  const store = new TunnelStore({ dir });
  const real = fs.openSync;
  let thrown = 0;
  fs.openSync = (p, flags, ...rest) => {
    if (String(p).endsWith(".lock") && flags === "wx" && thrown < 2) {
      thrown++;
      throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" });
    }
    return real(p, flags, ...rest);
  };
  try { store.addDevice({ id: "a", pub: "x", approved: true, pairedAt: Date.now() }); } finally { fs.openSync = real; }
  assert.strictEqual(thrown, 2);
  assert.deepStrictEqual(Object.keys(store.devices()), ["a"]);
});

test("L5: a stale lock from a dead process is taken over", () => {
  const dir = tmp();
  const store = new TunnelStore({ dir });
  store.addDevice({ id: "a", pub: "x", approved: true, pairedAt: Date.now() });
  const lock = path.join(dir, "devices.json.lock");
  fs.writeFileSync(lock, "999999");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  store.addDevice({ id: "b", pub: "y", approved: true, pairedAt: Date.now() });
  assert.deepStrictEqual(Object.keys(store.devices()).sort(), ["a", "b"]);
  assert.ok(!fs.existsSync(lock));
});

// ------------------------------------------------------------------ L6 ----

test("L6: damaged state files stop the tunnel and are never replaced", () => {
  for (const [file, reader] of [["tunnel-key.json", (s) => s.keys()], ["devices.json", (s) => s.devices()], ["pairing.json", (s) => s.pendingPairings()]]) {
    const dir = tmp();
    const store = new TunnelStore({ dir });
    store.room(); store.addDevice({ id: "d", pub: "x", approved: true, pairedAt: Date.now() }); store.createPairing();
    const f = path.join(dir, file);
    const damaged = fs.readFileSync(f, "utf8").slice(0, 30);
    fs.writeFileSync(f, damaged);
    assert.throws(() => reader(store), { code: "CORRUPT" }, file);
    assert.throws(() => new HubTunnel({ store, relay: H.RELAY, dispatch() {} }), { code: "CORRUPT" }, file);
    if (file === "devices.json") assert.throws(() => store.addDevice({ id: "e", pub: "y", approved: false, pairedAt: Date.now() }), { code: "CORRUPT" });
    assert.strictEqual(fs.readFileSync(f, "utf8"), damaged, `${file} must be left untouched`);
  }
});

test("L6: secret files are fsynced before the rename", () => {
  const calls = [];
  const real = fs.fsyncSync;
  fs.fsyncSync = (fd) => { calls.push(fd); return real(fd); };
  try { new TunnelStore({ dir: tmp() }).keys(); } finally { fs.fsyncSync = real; }
  assert.ok(calls.length >= 1);
});

// ------------------------------------------------------------------ L7 ----

test("L7: pairing labels are reduced to printable characters wherever stored or listed", async (t) => {
  const bad = "A‮B\u0085C​D⁦E\u001b[31m F﻿" + "x".repeat(100);
  const clean = tunnel.sanitizeLabel(bad);
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(clean), JSON.stringify(clean));
  assert.ok(clean.length <= 60 && clean.startsWith("ABCDE"));
  assert.strictEqual(tunnel.sanitizeLabel("‮​"), "phone");
  // hand-edited / older files are cleaned on the way out
  const store = new TunnelStore({ dir: tmp() });
  store.addDevice({ id: "d1", label: "evil‮label\u009b", pub: "x", approved: true, pairedAt: Date.now() });
  assert.strictEqual(store.listDevices()[0].label, "evillabel");
  if (!needX(t)) return;
  const env = await H.setup();
  try {
    const { device } = await TC.pair({ link: env.link, label: "Pi‮xel\u0085​", fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 4000 });
    assert.strictEqual(env.store.listDevices().find((d) => d.id === device.deviceId).label, "Pixel");
    assert.strictEqual(env.store.devices()[device.deviceId].label, "Pixel", "stored clean too");
  } finally { await env.close(); }
});

function cli(home, args, preload) {
  const env = { ...process.env, ARCFLARE_HOME: home, NO_COLOR: "1" };
  if (preload) env.NODE_OPTIONS = `--require ${preload}`;
  return spawnSync(process.execPath, [path.resolve(__dirname, "../bin/arcflare.js"), "phone", "devices", ...args], { env, encoding: "utf8", input: "" });
}
function cliHome() {
  const home = tmp();
  process.env.ARCFLARE_HOME = home;
  const hubDir = require("../lib/hub/cli").hubDir();
  const store = new TunnelStore({ dir: hubDir });
  store.addDevice({ id: "dev-0123456789", label: "Pixel", pub: "x", approved: false, pairedAt: Date.now(), sas: "123456" });
  return { home, store };
}

test("L7: `devices approve` without a terminal needs --yes and shows the code", () => {
  const { home, store } = cliHome();
  let r = cli(home, ["approve", "dev-0123"]);
  assert.match(r.stdout, /123 456/);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(store.listDevices()[0].approved, false, "not approved blind");
  r = cli(home, ["approve", "dev-0123", "--yes"]);
  assert.match(r.stdout, /123 456/);
  assert.strictEqual(store.listDevices()[0].approved, true);
});

test("L7: a failed approve() is not reported as paired", () => {
  const { home, store } = cliHome();
  const pre = path.join(tmp(), "pre.js");
  fs.writeFileSync(pre, `require(${JSON.stringify(path.resolve(__dirname, "../lib/hub/tunnel"))}).TunnelStore.prototype.approve = () => false;`);
  const r = cli(home, ["approve", "dev-0123", "--yes"], pre);
  assert.doesNotMatch(r.stdout, /paired Pixel/);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(store.listDevices()[0].approved, false);
});

// ------------------------------------------------------------ info items ----

test("info: expired pairings are pruned from pairing.json on disk (psk gone)", () => {
  let t = 1e6;
  const dir = tmp();
  const store = new TunnelStore({ dir, now: () => t });
  store.createPairing();
  assert.match(fs.readFileSync(path.join(dir, "pairing.json"), "utf8"), /psk/);
  t += 11 * 60 * 1000;
  assert.deepStrictEqual(store.pendingPairings(), {});
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "pairing.json"), "utf8"), /psk/);
});

test("info: idle timeout applies to a half-sent request, not to a running handler", () => {
  let t = 1e6;
  const hub = newHub({ now: () => t });
  const half = fakeSession(hub); half.reqs.set(1, { id: 1, dispatched: false });
  const sse = fakeSession(hub); sse.reqs.set(1, { id: 1, dispatched: true, cancel() {} });
  t += 31 * 60 * 1000;
  hub._housekeeping();
  assert.strictEqual(half.alive, false);
  assert.strictEqual(sse.alive, true);
});

test("info: the hub's rekey timer uses the injected clock", () => {
  let t = 5000;
  const hub = newHub({ now: () => t });
  const s = fakeSession(hub);
  let frames = 0; hub.on("frame", () => frames++);
  hub._send(s, { t: "pong" });
  assert.strictEqual(frames, 1, "not due: rekeyMs has not passed on the injected clock");
  t += hub.limits.rekeyMs;
  hub._send(s, { t: "pong" });
  assert.strictEqual(frames, 3, "due: message plus rekey");
});

test("info: the hub enforces the 12 KiB body-chunk limit", () => {
  const hub = newHub();
  const s = fakeSession(hub);
  hub._message(s, { t: "req", id: 1, m: "POST", p: "/api/x", h: {} });
  hub._message(s, { t: "body", id: 1, d: I.b64u(Buffer.alloc(12 * 1024)) });
  assert.throws(() => hub._message(s, { t: "body", id: 1, d: I.b64u(Buffer.alloc(12 * 1024 + 1)) }), { code: "BAD_MESSAGE" });
});

test("info: the phone ends the session on an unknown message type even for an unknown id", async () => {
  const tun = new TC.Tunnel({}, {});
  await assert.rejects(tun._message({ t: "bogus", id: 99999 }), { code: "PROTOCOL" });
  await assert.rejects(tun._message({ t: "bogus" }), { code: "PROTOCOL" });
});

test("info: the phone's relay URL check is as strict as the hub's", () => {
  const k = () => I.b64u(nodeCrypto.randomBytes(32));
  for (const r of ["https://u:p@relay.test", "https://relay.test/?x=1", "https://relay.test/#f"]) {
    const link = `arcflare://pair?v=1&r=${encodeURIComponent(r)}&rm=${k()}&hk=${k()}&ps=${k()}`;
    assert.throws(() => TC.parsePairingLink(link), /plain origin/, r);
    assert.throws(() => tunnel.checkRelayUrl(r), /plain origin/);
  }
  assert.ok(TC.parsePairingLink(`arcflare://pair?v=1&r=${encodeURIComponent("https://relay.test")}&rm=${k()}&hk=${k()}&ps=${k()}`));
});

// ------------------------------------------------------------------ L4 ----

test("L4: a relay that answers every poll at once with no frames cannot make the phone spin (about 1 poll per second)", async (t) => {
  if (!needX(t)) return;
  const b = () => I.b64u(nodeCrypto.randomBytes(32));
  const kp = await globalThis.crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  const device = {
    v: 1, relay: "https://relay.test", room: b(), hubKey: b(), deviceId: I.b64u(nodeCrypto.randomBytes(16)),
    roomToken: "aftc_" + b(), privateKey: kp.privateKey, publicKey: b(),
  };
  const calls = { get: 0, post: 0 };
  const lying = async (url, init) => {
    if (init.method === "GET") { calls.get++; return new Response(JSON.stringify({ frames: [], head: 0, online: true })); }
    calls.post++;
    return new Response('{"ok":true}');
  };
  const t0 = Date.now();
  await assert.rejects(TC.connect(device, { fetch: lying, handshakeTimeoutMs: 2500 }), { code: "TIMEOUT" });
  const secs = (Date.now() - t0) / 1000;
  assert.ok(calls.get >= 1, "it did poll");
  assert.ok(calls.get <= Math.ceil(secs) + 1, `${calls.get} polls in ${secs.toFixed(1)} s is a spin`);
  // and the floor is configurable (so tests and slow links can lower it) but defaults to 1 s
  const calls2 = { get: 0 };
  const quick = async (url, init) => { if (init.method === "GET") calls2.get++; return new Response(init.method === "GET" ? '{"frames":[],"head":0,"online":true}' : '{"ok":true}'); };
  await assert.rejects(TC.connect(device, { fetch: quick, handshakeTimeoutMs: 600, minPollMs: 20 }), { code: "TIMEOUT" });
  assert.ok(calls2.get > 5, "the floor is configurable; the default (1 s) is the protection");
});

// ------------------------------------------------- round 3c: file-stamp races ----
// The hub notices changes to devices.json / pairing.json by their stamp. The stamp must be taken BEFORE the file
// is read: a write by the CLI that lands between the read and a later stat would otherwise be recorded as already
// seen, and a revoke (or a new pairing code) would be missed until some other change.

test("3c F2: a CLI revoke that lands between the hub's read and its stat is still noticed next pass", async (t) => {
  if (!needX(t)) return;
  const env = await H.setup();
  try {
    const A = await H.pairAndApprove(env);
    const cli = new TunnelStore({ dir: env.store.dir });
    const orig = env.store.devices.bind(env.store);
    let armed = true;
    env.store.devices = function () { const v = orig(); if (armed) { armed = false; cli.revoke(A.deviceId); } return v; };
    env.hub._reload(true);                  // the unlucky read: the revoke lands right after it
    env.store.devices = orig;
    env.hub._reload(false);                 // the next ordinary pass
    assert.ok(!cli.devices()[A.deviceId], "the CLI revoke is on disk");
    assert.ok(!env.hub._devices[A.deviceId], "and the hub no longer has the device in memory");
  } finally { await env.close(); }
});

test("3c F1: a pairing the CLI writes between the hub's read and its stat reaches the allowlists", async (t) => {
  if (!needX(t)) return;
  const env = await H.setup();
  try {
    const cli = new TunnelStore({ dir: env.store.dir });
    env.hub._pendCache = null;
    const orig = env.store.pendingPairings.bind(env.store);
    let armed = true, fresh = null;
    env.store.pendingPairings = function () { const v = orig(); if (armed) { armed = false; fresh = cli.createPairing(); } return v; };
    const before = Object.keys(env.hub._pendingPairings()).length;   // reads the old file; the CLI writes right after
    env.store.pendingPairings = orig;
    const after = Object.keys(env.hub._pendingPairings()).length;    // the next pass must read again
    assert.ok(fresh, "the CLI wrote a pairing");
    assert.strictEqual(after, before + 1, "the new pairing is seen on the next pass, not hidden behind the cache");
  } finally { await env.close(); }
});
