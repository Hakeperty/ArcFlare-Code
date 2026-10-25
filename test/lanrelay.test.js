// The hub's own mailbox (lib/hub/lanrelay.js) against TUNNEL.md section 15. These are the
// checks that were run against the website's reference relay (relay-check.mjs), ported to
// an in-process server on 127.0.0.1. Time-dependent rules use an offset clock, not sleeps.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const crypto = require("node:crypto");
const { createLanRelay, tokenHash } = require("../lib/hub/lanrelay");

const b64u = (b) => Buffer.from(b).toString("base64url");
const H = (t) => crypto.createHash("sha256").update(t, "utf8").digest("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(limits, opts = { serveHub: true }) {
  const hubToken = "afth_" + b64u(crypto.randomBytes(32));
  const room = { hubToken, roomId: H(hubToken) };
  const clock = { off: 0, now: () => Date.now() + clock.off };
  const mb = createLanRelay({ roomId: room.roomId, now: clock.now, limits, serveHub: opts.serveHub });
  const server = http.createServer((req, res) => mb.handle(req, res, req.headers["x-test-ip"] || req.socket.remoteAddress));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = new Set([hubToken]);
  const frames = new Set();
  const leaks = [];
  let seqIp = 1, fn = 0;
  const mkTok = (exp) => { const t = "aftc_" + b64u(crypto.randomBytes(32)); tokens.add(t); return exp === undefined ? { t, h: H(t) } : { t, h: H(t), exp }; };
  const mkFrame = () => { const f = b64u(Buffer.from(`FRAMEBODY-${++fn}-${crypto.randomBytes(12).toString("hex")}`)); frames.add(f); return f; };
  const chan = () => b64u(crypto.randomBytes(16));
  const ent = (c) => (c.exp === undefined ? { h: c.h } : { h: c.h, exp: c.exp });
  const R = (part = "", id = room.roomId) => `/api/tunnel/room/${id}${part}`;

  async function call(method, path, o = {}) {
    const headers = { "x-test-ip": o.ip || `10.1.${(seqIp >> 8) & 255}.${seqIp++ & 255}` };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.auth) headers.authorization = o.auth;
    if (o.origin) headers.origin = o.origin;
    if (o.acrm) headers["access-control-request-method"] = o.acrm;
    let body;
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers["content-type"] = o.ct || "application/json"; }
    if (o.raw !== undefined) { body = o.raw; headers["content-type"] = o.ct || "application/json"; }
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 204 */ }
    const hdrs = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    const delivers = method === "GET" && res.status === 200 && j && Array.isArray(j.frames) && j.frames.length > 0;
    for (const t of tokens) if (text.includes(t) || hdrs.includes(t)) leaks.push(`token in ${method} ${path.slice(0, 40)}`);
    if (/bearer/i.test(text) || /bearer/i.test(hdrs)) leaks.push("authorization echo");
    if (!delivers) for (const f of frames) if (text.includes(f) || hdrs.includes(f)) { leaks.push("frame"); break; }
    assert.strictEqual(res.headers.get("cache-control"), "no-store", `no-store on ${method} ${path.slice(0, 50)} (${res.status})`);
    assert.notStrictEqual(res.headers.get("access-control-allow-origin"), "*");
    if (method !== "HEAD" && res.status !== 204) assert.ok(j && (typeof j.error === "string" || res.status === 200), `JSON body ${res.status}: ${text.slice(0, 60)}`);
    return { status: res.status, h: res.headers, text, j };
  }
  const put = (clients, extra = {}) => call("PUT", R(), { token: room.hubToken, json: { v: 1, clients: clients.map(ent) }, ...extra });
  const hubGet = (after = 0, wait = 0, extra = {}) => call("GET", R(`/hub?after=${after}&wait=${wait}`), { token: room.hubToken, ...extra });
  const hubPost = (fr, extra = {}) => call("POST", R("/hub"), { token: room.hubToken, json: { frames: fr }, ...extra });
  const cGet = (tok, ch, after = 0, wait = 0, extra = {}) => call("GET", R(`/client?ch=${ch}&after=${after}&wait=${wait}`), { token: tok.t, ...extra });
  const cPost = (tok, ch, fr, extra = {}) => call("POST", R("/client"), { token: tok.t, json: { ch, frames: fr }, ...extra });
  const eq = (name, got, want) => assert.strictEqual(got, want, `${name}: got ${got}, want ${want}`);
  return {
    room, clock, mb, base, call, put, hubGet, hubPost, cGet, cPost, mkTok, mkFrame, chan, R, eq, leaks, tokens, frames,
    async close() { mb.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); assert.deepStrictEqual(leaks, []); },
  };
}

test("methods, paths and ids", async () => {
  const t = await boot();
  try {
    const { room, call, eq, R } = t;
    let r = await call("GET", R(), { token: room.hubToken });
    eq("GET on room root is 405", r.status, 405);
    assert.match(r.h.get("allow") || "", /PUT/);
    eq("PUT on /hub is 405", (await call("PUT", R("/hub"), { token: room.hubToken, json: {} })).status, 405);
    eq("DELETE on /client is 405", (await call("DELETE", R("/client"), {})).status, 405);
    eq("OPTIONS on room root is 405", (await call("OPTIONS", R(), { origin: "https://localhost", acrm: "PUT" })).status, 405);
    r = await call("OPTIONS", R("/hub"), { origin: "https://localhost", acrm: "GET" });
    assert.ok(r.status === 405 && !r.h.get("access-control-allow-origin"));
    eq("malformed roomId is 400", (await call("PUT", "/api/tunnel/room/short", { token: room.hubToken, json: { v: 1, clients: [] } })).status, 400);
    eq("no token on an unknown path is 401", (await call("GET", "/api/tunnel/nothing")).status, 401);
    eq("no token on /api/tunnel/ is 401", (await call("GET", "/api/tunnel/")).status, 401);
    eq("token on an unknown path is 404", (await call("GET", "/api/tunnel/nothing", { token: room.hubToken })).status, 404);
  } finally { await t.close(); }
});

test("hub PUT: auth, one room only", async () => {
  const t = await boot();
  try {
    const { room, call, put, eq, R, tokens } = t;
    const other = "afth_" + b64u(crypto.randomBytes(32));
    tokens.add(other);
    const ip = "198.51.100.10";
    eq("PUT without Authorization -> 401", (await call("PUT", R(), { json: { v: 1, clients: [] }, ip })).status, 401);
    eq("PUT with another room's hub token -> 401", (await put([], { token: other, ip })).status, 401);
    eq("PUT with a client-shaped token -> 401", (await put([], { token: t.mkTok().t, ip })).status, 401);
    eq("PUT with malformed Authorization -> 401", (await call("PUT", R(), { auth: "Basic abc", json: { v: 1, clients: [] }, ip })).status, 401);
    eq("PUT with a truncated hub token -> 401", (await put([], { token: room.hubToken.slice(0, -1), ip })).status, 401);
    const r = await put([]);
    assert.ok(r.status === 200 && r.j.ok === true);
    // a valid hub token for a room this hub does not host: refused
    eq("PUT for another room (valid token for it) -> 403", (await call("PUT", R("", H(other)), { token: other, json: { v: 1, clients: [] } })).status, 403);
    eq("hub GET for another room -> 404", (await call("GET", R("/hub?after=0&wait=0", H(other)), { token: other })).status, 404);
    eq("hub POST for another room -> 404", (await call("POST", R("/hub", H(other)), { token: other, json: { frames: [] } })).status, 404);
    assert.strictEqual(t.mb.stats().hasRoom, true);
  } finally { await t.close(); }
});

test("hub PUT: bodies and sizes", async () => {
  const t = await boot();
  try {
    const { room, call, eq, R, base } = t;
    const c = t.mkTok();
    const bad = async (name, o, want = 400) => eq(name, (await call("PUT", R(), { token: room.hubToken, ...o })).status, want);
    await bad("PUT not JSON", { raw: "{nope" });
    await bad("PUT wrong content-type", { raw: JSON.stringify({ v: 1, clients: [] }), ct: "text/plain" });
    await bad("PUT v:2", { json: { v: 2, clients: [] } });
    await bad("PUT missing clients", { json: { v: 1 } });
    await bad("PUT 33 clients", { json: { v: 1, clients: Array.from({ length: 33 }, () => ({ h: t.mkTok().h })) } });
    await bad("PUT bad hash", { json: { v: 1, clients: [{ h: "nope" }] } });
    await bad("PUT bad exp", { json: { v: 1, clients: [{ h: c.h, exp: "soon" }] } });
    await bad("PUT array body", { json: [] });
    eq("PUT 32 clients -> 200", (await call("PUT", R(), { token: room.hubToken, json: { v: 1, clients: Array.from({ length: 32 }, () => ({ h: t.mkTok().h })) } })).status, 200);
    await bad("PUT body > 8 KB -> 413", { json: { v: 1, clients: [], pad: "x".repeat(9000) } }, 413);
    const big = new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('{"v":1,"clients":[],"pad":"' + "x".repeat(20000) + '"}')); ctl.close(); } });
    const res = await fetch(base + R(), { method: "PUT", headers: { authorization: `Bearer ${room.hubToken}`, "content-type": "application/json", "x-test-ip": "10.9.9.9" }, body: big, duplex: "half" });
    eq("oversize streamed body (no Content-Length) -> 413", res.status, 413);
    await res.text();
  } finally { await t.close(); }
});

test("unknown room is 404 until the hub has made it", async () => {
  const t = await boot();
  try {
    const { eq, hubGet, hubPost, cGet, cPost, chan, mkTok, mkFrame } = t;
    const c = mkTok();
    eq("hub GET", (await hubGet()).status, 404);
    eq("hub POST", (await hubPost([])).status, 404);
    eq("client GET", (await cGet(c, chan())).status, 404);
    eq("client POST", (await cPost(c, chan(), [mkFrame()])).status, 404);
  } finally { await t.close(); }
});

test("client auth, exp and the grace window", async () => {
  const t = await boot();
  try {
    const { room, call, eq, put, cGet, cPost, mkTok, mkFrame, chan, clock, R } = t;
    const dev = mkTok(), stranger = mkTok();
    const pair = mkTok(clock.now() + 2500);
    await put([dev, pair]);
    const ch = chan(), ip = "198.51.100.20";
    eq("wrong token -> 401", (await cGet(stranger, ch, 0, 0, { ip })).status, 401);
    eq("POST wrong token -> 401", (await cPost(stranger, chan(), [mkFrame()], { ip })).status, 401);
    eq("malformed token -> 401", (await call("GET", R(`/client?ch=${ch}`), { token: "aftc_short", ip })).status, 401);
    eq("hub token on a client route -> 401", (await call("GET", R(`/client?ch=${ch}`), { token: room.hubToken, ip })).status, 401);
    eq("pairing token before expiry -> 200", (await cGet(pair, chan())).status, 200);
    clock.off += 2800;
    eq("pairing token after exp -> 401", (await cGet(pair, chan(), 0, 0, { ip })).status, 401);
    pair.exp = clock.now() + 2500;
    await put([dev, pair]);
    eq("re-listed with a later exp -> 200", (await cGet(pair, chan())).status, 200);
    await put([dev]);
    eq("removed from the allowlist -> 401", (await cGet(pair, chan(), 0, 0, { ip })).status, 401);
    eq("device token still fine", (await cGet(dev, chan())).status, 200);
    const dead = mkTok(clock.now() - 1000);
    await put([dev, dead]);
    eq("exp already past -> 401", (await cGet(dead, chan(), 0, 0, { ip })).status, 401);
  } finally { await t.close(); }
});

test("validation: frames, bodies, queries, all-or-nothing", async () => {
  const t = await boot();
  try {
    const { call, eq, put, cGet, cPost, hubPost, mkTok, mkFrame, chan, R } = t;
    const c = mkTok();
    await put([c]);
    const ch = chan();
    eq("client POST ok", (await cPost(c, ch, [mkFrame()])).status, 200);
    const maxFrame = "B".repeat(44000);
    eq("44000 chars", (await cPost(c, ch, [maxFrame])).status, 200);
    eq("44001 chars", (await cPost(c, ch, ["B".repeat(44001)])).status, 400);
    eq("23 chars", (await cPost(c, ch, ["A".repeat(23)])).status, 400);
    eq("'+'", (await cPost(c, ch, ["A".repeat(30) + "+"])).status, 400);
    eq("'=' padding", (await cPost(c, ch, ["A".repeat(30) + "=="])).status, 400);
    eq("not a string", (await cPost(c, ch, [123456])).status, 400);
    eq("17 frames", (await cPost(c, ch, Array.from({ length: 17 }, mkFrame))).status, 400);
    eq("16 frames", (await cPost(c, ch, Array.from({ length: 16 }, mkFrame))).status, 200);
    eq("bad channel", (await cPost(c, "short", [mkFrame()])).status, 400);
    eq("missing channel on GET", (await call("GET", R("/client"), { token: c.t })).status, 400);
    eq("body > 800 KB", (await cPost(c, ch, Array.from({ length: 20 }, () => maxFrame))).status, 413);
    eq("malformed JSON", (await call("POST", R("/client"), { token: c.t, raw: "{{" })).status, 400);
    eq("after=abc", (await call("GET", R(`/client?ch=${ch}&after=abc`), { token: c.t })).status, 400);
    eq("wait=1.5", (await call("GET", R("/hub?wait=1.5"), { token: t.room.hubToken })).status, 400);
    const hf = (n) => Array.from({ length: n }, () => ({ ch, c: mkFrame() }));
    eq("hub POST ok", (await hubPost(hf(2))).status, 200);
    eq("hub POST 64 frames", (await hubPost(hf(64))).status, 200);
    eq("hub POST 65 frames", (await hubPost(hf(65))).status, 400);
    eq("hub POST oversize frame", (await hubPost([{ ch, c: "B".repeat(44001) }])).status, 400);
    eq("hub POST bad channel id", (await hubPost([{ ch: "nope", c: mkFrame() }])).status, 400);
    eq("hub POST body > 3 MB", (await hubPost([{ ch, c: "D".repeat(3 * 1024 * 1024 + 10) }])).status, 413);
    eq("hub POST with one bad frame", (await hubPost([{ ch, c: mkFrame() }, { ch, c: "A".repeat(10) }])).status, 400);
    const after = await cGet(c, ch, 0, 0);
    eq("a rejected hub batch stored nothing of it", after.j.frames.length, 66);
  } finally { await t.close(); }
});

test("hub <-> phone happy path, long polls, revocation", async () => {
  const t = await boot();
  try {
    const { eq, put, cGet, cPost, hubGet, hubPost, mkTok, mkFrame, chan } = t;
    const a = mkTok(), b = mkTok();
    await put([a, b]);
    const cha = chan(), chb = chan();
    let r = await cGet(a, cha);
    assert.ok(r.status === 200 && r.j.frames.length === 0 && r.j.head === 0 && r.j.online === true, r.text);
    const unknown = chan();
    r = await hubPost([{ ch: unknown, c: mkFrame() }]);
    assert.ok(r.status === 200 && r.j.accepted === 0);
    const f1 = mkFrame(), f2 = mkFrame(), f3 = mkFrame();
    r = await hubPost([{ ch: cha, c: f1 }, { ch: cha, c: f2 }, { ch: unknown, c: f3 }]);
    eq("accepted counts only known channels", r.j.accepted, 2);
    r = await cGet(a, cha, 0, 0);
    assert.deepStrictEqual(r.j.frames, [{ seq: 1, c: f1 }, { seq: 2, c: f2 }]);
    eq("head", r.j.head, 2);
    eq("after=1", (await cGet(a, cha, 1, 0)).j.frames.length, 1);
    eq("after=head", (await cGet(a, cha, 2, 0)).j.frames.length, 0);
    eq("other token GET on a bound channel -> 403", (await cGet(b, cha)).status, 403);
    eq("other token POST on a bound channel -> 403", (await cPost(b, cha, [mkFrame()])).status, 403);
    const t0 = Date.now();
    const pending = cGet(a, cha, 2, 10);
    await sleep(300);
    const f4 = mkFrame();
    await hubPost([{ ch: cha, c: f4 }]);
    r = await pending;
    assert.ok(r.j.frames.length === 1 && r.j.frames[0].c === f4 && Date.now() - t0 < 5000, "client long-poll wakes");
    const t1 = Date.now();
    r = await cGet(a, cha, 3, 1);
    assert.ok(r.j.frames.length === 0 && Date.now() - t1 >= 800 && Date.now() - t1 < 4000, "long-poll returns empty after ~wait");
    const p1 = mkFrame(), p2 = mkFrame(), p3 = mkFrame();
    eq("client POST", (await cPost(a, cha, [p1, p2])).j.ok, true);
    await cPost(b, chb, [p3]);
    r = await hubGet(0, 0);
    assert.ok(r.j.frames.map((f) => f.seq).join() === "1,2,3" && r.j.frames[0].ch === cha && r.j.frames[2].ch === chb && r.j.frames[2].c === p3 && r.j.head === 3, r.text);
    eq("hub after=2", (await hubGet(2, 0)).j.frames.length, 1);
    const t2 = Date.now();
    const hp = hubGet(3, 10);
    await sleep(300);
    const p4 = mkFrame();
    await cPost(a, cha, [p4]);
    r = await hp;
    assert.ok(r.j.frames.length === 1 && r.j.frames[0].c === p4 && Date.now() - t2 < 5000, "hub long-poll wakes");
    r = await hubGet(99, 0);
    assert.ok(r.j.frames.length === 0 && r.j.head === 4, "head < after is visible");
    const pend = cGet(b, chb, 0, 10, { ip: "198.51.100.30" });
    await sleep(300);
    await put([a]);
    eq("revoked token's in-flight long-poll ends with 401", (await pend).status, 401);
    eq("revoked token -> 401", (await cGet(b, chb, 0, 0, { ip: "198.51.100.30" })).status, 401);
    eq("revoked channel gets no hub frames", (await hubPost([{ ch: chb, c: mkFrame() }])).j.accepted, 0);
    eq("surviving token unaffected", (await cGet(a, cha, 0, 0)).status, 200);
  } finally { await t.close(); }
});

test("channel count limits", async () => {
  const t = await boot();
  try {
    const { eq, put, cGet, cPost, mkTok, mkFrame, chan } = t;
    const toks = Array.from({ length: 9 }, () => mkTok());
    await put(toks);
    const mine = [];
    for (let i = 0; i < 8; i++) { mine.push(chan()); eq(`channel #${i + 1}`, (await cGet(toks[0], mine[i])).status, 200); }
    let r = await cGet(toks[0], chan());
    assert.ok(r.status === 429 && Number(r.h.get("retry-after")) >= 1, "9th channel for one token");
    eq("9th via POST", (await cPost(toks[0], chan(), [mkFrame()])).status, 429);
    for (let k = 1; k < 8; k++) for (let i = 0; i < 8; i++) eq(`fill ${k}/${i}`, (await cGet(toks[k], chan())).status, 200);
    r = await cGet(toks[8], chan());
    assert.ok(r.status === 429 && Number(r.h.get("retry-after")) >= 1, "65th channel in the room");
    eq("a bound channel keeps working at the limit", (await cGet(toks[0], mine[3])).status, 200);
  } finally { await t.close(); }
});

test("queue limits: counts, bytes, reply cap, paging", async () => {
  const t = await boot({ inflight: 1000, inflightPerIp: 1000, ratePerS: 1e6, rateBurst: 1e6 });
  try {
    const { eq, put, cGet, cPost, hubGet, hubPost, mkTok, chan } = t;
    const c = mkTok();
    await put([c]);
    let ch = chan();
    await cGet(c, ch);
    for (let i = 0; i < 9; i++) await hubPost(Array.from({ length: 64 }, () => ({ ch, c: "E".repeat(30) })));
    let all = [], after = 0, head = 0;
    for (let i = 0; i < 5; i++) {
      const r = await cGet(c, ch, after, 0);
      if (!r.j.frames.length) break;
      assert.ok(r.j.frames.length <= 256);
      all = all.concat(r.j.frames); after = all[all.length - 1].seq; head = r.j.head;
    }
    assert.ok(all.length === 512 && all[0].seq === 65 && head === 576, `channel queue keeps newest 512: ${all.length} ${all[0].seq} ${head}`);
    eq("page size", (await cGet(c, ch, 0, 0)).j.frames.length, 256);

    // hub queue: 1024 frames
    const t2 = await boot({ inflight: 1000, inflightPerIp: 1000, ratePerS: 1e6, rateBurst: 1e6 });
    try {
      const c2 = t2.mkTok();
      await t2.put([c2]);
      const ch2 = t2.chan();
      for (let i = 0; i < 69; i++) await t2.cPost(c2, ch2, Array.from({ length: 16 }, () => "F".repeat(30)));
      let got = [], aft = 0, hd = 0;
      for (let i = 0; i < 6; i++) {
        const r = await t2.hubGet(aft, 0);
        if (!r.j.frames.length) break;
        got = got.concat(r.j.frames); aft = got[got.length - 1].seq; hd = r.j.head;
      }
      assert.ok(got.length === 1024 && got[0].seq === 81 && hd === 1104, `hub queue keeps newest 1024: ${got.length} ${got[0].seq} ${hd}`);
    } finally { await t2.close(); }

    // hub queue: 16 MB, and replies paged under the 3 MB cap
    const t3 = await boot({ inflight: 1000, inflightPerIp: 1000, ratePerS: 1e6, rateBurst: 1e6 });
    try {
      const c3 = t3.mkTok();
      await t3.put([c3]);
      const ch3 = t3.chan();
      const big = "G".repeat(44000);
      for (let i = 0; i < 30; i++) await t3.cPost(c3, ch3, Array.from({ length: 16 }, () => big));
      let n = 0, aft = 0, hd = 0, maxReply = 0, contiguous = true, pages = 0;
      for (let i = 0; i < 40; i++) {
        const r = await t3.hubGet(aft, 0);
        if (!r.j.frames.length) break;
        pages++;
        maxReply = Math.max(maxReply, r.text.length);
        for (const f of r.j.frames) { if (n && f.seq !== aft + 1) contiguous = false; aft = f.seq; n++; }
        hd = r.j.head;
      }
      assert.ok(n <= Math.floor((16 * 1024 * 1024) / 44000) && n > 300 && hd === 480, `16 MB cap: kept ${n}, head ${hd}`);
      assert.ok(maxReply < 3_000_000 && pages > 1, `replies paged: max ${maxReply} over ${pages}`);
      assert.ok(contiguous);
    } finally { await t3.close(); }

    // hub -> phone: channel byte cap (LAN hardening), oldest dropped, replies under the cap
    const t4 = await boot({ inflight: 1000, inflightPerIp: 1000, ratePerS: 1e6, rateBurst: 1e6 });
    try {
      const c4 = t4.mkTok();
      await t4.put([c4]);
      ch = t4.chan();
      await t4.cGet(c4, ch);
      const big = "H".repeat(44000);
      for (let i = 0; i < 6; i++) await t4.hubPost(Array.from({ length: 64 }, () => ({ ch, c: big }))); // ~17 MB offered
      let n = 0, aft = 0, hd = 0, maxReply = 0;
      for (let i = 0; i < 60; i++) {
        const r = await t4.cGet(c4, ch, aft, 0);
        if (!r.j.frames.length) break;
        maxReply = Math.max(maxReply, r.text.length);
        for (const f of r.j.frames) { aft = f.seq; n++; }
        hd = r.j.head;
      }
      assert.ok(n * 44000 <= 8 * 1024 * 1024 + 44064 && n > 100 && hd === 384, `channel byte cap: kept ${n}, head ${hd}`);
      assert.ok(maxReply < 3_000_000);
    } finally { await t4.close(); }
  } finally { await t.close(); }
});

test("rate limiting (per token hash), refill by clock", async () => {
  const t = await boot({ inflight: 1000, inflightPerIp: 1000 });
  try {
    const { eq, put, hubGet, cGet, mkTok, chan, clock } = t;
    const c = mkTok();
    await put([c]);
    const rs = await Promise.all(Array.from({ length: 200 }, () => hubGet(0, 0)));
    const n200 = rs.filter((r) => r.status === 200).length, n429 = rs.filter((r) => r.status === 429);
    assert.ok(n200 >= 55 && n200 <= 115 && n429.length >= 85, `burst passes, rest 429 (200s=${n200})`);
    assert.ok(n429.every((r) => /^\d+$/.test(r.h.get("retry-after") || "") && Number(r.h.get("retry-after")) >= 1));
    clock.off += 3200;
    eq("refilled", (await hubGet(0, 0)).status, 200);
    const ch = chan();
    const rc = await Promise.all(Array.from({ length: 150 }, () => cGet(c, ch, 0, 0)));
    const c200 = rc.filter((r) => r.status === 200).length;
    assert.ok(c200 >= 50 && c200 <= 115 && rc.some((r) => r.status === 429), `client bucket (200s=${c200})`);
  } finally { await t.close(); }
});

test("failed-auth lockout keys on the socket address, not on headers", async () => {
  const t = await boot();
  try {
    const { eq, put, cGet, call, mkTok, chan, R, room } = t;
    const c = mkTok();
    await put([c]);
    const ip = "203.0.113.77", stranger = mkTok();
    const st = [];
    for (let i = 0; i < 30; i++) st.push((await cGet(stranger, chan(), 0, 0, { ip })).status);
    assert.ok(st.every((s) => s === 401), st.join());
    let last = await cGet(stranger, chan(), 0, 0, { ip });
    assert.ok(last.status === 429 && Number(last.h.get("retry-after")) >= 1);
    // N3: the lockout answers only tokens that are WRONG; a valid token is checked first and keeps working.
    eq("a valid token from that address is still served while locked", (await cGet(c, chan(), 0, 0, { ip })).status, 200);
    eq("a wrong token from that address is 429", (await cGet(mkTok(), chan(), 0, 0, { ip })).status, 429);
    eq("a valid hub token still works too", (await call("PUT", R(), { token: room.hubToken, json: { v: 1, clients: [c] }, ip })).status, 200);
    eq("a wrong hub token is 429", (await call("PUT", R(), { token: "afth_" + b64u(crypto.randomBytes(32)), json: { v: 1, clients: [] }, ip })).status, 429);
    eq("another address is unaffected", (await cGet(c, chan(), 0, 0, { ip: "203.0.113.78" })).status, 200);
    // X-Forwarded-For is never read: spoofing it does not change who the caller is
    const res = await fetch(t.base + R(`/client?ch=${chan()}`), { headers: { authorization: `Bearer ${mkTok().t}`, "x-forwarded-for": "9.9.9.9", "x-test-ip": ip } });
    eq("XFF cannot dodge the lock", res.status, 429);
    await res.text();
    const ip2 = "203.0.113.79";
    for (let i = 0; i < 30; i++) await t.put([], { token: "afth_" + b64u(crypto.randomBytes(32)), ip: ip2 });
    eq("wrong hub tokens lock the address out (for wrong tokens)", (await t.put([], { token: "afth_" + b64u(crypto.randomBytes(32)), ip: ip2 })).status, 429);
    eq("the right hub token is not locked out", (await t.put([c], { ip: ip2 })).status, 200);
    // lockout expires with the minute
    t.clock.off += 61_000;
    eq("lock lifts", (await cGet(c, chan(), 0, 0, { ip })).status, 200);
  } finally { await t.close(); }
});

test("CORS: exact origins only, never *", async () => {
  const t = await boot();
  try {
    const { call, eq, put, cGet, cPost, hubGet, mkTok, mkFrame, chan, R } = t;
    const c = mkTok();
    await put([c]);
    const ch = chan();
    for (const origin of ["https://localhost", "capacitor://localhost"]) {
      const r = await call("OPTIONS", R("/client"), { origin, acrm: "POST" });
      const hd = (k) => r.h.get(k);
      assert.ok(r.status === 204 && hd("access-control-allow-origin") === origin && hd("access-control-allow-methods") === "GET, POST, OPTIONS" &&
        hd("access-control-allow-headers") === "Authorization, Content-Type" && hd("access-control-max-age") === "600" && /Origin/.test(hd("vary") || ""), origin);
    }
    eq("preflight needs no auth and no room", (await call("OPTIONS", `/api/tunnel/room/${"A".repeat(43)}/client`, { origin: "https://localhost", acrm: "GET" })).status, 204);
    for (const origin of ["https://evil.example", "http://localhost", "https://localhost.evil.com", "https://localhost:8443", "null", "capacitor://evil", "*"]) {
      const r = await call("OPTIONS", R("/client"), { origin, acrm: "GET" });
      assert.ok(r.status === 403 && !r.h.get("access-control-allow-origin"), origin);
    }
    let r = await call("OPTIONS", R("/client"), { acrm: "GET" });
    assert.ok(r.status === 403 && !r.h.get("access-control-allow-origin"));
    r = await call("OPTIONS", R("/client"), { origin: "https://localhost", acrm: "DELETE" });
    assert.ok(r.status === 405 && !r.h.get("access-control-allow-origin"));
    const o = "https://localhost";
    r = await cGet(c, ch, 0, 0, { origin: o });
    assert.ok(r.status === 200 && r.h.get("access-control-allow-origin") === o && /Origin/.test(r.h.get("vary") || ""));
    assert.strictEqual(r.h.get("access-control-expose-headers"), "Retry-After");
    r = await cGet(mkTok(), ch, 0, 0, { origin: o, ip: "198.51.100.40" });
    assert.ok(r.status === 401 && r.h.get("access-control-allow-origin") === o);
    r = await cPost(c, "bad", [mkFrame()], { origin: o });
    assert.ok(r.status === 400 && r.h.get("access-control-allow-origin") === o);
    r = await cGet(c, ch, 0, 0, { origin: "https://evil.example" });
    assert.ok(!r.h.get("access-control-allow-origin") && r.h.get("vary") !== null);
    r = await hubGet(0, 0, { origin: o });
    assert.ok(!r.h.get("access-control-allow-origin") && !r.h.get("access-control-allow-methods"));
    r = await call("HEAD", R("/client"), { origin: o });
    assert.ok(r.status === 405 && r.h.get("access-control-allow-origin") === o);
  } finally { await t.close(); }
});

test("hub offline: 45 s without a hub request", async () => {
  const t = await boot();
  try {
    const { eq, put, cGet, cPost, hubGet, hubPost, mkTok, mkFrame, chan, clock } = t;
    const a = mkTok(), b = mkTok();
    await put([a, b]);
    const ch = chan(), chNew = chan(), chB = chan();
    const before = mkFrame();
    eq("hub fresh: POST works", (await cPost(a, ch, [before])).status, 200);
    await cGet(b, chB);
    clock.off += 46_500;
    let r = await cPost(a, ch, [mkFrame()]);
    assert.ok(r.status === 409 && r.j.error === "the computer is offline", r.text);
    eq("409 for a brand-new channel too", (await cPost(a, chNew, [mkFrame()])).status, 409);
    eq("a channel of another token is 403 first", (await cPost(a, chB, [mkFrame()])).status, 403);
    r = await cGet(a, ch, 0, 0);
    assert.ok(r.status === 200 && r.j.online === false, r.text);
    r = await hubGet(0, 0);
    assert.ok(r.j.frames.length === 1 && r.j.frames[0].c === before, "nothing stored by the refused POSTs");
    eq("the refused POST did not bind its channel", (await hubPost([{ ch: chNew, c: mkFrame() }])).j.accepted, 0);
    eq("hub back: POST works", (await cPost(a, ch, [mkFrame()])).status, 200);
    eq("online again", (await cGet(a, ch, 0, 0)).j.online, true);
  } finally { await t.close(); }
});

test("a small connection budget: floods get 429, other addresses are served", async () => {
  const t = await boot({ inflight: 6, inflightPerIp: 3 });
  try {
    const { eq, put, cGet, mkTok, chan } = t;
    const c = mkTok();
    await put([c]);
    const ip = "10.7.7.7";
    const polls = Array.from({ length: 3 }, () => cGet(c, chan(), 0, 2, { ip }));
    await sleep(150);
    const r = await cGet(c, chan(), 0, 0, { ip });
    assert.ok(r.status === 429 && Number(r.h.get("retry-after")) >= 1, "4th concurrent request from one address");
    eq("another address still served", (await cGet(c, chan(), 0, 0, { ip: "10.8.8.8" })).status, 200);
    await Promise.all(polls);
    eq("budget frees up", (await cGet(c, chan(), 0, 0, { ip })).status, 200);
    assert.strictEqual(t.mb.stats().inflight, 0);
  } finally { await t.close(); }
});

test("a stalled body is dropped by the idle deadline", async () => {
  const t = await boot({ bodyIdleMs: 300 });
  try {
    const net = require("node:net");
    const port = Number(new URL(t.base).port);
    const out = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(`PUT /api/tunnel/room/${t.room.roomId} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${t.room.hubToken}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"v"`);
      });
      let buf = "";
      s.on("data", (d) => { buf += d; });
      s.on("close", () => resolve(buf));
      setTimeout(() => { s.destroy(); resolve(buf + "|timeout"); }, 3000);
    });
    assert.ok(!out.endsWith("|timeout"), "the socket was closed by the hub");
    assert.strictEqual(t.mb.stats().inflight, 0);
  } finally { await t.close(); }
});

test("blind and bounded: no raw token stored, timer unref'd, close() releases", async () => {
  const t = await boot();
  try {
    const { put, cPost, mkTok, mkFrame, chan, mb, tokens } = t;
    const c = mkTok();
    await put([c]);
    await cPost(c, chan(), [mkFrame()]);
    const dump = mb._dump();
    for (const tk of tokens) assert.ok(!dump.includes(tk) && !dump.includes(tk.slice(5)), "no raw token in the mailbox");
    assert.ok(dump.includes(tokenHash(c.t)), "token hashes only");
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(dump), "no addresses");
  } finally { await t.close(); }
  // createLanRelay alone must not keep the process alive
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, ["-e", `const m=require(${JSON.stringify(require.resolve("../lib/hub/lanrelay"))}).createLanRelay({roomId:"A".repeat(43)});`], { timeout: 5000 });
});

test("N4: without serveHub the room PUT and the /hub endpoints answer 404 and change nothing", async () => {
  const t = await boot(undefined, { serveHub: false });
  try {
    const { room, call, eq, R, mkTok, mb } = t;
    const c = mkTok();
    mb.local.putRoom([{ h: c.h }]);
    const before = mb.allowlistSig ? null : mb.local.allowlistSig();
    eq("PUT with the hub token", (await call("PUT", R(), { token: room.hubToken, json: { v: 1, clients: [] } })).status, 404);
    eq("hub GET", (await call("GET", R("/hub?after=0&wait=0"), { token: room.hubToken })).status, 404);
    eq("hub POST", (await call("POST", R("/hub"), { token: room.hubToken, json: { frames: [] } })).status, 404);
    eq("no token at all", (await call("PUT", R(), { json: { v: 1, clients: [] } })).status, 404);
    eq("allowlist unchanged", mb.local.allowlistSig(), before);
    assert.ok(mb.local.allowlistSig().includes(c.h));
    // the phone side still works
    eq("client poll", (await t.cGet(c, t.chan(), 0, 0)).status, 200);
  } finally { await t.close(); }
});

test("N3: junk from the phone's own address (tokenless, unknown paths) neither locks nor throttles a valid token", async () => {
  const t = await boot();
  try {
    const { eq, put, cGet, call, mkTok, chan } = t;
    const c = mkTok();
    await put([c]);
    const ip = "198.51.100.200";
    for (let i = 0; i < 80; i++) await call("GET", "/api/tunnel/x", { ip });                    // no token, unknown path
    for (let i = 0; i < 80; i++) await call("GET", `/api/tunnel/room/${t.room.roomId}/client?ch=${chan()}`, { ip }); // no token, known path
    for (let i = 0; i < 5; i++) eq("valid token after junk", (await cGet(c, chan(), 0, 0, { ip })).status, 200);
    // unknown path WITH a token is a plain 404 and counts nothing either
    for (let i = 0; i < 40; i++) eq("unknown path 404", (await call("GET", "/api/tunnel/x", { ip, token: c.t })).status, 404);
    eq("still valid", (await cGet(c, chan(), 0, 0, { ip })).status, 200);
  } finally { await t.close(); }
});
