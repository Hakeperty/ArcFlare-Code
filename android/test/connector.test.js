"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../www/connector.js");
const { validateLink } = require("../www/link.js");
const { A43, hubLink } = require("./helpers.js");

const LAN = "http://192.168.1.20:8765";
const RELAY = "https://arcflare.net";
const rec = (o = {}) => Object.assign({
  v: 1, relay: RELAY, room: A43, hubKey: A43, lan: LAN, deviceId: A43.slice(0, 22), roomToken: "aftc_" + A43, lanToken: "aftl_" + A43,
  label: "Android phone", privateKey: { fake: 1 }, publicKey: A43,
}, o);

/** Fake ArcFlareTunnel. behave(base, opts) decides each connect: "ok" | error code | "hang". */
function fakeEnv(behave) {
  const env = { connects: [], pairs: [], closed: 0, lanFetches: [] };
  env.deps = {
    lanFetch: (base) => { const f = { fetch: () => {}, base }; env.lanFetches.push(f); return f; },
    Tunnel: {
      async connect(device, opts) {
        env.connects.push({ base: device.relay, opts, device });
        const b = behave(device.relay, opts);
        if (b === "hang") return new Promise(() => {});
        if (b !== "ok") throw Object.assign(new Error(b), { code: b });
        return { close() { env.closed++; }, base: device.relay };
      },
      async pair(opts) {
        env.pairs.push(opts);
        const b = behave(new URL(opts.link.replace("arcflare://", "https://")).searchParams.get("r"), opts);
        if (b !== "ok") throw Object.assign(new Error(b), { code: b });
        return { sas: "123456", device: { relay: "x" } };
      },
    },
  };
  return env;
}

test("home answers: used, with the native LAN fetch and a 3 s handshake cap; the relay is NEVER contacted", async () => {
  const env = fakeEnv(() => "ok");
  const r = await C.connectBest(env.deps, rec());
  assert.equal(r.kind, "home");
  assert.deepEqual(env.connects.map((c) => c.base), [LAN]);
  assert.equal(env.connects[0].opts.handshakeTimeoutMs, 3000);
  assert.equal(typeof env.connects[0].opts.fetch, "function");
  assert.deepEqual(env.lanFetches.map((f) => f.base), [LAN], "the LAN fetch is built for exactly the stored LAN base");
  assert.equal(env.connects[0].device.relay, LAN, "the tunnel client is pointed at the LAN base");
  assert.equal(env.connects[0].device.hubKey, A43, "same pinned key");
});

test("home fails -> relay is tried next with the plain (browser) fetch and the longer cap", async () => {
  const env = fakeEnv((base) => (base === LAN ? "TIMEOUT" : "ok"));
  const r = await C.connectBest(env.deps, rec());
  assert.equal(r.kind, "relay");
  assert.deepEqual(env.connects.map((c) => c.base), [LAN, RELAY]);
  // the relay uses the page's own fetch, wrapped in a guard that refuses the LAN token
  assert.equal(typeof env.connects[1].opts.fetch, "function");
  await assert.rejects(env.connects[1].opts.fetch(RELAY + "/x", { headers: { Authorization: "Bearer " + rec().lanToken } }), { code: "TOKEN_MISUSE" });
  assert.equal(env.connects[1].opts.handshakeTimeoutMs, 10000);
  assert.deepEqual(r.attempts, [{ kind: "home", code: "TIMEOUT" }]);
});

test("N1: the home target gets a LAN fetch that refuses the relay token; an earlier-build record never tries home", async () => {
  const env = fakeEnv(() => "ok");
  const lf = [];
  env.deps.lanFetch = (base, o) => { lf.push(o); return { fetch: () => {} }; };
  await C.connectBest(env.deps, rec());
  assert.deepEqual(lf, [{ refuse: [rec().roomToken] }]);
  const old = rec(); delete old.lanToken;
  const env2 = fakeEnv((base) => (base === LAN ? "ok" : "ok"));
  const r = await C.connectBest(env2.deps, old);
  assert.equal(r.kind, "relay");
  assert.deepEqual(env2.connects.map((c) => c.base), [RELAY], "the LAN base was never contacted for it");
  assert.equal(env2.lanFetches.length, 0);
  const lanOnlyOld = rec({ relay: LAN }); delete lanOnlyOld.lanToken;
  await assert.rejects(C.connectBest(fakeEnv(() => "ok").deps, lanOnlyOld), { code: "UNREACHABLE" });
});

test("both fail -> rejects with both attempts and the relay's code", async () => {
  const env = fakeEnv((base) => (base === LAN ? "TIMEOUT" : "REFUSED"));
  await assert.rejects(C.connectBest(env.deps, rec()), (e) => {
    assert.equal(e.code, "REFUSED");
    assert.deepEqual(e.attempts, [{ kind: "home", code: "TIMEOUT" }, { kind: "relay", code: "REFUSED" }]);
    return true;
  });
});

test("relay == LAN base (internet relay off): only one attempt, no second contact", async () => {
  const env = fakeEnv(() => "TIMEOUT");
  await assert.rejects(C.connectBest(env.deps, rec({ relay: LAN })), { code: "TIMEOUT" });
  assert.equal(env.connects.length, 1);
});

test("no LAN base stored: relay only, the LAN fetch is never built", async () => {
  const env = fakeEnv(() => "ok");
  const r = await C.connectBest(env.deps, rec({ lan: null }));
  assert.equal(r.kind, "relay");
  assert.equal(env.lanFetches.length, 0);
});

test("PENDING from home proves the hub and ends the search (the relay is not asked)", async () => {
  const env = fakeEnv((base) => (base === LAN ? "PENDING" : "ok"));
  await assert.rejects(C.connectBest(env.deps, rec()), { code: "PENDING" });
  assert.deepEqual(env.connects.map((c) => c.base), [LAN]);
});

test("HANDSHAKE failure on home (wrong key / squatter) falls to the relay, never trusts the LAN", async () => {
  const env = fakeEnv((base) => (base === LAN ? "HANDSHAKE" : "ok"));
  const r = await C.connectBest(env.deps, rec());
  assert.equal(r.kind, "relay");
});

test("skipHome (a page the shell has just checked) goes straight to the relay", async () => {
  const env = fakeEnv(() => "ok");
  const r = await C.connectBest(env.deps, rec(), { skipHome: true });
  assert.equal(r.kind, "relay");
  assert.deepEqual(env.connects.map((c) => c.base), [RELAY]);
});

test("a handshake that never settles is cut at the cap (3 s home) and a late success is closed", async () => {
  const env = fakeEnv(() => "hang");
  const t0 = Date.now();
  const p = C.connectTarget(env.deps, rec(), { kind: "home", base: LAN });
  // shorten: only check it does reject by itself near 3.5 s
  await assert.rejects(p, { code: "TIMEOUT" });
  const ms = Date.now() - t0;
  assert.ok(ms >= 3000 && ms < 4500, "took " + ms);
});

test("check(): never throws; reports ok/code; closes the probe tunnel", async () => {
  let env = fakeEnv(() => "ok");
  assert.deepEqual(await C.check(env.deps, rec(), "home"), { ok: true });
  assert.equal(env.closed, 1);
  env = fakeEnv(() => "OFFLINE");
  assert.deepEqual(await C.check(env.deps, rec(), "relay"), { ok: false, code: "OFFLINE" });
  assert.deepEqual(await C.check(env.deps, rec({ lan: null }), "home"), { ok: false, code: "NO_TARGET" });
  assert.deepEqual(await C.check(env.deps, rec({ relay: LAN }), "relay"), { ok: false, code: "NO_TARGET" });
});

test("pairBest: LAN first with a short cap and the LAN fetch; the link given to pair() has r = the LAN base", async () => {
  const env = fakeEnv(() => "ok");
  const v = validateLink(hubLink()).value;
  const res = await C.pairBest(env.deps, v, "Android phone");
  assert.equal(res.via, "home");
  assert.equal(env.pairs.length, 1);
  assert.equal(validateLink(env.pairs[0].link).value.lan, LAN);
  assert.ok(env.pairs[0].link.includes("r=" + encodeURIComponent(LAN)));
  assert.equal(env.pairs[0].timeoutMs, 8000);
  assert.equal(typeof env.pairs[0].fetch, "function");
});

test("pairBest: LAN timeout, HANDSHAKE and REFUSED fall through to the relay; the relay's own HANDSHAKE/REFUSED end it", async () => {
  const v = validateLink(hubLink()).value;
  let env = fakeEnv((base) => (base === LAN ? "TIMEOUT" : "ok"));
  assert.equal((await C.pairBest(env.deps, v, "x")).via, "relay");
  assert.equal(env.pairs.length, 2);
  assert.equal(env.pairs[1].fetch, undefined);
  assert.equal(env.pairs[1].timeoutMs, 30000);
  for (const code of ["HANDSHAKE", "REFUSED"]) {
    // N6: an impostor at the LAN address (forged answer, or a 401) must not be able to block pairing: the relay is tried
    env = fakeEnv((base) => (base === LAN ? code : "ok"));
    assert.equal((await C.pairBest(env.deps, v, "x")).via, "relay", code + " from home falls through");
    assert.equal(env.pairs.length, 2);
    // ... but the relay's own verdict is final
    env = fakeEnv(() => code);
    await assert.rejects(C.pairBest(env.deps, v, "x"), { code });
    assert.equal(env.pairs.length, 2, code + " from the relay ends it");
    // LAN-only link: the single attempt's verdict is final
    env = fakeEnv(() => code);
    await assert.rejects(C.pairBest(env.deps, validateLink(hubLink({ relay: LAN, lan: LAN })).value, "x"), { code });
    assert.equal(env.pairs.length, 1);
  }
  // errors that no other target could change still end it at once
  for (const code of ["BAD_LINK", "BAD_VERSION", "NO_X25519"]) {
    env = fakeEnv((base) => (base === LAN ? code : "ok"));
    await assert.rejects(C.pairBest(env.deps, v, "x"), { code });
    assert.equal(env.pairs.length, 1, code + " ends it");
  }
});

test("pairBest: LAN-only link (r = l) has a single attempt with the full cap; relay-only link never builds a LAN fetch", async () => {
  let env = fakeEnv(() => "TIMEOUT");
  await assert.rejects(C.pairBest(env.deps, validateLink(hubLink({ relay: LAN, lan: LAN })).value, "x"), { code: "TIMEOUT" });
  assert.equal(env.pairs.length, 1);
  assert.equal(env.pairs[0].timeoutMs, 30000);
  env = fakeEnv(() => "ok");
  await C.pairBest(env.deps, validateLink(hubLink({ lan: null })).value, "x");
  assert.equal(env.lanFetches.length, 0);
});
