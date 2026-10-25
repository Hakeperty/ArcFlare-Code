"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decideMode, targets, isPairedRecord } = require("../www/mode.js");
const { A43 } = require("./helpers.js");

const LAN = "http://192.168.1.20:8765";
const rec = (o = {}) => Object.assign({
  v: 1, relay: "https://arcflare.net", room: A43, hubKey: A43, lan: LAN,
  deviceId: A43.slice(0, 22), roomToken: "aftc_" + A43, label: "Android phone", privateKey: { fake: "CryptoKey" }, publicKey: A43,
}, o);
const lanOnly = (o = {}) => rec(Object.assign({ relay: LAN }, o));
const OK = { ok: true }, NO = { ok: false };

test("no record, or a damaged one -> unpaired (whatever the handshakes said)", () => {
  assert.equal(decideMode({ record: null, home: OK, relay: OK }), "unpaired");
  assert.equal(decideMode({ record: undefined }), "unpaired");
  assert.equal(decideMode({ record: {} }), "unpaired");
  assert.equal(decideMode({}), "unpaired");
  assert.equal(decideMode({ record: rec({ roomToken: "nope" }), home: OK }), "unpaired");
  assert.equal(decideMode({ record: rec({ hubKey: "short" }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ privateKey: null }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ relay: "http://arcflare.net" }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ lan: "http://8.8.8.8:8765" }) }), "unpaired");
  assert.equal(decideMode({ record: rec({ lan: "http://192.168.1.20:80" }) }), "unpaired", "port 80 is not a LAN base");
  assert.equal(decideMode({ record: rec({ relay: "http://192.168.1.99:8765" }) }), "unpaired", "an http relay must equal the LAN base");
  assert.equal(decideMode({ record: rec({ relay: LAN, lan: null }) }), "unpaired", "an http relay without a LAN base");
});

test("home handshake ok -> home, even though a relay target exists and would also work", () => {
  assert.equal(decideMode({ record: rec(), home: OK }), "home");
  assert.equal(decideMode({ record: rec(), home: OK, relay: OK }), "home");
  assert.equal(decideMode({ record: rec(), home: OK, relay: NO }), "home");
});

test("home failed -> relay when the relay handshake worked", () => {
  assert.equal(decideMode({ record: rec(), home: NO, relay: OK }), "relay");
  assert.equal(decideMode({ record: rec(), home: null, relay: OK }), "relay", "home not tried is not home");
});

test("home failed and relay failed or not tried -> unreachable", () => {
  assert.equal(decideMode({ record: rec(), home: NO, relay: NO }), "unreachable");
  assert.equal(decideMode({ record: rec(), home: NO }), "unreachable");
  assert.equal(decideMode({ record: rec() }), "unreachable");
});

test("no LAN base stored: only the relay target; a home result means nothing", () => {
  assert.deepEqual(targets(rec({ lan: null })).map((t) => t.kind), ["relay"]);
  assert.equal(decideMode({ record: rec({ lan: null }), home: OK }), "unreachable");
  assert.equal(decideMode({ record: rec({ lan: null }), home: OK, relay: OK }), "relay");
});

test("internet relay off (relay == lan): one target; a relay result cannot make a second one", () => {
  assert.deepEqual(targets(lanOnly()), [{ kind: "home", base: LAN }]);
  assert.equal(decideMode({ record: lanOnly(), home: OK }), "home");
  assert.equal(decideMode({ record: lanOnly(), home: NO, relay: OK }), "unreachable");
  assert.equal(decideMode({ record: lanOnly(), home: NO }), "unreachable");
});

test("targets: home first, then relay, each with its own base", () => {
  assert.deepEqual(targets(rec()), [{ kind: "home", base: LAN }, { kind: "relay", base: "https://arcflare.net" }]);
  assert.deepEqual(targets(null), []);
  assert.deepEqual(targets(rec({ roomToken: "x" })), []);
});

test("a loose result object does not count: only ok === true", () => {
  assert.equal(decideMode({ record: rec(), home: { ok: "yes" }, relay: { ok: 1 } }), "unreachable");
  assert.equal(decideMode({ record: rec(), home: {}, relay: { ok: true } }), "relay");
});

test("isPairedRecord accepts a loopback http relay (dev builds), a missing lan, and relay == lan", () => {
  assert.equal(isPairedRecord(rec({ relay: "http://localhost:3000" })), true);
  assert.equal(isPairedRecord(rec({ lan: null })), true);
  assert.equal(isPairedRecord(lanOnly()), true);
});

test("mode.js stays pure: no network, no DOM, no storage", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "www", "mode.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\bfetch\b|XMLHttpRequest|document\.|indexedDB|localStorage|Capacitor|setTimeout/);
});
