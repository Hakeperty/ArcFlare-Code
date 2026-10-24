// Shared helpers for the tunnel robustness tests (not a test file): fake relay, hub setup.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { EventEmitter } = require("node:events");
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
const tunnel = require("../lib/hub/tunnel");
const TC = require("../lib/hub/ui/tunnel-client");
const { createHubServer } = require("../lib/hub/server");
const { AuthStore } = require("../lib/hub/auth");
const { HubTunnel, TunnelStore, pairingLink, tokenHash, TunnelRequest, TunnelResponse } = tunnel;
const I = tunnel._internal;
const RELAY = "https://relay.test";
const PASSWORD = "correct-horse-battery";
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
module.exports = { tunnel, TC, I, HubTunnel, TunnelStore, AuthStore, createHubServer, pairingLink, tokenHash,
  fakeRelay, fakeSupervisor, setup, pairAndApprove, json, login, until, RELAY, PASSWORD, nodeCrypto, fs, path, os };
