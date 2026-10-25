"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../www/transport.js");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake of what ArcFlareTunnel.connect() returns (request / eventSource / onclose). */
function fakeTunnel(over = {}) {
  const t = {
    requests: [], streams: [], onclose: null, closed: false,
    async request(method, path, o) {
      t.requests.push({ method, path, o });
      if (over.request) return over.request(method, path, o, t);
      const body = Buffer.from(JSON.stringify({ hello: "world", path }));
      return { status: 200, headers: { "content-type": "application/json", "retry-after": "3" }, body, text: () => body.toString(), json: () => JSON.parse(body.toString()) };
    },
    eventSource(path) {
      const es = { path, readyState: 0, onopen: null, onmessage: null, onerror: null, lastEventId: "", closeCalls: 0, close() { es.closeCalls++; es.readyState = 2; } };
      t.streams.push(es);
      return es;
    },
  };
  return t;
}

function setup(tunnelFactory = () => fakeTunnel()) {
  const tunnels = [];
  let connects = 0;
  const transport = create({ connect: async () => { connects++; const t = tunnelFactory(connects); tunnels.push(t); return t; } });
  return { transport, tunnels, connects: () => connects };
}

test("fetch resolves to ok/status/headers.get/json/text", async () => {
  const { transport, tunnels } = setup();
  const res = await transport.fetch("/api/me", { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin" });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.equal(res.headers.get("RETRY-AFTER"), "3");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.deepEqual(await res.json(), { hello: "world", path: "/api/me" });
  assert.equal(JSON.parse(await res.text()).path, "/api/me");
  assert.equal(tunnels[0].requests[0].method, "GET");
});

test("only Accept, Content-Type and X-CSRF-Token are passed; method is upper-cased; body is passed", async () => {
  const { transport, tunnels } = setup();
  await transport.fetch("/api/login", {
    method: "post", credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": "tok", Cookie: "x=1", Authorization: "Bearer y", "X-Evil": "1" },
    body: '{"a":1}',
  });
  const r = tunnels[0].requests[0];
  assert.equal(r.method, "POST");
  assert.deepEqual(r.o.headers, { accept: "application/json", "content-type": "application/json", "x-csrf-token": "tok" });
  assert.equal(r.o.body, '{"a":1}');
});

test("Headers-like init is accepted", async () => {
  const { transport, tunnels } = setup();
  await transport.fetch("/api/x", { headers: new Headers({ Accept: "text/plain", Cookie: "a=b" }) });
  assert.deepEqual(tunnels[0].requests[0].o.headers, { accept: "text/plain" });
});

test("non-2xx: ok is false and the body is still readable", async () => {
  const { transport } = setup(() => fakeTunnel({
    request: async () => { const b = Buffer.from('{"error":"nope"}'); return { status: 401, headers: {}, body: b, text: () => b.toString(), json: () => JSON.parse(b.toString()) }; },
  }));
  const res = await transport.fetch("/api/me");
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "nope");
  assert.equal(res.headers.get("content-type"), null);
});

test("response headers that arrive as a plain object still get .get()", async () => {
  const { transport } = setup(() => fakeTunnel({ request: async () => ({ status: 204, headers: { "Cache-Control": "no-store" }, body: new Uint8Array(0), text: () => "", json: () => null }) }));
  const res = await transport.fetch("/api/logout", { method: "POST" });
  assert.equal(typeof res.headers.get, "function");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("paths that are not /... are refused (no absolute URLs through the adapter)", async () => {
  const { transport, connects } = setup();
  for (const p of ["https://evil.example/api/me", "//evil.example/api/me", "api/me", "", null, 5]) {
    await assert.rejects(transport.fetch(p), (e) => e.code === "BAD_PATH");
  }
  assert.equal(connects(), 0);
});

test("the session is opened lazily and shared by concurrent first calls", async () => {
  const { transport, connects } = setup();
  assert.equal(connects(), 0);
  await Promise.all([transport.fetch("/api/a"), transport.fetch("/api/b"), transport.fetch("/api/c")]);
  assert.equal(connects(), 1);
});

test("after the tunnel's onclose the next call opens a fresh session", async () => {
  const { transport, tunnels, connects } = setup();
  await transport.fetch("/api/a");
  tunnels[0].onclose(new Error("RESET"));
  await transport.fetch("/api/b");
  assert.equal(connects(), 2);
  assert.equal(tunnels[1].requests.length, 1);
});

test("a failed connect is reported and the next call tries again", async () => {
  let n = 0;
  const { transport, connects } = setup(() => { if (++n === 1) throw Object.assign(new Error("pending"), { code: "PENDING" }); return fakeTunnel(); });
  await assert.rejects(transport.fetch("/api/a"), (e) => e.code === "PENDING");
  assert.equal((await transport.fetch("/api/a")).status, 200);
  assert.equal(connects(), 2);
});

test("a GET that hits a just-closed session reconnects once; a POST does not retry", async () => {
  let first = true;
  const { transport, tunnels, connects } = setup(() => fakeTunnel({
    request: async (m, p, o, t) => { if (first) { first = false; throw Object.assign(new Error("tunnel closed"), { code: "CLOSED" }); } const b = Buffer.from("{}"); return { status: 200, headers: {}, body: b, text: () => "{}", json: () => ({}) }; },
  }));
  assert.equal((await transport.fetch("/api/a")).status, 200);
  assert.equal(connects(), 2);
  assert.equal(tunnels.length, 2);
  // POST: error propagates
  const p2 = setup(() => fakeTunnel({ request: async () => { throw Object.assign(new Error("tunnel closed"), { code: "CLOSED" }); } }));
  await assert.rejects(p2.transport.fetch("/api/b", { method: "POST", body: "{}" }), (e) => e.code === "CLOSED");
  assert.equal(p2.connects(), 1);
});

test("eventSource has addEventListener: 'message' listeners and onmessage both get unnamed events", async () => {
  const { transport, tunnels } = setup();
  const es = transport.eventSource("/api/events");
  assert.equal(typeof es.addEventListener, "function");
  assert.equal(typeof es.removeEventListener, "function");
  assert.equal(typeof es.close, "function");
  assert.equal(es.readyState, 0);
  const viaProp = [], viaListener = [], viaRemoved = [], opened = [];
  es.onmessage = (ev) => viaProp.push(ev.data);
  es.onopen = () => opened.push(1);
  es.addEventListener("message", (ev) => viaListener.push(ev.data));
  const removed = (ev) => viaRemoved.push(ev.data);
  es.addEventListener("message", removed);
  es.removeEventListener("message", removed);
  await tick();
  const inner = tunnels[0].streams[0];
  assert.equal(inner.path, "/api/events");
  inner.readyState = 1; inner.onopen({});
  inner.onmessage({ type: "message", data: '{"seq":1}', lastEventId: "7" });
  inner.onmessage({ type: "message", data: '{"seq":2}', lastEventId: "8" });
  assert.deepEqual(viaProp, ['{"seq":1}', '{"seq":2}']);
  assert.deepEqual(viaListener, ['{"seq":1}', '{"seq":2}']);
  assert.deepEqual(viaRemoved, []);
  assert.deepEqual(opened, [1]);
  assert.equal(es.readyState, 1);
  assert.equal(es.lastEventId, "8");
});

test("addEventListener for named events (the UI registers all STREAM_TYPES) is accepted and never fires, without error", async () => {
  const { transport, tunnels } = setup();
  const es = transport.eventSource("/api/agents/a1/events");
  const seen = [];
  for (const t of ["status", "delta", "tool", "approval", "turn_end", "error"]) es.addEventListener(t, (ev) => seen.push(t));
  es.addEventListener("message", () => {});
  es.addEventListener("message", null);        // ignored, not an error
  await tick();
  tunnels[0].streams[0].onmessage({ type: "message", data: "{}" });
  assert.deepEqual(seen, []);
});

test("eventSource error: readyState 2, onerror and 'error' listeners fire; no retry inside the adapter", async () => {
  const { transport, tunnels, connects } = setup();
  const es = transport.eventSource("/api/events");
  let onerr = 0, listener = 0;
  es.onerror = () => onerr++;
  es.addEventListener("error", () => listener++);
  await tick();
  tunnels[0].streams[0].onerror({});
  assert.equal(es.readyState, 2);
  assert.equal(onerr, 1);
  assert.equal(listener, 1);
  await tick(20);
  assert.equal(connects(), 1);
  assert.equal(tunnels[0].streams.length, 1);
});

test("eventSource when the session cannot be opened: one asynchronous onerror, no retry", async () => {
  const { transport, connects } = setup(() => { throw Object.assign(new Error("offline"), { code: "OFFLINE" }); });
  const es = transport.eventSource("/api/events");
  assert.equal(es.readyState, 0);
  let errors = 0;
  es.onerror = () => errors++;
  await tick(20);
  assert.equal(errors, 1);
  assert.equal(es.readyState, 2);
  assert.equal(connects(), 1);
});

test("the UI's pattern works: onerror -> es.close() is harmless, repeated close() too", async () => {
  const { transport, tunnels } = setup();
  const es = transport.eventSource("/api/events");
  es.onerror = () => es.close();
  await tick();
  tunnels[0].streams[0].onerror({});
  es.close(); es.close();
  assert.equal(es.readyState, 2);
});

test("close() before the session is up closes the stream as soon as it exists and fires nothing", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const tunnels = [];
  const transport = create({ connect: async () => { await gate; const t = fakeTunnel(); tunnels.push(t); return t; } });
  const es = transport.eventSource("/api/events");
  let events = 0; es.onmessage = es.onerror = es.onopen = () => events++;
  es.close();
  release();
  await tick(10);
  assert.equal(es.readyState, 2);
  assert.equal(tunnels[0].streams.length, 0, "no stream is opened for a closed wrapper");
  assert.equal(events, 0);
});

test("close() after the stream exists is forwarded and later events are ignored", async () => {
  const { transport, tunnels } = setup();
  const es = transport.eventSource("/api/events");
  const got = []; es.onmessage = (ev) => got.push(ev);
  await tick();
  es.close();
  assert.equal(tunnels[0].streams[0].closeCalls, 1);
  tunnels[0].streams[0].onmessage({ data: "{}" });
  assert.deepEqual(got, []);
});

test("a throwing UI callback does not break delivery to other listeners", async () => {
  const { transport, tunnels } = setup();
  const es = transport.eventSource("/api/events");
  const got = [];
  es.onmessage = () => { throw new Error("ui bug"); };
  es.addEventListener("message", (ev) => got.push(ev.data));
  await tick();
  tunnels[0].streams[0].onmessage({ data: "x" });
  assert.deepEqual(got, ["x"]);
});

test("against the REAL tunnel-client: an unavailable session gives an already-closed stream and one onerror", async () => {
  const TC = require("../www/ui/tunnel-client.js");
  const real = new TC.Tunnel({ relay: "https://arcflare.net" }, {});     // state "new": _start() rejects with CLOSED
  let connects = 0;
  const transport = create({ connect: async () => { connects++; return real; } });
  const es = transport.eventSource("/api/events");
  let errors = 0;
  es.onerror = () => errors++;
  assert.equal(typeof es.addEventListener, "function");
  await tick(30);
  assert.equal(errors, 1);
  assert.equal(es.readyState, 2);
  assert.equal(connects, 1);
  // and the real tunnel-client's eventSource really lacks addEventListener (the reason the wrapper exists)
  assert.equal(typeof real.eventSource("/api/events").addEventListener, "undefined");
});

test("against the REAL tunnel-client: fetch on a closed session rejects, it never hangs", async () => {
  const TC = require("../www/ui/tunnel-client.js");
  const real = new TC.Tunnel({ relay: "https://arcflare.net" }, {});
  const transport = create({ connect: async () => real });
  await assert.rejects(transport.fetch("/api/me", { method: "POST", body: "{}" }), (e) => e.code === "CLOSED");
});
