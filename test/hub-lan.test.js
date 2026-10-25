// The encrypted home-network path (TUNNEL.md section 16): the REAL HubTunnel, the REAL LAN
// mailbox (lib/hub/lanrelay.js) mounted in the REAL hub server on 127.0.0.1, and the REAL phone
// client (lib/hub/ui/tunnel-client.js), with the internet relay target OFF.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
const H = require("./_tunnel-harness");
const { createLanRelay } = require("../lib/hub/lanrelay");
const { TC, I, tunnel, HubTunnel, TunnelStore, AuthStore, createHubServer, pairingLink, tokenHash, fakeSupervisor, fakeRelay, json, until, PASSWORD, RELAY } = H;

let x25519 = true;
test.before(async () => {
  try {
    const k = await globalThis.crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    await globalThis.crypto.subtle.exportKey("raw", k.publicKey);
  } catch { x25519 = false; }
});
const needX = (t) => {
  if (!x25519) { t.skip("this Node's WebCrypto has no X25519; the phone half cannot run here"); return false; }
  return true;
};

/** A hub with its LAN mailbox mounted; optionally also the (fake) internet relay as a second target. */
async function lanEnv({ withRelay = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("alice", PASSWORD);
  const supervisor = fakeSupervisor();
  const store = new TunnelStore({ dir });
  const room = store.room();
  const mailbox = createLanRelay({ roomId: room.roomId });
  const secret = store.createPairing().secret; // before the hub starts, as the harness does
  const remote = { addr: "127.0.0.1" };
  let hub = null;
  const server = createHubServer({
    auth, supervisor, lanRelay: mailbox, getRemoteAddress: () => remote.addr, config: { heartbeatMs: 1000 },
  });
  const relay = fakeRelay();
  const logs = [];
  hub = new HubTunnel({
    store, relay: withRelay ? RELAY : null, local: mailbox.local, dispatch: server.dispatchTunnel, auth,
    fetch: relay.fetch, pollWaitSec: 1, minPollMs: 50, log: (m) => logs.push(String(m && m.message || m)),
  });
  const where = await server.listen({ port: 0, host: "127.0.0.1" });
  await hub.start();
  const base = `http://127.0.0.1:${where.port}`;
  // Everything the phone sends and receives on the wire, as text.
  const wire = [];
  const spyFetch = async (url, init = {}) => {
    wire.push(`${init.method || "GET"} ${url} ${JSON.stringify(init.headers || {})} ${init.body || ""}`);
    const res = await fetch(url, init);
    const copy = res.clone();
    copy.text().then((t) => wire.push(t), () => {});
    return res;
  };
  const link = pairingLink({ relay: base, roomId: room.roomId, hubPub: room.hubPub, secret, lan: base });
  return {
    dir, auth, supervisor, store, room, mailbox, server, hub, base, relay, remote, logs, wire, link, secret,
    opts: { fetch: spyFetch, pollWaitSec: 1, minPollMs: 50, handshakeTimeoutMs: 4000 },
    async close() { await hub.stop(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const status = async (env, method, p, init = {}) => {
  const res = await fetch(env.base + p, { method, ...init });
  const text = await res.text();
  return { status: res.status, h: res.headers, text, j: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

test("pair, approve, log in, CSRF, create an agent: all over the LAN mailbox, relay target OFF", async (t) => {
  if (!needX(t)) return;
  const env = await lanEnv();
  try {
    assert.strictEqual(env.hub.relay, null, "no internet relay configured");
    const { device, sas } = await TC.pair({ link: env.link, label: "Pixel LAN", fetch: env.opts.fetch, pollWaitSec: 1, minPollMs: 50, timeoutMs: 4000 });
    assert.strictEqual(device.relay, env.base, "the pairing record's relay is the LAN base URL");
    assert.match(sas, /^\d{6}$/);
    const rec = env.store.listDevices().find((d) => d.id === device.deviceId);
    assert.strictEqual(rec.sas, sas, "both screens show the same code");
    await assert.rejects(TC.connect(device, env.opts), { code: "PENDING" });
    env.store.approve(device.deviceId);

    const tun = await TC.connect(device, env.opts);
    let r = await tun.request("GET", "/api/me");
    assert.strictEqual(r.status, 401);
    r = await H.login(tun, "wrong-password-1");
    assert.strictEqual(r.status, 401);
    r = await H.login(tun);
    assert.strictEqual(r.status, 200);
    const csrf = r.json().csrf;
    assert.strictEqual(r.headers["set-cookie"], undefined, "the cookie stays on the hub");
    const cookie = env.hub.jar.get(device.deviceId).value;

    const body = { name: "secret-agent-name", cwd: "/home/alice/project", tier: "light" };
    r = await tun.request("POST", "/api/agents", json(body));
    assert.strictEqual(r.status, 403, "CSRF still enforced inside the tunnel");
    r = await tun.request("POST", "/api/agents", { headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(env.supervisor.created, 1);
    assert.ok(env.auth.listSessions("alice").some((s) => s.ip === `relay:${device.deviceId}`), "lockout/session key is the authenticated device");
    // The mailbox is not reachable through the tunnel itself, nor is any page.
    assert.strictEqual((await tun.request("GET", "/api/tunnel/room/" + env.room.roomId + "/hub")).status, 404);
    assert.strictEqual((await tun.request("GET", "/index.html")).status, 404);
    tun.close();

    // What the mailbox held and what crossed the wire: ciphertext only.
    const everything = env.mailbox._dump() + "\n" + env.wire.join("\n");
    const forbidden = {
      password: PASSWORD, username: "alice", cookie, csrf, pathMe: "/api/me", pathLogin: "/api/login", pathAgents: "/api/agents",
      agent: "secret-agent-name", cwd: "/home/alice", pairingSecret: env.secret,
      pairingPsk: I.b64u(tunnel.derivePairing(Buffer.from(env.secret, "base64url")).psk),
      hubPrivate: I.b64u(env.store.keys().priv), roomSecret: I.b64u(env.store.keys().roomSecret),
    };
    assert.ok(everything.length > 2000, "something was actually carried");
    for (const [what, s] of Object.entries(forbidden)) {
      assert.ok(!everything.includes(s), `the mailbox/wire held the ${what}`);
      assert.ok(!everything.includes(Buffer.from(s).toString("base64url").slice(0, 16)), `the mailbox/wire held the ${what} (base64)`);
    }
    // N1: the home mailbox knows ONLY the LAN token's hash. The internet-relay token never reaches it: not on the
    // wire (everything here went to the LAN base), not in the allowlist.
    assert.match(device.lanToken, /^aftl_[A-Za-z0-9_-]{43}$/);
    assert.notStrictEqual(device.lanToken, device.roomToken);
    assert.ok(!env.mailbox._dump().includes(device.lanToken), "the mailbox keeps token hashes only");
    assert.ok(env.mailbox._dump().includes(tokenHash(device.lanToken)), "H(lanToken) is on the LAN allowlist");
    assert.ok(!env.mailbox._dump().includes(tokenHash(device.roomToken)), "H(roomToken) is NOT on the LAN allowlist");
    assert.ok(!everything.includes(device.roomToken), "the relay token was never sent to the LAN base");
    assert.ok(env.wire.some((w) => w.includes(device.lanToken)), "the LAN token is what the phone sent");
    assert.ok(!env.logs.join("\n").includes(device.roomToken) && !env.logs.join("\n").includes(device.lanToken));
  } finally { await env.close(); }
});

test("access: no token is 401, a public address is refused, a wrong Host is refused", async () => {
  const env = await lanEnv();
  try {
    const p = `/api/tunnel/room/${env.room.roomId}`;
    for (const [m, u] of [["GET", `${p}/client?ch=${"A".repeat(22)}`], ["POST", `${p}/client`], ["GET", "/api/tunnel"], ["GET", "/api/tunnel/"]]) {
      const r = await status(env, m, u, m === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" });
      assert.strictEqual(r.status, 401, `${m} ${u} without a token`);
      assert.ok(!r.h.get("access-control-allow-origin"));
    }
    // The hub side is not served over HTTP at all (N4): 404, with or without a token.
    for (const [m, u] of [["GET", `${p}/hub`], ["PUT", p]]) assert.strictEqual((await status(env, m, u, m === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" })).status, 404, `${m} ${u}`);
    // A cookie is not a credential here.
    const r = await status(env, "GET", `${p}/client?ch=${"A".repeat(22)}`, { headers: { cookie: "arcflare_sid=abc" } });
    assert.strictEqual(r.status, 401);
    // Public peers never reach the mailbox (the same gate as the UI), nor with a valid token.
    env.remote.addr = "8.8.8.8";
    const tok = "afth_" + I.b64u(nodeCrypto.randomBytes(32));
    for (const u of [`${p}/client?ch=${"A".repeat(22)}`, "/api/tunnel/", "/api/me", "/"]) {
      const x = await status(env, "GET", u, { headers: { authorization: `Bearer ${tok}` } });
      assert.strictEqual(x.status, 403, `public peer on ${u}`);
    }
    env.remote.addr = "::ffff:8.8.8.8";
    assert.strictEqual((await status(env, "GET", "/api/tunnel/")).status, 403);
    env.remote.addr = "192.168.1.50";
    assert.strictEqual((await status(env, "GET", "/api/tunnel/")).status, 401, "a private peer is let in (and then needs a token)");
    const evil = await new Promise((resolve, reject) => {
      const rq = require("node:http").request({ host: "127.0.0.1", port: Number(new URL(env.base).port), path: `${p}/client?ch=${"A".repeat(22)}`, headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      rq.on("error", reject); rq.end();
    });
    assert.strictEqual(evil, 421, "the Host allowlist runs first");
    assert.strictEqual(env.mailbox.stats().hasRoom, true);
  } finally { await env.close(); }
});

test("the web UI keeps its cookie and CSRF rules exactly; the mailbox has neither", async () => {
  const env = await lanEnv();
  try {
    let r = await status(env, "GET", "/api/me");
    assert.strictEqual(r.status, 401, "UI API needs a cookie");
    r = await status(env, "POST", "/api/login", { headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify({ username: "alice", password: PASSWORD }) });
    assert.strictEqual(r.status, 403, "Origin check still applies to the UI API");
    r = await status(env, "POST", "/api/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: PASSWORD }) });
    assert.strictEqual(r.status, 200);
    const cookie = r.h.get("set-cookie").split(";")[0];
    const csrf = r.j.csrf;
    const mk = (extra) => ({ headers: { "content-type": "application/json", cookie, ...extra }, body: JSON.stringify({ name: "x", cwd: "/tmp" }) });
    assert.strictEqual((await status(env, "POST", "/api/agents", mk({}))).status, 403, "no CSRF token");
    assert.strictEqual((await status(env, "POST", "/api/agents", mk({ "x-csrf-token": "nope" }))).status, 403, "wrong CSRF token");
    assert.strictEqual((await status(env, "POST", "/api/agents", mk({ "x-csrf-token": csrf, origin: "http://evil.example" }))).status, 403, "bad Origin");
    assert.strictEqual((await status(env, "POST", "/api/agents", { headers: { cookie, "x-csrf-token": csrf }, body: "{}" })).status, 415, "JSON content type still required");
    assert.strictEqual((await status(env, "POST", "/api/agents", mk({ "x-csrf-token": csrf }))).status, 201);
    // The mailbox ignores the signed-in cookie entirely: a session is not a mailbox credential...
    const p = `/api/tunnel/room/${env.room.roomId}`;
    assert.strictEqual((await status(env, "GET", `${p}/client?ch=${"A".repeat(22)}`, { headers: { cookie, "x-csrf-token": csrf } })).status, 401);
    // ...and a bearer-token mailbox call needs no cookie and no CSRF token (the hub's PUT is 404 here, N4).
    const hubTok = env.store.room().hubToken;
    const put = await status(env, "PUT", p, { headers: { authorization: `Bearer ${hubTok}`, "content-type": "application/json" }, body: JSON.stringify({ v: 1, clients: [] }) });
    assert.strictEqual(put.status, 404);
    assert.strictEqual(put.h.get("set-cookie"), null, "the mailbox never sets a cookie");
    // Unknown /api paths still answer through the session logic (401 without a cookie, 404 with one).
    assert.strictEqual((await status(env, "GET", "/api/nothing")).status, 401);
    assert.strictEqual((await status(env, "GET", "/api/nothing", { headers: { cookie } })).status, 404);
  } finally { await env.close(); }
});

test("both carriers at once: one device, one hub-side session, either mailbox", async (t) => {
  if (!needX(t)) return;
  const env = await lanEnv({ withRelay: true });
  try {
    // Pair over the internet relay (fake), connect over the LAN mailbox and over the relay.
    const relayLink = pairingLink({ relay: RELAY, roomId: env.room.roomId, hubPub: env.room.hubPub, secret: env.secret, lan: env.base });
    const { device } = await TC.pair({ link: relayLink, label: "Both", fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, timeoutMs: 5000 });
    env.store.approve(device.deviceId);
    const lanDevice = { ...device, relay: env.base };
    const viaLan = await TC.connect(lanDevice, env.opts);
    const viaNet = await TC.connect(device, { fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, handshakeTimeoutMs: 4000 });
    const r = await H.login(viaLan);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await viaNet.request("GET", "/api/me")).status, 200, "the relay carrier shares the device's hub-side session");
    assert.strictEqual((await viaLan.request("GET", "/api/me")).status, 200);
    const mine = [...env.hub.sessions.values()];
    assert.deepStrictEqual(mine.map((s) => s.via).sort(), ["lan", "net"]);
    assert.ok(env.auth.listSessions("alice").every((s) => s.ip === `relay:${device.deviceId}`));
    // Frames of a LAN session are never accepted from the other carrier (and vice versa).
    const lanS = mine.find((s) => s.via === "lan");
    const before = env.hub.sessions.size;
    env.hub.receive(lanS.ch, I.b64u(Buffer.concat([Buffer.from([1, 3]), lanS.sid, Buffer.alloc(8), Buffer.alloc(40)])), "net");
    assert.strictEqual(env.hub.sessions.size, before);
    // Revocation cuts off both carriers.
    env.store.revoke(device.deviceId);
    assert.ok(await until(() => env.hub.sessions.size === 0), "all sessions gone");
    await assert.rejects(TC.connect(lanDevice, { ...env.opts, handshakeTimeoutMs: 1500 }));
    await assert.rejects(TC.connect(device, { fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, handshakeTimeoutMs: 1500 }));
    viaLan.close(); viaNet.close();
  } finally { await env.close(); }
});

test("revoking a device over the LAN mailbox: allowlist republished, token refused", async (t) => {
  if (!needX(t)) return;
  const env = await lanEnv();
  try {
    const { device } = await TC.pair({ link: env.link, label: "Pixel", fetch: env.opts.fetch, pollWaitSec: 1, minPollMs: 50, timeoutMs: 4000 });
    env.store.approve(device.deviceId);
    const tun = await TC.connect(device, env.opts);
    assert.strictEqual((await H.login(tun)).status, 200);
    const token = env.hub.jar.get(device.deviceId).value;
    env.store.revoke(device.deviceId);
    assert.ok(await until(() => env.hub.sessions.size === 0));
    assert.strictEqual(env.auth.authenticate(token), null);
    const res = await fetch(`${env.base}/api/tunnel/room/${env.room.roomId}/client?ch=${"B".repeat(22)}`, { headers: { authorization: `Bearer ${device.roomToken}` } });
    assert.ok(await until(async () => (await fetch(`${env.base}/api/tunnel/room/${env.room.roomId}/client?ch=${"B".repeat(22)}`, { headers: { authorization: `Bearer ${device.roomToken}` } })).status === 401, 5000), "token refused");
    await res.text();
    tun.close();
  } finally { await env.close(); }
});

test("link rules: http only for the LAN (private IPv4 / .local); the internet relay stays https", () => {
  assert.strictEqual(tunnel.checkLanUrl("http://192.168.1.5:7878"), "http://192.168.1.5:7878");
  assert.strictEqual(tunnel.checkLanUrl("http://10.0.0.2:1/"), "http://10.0.0.2:1");
  assert.strictEqual(tunnel.checkLanUrl("http://172.16.0.9:7878"), "http://172.16.0.9:7878");
  assert.strictEqual(tunnel.checkLanUrl("http://my-pc.local:7878"), "http://my-pc.local:7878");
  for (const bad of ["http://8.8.8.8:7878", "http://172.32.0.1", "http://169.254.1.1", "http://example.com", "http://192.168.1.5.evil.com", "http://user@192.168.1.5", "http://192.168.1.5/?x=1", "ftp://192.168.1.5", "http://[fd00::1]:80"]) {
    assert.throws(() => tunnel.checkLanUrl(bad), undefined, bad);
  }
  assert.throws(() => tunnel.checkRelayUrl("http://192.168.1.5:7878"), /https/, "the hub's internet relay setting never takes http");
  const link = (r, l) => pairingLink({ relay: r, roomId: I.b64u(nodeCrypto.randomBytes(32)), hubPub: I.x25519Generate().pub, secret: I.b64u(nodeCrypto.randomBytes(32)), lan: l });
  const ok = TC.parsePairingLink(link("http://192.168.1.5:7878", "http://192.168.1.5:7878"));
  assert.strictEqual(ok.relay, "http://192.168.1.5:7878");
  assert.strictEqual(ok.lan, "http://192.168.1.5:7878");
  assert.strictEqual(TC.parsePairingLink(link("https://arcflare.net", "http://192.168.1.5:7878")).relay, "https://arcflare.net");
  assert.throws(() => TC.parsePairingLink(link("http://8.8.8.8", null)), { code: "BAD_LINK" });
  assert.throws(() => TC.parsePairingLink(link("http://relay.example", null)), { code: "BAD_LINK" });
  assert.throws(() => TC.parsePairingLink(link("https://arcflare.net", "http://8.8.8.8:7878")), { code: "BAD_LINK" });
  assert.throws(() => TC.parsePairingLink(link("https://arcflare.net", "http://evil.example")), { code: "BAD_LINK" });
});

// ---- contract with the phone app ------------------------------------------
// The hub must never print a pairing link the app refuses (the app's link.js is
// the strict side; it is a pure module, so it can be run here against the hub's
// own output).

test("pairing-link LAN addresses: what the hub prints is always what the app accepts", () => {
  const appLink = require("../android/www/link.js");
  const parse = appLink.parseLink || appLink.validateLink || appLink.parse || appLink.validate;
  assert.strictEqual(typeof parse, "function", "android/www/link.js exposes its validator");

  const good = ["http://192.168.1.5:7878", "http://10.0.0.2:7878", "http://172.16.0.9:9000", "http://my-pc.local:7878"];
  for (const lan of good) {
    const base = tunnel.checkPairingLanUrl(lan);
    const link = tunnel.pairingLink({
      relay: base, roomId: Buffer.alloc(32, 5).toString("base64url"), hubPub: Buffer.alloc(32, 7), secret: Buffer.alloc(32, 9).toString("base64url"), lan: base,
    });
    const res = parse(link);
    assert.ok(res && (res.ok === undefined || res.ok === true), `the app accepts the hub's own link for ${lan}: ${JSON.stringify(res)}`);
  }

  const bad = [
    "https://192.168.1.5:7878",   // a certificate for an IP cannot be validated
    "http://localhost:7878", "http://127.0.0.1:7878", "http://[::1]:7878",
    "http://192.168.1.5",         // no port
    "http://192.168.1.5:80", "http://192.168.1.5:443", "http://192.168.1.5:0", "http://192.168.1.5:65536",
    "http://192.168.1.5:7878/ui", "http://192.168.1.5:7878/?x=1", "http://u:p@192.168.1.5:7878",
    "http://8.8.8.8:7878", "http://169.254.1.1:7878", "http://my-pc.local.evil.com:7878", "http://192.168.1.5.evil.com:7878",
  ];
  for (const url of bad) assert.throws(() => tunnel.checkPairingLanUrl(url), undefined, `refused: ${url}`);
});

test("N7: .local names: the hub accepts exactly what the app's link.js accepts (it can never print a link the app refuses)", () => {
  const appLink = require("../android/www/link.js");
  const names = [
    "my-pc.local", "a.local", "x.y.local", "a-b.c-d.local", "xn--bcher-kva.local", "9lives.local", "A.LOCAL", "bücher.local",
    "-x.local", "x-.local", "a.-b.local", "a-.b.local", ".local", "..local", "x..local", "x.local.", "x_y.local", "-.local", "--.local",
    "a".repeat(63) + ".local", "a".repeat(69) + ".local", "a".repeat(70) + ".local", "a".repeat(75) + ".local", "a.".repeat(37) + "local", "a.".repeat(38) + "local",
    "my pc.local", "my%20pc.local", "x.local.evil.com", "local", "x.localx", "x.local@evil.com",
  ];
  for (const name of names) {
    const url = `http://${name}:7878`;
    let hub = null;
    try { hub = tunnel.checkPairingLanUrl(url); } catch { /* refused */ }
    if (hub) {
      assert.ok(appLink.validateLanUrl(hub), `the hub would print ${hub}, which the app refuses`);
      assert.ok(appLink.validateLink(tunnel.pairingLink({ relay: hub, roomId: Buffer.alloc(32, 5).toString("base64url"), hubPub: Buffer.alloc(32, 7), secret: Buffer.alloc(32, 9).toString("base64url"), lan: hub })).ok, `app refuses the whole link for ${hub}`);
    } else {
      // what the app refuses, the hub refused; and what the app takes as typed (already lower case, ASCII), the hub takes
      if (appLink.validateLanUrl(url)) assert.fail(`the app accepts ${url} but the hub refuses it`);
    }
  }
  // the isLanHost rule itself (also used by checkLanUrl)
  for (const bad of ["-x.local", "x-.local", "a".repeat(75) + ".local", ".local", "x..local"]) assert.strictEqual(tunnel.isLanHost(bad), false, bad);
  for (const good of ["my-pc.local", "x.local", "a".repeat(74) + ".local"]) assert.strictEqual(tunnel.isLanHost(good), true, good);
});

test("N4: the room PUT and the /hub endpoints are not served over the LAN socket; a drifted allowlist is put right", async () => {
  const env = await lanEnv();
  try {
    env.store.createPairing(); await env.hub._syncRoom(true);
    const n = () => JSON.parse(env.mailbox._dump()).clients.length;
    const before = n();
    assert.ok(before >= 1);
    const hubAuth = { authorization: `Bearer ${env.room.hubToken}`, "content-type": "application/json" };
    const room = `/api/tunnel/room/${env.room.roomId}`;
    let r = await status(env, "PUT", room, { headers: hubAuth, body: JSON.stringify({ v: 1, clients: [] }) });
    assert.strictEqual(r.status, 404, "PUT with the real hub token: 404");
    r = await status(env, "GET", `${room}/hub?after=0&wait=0`, { headers: hubAuth });
    assert.strictEqual(r.status, 404, "hub poll over HTTP: 404");
    r = await status(env, "POST", `${room}/hub`, { headers: hubAuth, body: JSON.stringify({ frames: [] }) });
    assert.strictEqual(r.status, 404, "hub send over HTTP: 404");
    assert.strictEqual(n(), before, "the allowlist was not touched");
    // Whatever else may drift the mailbox (a bug, a future endpoint): the next housekeeping pass restores it.
    env.mailbox.local.putRoom([]);
    assert.strictEqual(n(), 0);
    env.hub._housekeeping();
    assert.strictEqual(n(), before, "housekeeping re-asserted the allowlist");
  } finally { await env.close(); }
});

test("N1: per-carrier allowlists: H(lanToken) only on the LAN mailbox, H(roomToken) only on the internet relay; revoke removes both", async (t) => {
  if (!needX(t)) return;
  const env = await lanEnv({ withRelay: true });
  try {
    const relayLink = pairingLink({ relay: RELAY, roomId: env.room.roomId, hubPub: env.room.hubPub, secret: env.secret, lan: env.base });
    const { device } = await TC.pair({ link: relayLink, label: "Both", fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, timeoutMs: 5000 });
    env.store.approve(device.deviceId);
    await env.hub._syncRoom(true);
    const relayList = () => { const room = env.relay.rooms.get(env.room.roomId); return room ? room.clients.map((c) => c.h) : []; };
    const lanList = () => JSON.parse(env.mailbox._dump()).clients.map((c) => c.h);
    const hR = tokenHash(device.roomToken), hL = tokenHash(device.lanToken);
    assert.ok(relayList().includes(hR) && !relayList().includes(hL), "relay: H(roomToken) only");
    assert.ok(lanList().includes(hL) && !lanList().includes(hR), "LAN: H(lanToken) only");
    // the relay token is useless on the LAN mailbox, whatever is asked
    const q = `${env.base}/api/tunnel/room/${env.room.roomId}/client?ch=${"C".repeat(22)}&after=0&wait=0`;
    assert.strictEqual((await fetch(q, { headers: { authorization: `Bearer ${device.roomToken}` } })).status, 401, "relay token on the LAN mailbox");
    assert.strictEqual((await fetch(q, { headers: { authorization: `Bearer ${device.lanToken}` } })).status, 200, "LAN token on the LAN mailbox");
    // and the LAN token is useless on the relay
    const rres = await env.relay.fetch(`${RELAY}/api/tunnel/room/${env.room.roomId}/client?ch=${"C".repeat(22)}&after=0&wait=0`, { headers: { Authorization: `Bearer ${device.lanToken}` } });
    assert.ok(rres.status === 401 || rres.status === 403, "LAN token on the relay: " + rres.status);
    // the hub never sent the LAN token hash to the relay (the operator could not even use it) and vice versa
    assert.ok(!env.relay.seen.join("\n").includes(hL), "the relay operator never saw H(lanToken)");
    // a phone with this record talks to each base with its own token only
    const spyLan = [], spyNet = [];
    const viaLan = await TC.connect({ ...device, relay: env.base }, { ...env.opts, fetch: async (url, init = {}) => { spyLan.push({ url, auth: (init.headers || {}).Authorization }); return env.opts.fetch(url, init); } });
    const viaNet = await TC.connect(device, { fetch: async (url, init = {}) => { spyNet.push({ url, auth: (init.headers || {}).Authorization }); return env.relay.fetch(url, init); }, pollWaitSec: 1, minPollMs: 50, handshakeTimeoutMs: 4000 });
    assert.ok(spyLan.length && spyLan.every((x) => x.url.startsWith(env.base) && x.auth === `Bearer ${device.lanToken}`), "every request to the LAN base carries the LAN token");
    assert.ok(spyNet.length && spyNet.every((x) => x.url.startsWith(RELAY) && x.auth === `Bearer ${device.roomToken}`), "every request to the relay carries the relay token");
    viaLan.close(); viaNet.close();
    // revoke: both allowlists lose the device
    env.hub.revokeDevice(device.deviceId);
    await env.hub._syncRoom(true);
    assert.ok(!relayList().includes(hR) && !lanList().includes(hL), "revoked on both carriers");
  } finally { await env.close(); }
});

test("N1: a device paired by an earlier build (no lanToken) is relay-only: no LAN allowlist entry, the phone sends nothing to the LAN", async (t) => {
  if (!needX(t)) return;
  const env = await lanEnv({ withRelay: true });
  try {
    const relayLink = pairingLink({ relay: RELAY, roomId: env.room.roomId, hubPub: env.room.hubPub, secret: env.secret, lan: env.base });
    const { device } = await TC.pair({ link: relayLink, label: "Old", fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, timeoutMs: 5000 });
    env.store.approve(device.deviceId);
    // make the stored device look like an old build's: no lanTokenHash on the hub, no lanToken on the phone
    env.store._mutateDevices((devs) => { delete devs[device.deviceId].lanTokenHash; });
    env.hub._reload(true); await env.hub._syncRoom(true);
    const lan = JSON.parse(env.mailbox._dump()).clients.map((c) => c.h);
    assert.ok(!lan.includes(tokenHash(device.roomToken)) && !lan.includes(tokenHash(device.lanToken)), "no LAN entry for it");
    const old = { ...device, lanToken: null };
    delete old.lanToken;
    const seen = [];
    await assert.rejects(TC.connect({ ...old, relay: env.base }, { ...env.opts, fetch: async (u, i) => { seen.push(u); return env.opts.fetch(u, i); } }), { code: "NO_LAN_TOKEN" });
    assert.deepStrictEqual(seen, [], "not one request went to the LAN base, and the relay token never left");
    // over the internet relay it still works
    const viaNet = await TC.connect(old, { fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, handshakeTimeoutMs: 4000 });
    assert.strictEqual((await viaNet.request("GET", "/api/me")).status, 401);
    viaNet.close();
    // and the relay token is never offered to a plain-http base that is not the stored LAN base
    await assert.rejects(TC.connect({ ...old, relay: "http://192.168.9.9:8765" }, { ...env.opts, fetch: async (u) => { seen.push(u); throw new Error("must not be called"); } }), { code: "BAD_DEVICE" });
    assert.deepStrictEqual(seen, []);
  } finally { await env.close(); }
});

test("N2: one handshake budget per carrier plus an overall ceiling: a flooded relay cannot shut the home path", async (t) => {
  if (!needX(t)) return;
  const env = await lanEnv({ withRelay: true });
  try {
    const relayLink = pairingLink({ relay: RELAY, roomId: env.room.roomId, hubPub: env.room.hubPub, secret: env.secret, lan: env.base });
    const { device } = await TC.pair({ link: relayLink, label: "Both", fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, timeoutMs: 5000 });
    env.store.approve(device.deviceId);
    const per = env.hub.limits.handshakesPerMinute, total = env.hub.limits.handshakesTotalPerMinute;
    assert.ok(per < total && total < 2 * per, "ceiling between one budget and two");
    // a flood arriving over the internet relay uses up ITS budget (one handshake was spent on the pairing above)
    let used = 0;
    while (env.hub._rateOk("net")) used++;
    assert.ok(used >= per - 2 && used <= per, "net budget exhausted: " + used);
    assert.strictEqual(env.hub._rateOk("net"), false);
    // the relay carrier is now refused: its handshake times out...
    await assert.rejects(TC.connect(device, { fetch: env.relay.fetch, pollWaitSec: 1, minPollMs: 50, handshakeTimeoutMs: 1200 }), { code: "TIMEOUT" });
    // ...and the home path still works
    const viaLan = await TC.connect({ ...device, relay: env.base }, env.opts);
    assert.strictEqual((await viaLan.request("GET", "/api/me")).status, 401);
    viaLan.close();
    // the overall ceiling holds for both together, and always leaves the other carrier at least total - per
    let lan = 0;
    while (env.hub._rateOk("lan")) lan++;
    assert.ok(lan >= total - per - 4 && lan <= total - per, "lan got what the ceiling leaves: " + lan);
    assert.ok(total - per >= 30);
  } finally { await env.close(); }
});

test("N8b: housekeeping does not re-read pairing.json while nothing changed, and notices a new pairing at once", async () => {
  const env = await lanEnv();
  try {
    let reads = 0;
    const orig = env.store.pendingPairings.bind(env.store);
    env.store.pendingPairings = () => { reads++; return orig(); };
    env.hub._housekeeping();
    const base = reads;
    for (let i = 0; i < 10; i++) env.hub._housekeeping();
    assert.strictEqual(reads, base, "ten idle passes read the file zero more times");
    const sec = env.store.createPairing();
    env.hub._housekeeping();
    assert.ok(reads > base, "a new pairing is picked up");
    assert.ok(JSON.parse(env.mailbox._dump()).clients.some((c) => c.h === tokenHash(tunnel.derivePairing(Buffer.from(sec.secret, "base64url")).pairToken)), "and published to the LAN allowlist");
  } finally { await env.close(); }
});

test("3c F6: the browser-side client applies the same .local rule as the hub and the app", () => {
  const client = require("../lib/hub/ui/tunnel-client.js");
  const link = (host) => tunnel.pairingLink({
    relay: `http://${host}:7878`, roomId: Buffer.alloc(32, 5).toString("base64url"), hubPub: Buffer.alloc(32, 7),
    secret: Buffer.alloc(32, 9).toString("base64url"), lan: `http://${host}:7878`,
  });
  const accepts = (host) => { try { client.parsePairingLink(link(host)); return true; } catch { return false; } };
  for (const ok of ["my-pc.local", "a.b.local", "192.168.1.5", "10.0.0.2"]) assert.ok(accepts(ok), `client accepts ${ok}`);
  for (const bad of ["-x.local", "a-.local", "a..local", `${"x".repeat(80)}.local`, "8.8.8.8", "my-pc.local.evil.com"]) {
    assert.ok(!accepts(bad), `client refuses ${bad.slice(0, 20)}`);
    assert.strictEqual(tunnel.isLanHost(bad), false, `and so does the hub: ${bad.slice(0, 20)}`);
  }
});
