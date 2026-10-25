"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create, checkUrl, MAX_BYTES } = require("../www/lanfetch.js");

const LAN = "http://192.168.1.20:8765";
const ROOM = "A".repeat(43);
const POLL = `${LAN}/api/tunnel/room/${ROOM}/client?ch=${"B".repeat(22)}&after=0&wait=25`;
const POST = `${LAN}/api/tunnel/room/${ROOM}/client`;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake of Capacitor's CapacitorHttp: records every call; answers come from `answer(req)`. */
function fakeHttp(answer) {
  const h = { calls: [], pending: [] };
  const run = (method) => (req) => {
    h.calls.push({ method, req });
    return new Promise((resolve, reject) => {
      const go = () => Promise.resolve().then(() => answer ? answer(req, method) : { status: 200, headers: { "Content-Type": "application/json" }, data: { frames: [], head: 0 } }).then(resolve, reject);
      if (h.hold) h.pending.push(go); else go();
    });
  };
  h.get = run("GET"); h.post = run("POST");
  return h;
}
const make = (answer, o = {}) => { const http = fakeHttp(answer); return { http, f: create(Object.assign({ http, lanBase: LAN }, o)).fetch }; };

test("a mailbox GET goes to the native stack with the exact URL, our timeouts, no redirects", async () => {
  const { http, f } = make();
  const res = await f(POLL, { method: "GET", headers: { Authorization: "Bearer aftc_x" }, cache: "no-store", credentials: "omit" });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { frames: [], head: 0 });
  assert.equal(http.calls.length, 1);
  const { method, req } = http.calls[0];
  assert.equal(method, "GET");
  assert.equal(req.url, POLL);
  assert.equal(req.disableRedirects, true);
  assert.equal(req.connectTimeout, 3000);
  assert.ok(req.readTimeout >= 30000, "covers the 25 s long poll");
  assert.deepEqual(req.headers, { Authorization: "Bearer aftc_x" });
});

test("a mailbox POST sends the JSON body as data with Content-Type", async () => {
  const { http, f } = make();
  await f(POST, { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ ch: "c", frames: ["x"] }) });
  assert.equal(http.calls[0].method, "POST");
  assert.deepEqual(http.calls[0].req.data, { ch: "c", frames: ["x"] });
  assert.equal(http.calls[0].req.headers["Content-Type"], "application/json");
  assert.ok(http.calls[0].req.readTimeout <= 20000);
});

test("wrong host, port, scheme, path or shape is refused and never reaches the native stack", async () => {
  const { http, f } = make();
  const bads = [
    `http://192.168.1.21:8765/api/tunnel/room/${ROOM}/client`,
    `http://192.168.1.20:8766/api/tunnel/room/${ROOM}/client`,
    `https://192.168.1.20:8765/api/tunnel/room/${ROOM}/client`,
    `http://192.168.1.20/api/tunnel/room/${ROOM}/client`,
    `http://8.8.8.8:8765/api/tunnel/room/${ROOM}/client`,
    "http://evil.example/api/tunnel/x",
    `${LAN}/api/status`,
    `${LAN}/api/tunnel`,
    `${LAN}/`,
    `${LAN}/api/tunnel/../me`,
    `${LAN}/api/tunnel/%2e%2e/me`,
    `${LAN}/api/tunnel/room/..%2f..%2fx`,
    `${LAN}/api/tunnel/x#frag`,
    `http://u:p@192.168.1.20:8765/api/tunnel/x`,
    `http://192.168.1.20:8765@evil.example/api/tunnel/x`,
    `http://192.168.1.20:8765.evil.example/api/tunnel/x`,
    `${LAN}\\@evil.example/api/tunnel/x`,
    `${LAN}/api/tunnel/x y`,
    `HTTP://192.168.1.20:8765/api/tunnel/x`,
    "/api/tunnel/x", "", null, undefined, 42, { href: POLL },
  ];
  for (const url of bads) await assert.rejects(f(url, { method: "GET" }), { code: "LAN_REFUSED" }, String(url));
  assert.equal(http.calls.length, 0);
});

test("other methods, a body on GET, a non-JSON POST body: refused", async () => {
  const { http, f } = make();
  for (const m of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) await assert.rejects(f(POST, { method: m }), { code: "LAN_REFUSED" });
  await assert.rejects(f(POLL, { method: "GET", body: "{}" }), { code: "LAN_REFUSED" });
  await assert.rejects(f(POST, { method: "POST", body: "not json" }), { code: "LAN_REFUSED" });
  await assert.rejects(f(POST, { method: "POST" }), { code: "LAN_REFUSED" });
  assert.equal(http.calls.length, 0);
});

test("no cookie is ever sent: Cookie headers (any case) and every header outside the allow-list are dropped", async () => {
  const { http, f } = make();
  await f(POLL, { headers: { Cookie: "session=abc", cookie: "x=1", "COOKIE": "y", "X-CSRF-Token": "t", Origin: "https://localhost", Referer: "https://localhost/", Authorization: "Bearer t", Accept: "application/json" }, credentials: "include" });
  const sent = http.calls[0].req.headers;
  assert.deepEqual(Object.keys(sent).sort(), ["Accept", "Authorization"]);
  assert.ok(!Object.keys(sent).some((k) => /cookie/i.test(k)));
  // Headers object input works too
  const H = new Headers({ Cookie: "a=b", Authorization: "Bearer t" });
  await f(POLL, { headers: H });
  assert.deepEqual(Object.keys(http.calls[1].req.headers), ["Authorization"]);
  // header injection attempt: dropped
  await f(POLL, { headers: { Authorization: "Bearer t\r\nCookie: a=b" } });
  assert.deepEqual(http.calls[2].req.headers, {});
});

test("no cookie is stored or surfaced: Set-Cookie is stripped from every answer", async () => {
  const { f } = make(() => ({ status: 200, headers: { "Set-Cookie": "s=1; HttpOnly", "set-cookie2": "x", "Content-Type": "application/json", "X-A": "b" }, data: { frames: [] } }));
  const res = await f(POLL, {});
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.equal(res.headers.get("set-cookie2"), null);
  assert.equal(res.headers.get("x-a"), "b");
  assert.equal(res.headers.get("CONTENT-TYPE"), "application/json");
});

test("redirects are refused: disableRedirects is on, and a 3xx answer is an error, not followed", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { http, f } = make(() => ({ status, headers: { Location: "http://evil.example/" }, data: "" }));
    await assert.rejects(f(POLL, {}), { code: "LAN_REFUSED" });
    assert.equal(http.calls.length, 1, "exactly one native request, to the mailbox only");
    assert.equal(http.calls[0].req.disableRedirects, true);
  }
});

test("oversize answers are refused (declared length, and body size)", async () => {
  const big = "x".repeat(MAX_BYTES + 1);
  let { f } = make(() => ({ status: 200, headers: { "Content-Length": String(MAX_BYTES + 1) }, data: "{}" }));
  await assert.rejects(f(POLL, {}), { code: "TOO_BIG" });
  ({ f } = make(() => ({ status: 200, headers: {}, data: big })));
  await assert.rejects(f(POLL, {}), { code: "TOO_BIG" });
  // a parsed JSON object (the native layer parses application/json) is measured after re-serialising
  ({ f } = make(() => ({ status: 200, headers: { "Content-Type": "application/json" }, data: { frames: [big] } })));
  await assert.rejects(f(POLL, {}), { code: "TOO_BIG" });
  // multi-byte text counts in bytes
  ({ f } = make(() => ({ status: 200, headers: {}, data: "é".repeat(Math.floor(MAX_BYTES / 2) + 1) })));
  await assert.rejects(f(POLL, {}), { code: "TOO_BIG" });
  // exactly at the cap is fine
  ({ f } = make(() => ({ status: 200, headers: {}, data: "x".repeat(MAX_BYTES) })));
  assert.equal((await (await f(POLL, {})).text()).length, MAX_BYTES);
});

test("error statuses come back as a response (the tunnel client reads 401/403/409/429 itself)", async () => {
  const { f } = make(() => ({ status: 409, headers: {}, data: { error: "the computer is offline" } }));
  const res = await f(POST, { method: "POST", body: "{}" });
  assert.equal(res.status, 409);
  assert.equal(res.ok, false);
  assert.deepEqual(await res.json(), { error: "the computer is offline" });
});

test("native failures (timeout, connection refused) reject; they never resolve", async () => {
  const { f } = make(() => { throw new Error("SocketTimeoutException"); });
  await assert.rejects(f(POLL, {}));
  const { f: g } = make(() => Promise.reject("weird string rejection"));
  await assert.rejects(g(POLL, {}), { code: "NETWORK" });
});

test("abort before the call: rejects with AbortError and nothing is sent", async () => {
  const { http, f } = make();
  const ac = new AbortController(); ac.abort();
  await assert.rejects(f(POLL, { signal: ac.signal }), { name: "AbortError" });
  assert.equal(http.calls.length, 0);
});

test("abort during the call: rejects at once; the late native answer is ignored (no unhandled rejection, no resolve)", async () => {
  const http = fakeHttp(); http.hold = true;
  const f = create({ http, lanBase: LAN }).fetch;
  const ac = new AbortController();
  let outcome = "pending";
  const p = f(POLL, { signal: ac.signal }).then(() => { outcome = "resolved"; }, (e) => { outcome = e.name; });
  await tick();
  assert.equal(http.calls.length, 1);
  ac.abort();
  await tick();
  assert.equal(outcome, "AbortError");
  http.pending.forEach((go) => go());          // the native answer arrives late
  await tick(20);
  assert.equal(outcome, "AbortError", "a late answer cannot change the outcome");
  await p;
  // and the same for a late native FAILURE
  const http2 = fakeHttp(() => { throw new Error("late failure"); }); http2.hold = true;
  const f2 = create({ http: http2, lanBase: LAN }).fetch;
  const ac2 = new AbortController();
  const p2 = f2(POLL, { signal: ac2.signal }).catch((e) => e.name);
  await tick(); ac2.abort();
  assert.equal(await p2, "AbortError");
  http2.pending.forEach((go) => go());
  await tick(20);
});

test("AbortSignal.timeout / AbortSignal.any (what the tunnel client passes) work", async () => {
  const http = fakeHttp(); http.hold = true;
  const f = create({ http, lanBase: LAN }).fetch;
  const ac = new AbortController();
  const sig = AbortSignal.any([ac.signal, AbortSignal.timeout(60000)]);
  const p = f(POLL, { signal: sig }).catch((e) => e.name);
  await tick(); ac.abort();
  assert.equal(await p, "AbortError");
});

test("a runaway number of concurrent requests is refused", async () => {
  const http = fakeHttp(); http.hold = true;
  const f = create({ http, lanBase: LAN }).fetch;
  const ac = new AbortController();
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(f(POLL, { signal: ac.signal }).catch(() => {}));
  await tick();
  await assert.rejects(f(POLL, {}), { code: "LAN_REFUSED" });
  ac.abort(); await Promise.all(ps);
});

test("create() refuses anything that is not a stored-style LAN base, and a missing native http", () => {
  const http = fakeHttp();
  for (const base of ["http://8.8.8.8:8765", "https://192.168.1.20:8765", "http://192.168.1.20", "http://192.168.1.20:8765/", "http://192.168.1.20:80", "", null, "http://hub.local.evil.com:8765"]) {
    assert.throws(() => create({ http, lanBase: base }), { code: "LAN_REFUSED" }, String(base));
  }
  assert.throws(() => create({ http: null, lanBase: LAN }), { code: "LAN_REFUSED" });
  assert.throws(() => create({ http: { get() {} }, lanBase: LAN }), { code: "LAN_REFUSED" });
  assert.ok(create({ http, lanBase: "http://studio.local:9000" }));
});

test("checkUrl is exact: only the stored base's own mailbox paths", () => {
  assert.ok(checkUrl(POLL, LAN));
  assert.throws(() => checkUrl(POLL, "http://192.168.1.20:8766"), { code: "LAN_REFUSED" });
});
