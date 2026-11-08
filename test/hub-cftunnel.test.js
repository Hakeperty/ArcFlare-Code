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
  fs.writeFileSync(fake, "console.error('INF | https://abc-def.trycloudflare.com |'); setTimeout(() => {}, 30000);");
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
