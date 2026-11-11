"use strict";
// The Cloudflare way in (lib/hub/cftunnel.js): only the phone mailbox endpoint is reachable, and a running hub's
// address is read back strictly.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cf = require("../lib/hub/cftunnel");

const ROOM = "A".repeat(43);

test("only GET/POST/OPTIONS on the room's client endpoint reach the mailbox; everything else is 404", async () => {
  assert.strictEqual(cf.allowedPath(`/api/tunnel/room/${ROOM}/client?ch=x&after=0`, ROOM), true);
  for (const p of ["/", "/api/login", "/api/me", `/api/tunnel/room/${ROOM}`, `/api/tunnel/room/${ROOM}/hub`, `/api/tunnel/room/${"B".repeat(43)}/client`, `/api/tunnel/room/${ROOM}/client/../../api/me`]) {
    assert.strictEqual(cf.allowedPath(p, ROOM), false, p);
  }
  // A fake cloudflared that prints an address, so the listener runs; then probe it directly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-"));
  const fake = path.join(dir, "fake-cloudflared.js");
  fs.writeFileSync(fake, "console.error('INF | https://abc-def.trycloudflare.com |'); console.error('INF Registered tunnel connection connIndex=0 protocol=quic'); setTimeout(() => {}, 30000);");
  const seen = [];
  const mailbox = { handle: (req, res, ip) => { seen.push([req.url, ip]); res.end("{}"); } };
  const urlFile = path.join(dir, "url.json");
  let port = null;
  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...a) { this.once("listening", () => { port = this.address().port; }); return origListen.apply(this, a); };
  let t;
  try {
    t = await cf.startCloudflare({ mailbox, roomId: ROOM, file: urlFile, exe: process.execPath, prefixArgs: [fake], timeoutMs: 15000 });
  } finally { http.Server.prototype.listen = origListen; }
  try {
    assert.strictEqual(t.url, "https://abc-def.trycloudflare.com");
    assert.strictEqual(cf.currentUrl(urlFile), t.url);
    const get = (p, headers = {}) => new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: p, headers }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode)); }));
    assert.strictEqual(await get("/api/me"), 404);
    assert.strictEqual(await get("/"), 404);
    assert.strictEqual(await get(`/api/tunnel/room/${ROOM}/client?ch=x`, { "cf-connecting-ip": "203.0.113.9" }), 200);
    assert.deepStrictEqual(seen, [[`/api/tunnel/room/${ROOM}/client?ch=x`, "203.0.113.9"]]);
  } finally { t.close(); }
  assert.strictEqual(cf.currentUrl(urlFile), null, "the address file goes when the tunnel closes");
});

test("a stored address that is not a plain trycloudflare https URL is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-"));
  const f = path.join(dir, "u.json");
  for (const bad of ["http://abc.trycloudflare.com", "https://evil.com", "https://abc.trycloudflare.com/x", "https://abc.trycloudflare.com.evil.com"]) {
    fs.writeFileSync(f, JSON.stringify({ url: bad }));
    assert.strictEqual(cf.currentUrl(f), null, bad);
  }
  assert.strictEqual(cf.callerOf({ headers: { "cf-connecting-ip": "x<script>" } }), "cloudflare");
});

test("connect install keeps only a download whose SHA-256 matches the one GitHub publishes", async () => {
  const crypto = require("crypto");
  const name = cf.assetName();
  if (!name || name.endsWith(".tgz")) return; // the archive path needs tar; the plain-file path is what is tested here
  const body = Buffer.from("pretend cloudflared");
  const good = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
  const mk = (digest, url = `https://github.com/cloudflare/cloudflared/releases/download/2026.1.1/${name}`) => async (u) => {
    if (u.includes("/releases/latest")) return new Response(JSON.stringify({ tag_name: "2026.1.1", assets: [{ name, size: body.length, digest, browser_download_url: url }] }));
    return new Response(body);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfi-"));
  await assert.rejects(cf.installPortable({ fetchImpl: mk("sha256:" + "0".repeat(64)), dir }), /checksum mismatch/);
  assert.deepStrictEqual(fs.readdirSync(dir), [], "nothing kept after a mismatch");
  await assert.rejects(cf.installPortable({ fetchImpl: mk(undefined), dir }), /checksum/);
  await assert.rejects(cf.installPortable({ fetchImpl: mk(good, "https://evil.example/cloudflared"), dir }), /has no/);
  const exe = await cf.installPortable({ fetchImpl: mk(good), dir });
  assert.deepStrictEqual(fs.readFileSync(exe), body);
});

test("connect install gives up on a stalled GitHub answer or download and says which one timed out", async () => {
  if (!cf.assetName()) return;
  // A fetch that never answers on its own, only when its signal fires.
  const stall = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(o.signal.reason)));
  await assert.rejects(cf.installPortable({ fetchImpl: stall, dir: os.tmpdir(), apiMs: 50 }), /timed out asking GitHub/);
  const name = cf.assetName();
  const rel = new Response(JSON.stringify({ tag_name: "t", assets: [{ name, size: 1, digest: "sha256:" + "0".repeat(64), browser_download_url: `https://github.com/cloudflare/cloudflared/releases/download/t/${name}` }] }));
  const f = (u, o) => (u.includes("/releases/latest") ? Promise.resolve(rel) : stall(u, o));
  await assert.rejects(cf.installPortable({ fetchImpl: f, dir: os.tmpdir(), downloadMs: 50 }), /timed out downloading cloudflared/);
});

test("a kept tunnel survives a hub restart: same address, same cloudflared; a dead one is replaced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-keep-"));
  const fake = path.join(dir, "fake-cloudflared.js");
  // Each start prints a different address, so reuse is visible.
  fs.writeFileSync(fake, "console.error('INF | https://run-' + process.pid + '.trycloudflare.com |'); console.error('INF Registered tunnel connection connIndex=0 protocol=quic'); setInterval(() => {}, 1000);");
  const mailbox = { handle: (req, res) => res.end("{}") };
  const keepFile = path.join(dir, "cloudflared.json");
  const opts = { mailbox, roomId: ROOM, file: path.join(dir, "url.json"), keepFile, exe: process.execPath, prefixArgs: [fake], timeoutMs: 15000 };
  const ok = async () => ({ status: 200 });
  const a = await cf.startCloudflare({ ...opts, fetchImpl: ok });
  const k1 = cf.readKeep(keepFile);
  assert.ok(k1 && cf.pidAlive(k1.pid) && k1.url === a.url);
  a.close({ keep: true });                       // the hub stops; cloudflared keeps running
  assert.ok(cf.pidAlive(k1.pid));
  const b = await cf.startCloudflare({ ...opts, fetchImpl: ok });
  try {
    assert.strictEqual(b.url, a.url, "the phone's address did not change");
    assert.strictEqual(cf.readKeep(keepFile).pid, k1.pid, "no second cloudflared");
  } finally { b.close({ keep: true }); }
  // The kept address no longer reaches us (Cloudflare dropped it): kill it and start a fresh one.
  const c = await cf.startCloudflare({ ...opts, fetchImpl: async () => { throw new Error("unreachable"); } });
  try {
    assert.notStrictEqual(c.url, a.url);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!cf.pidAlive(k1.pid), "the stale cloudflared was stopped");
  } finally { c.close(); }
  assert.strictEqual(cf.readKeep(keepFile), null, "a full close removes the kept tunnel");
  assert.strictEqual(cf.stopKept(keepFile), false);
});

// ---- An address is not a tunnel: the hub waits for a connection behind it. -------------------------------------
// On Linux especially (a firewall that drops UDP, a resolver that will not answer for Cloudflare's tunnel servers),
// Cloudflare hands out the address and cloudflared then never connects. The hub used to announce that as "on".

const fakeIn = (dir, body) => { const f = path.join(dir, "fake-cloudflared.js"); fs.writeFileSync(f, body); return f; };
const noReach = async () => ({ status: 530 });      // what Cloudflare answers for an address with no tunnel behind it

test("when QUIC does not get through, cloudflared is started again over HTTP/2, and that is remembered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-h2-"));
  // Connects only when asked for HTTP/2, like a network that drops UDP.
  const fake = fakeIn(dir, `
    const h2 = process.argv.includes("http2");
    console.error("INF | https://" + (h2 ? "over-http2" : "over-quic") + ".trycloudflare.com |");
    if (h2) console.error("INF Registered tunnel connection connIndex=0 protocol=http2");
    else console.error('ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity"');
    setInterval(() => {}, 1000);`);
  const keepFile = path.join(dir, "cloudflared.json");
  const logs = [], urls = [];
  const opts = { mailbox: { handle: (q, r) => r.end("{}") }, roomId: ROOM, file: path.join(dir, "url.json"), keepFile,
    exe: process.execPath, prefixArgs: [fake], connectMs: 400, timeoutMs: 20000, fetchImpl: noReach, log: (m) => logs.push(m), onUrl: (u) => urls.push(u) };
  const t = await cf.startCloudflare(opts);
  try {
    assert.strictEqual(t.url, "https://over-http2.trycloudflare.com");
    assert.strictEqual(t.mode, "http2");
    // The address that never worked was never told to anyone.
    assert.deepStrictEqual(urls, ["https://over-http2.trycloudflare.com"]);
    assert.ok(logs.some((l) => /no connection to Cloudflare over QUIC; trying HTTP2/.test(l)), logs.join(" | "));
    assert.strictEqual(cf.readKeep(keepFile).url, t.url);
  } finally { t.close(); }
  // Next start goes straight to HTTP/2 instead of waiting for QUIC to fail again.
  const logs2 = [];
  const again = await cf.startCloudflare({ ...opts, log: (m) => logs2.push(m) });
  try {
    assert.strictEqual(again.mode, "http2");
    assert.ok(!logs2.some((l) => /trying HTTP2/.test(l)), logs2.join(" | "));
  } finally { again.close(); }
});

test("when nothing connects, the hub is told why, and no address is published or left running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dead-"));
  const fake = fakeIn(dir, `
    console.error("INF | https://never-up.trycloudflare.com |");
    console.error('ERR edge discovery: error looking up Cloudflare edge IPs: the DNS query failed error="lookup _v2-origintunneld._tcp.argotunnel.com on 8.8.8.8:53: no such host"');
    setInterval(() => {}, 1000);`);
  const keepFile = path.join(dir, "cloudflared.json");
  const urlFile = path.join(dir, "url.json");
  const urls = [];
  await assert.rejects(
    cf.startCloudflare({ mailbox: { handle: (q, r) => r.end("{}") }, roomId: ROOM, file: urlFile, keepFile, exe: process.execPath, prefixArgs: [fake],
      connectMs: 300, timeoutMs: 20000, fetchImpl: noReach, onUrl: (u) => urls.push(u) }),
    (e) => e.code === "CF_NOT_CONNECTED" && /could not connect to Cloudflare's network/.test(e.message) && /DNS does not answer for Cloudflare's tunnel servers/.test(e.message));
  assert.deepStrictEqual(urls, []);
  assert.strictEqual(cf.currentUrl(urlFile), null);
  assert.strictEqual(cf.readKeep(keepFile), null);
});

test("a tunnel that works counts as up even if cloudflared words its log differently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-quiet-"));
  const fake = fakeIn(dir, `console.error("INF | https://quiet-one.trycloudflare.com |"); setInterval(() => {}, 1000);`);
  const t = await cf.startCloudflare({ mailbox: { handle: (q, r) => r.end("{}") }, roomId: ROOM, exe: process.execPath, prefixArgs: [fake],
    connectMs: 300, timeoutMs: 20000, fetchImpl: async () => ({ status: 200 }) });
  try { assert.strictEqual(t.url, "https://quiet-one.trycloudflare.com"); } finally { t.close(); }
});

test("cloudflared's log is read for the address, the connection and the reason", () => {
  // The API host in an error message is not the tunnel's address.
  const failed = 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host';
  assert.strictEqual(cf.readLog(failed).url, null);
  assert.match(cf.readLog(failed).why, /could not reach Cloudflare to ask for an address/);
  assert.match(cf.diagnose('failed to request quick Tunnel: 429 Too Many Requests'), /refusing new quick tunnels/);
  const ok = "INF |  https://a-b-c.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0 ip=198.41.200.13 location=arn02 protocol=quic";
  assert.deepStrictEqual(cf.readLog(ok), { url: "https://a-b-c.trycloudflare.com", connected: true, why: null });
  assert.match(cf.diagnose('failed to dial to edge with quic: timeout: no recent network activity'), /port 7844/);
  assert.strictEqual(cf.diagnose("INF Starting tunnel"), null);
  // And an address file holding the API host is not believed either.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cf-")), "u.json");
  fs.writeFileSync(f, JSON.stringify({ url: "https://api.trycloudflare.com" }));
  assert.strictEqual(cf.currentUrl(f), null);
});

test("a kept process is only reused or stopped if it really is cloudflared", { skip: process.platform !== "linux" }, () => {
  // After a reboot the saved number belongs to something else: this test process, say.
  assert.strictEqual(cf.pidAlive(process.pid), true);
  assert.strictEqual(cf.isCloudflared(process.pid), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pid-"));
  const keepFile = path.join(dir, "cloudflared.json");
  fs.writeFileSync(keepFile, JSON.stringify({ pid: process.pid, port: 1, url: "https://old-one.trycloudflare.com" }));
  assert.strictEqual(cf.stopKept(keepFile), false, "it did not try to stop a process that is not cloudflared");
});
