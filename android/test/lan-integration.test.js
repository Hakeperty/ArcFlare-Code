"use strict";
// INTEGRATION: the REAL hub (HubTunnel + the hub's LAN mailbox lib/hub/lanrelay.js inside the real hub server) and
// the REAL shipped tunnel client (www/ui/tunnel-client.js) and this app's connector + lanfetch, with ONLY the native
// HTTP stack faked: a stand-in for Capacitor's CapacitorHttp that performs real HTTP to the hub's mailbox, rewriting the
// LAN address http://192.168.1.20:8765 to the hub's real 127.0.0.1 port, and that answers like Capacitor does
// (application/json answers come back already parsed, header names as the server wrote them, redirects off).
// Proves the wire contract between this app and the hub's mailbox. Does not prove anything about Android.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const H = require("../../test/_tunnel-harness");
const { createLanRelay } = require("../../lib/hub/lanrelay");
const { HubTunnel, TunnelStore, AuthStore, createHubServer, pairingLink, fakeSupervisor, json, PASSWORD } = H;
const TC = require("../www/ui/tunnel-client.js");
const LanFetch = require("../www/lanfetch.js");
const Connector = require("../www/connector.js");
const Link = require("../www/link.js");

const LAN = "http://192.168.1.20:8765";
let x25519 = true;
test.before(async () => {
  try { const k = await globalThis.crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]); await globalThis.crypto.subtle.exportKey("raw", k.publicKey); } catch { x25519 = false; }
});
const skip = (t) => { if (!x25519) { t.skip("no X25519 in this Node"); return true; } return false; };

/** A fake of CapacitorHttp doing real HTTP to 127.0.0.1:<port>; `seen` records what the app asked for. */
function fakeNative(port, seen) {
  const call = (method) => (o) => new Promise((resolve, reject) => {
    seen.push({ method, url: o.url, headers: Object.assign({}, o.headers), disableRedirects: o.disableRedirects, connectTimeout: o.connectTimeout, readTimeout: o.readTimeout, data: o.data });
    const u = new URL(o.url);
    const body = method === "POST" ? JSON.stringify(o.data) : undefined;
    const headers = Object.assign({ Host: u.host }, o.headers);          // the Host a real phone sends: the LAN address
    if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, path: u.pathname + u.search, method, headers, timeout: o.readTimeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
        let data = text;
        if ((res.headers["content-type"] || "").includes("application/json")) { try { data = JSON.parse(text); } catch { /* text */ } }
        resolve({ status: res.statusCode, headers: h, data, url: o.url });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("SocketTimeoutException")); });
    if (body !== undefined) req.write(body);
    req.end();
  });
  return { get: call("GET"), post: call("POST") };
}

async function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-lan-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("alice", PASSWORD);
  const store = new TunnelStore({ dir });
  const room = store.room();
  const mailbox = createLanRelay({ roomId: room.roomId });
  const secret = store.createPairing().secret;
  const server = createHubServer({ auth, supervisor: fakeSupervisor(), lanRelay: mailbox, getRemoteAddress: () => "127.0.0.1", config: { heartbeatMs: 1000 } });
  const hub = new HubTunnel({ store, relay: null, local: mailbox.local, dispatch: server.dispatchTunnel, auth, fetch: async () => { throw new Error("the internet relay must not be used"); }, pollWaitSec: 1, minPollMs: 50, log() {} });
  const where = await server.listen({ port: 0, host: "127.0.0.1" });
  await hub.start();
  const seen = [];
  const native = fakeNative(where.port, seen);
  // the link exactly as `arcflare phone pair` prints it with the internet relay off: r = l = the LAN base
  const text = pairingLink({ relay: LAN, roomId: room.roomId, hubPub: room.hubPub, secret, lan: LAN });
  const deps = { Tunnel: TC, lanFetch: (lanBase) => LanFetch.create({ http: native, lanBase }), extra: { pollWaitSec: 1, minPollMs: 50 } };
  return { dir, store, hub, seen, deps, text, auth,
    async close() { await hub.stop(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("LAN-only pairing, approval, connect, login: the shell's real modules against the real hub mailbox", async (t) => {
  if (skip(t)) return;
  const e = await env();
  try {
    const v = Link.validateLink(e.text);
    assert.equal(v.ok, true, v.error);
    assert.equal(v.value.relayIsLan, true);
    const { device, sas, via } = await Connector.pairBest(e.deps, v.value, "Android phone");
    assert.equal(via, "home");
    assert.match(sas, /^\d{6}$/);
    const rec = Object.assign({}, device, { relay: v.value.relay, lan: v.value.lan });
    // not approved yet: the home handshake succeeds but says PENDING (and does not go anywhere else)
    await assert.rejects(Connector.connectBest(e.deps, rec), { code: "PENDING" });
    e.store.approve(device.deviceId);
    const c = await Connector.connectBest(e.deps, rec);
    assert.equal(c.kind, "home");
    let r = await c.tunnel.request("GET", "/api/me");
    assert.equal(r.status, 401);
    r = await c.tunnel.request("POST", "/api/login", json({ username: "alice", password: PASSWORD, device: "phone" }));
    assert.equal(r.status, 200);
    assert.equal(r.headers["set-cookie"], undefined, "the session cookie stays on the hub");
    c.tunnel.close();

    // What the app asked the native stack for: only the mailbox, only GET/POST, only Authorization/Content-Type, no redirects.
    assert.ok(e.seen.length > 10);
    for (const s of e.seen) {
      assert.ok(s.url.startsWith(LAN + "/api/tunnel/room/" + e.store.room().roomId + "/client"), s.url);
      assert.ok(["GET", "POST"].includes(s.method));
      assert.equal(s.disableRedirects, true);
      assert.equal(s.connectTimeout, 3000);
      for (const k of Object.keys(s.headers)) assert.ok(["Authorization", "Content-Type"].includes(k) || k === "Accept", "unexpected header " + k);
      assert.ok(!Object.keys(s.headers).some((k) => /cookie/i.test(k)));
    }
    assert.ok(e.seen.some((s) => s.method === "POST" && s.data && Array.isArray(s.data.frames)), "frames were posted as JSON");
    // N1: the token the phone sent to the LAN base is the LAN token (after pairing) and never the relay token
    assert.match(device.lanToken, /^aftl_/);
    assert.ok(e.seen.every((s) => !JSON.stringify(s).includes(device.roomToken)), "the relay token never went to the home network");
    assert.ok(e.seen.some((s) => s.headers.Authorization === "Bearer " + device.lanToken), "the LAN token did");
    // nothing readable in what crossed: the posted frames never contain the password or the path
    const wire = JSON.stringify(e.seen.map((s) => s.data || s.url));
    assert.ok(!wire.includes(PASSWORD) && !wire.includes("/api/login"));
  } finally { await e.close(); }
});

test("a squatter on the LAN address (wrong hub key) fails the handshake: nothing is trusted, nothing in clear", async (t) => {
  if (skip(t)) return;
  const e = await env();
  try {
    const v = Link.validateLink(e.text);
    const { device } = await Connector.pairBest(e.deps, v.value, "Android phone");
    e.store.approve(device.deviceId);
    // the record claims a DIFFERENT hub key than the hub that answers at this address
    const wrong = Object.assign({}, device, { relay: v.value.relay, lan: v.value.lan, hubKey: Buffer.alloc(32, 9).toString("base64url") });
    await assert.rejects(Connector.connectBest(e.deps, wrong), (err) => ["HANDSHAKE", "TIMEOUT"].includes(err.code));
  } finally { await e.close(); }
});

test("hub offline / nothing listening: the home attempt fails within its 3 s cap and reports it", async (t) => {
  if (skip(t)) return;
  const e = await env();
  try {
    const v = Link.validateLink(e.text);
    const { device } = await Connector.pairBest(e.deps, v.value, "Android phone");
    e.store.approve(device.deviceId);
    await e.hub.stop();                                              // the hub stops polling its mailbox: phone gets 409 "offline"
    const t0 = Date.now();
    await assert.rejects(Connector.connectBest(e.deps, Object.assign({}, device, { relay: v.value.relay, lan: v.value.lan })), (err) => ["OFFLINE", "TIMEOUT"].includes(err.code));
    assert.ok(Date.now() - t0 < 5000);
  } finally { await e.close().catch(() => {}); }
});
