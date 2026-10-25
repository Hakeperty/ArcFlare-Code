"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decideMode, probeLan, looksLikeHub, isPairedRecord } = require("../www/mode.js");
const { A43 } = require("./helpers.js");

const rec = (o = {}) => Object.assign({
  v: 1, relay: "https://arcflare.net", room: A43, hubKey: A43, lan: "http://192.168.1.20:8765",
  deviceId: A43.slice(0, 22), roomToken: "aftc_" + A43, label: "Android phone", privateKey: { fake: "CryptoKey" }, publicKey: A43,
}, o);

test("no record, or a damaged one -> unpaired", () => {
  assert.equal(decideMode({ record: null, probe: { ok: true } }), "unpaired");
  assert.equal(decideMode({ record: undefined }), "unpaired");
  assert.equal(decideMode({ record: {} }), "unpaired");
  assert.equal(decideMode({ record: rec({ roomToken: "nope" }), probe: { ok: true } }), "unpaired");
  assert.equal(decideMode({ record: rec({ hubKey: "short" }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ privateKey: null }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ relay: "http://arcflare.net" }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ lan: "http://8.8.8.8:80" }) }), "unpaired");
});

test("LAN answered -> home, even though a relay pairing exists (LAN is always preferred)", () => {
  assert.equal(decideMode({ record: rec(), probe: { ok: true } }), "home");
});

test("LAN down -> relay; no LAN stored -> relay", () => {
  assert.equal(decideMode({ record: rec(), probe: { ok: false } }), "relay");
  assert.equal(decideMode({ record: rec(), probe: null }), "relay");
  assert.equal(decideMode({ record: rec({ lan: null }), probe: { ok: true } }), "relay", "a probe result means nothing without a stored LAN URL");
});

test("relay unusable (old WebView) and LAN down -> unreachable; LAN still wins", () => {
  assert.equal(decideMode({ record: rec(), probe: { ok: false }, relayUsable: false }), "unreachable");
  assert.equal(decideMode({ record: rec(), probe: { ok: true }, relayUsable: false }), "home");
});

test("isPairedRecord accepts a loopback http relay (dev builds) and a missing lan", () => {
  assert.equal(isPairedRecord(rec({ relay: "http://localhost:3000" })), true);
  assert.equal(isPairedRecord(rec({ lan: null })), true);
});

test("looksLikeHub: only a JSON object with boolean setup", () => {
  assert.equal(looksLikeHub({ status: 200, data: { setup: true } }), true);
  assert.equal(looksLikeHub({ status: 200, data: { setup: false } }), true);
  assert.equal(looksLikeHub({ status: 200, data: '{"setup":true}' }), true);
  assert.equal(looksLikeHub({ status: 200, data: { setup: "yes" } }), false);
  assert.equal(looksLikeHub({ status: 200, data: { ok: true } }), false);
  assert.equal(looksLikeHub({ status: 200, data: "<html>router login</html>" }), false);
  assert.equal(looksLikeHub({ status: 200, data: [{ setup: true }] }), false);
  assert.equal(looksLikeHub({ status: 200, data: null }), false);
  assert.equal(looksLikeHub({ status: 302, data: { setup: true } }), false);
  assert.equal(looksLikeHub({ status: 404, data: { setup: true } }), false);
  assert.equal(looksLikeHub(null), false);
});

test("probeLan asks the exact URL and accepts a hub", async () => {
  let asked;
  const r = await probeLan(async (o) => { asked = o; return { status: 200, data: { setup: true } }; }, "http://192.168.1.20:8765", 2000);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(asked, { url: "http://192.168.1.20:8765/api/status", timeoutMs: 2000 });
});

test("probeLan rejects look-alikes, errors and bad URLs without throwing", async () => {
  const lan = "http://192.168.1.20:8765";
  assert.equal((await probeLan(async () => ({ status: 200, data: "<html>" }), lan)).ok, false);
  assert.equal((await probeLan(async () => ({ status: 200, data: { setup: 1 } }), lan)).ok, false);
  assert.equal((await probeLan(async () => { throw new Error("ECONNREFUSED"); }, lan)).ok, false);
  let called = false;
  assert.equal((await probeLan(async () => { called = true; return { status: 200, data: { setup: true } }; }, "http://8.8.8.8:80")).ok, false);
  assert.equal(called, false, "a public address is never probed");
  assert.equal((await probeLan(async () => ({}), null)).ok, false);
});

test("probeLan enforces its own deadline even if the native call hangs", async () => {
  const t0 = Date.now();
  const r = await probeLan(() => new Promise(() => {}), "http://192.168.1.20:8765", 150);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1000);
});
