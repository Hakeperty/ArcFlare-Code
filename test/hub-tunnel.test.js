// The relay tunnel, end to end: the Node hub half (lib/hub/tunnel.js) against
// the WebCrypto phone half (lib/hub/ui/tunnel-client.js), through an in-memory
// relay that implements the "Relay API" section of lib/hub/TUNNEL.md, into the
// real hub request handler with a real AuthStore.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const nodeCrypto = require("node:crypto");
const { EventEmitter } = require("node:events");

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto; // Node 18

const tunnel = require("../lib/hub/tunnel");
const TC = require("../lib/hub/ui/tunnel-client");
const { createHubServer } = require("../lib/hub/server");
const { AuthStore } = require("../lib/hub/auth");

const { HubTunnel, TunnelStore, pairingLink, tokenHash, TunnelRequest, TunnelResponse } = tunnel;
const I = tunnel._internal;
const RELAY = "https://relay.test";
const PASSWORD = "correct-horse-battery";

let x25519 = true;
test.before(async () => {
  try {
    const k = await globalThis.crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    await globalThis.crypto.subtle.exportKey("raw", k.publicKey);
  } catch {
    x25519 = false;
  }
});
const needX = (t) => {
  if (!x25519) { t.skip("this Node's WebCrypto has no X25519; the phone half cannot run here"); return false; }
  return true;
};

// ----------------------------------------------------------- fake relay ----

/**
 * The Relay API from TUNNEL.md, in memory, as a fetch() function. Records
 * every request it received (URL, headers, body) and everything it stored, so
 * tests can check what a relay operator would see.
 */
function fakeRelay() {
  const rooms = new Map();
  const seen = [];     // every request as text
  const stored = [];   // every frame text it queued
  const hooks = { toHub: null, toClient: null };
  const B64 = /^[A-Za-z0-9_-]+$/;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const bearer = (init) => {
    const m = /^Bearer (\S+)$/.exec((init.headers && (init.headers.Authorization || init.headers.authorization)) || "");
    return m ? m[1] : null;
  };
  const hashOf = (t) => nodeCrypto.createHash("sha256").update(t, "utf8").digest("base64url");
  const wake = (r) => { for (const w of r.waiters) w(); r.waiters.clear(); };
  const wait = (r, ms, signal) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); r.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    r.waiters.add(done);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
  const clientOk = (r, tok) => {
    if (!tok || !/^aftc_[A-Za-z0-9_-]{43}$/.test(tok)) return null;
    const h = hashOf(tok);
    const e = r.clients.find((c) => c.h === h);
    if (!e || (e.exp && e.exp <= Date.now())) return null;
    return h;
  };

  async function fetch(url, init = {}) {
    if (init.signal && init.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const u = new URL(url);
    seen.push(`${init.method || "GET"} ${url} ${JSON.stringify(init.headers || {})} ${init.body || ""}`);
    const m = /^\/api\/tunnel\/room\/([A-Za-z0-9_-]{43})(?:\/(hub|client))?$/.exec(u.pathname);
    if (!m || u.origin !== RELAY) return reply(404, { error: "not found" });
    const roomId = m[1], part = m[2], method = init.method || "GET";
    const tok = bearer(init);
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { return reply(400, { error: "bad json" }); } }
    let r = rooms.get(roomId);

    if (!part) {
      if (method !== "PUT") return reply(405, { error: "method" });
      if (!tok || !/^afth_[A-Za-z0-9_-]{43}$/.test(tok) || hashOf(tok) !== roomId) return reply(401, { error: "bad hub token" });
      if (!body || !Array.isArray(body.clients) || body.clients.length > 32) return reply(400, { error: "bad clients" });
      if (!r) { r = { hubQ: [], hubSeq: 0, chans: new Map(), clients: [], hubSeen: 0, waiters: new Set() }; rooms.set(roomId, r); }
      r.clients = body.clients.map((c) => ({ h: c.h, exp: c.exp || 0 }));
      r.hubSeen = Date.now();
      return reply(200, { ok: true });
    }
    if (!r) return reply(404, { error: "no such room" });

    if (part === "hub") {
      if (!tok || hashOf(tok) !== roomId) return reply(401, { error: "bad hub token" });
      r.hubSeen = Date.now();
      if (method === "GET") {
        const after = Number(u.searchParams.get("after")) || 0;
        const ms = Math.min(Number(u.searchParams.get("wait")) || 0, 25) * 1000;
        const pending = () => r.hubQ.filter((f) => f.seq > after);
        if (!pending().length) await wait(r, ms, init.signal);
        r.hubSeen = Date.now();
        return reply(200, { frames: pending(), head: r.hubSeq });
      }
      if (method === "POST") {
        const frames = body && Array.isArray(body.frames) ? body.frames : null;
        if (!frames || frames.length > 64) return reply(400, { error: "bad frames" });
        let accepted = 0;
        for (const f of frames) {
          if (!f || typeof f.c !== "string" || !B64.test(f.c) || f.c.length > 44000) return reply(400, { error: "bad frame" });
          const ch = r.chans.get(f.ch);
          if (!ch) continue;
          for (const c of hooks.toClient ? hooks.toClient(f.ch, f.c) : [f.c]) {
            ch.q.push({ seq: ++ch.seq, c });
            stored.push(c);
          }
          accepted++;
        }
        wake(r);
        return reply(200, { ok: true, accepted });
      }
      return reply(405, { error: "method" });
    }

    // client
    const who = clientOk(r, tok);
    if (!who) return reply(401, { error: "not allowed" });
    const chId = method === "GET" ? u.searchParams.get("ch") : body && body.ch;
    if (typeof chId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(chId)) return reply(400, { error: "bad channel" });
    let ch = r.chans.get(chId);
    if (ch && ch.owner !== who) return reply(403, { error: "channel belongs to another token" });
    if (!ch) { ch = { owner: who, q: [], seq: 0 }; r.chans.set(chId, ch); }
    if (method === "GET") {
      const after = Number(u.searchParams.get("after")) || 0;
      const ms = Math.min(Number(u.searchParams.get("wait")) || 0, 25) * 1000;
      const pending = () => ch.q.filter((f) => f.seq > after);
      if (!pending().length) await wait(r, ms, init.signal);
      return reply(200, { frames: pending(), online: Date.now() - r.hubSeen < 45000, head: ch.seq });
    }
    if (method === "POST") {
      const frames = body && Array.isArray(body.frames) ? body.frames : null;
      if (!frames || frames.length > 16) return reply(400, { error: "bad frames" });
      if (Date.now() - r.hubSeen > 45000) return reply(409, { error: "hub offline" });
      for (const c of frames) {
        if (typeof c !== "string" || !B64.test(c) || c.length > 44000) return reply(400, { error: "bad frame" });
        for (const out of hooks.toHub ? hooks.toHub(chId, c) : [c]) {
          r.hubQ.push({ seq: ++r.hubSeq, ch: chId, c: out });
          stored.push(out);
        }
      }
      wake(r);
      return reply(200, { ok: true });
    }
    return reply(405, { error: "method" });
  }

  return { fetch, rooms, seen, stored, hooks };
}

// ------------------------------------------------------------- the hub ----

function fakeSupervisor() {
  const sup = new EventEmitter();
  sup.created = 0;
  sup.agents = {};
  sup.list = () => Object.values(sup.agents);
  sup.get = (id) => sup.agents[id] || null;
  sup.history = () => [];
  sup.create = async (o) => { const a = { id: "a" + ++sup.created, status: "stopped", ...o }; sup.agents[a.id] = a; return a; };
  return sup;
}

async function setup({ limits, createPairing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("alice", PASSWORD);
  const supervisor = fakeSupervisor();
  const server = createHubServer({ auth, supervisor, config: { heartbeatMs: 1000 } });
  const relay = fakeRelay();
  const store = new TunnelStore({ dir });
  const room = store.room();
  let link = null, secret = null;
  if (createPairing) {
    secret = store.createPairing().secret;
    link = pairingLink({ relay: RELAY, roomId: room.roomId, hubPub: room.hubPub, secret });
  }
  const logs = [];
  const hub = new HubTunnel({
    store, relay: RELAY, dispatch: server.dispatchTunnel, auth, fetch: relay.fetch,
    pollWaitSec: 1, limits, log: (m) => logs.push(String(m && m.message || m)),
  });
  await hub.start();
  const opts = { fetch: relay.fetch, pollWaitSec: 1, handshakeTimeoutMs: 4000 };
  return {
    dir, auth, supervisor, server, relay, store, room, hub, link, secret, opts, logs,
    async close() { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function pairAndApprove(env, label = "Pixel test") {
  const { device, sas } = await TC.pair({ link: env.link, label, fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 4000 });
  const rec = env.store.listDevices().find((d) => d.id === device.deviceId);
  assert.ok(rec, "hub recorded the device");
  assert.strictEqual(rec.sas, sas, "both sides show the same confirmation code");
  assert.strictEqual(rec.approved, false);
  env.store.approve(device.deviceId);
  return device;
}

const json = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

async function login(tun, password = PASSWORD) {
  return tun.request("POST", "/api/login", json({ username: "alice", password, device: "phone" }));
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

// --------------------------------------------------------- primitives ----

test("Node and WebCrypto halves agree on every primitive", async (t) => {
  if (!needX(t)) return;
  const ck = nodeCrypto.randomBytes(32), ikm = nodeCrypto.randomBytes(32);
  const a = I.hkdf(ck, ikm, 3), b = await TC._internal.hkdf(new Uint8Array(ck), new Uint8Array(ikm), 3);
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(Buffer.from(b[i]), a[i]);
  assert.deepStrictEqual(Buffer.from(await TC._internal.kdf(ck, "x")), I.kdf(ck, "x"));
  const k = nodeCrypto.randomBytes(32), ad = Buffer.from("ad");
  const ct = I.aeadSeal(k, 7, ad, Buffer.from("hello"));
  assert.strictEqual(Buffer.from(await TC._internal.open(k, 7, ad, ct)).toString(), "hello");
  await assert.rejects(TC._internal.open(k, 8, ad, ct), { code: "AEAD" });
  assert.deepStrictEqual(Buffer.from(await TC._internal.rekeyKey(k)), I.rekeyKey(k));
  // X25519 both ways
  const hubKp = I.x25519Generate();
  const ph = await TC._internal.generateX25519();
  assert.deepStrictEqual(Buffer.from(await TC._internal.dh(ph.privateKey, hubKp.pub)), I.dh(hubKp.priv, Buffer.from(ph.pub)));
  // low-order point refused
  assert.throws(() => I.dh(hubKp.priv, Buffer.alloc(32)), { code: "DH" });
  await assert.rejects(TC._internal.dh(ph.privateKey, new Uint8Array(32)));
  // base64url strictness
  for (let n = 0; n < 40; n++) {
    const r = nodeCrypto.randomBytes(n);
    assert.strictEqual(TC._internal.b64u(r), r.toString("base64url"));
    assert.deepStrictEqual(Buffer.from(TC._internal.unb64u(r.toString("base64url"))), r);
  }
  assert.strictEqual(TC._internal.unb64u("ab=c"), null);
  assert.strictEqual(I.unb64u("AB"), null); // non-canonical trailing bits
});

test("pairing link: custom scheme, carries the pinned key, never a web URL", (t) => {
  const kp = I.x25519Generate();
  const link = pairingLink({ relay: RELAY, roomId: I.b64u(nodeCrypto.randomBytes(32)), hubPub: kp.pub, secret: I.b64u(nodeCrypto.randomBytes(32)), lan: "http://192.168.1.5:7878" });
  assert.match(link, /^arcflare:\/\/pair\?v=1&/);
  const p = TC.parsePairingLink(link);
  assert.strictEqual(p.relay, RELAY);
  assert.strictEqual(p.hubKey, kp.pub.toString("base64url"));
  assert.strictEqual(p.lan, "http://192.168.1.5:7878");
  assert.throws(() => TC.parsePairingLink(link.replace("v=1", "v=2")), { code: "BAD_VERSION" });
  assert.throws(() => TC.parsePairingLink(link.replace(encodeURIComponent(RELAY), encodeURIComponent("http://evil.example"))), { code: "BAD_LINK" });
  assert.throws(() => tunnel.checkRelayUrl("http://relay.example"), /https/);
});

// ------------------------------------------------------------ the flow ----

test("pair, approve, log in and use the real handler through the tunnel; CSRF still enforced", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const { device, sas } = await TC.pair({ link: env.link, label: "Pixel test", fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 4000 });
    assert.match(sas, /^\d{6}$/);
    assert.strictEqual(env.store.listDevices()[0].sas, sas);

    // Not approved yet: the hub answers "pending" and opens nothing.
    await assert.rejects(TC.connect(device, env.opts), { code: "PENDING" });
    assert.strictEqual(env.hub.sessions.size, 0);

    env.store.approve(device.deviceId);
    const tun = await TC.connect(device, env.opts);
    assert.strictEqual(env.hub.sessions.size, 1);

    let r = await tun.request("GET", "/api/me");
    assert.strictEqual(r.status, 401, "no session yet");

    r = await login(tun, "wrong-password-1");
    assert.strictEqual(r.status, 401);
    r = await login(tun);
    assert.strictEqual(r.status, 200);
    const csrf = r.json().csrf;
    assert.ok(csrf);
    assert.strictEqual(r.headers["set-cookie"], undefined, "the cookie stays on the hub");
    assert.ok(env.hub.jar.get(device.deviceId), "hub-side jar holds the session");

    r = await tun.request("GET", "/api/me");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json().user.username, "alice");

    // Mutations need the CSRF header, exactly as on the LAN.
    const body = { name: "x", cwd: "/tmp", tier: "light" };
    r = await tun.request("POST", "/api/agents", json(body));
    assert.strictEqual(r.status, 403);
    r = await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": "nope" }, body: JSON.stringify(body) });
    assert.strictEqual(r.status, 403);
    r = await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(env.supervisor.created, 1);

    // A large body is chunked and reassembled in order.
    const big = "y".repeat(30000);
    r = await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ ...body, task: big }) });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(env.supervisor.agents.a2.task, big);

    // The session shows up with the device, not an address.
    const sessions = env.auth.listSessions("alice");
    assert.ok(sessions.some((s) => s.ip === `relay:${device.deviceId}`));

    // Only /api is reachable through the tunnel, and a client-sent Cookie is ignored.
    r = await tun.request("GET", "/index.html");
    assert.strictEqual(r.status, 404);
    // Logging out clears the hub-side jar.
    r = await tun.request("POST", "/api/logout", { headers: { "x-csrf-token": csrf } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(env.hub.jar.get(device.deviceId), undefined);
    r = await tun.request("GET", "/api/me", { headers: { cookie: "arcflare_sid=whatever" } });
    assert.strictEqual(r.status, 401);
    tun.close();
  } finally { await env.close(); }
});

test("the relay only ever sees ciphertext", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const device = await pairAndApprove(env);
    const tun = await TC.connect(device, env.opts);
    const r = await login(tun);
    const csrf = r.json().csrf;
    const cookie = env.hub.jar.get(device.deviceId).value;
    await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "secret-agent-name", cwd: "/home/alice/project" }) });
    const me = await tun.request("GET", "/api/me");
    assert.strictEqual(me.status, 200);
    tun.close();

    const everything = env.relay.seen.join("\n") + "\n" + env.relay.stored.join("\n");
    const forbidden = {
      password: PASSWORD, username: "alice", cookie, csrf, pathMe: "/api/me", pathLogin: "/api/login", pathAgents: "/api/agents", login: "login",
      agent: "secret-agent-name", cwd: "/home/alice", pairingSecret: env.secret,
      pairingPsk: I.b64u(tunnel.derivePairing(Buffer.from(env.secret, "base64url")).psk),
      hubPrivate: I.b64u(env.store.keys().priv), roomSecret: I.b64u(env.store.keys().roomSecret),
    };
    for (const [what, s] of Object.entries(forbidden)) {
      assert.ok(!everything.includes(s), `relay saw the ${what}`);
      // and not base64-wrapped either
      assert.ok(!everything.includes(Buffer.from(s).toString("base64url").slice(0, 16)), `relay saw the ${what} (base64)`);
    }
    // What the relay keeps about devices is hashes only.
    const roomState = JSON.stringify([...env.relay.rooms.values()][0].clients);
    assert.ok(!roomState.includes(device.roomToken));
    assert.ok(roomState.includes(tokenHash(device.roomToken)));
    // devices.json holds no secrets: public keys and hashes only.
    const devFile = fs.readFileSync(path.join(env.dir, "devices.json"), "utf8");
    assert.ok(!devFile.includes(device.roomToken));
    if (process.platform !== "win32") {
      for (const f of ["devices.json", "tunnel-key.json", "pairing.json"]) {
        assert.strictEqual(fs.statSync(path.join(env.dir, f)).mode & 0o777, 0o600, f);
      }
    }
  } finally { await env.close(); }
});

// ------------------------------------------------------------- attacks ----

test("tampered frames are detected in both directions and end the session", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const device = await pairAndApprove(env);
    let tun = await TC.connect(device, env.opts);
    assert.strictEqual((await tun.request("GET", "/api/status")).status, 200);

    // phone -> hub: flip one ciphertext bit
    env.relay.hooks.toHub = (ch, c) => {
      const b = Buffer.from(c, "base64url");
      if (b[1] === tunnel.T.DATA) b[b.length - 20] ^= 1;
      return [b.toString("base64url")];
    };
    await assert.rejects(tun.request("GET", "/api/status"), { code: "RESET" });
    assert.strictEqual(env.hub.sessions.size, 0);
    assert.ok(env.logs.some((l) => /authentication failed/.test(l)));
    env.relay.hooks.toHub = null;

    // hub -> phone: flip one ciphertext bit
    tun = await TC.connect(device, env.opts);
    env.relay.hooks.toClient = (ch, c) => {
      const b = Buffer.from(c, "base64url");
      if (b[1] === tunnel.T.DATA) b[b.length - 1] ^= 0x80;
      return [b.toString("base64url")];
    };
    await assert.rejects(tun.request("GET", "/api/status"), { code: "AEAD" });
    env.relay.hooks.toClient = null;

    // tampered handshake: no session, client gives up
    env.relay.hooks.toHub = (ch, c) => {
      const b = Buffer.from(c, "base64url");
      if (b[1] === tunnel.T.HS1) b[b.length - 3] ^= 1;
      return [b.toString("base64url")];
    };
    await assert.rejects(TC.connect(device, { ...env.opts, handshakeTimeoutMs: 1500 }), { code: "TIMEOUT" });
    env.relay.hooks.toHub = null;
    // a forged HS2 (relay pretending to be the hub) is refused
    env.relay.hooks.toClient = (ch, c) => {
      const b = Buffer.from(c, "base64url");
      if (b[1] === tunnel.T.HS2) nodeCrypto.randomBytes(32).copy(b, 18); // swap in the relay's own ephemeral key
      return [b.toString("base64url")];
    };
    await assert.rejects(TC.connect(device, env.opts), { code: "HANDSHAKE" });
  } finally { await env.close(); }
});

test("replayed frames are dropped; reordered or missing frames end the session", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const device = await pairAndApprove(env);
    const tun = await TC.connect(device, env.opts);
    const csrf = (await login(tun)).json().csrf;

    const captured = [];
    env.relay.hooks.toHub = (ch, c) => { captured.push({ ch, c }); return [c]; };
    const r = await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "x", cwd: "/tmp" }) });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(env.supervisor.created, 1);
    env.relay.hooks.toHub = null;

    // The relay replays the whole request. Nothing happens, the session lives.
    for (const f of captured) env.hub.receive(f.ch, f.c);
    await new Promise((res) => setTimeout(res, 100));
    assert.strictEqual(env.supervisor.created, 1, "replay did not create a second agent");
    assert.strictEqual((await tun.request("GET", "/api/status")).status, 200, "session survived the replay");

    // A replayed frame on a different channel is ignored too.
    env.hub.receive("A".repeat(22), captured[0].c);
    assert.strictEqual(env.hub.sessions.size, 1);

    // Reorder: hold one frame, deliver the next first.
    let held = null;
    env.relay.hooks.toHub = (ch, c) => {
      const b = Buffer.from(c, "base64url");
      if (b[1] !== tunnel.T.DATA) return [c];
      if (!held) { held = c; return []; }
      const out = [c, held];
      env.relay.hooks.toHub = null;
      return out;
    };
    const p1 = tun.request("GET", "/api/status");
    const p2 = tun.request("GET", "/api/me");
    await assert.rejects(Promise.all([p1, p2]), { code: "RESET" });
    assert.strictEqual(env.hub.sessions.size, 0);
    assert.ok(env.logs.some((l) => /frame missing/.test(l)));

    // A replayed handshake opens nothing (ephemeral key already seen).
    let hs1 = null;
    env.relay.hooks.toHub = (ch, c) => { if (Buffer.from(c, "base64url")[1] === tunnel.T.HS1) hs1 = { ch, c }; return [c]; };
    const tun2 = await TC.connect(device, env.opts);
    env.relay.hooks.toHub = null;
    const before = env.hub.sessions.size;
    env.hub.receive(hs1.ch, hs1.c);
    assert.strictEqual(env.hub.sessions.size, before);
    tun2.close();
  } finally { await env.close(); }
});

test("a pairing link with the wrong hub key fails; so does a forged pairing reply", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const wrong = pairingLink({ relay: RELAY, roomId: env.room.roomId, hubPub: I.x25519Generate().pub, secret: env.secret });
    await assert.rejects(TC.pair({ link: wrong, fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 1500 }), { code: "TIMEOUT" });
    assert.strictEqual(env.store.listDevices().length, 0);

    // A relay that answers the real link with its own HS2 is caught.
    env.relay.hooks.toClient = (ch, c) => {
      const b = Buffer.from(c, "base64url");
      if (b[1] === tunnel.T.HS2) b[b.length - 5] ^= 1;
      return [b.toString("base64url")];
    };
    await assert.rejects(TC.pair({ link: env.link, fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 4000 }), { code: "HANDSHAKE" });
  } finally { await env.close(); }
});

test("pairing secrets are one-time and expire", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    let hs1 = null;
    env.relay.hooks.toHub = (ch, c) => { if (Buffer.from(c, "base64url")[1] === tunnel.T.HS1) hs1 = { ch, c }; return [c]; };
    await TC.pair({ link: env.link, fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 4000 });
    env.relay.hooks.toHub = null;
    assert.strictEqual(env.store.listDevices().length, 1);
    const left = Object.values(env.store.pendingPairings());
    assert.ok(left.length === 1 && left[0].used, "consumed; token kept only for the reply grace");
    assert.ok(left[0].expires <= Date.now() + tunnel.LIMITS.pairGraceMs);
    assert.ok(!fs.readFileSync(path.join(env.dir, "pairing.json"), "utf8").includes('"psk"'), "psk erased on use");

    // Same link again: the hub does not answer (the relay may still carry it for the grace).
    await assert.rejects(TC.pair({ link: env.link, fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 1500 }), { code: "TIMEOUT" });
    assert.strictEqual(env.store.listDevices().length, 1);
    // The captured handshake replayed verbatim does nothing either.
    const frames = [];
    env.hub.on("frame", (f) => frames.push(f));
    env.hub.seenE.clear();
    env.hub.receive(hs1.ch, hs1.c);
    assert.strictEqual(frames.length, 0);
    assert.strictEqual(env.store.listDevices().length, 1);

    // An expired pairing.
    const s2 = env.store.createPairing({ ttlMs: 1 }).secret;
    await new Promise((r) => setTimeout(r, 5));
    await env.hub._syncRoom();
    const link2 = pairingLink({ relay: RELAY, roomId: env.room.roomId, hubPub: env.room.hubPub, secret: s2 });
    await assert.rejects(TC.pair({ link: link2, fetch: env.relay.fetch, pollWaitSec: 1, timeoutMs: 1500 }), { code: "REFUSED" });
    assert.strictEqual(env.store.listDevices().length, 1);
  } finally { await env.close(); }
});

test("a revoked device is cut off: session, relay access and login session", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const device = await pairAndApprove(env);
    const tun = await TC.connect(device, env.opts);
    assert.strictEqual((await login(tun)).status, 200);
    const token = env.hub.jar.get(device.deviceId).value;
    assert.ok(env.auth.authenticate(token));

    // The CLI revokes (another process: only the file changes).
    assert.strictEqual(env.store.revoke(device.deviceId), true);
    assert.ok(await until(() => env.hub.sessions.size === 0), "hub dropped the session");
    assert.strictEqual(env.auth.authenticate(token), null, "its login session was ended");
    assert.strictEqual(env.hub.jar.get(device.deviceId), undefined);
    await assert.rejects(tun.request("GET", "/api/me"));
    assert.ok(await until(() => !JSON.stringify([...env.relay.rooms.values()][0].clients).includes(tokenHash(device.roomToken))),
      "relay no longer accepts its token");
    await assert.rejects(TC.connect(device, { ...env.opts, handshakeTimeoutMs: 1500 }), { code: "REFUSED" });

    // Even if the relay still let it in, the hub would not answer.
    const frames = [];
    env.hub.on("frame", (f) => frames.push(f));
    const evil = fakeRelayBypass(env, device);
    await assert.rejects(TC.connect(device, { ...env.opts, fetch: evil, handshakeTimeoutMs: 1500 }), { code: "TIMEOUT" });
    assert.strictEqual(frames.filter((f) => Buffer.from(f.c, "base64url")[1] === tunnel.T.HS2).length, 0);
  } finally { await env.close(); }
});

/** A relay that ignores its allowlist: feeds the phone's frames straight to the hub. */
function fakeRelayBypass(env) {
  return async (url, init = {}) => {
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      for (const c of b.frames) env.hub.receive(b.ch, c);
      return new Response('{"ok":true}', { status: 200 });
    }
    await new Promise((r) => setTimeout(r, 200));
    return new Response('{"frames":[]}', { status: 200 });
  };
}

test("tunnel logins are locked out per device and cannot dodge the lockout", async (t) => {
  if (!needX(t)) return;
  const env = await setup();
  try {
    const device = await pairAndApprove(env);
    let tun = await TC.connect(device, env.opts);
    for (let i = 0; i < 5; i++) assert.strictEqual((await login(tun, "wrong-password-" + i)).status, 401);
    let r = await login(tun);
    assert.strictEqual(r.status, 429, "locked even with the right password");
    assert.ok(env.auth.byIp.has(`relay:${device.deviceId}`), "lockout keyed on the device");
    assert.ok(!env.auth.byIp.has("undefined") && !env.auth.byIp.has("unknown"), "not on a shared address");

    // A fresh session from the same device is the same device.
    tun.close();
    tun = await TC.connect(device, env.opts);
    r = await login(tun);
    assert.strictEqual(r.status, 429);
    // A client-chosen header cannot change who it is.
    r = await tun.request("POST", "/api/login", { headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" }, body: JSON.stringify({ username: "alice", password: PASSWORD }) });
    assert.strictEqual(r.status, 429);
  } finally { await env.close(); }
});

test("the private-address gate is skipped only for requests the tunnel dispatched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-gate-"));
  const auth = new AuthStore({ dir });
  const hub = createHubServer({ auth, supervisor: fakeSupervisor(), getRemoteAddress: () => "8.8.8.8" });
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  try {
    const status = (headers) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/status", headers, agent: false }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    assert.strictEqual(await status({}), 403);
    for (const h of [{ "x-arcflare-tunnel": "1" }, { "x-forwarded-for": "192.168.1.2" }, { via: "tunnel" }, { forwarded: "for=127.0.0.1" }]) {
      assert.strictEqual(await status(h), 403, JSON.stringify(h));
    }
    // A hand-built request object without the mark is refused too.
    const viaHandler = (dispatch) => new Promise((resolve) => {
      const req = new TunnelRequest({ method: "GET", url: "/api/status", headers: { host: "localhost" } });
      const res = new TunnelResponse({ head: (s) => resolve(s), data() {}, end() {}, abort() {}, backlog: () => 0 });
      dispatch(req, res);
    });
    assert.strictEqual(await viaHandler((q, s) => hub.server.emit("request", q, s)), 403);
    assert.strictEqual(await viaHandler((q, s) => hub.dispatchTunnel(q, s, { deviceId: "dev1" })), 200);
    assert.throws(() => hub.dispatchTunnel(new TunnelRequest({ method: "GET", url: "/", headers: {} }), {}, {}), /deviceId/);
    // Host allowlist still runs on tunnel requests.
    const bad = await new Promise((resolve) => {
      const req = new TunnelRequest({ method: "GET", url: "/api/status", headers: { host: "evil.example" } });
      const res = new TunnelResponse({ head: (s) => resolve(s), data() {}, end() {}, abort() {}, backlog: () => 0 });
      hub.dispatchTunnel(req, res, { deviceId: "dev1" });
    });
    assert.strictEqual(bad, 421);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown devices get nothing; SSE streams and rekeying work through the tunnel", async (t) => {
  if (!needX(t)) return;
  const env = await setup({ limits: { rekeyFrames: 3 } });
  try {
    const device = await pairAndApprove(env);
    // A device id the hub never paired: silence.
    const stranger = { ...device, deviceId: I.b64u(nodeCrypto.randomBytes(16)) };
    await assert.rejects(TC.connect(stranger, { ...env.opts, handshakeTimeoutMs: 1000 }), { code: "TIMEOUT" });
    // The right id with someone else's key: silence too.
    const other = await TC._internal.generateX25519();
    await assert.rejects(TC.connect({ ...device, privateKey: other.privateKey, publicKey: TC._internal.b64u(other.pub) }, { ...env.opts, handshakeTimeoutMs: 1000 }), { code: "TIMEOUT" });

    const tun = await TC.connect(device, { ...env.opts, rekeyFrames: 3 });
    await login(tun);
    for (let i = 0; i < 12; i++) assert.strictEqual((await tun.request("GET", "/api/me")).status, 200);
    const s = [...env.hub.sessions.values()][0];
    assert.ok(s.send.n > 12 && s.recv.n > 12);

    const got = [];
    const es = tun.eventSource("/api/events");
    await new Promise((resolve, reject) => { es.onopen = resolve; es.onerror = reject; });
    assert.strictEqual(env.supervisor.listenerCount("event"), 1);
    es.onmessage = (ev) => got.push(JSON.parse(ev.data));
    env.supervisor.emit("event", { type: "status", agentId: "a1", status: "running", seq: 1 });
    env.supervisor.emit("event", { type: "delta", agentId: "a1", text: "filtered out" });
    env.supervisor.emit("event", { type: "turn_end", agentId: "a1", seq: 2 });
    assert.ok(await until(() => got.length >= 2));
    assert.deepStrictEqual(got.map((g) => g.type), ["status", "turn_end"]);
    es.close();
    assert.ok(await until(() => env.supervisor.listenerCount("event") === 0), "cancel ended the stream on the hub");
    assert.strictEqual((await tun.request("GET", "/api/me")).status, 200);
    tun.close();
  } finally { await env.close(); }
});
