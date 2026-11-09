// Tests for the hub's HTTP server. Real HTTP on 127.0.0.1 port 0, with small
// in-test fakes for auth and supervisor so this file depends on neither
// lib/hub/auth.js nor lib/hub/supervisor.js. The cookie helpers are injected too,
// so the contract-level behaviour of server.js is what is under test.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createHubServer, isPrivateAddress } = require("../lib/hub/server");

const helpers = {
  cookieName: () => "sid",
  cookieHeader: (t, { maxAgeSec }) => `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`,
  clearCookieHeader: () => "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  parseCookies: (v) => Object.fromEntries(String(v || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0])),
  checkCsrf: (s, h) => !!s && typeof h === "string" && s.csrf === h,
};

function fakeAuth() {
  const sessions = new Map(); // token -> {user, session, csrf}
  let n = 0;
  return {
    sessions,
    hasAccounts: () => true,
    async login({ username, password }) {
      if (username === "locked") return { ok: false, code: "LOCKED", retryAfterMs: 2500 };
      if (username !== "alice" || password !== "correct-horse-1") return { ok: false, code: "BAD_CREDENTIALS" };
      const token = "tok" + ++n, csrf = "csrf" + n;
      sessions.set(token, { user: { username, role: "owner" }, session: { id: "s" + n }, csrf });
      return { ok: true, token, csrf, session: { id: "s" + n } };
    },
    authenticate: (t) => sessions.get(t) || null,
    logout: (t) => sessions.delete(t),
    listSessions: () => [...sessions.values()].map((s) => ({ id: s.session.id, device: "d", ip: "1.2.3.4", created: 1, lastSeen: 2, current: false })),
    revokeSession: (u, id) => {
      for (const [t, s] of sessions) if (s.session.id === id) return sessions.delete(t), true;
      return false;
    },
    revokeAll: () => 0,
  };
}

function fakeSupervisor() {
  const sup = new EventEmitter();
  sup.agents = { a1: { id: "a1", name: "one", status: "stopped" } };
  sup.hist = [1, 2, 3].map((seq) => ({ agentId: "a1", seq, t: 0, type: "delta", kind: "content", text: "t" + seq }));
  sup.list = () => Object.values(sup.agents);
  sup.get = (id) => sup.agents[id] || null;
  sup.history = (id, after = 0) => sup.hist.filter((e) => e.agentId === id && e.seq > after);
  sup.create = async (o) => {
    if (o.cwd === "/bad") throw Object.assign(new Error("cwd /secret/path not allowed"), { code: "BAD_CWD" });
    return { id: "a2", ...o };
  };
  sup.wake = async () => { throw Object.assign(new Error("busy"), { code: "BUSY" }); };
  sup.start = async () => { throw Object.assign(new Error("x"), { code: "NOT_FOUND" }); };
  sup.stop = async () => { const e = new Error("boom at /home/user/secret.js"); e.stack = "STACKTRACE /home/user/secret.js"; throw e; };
  sup.approve = () => true;
  sup.remove = () => {};
  return sup;
}

let uiDir;
test.before(() => {
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "hubui-"));
  fs.writeFileSync(path.join(uiDir, "index.html"), "<h1>hub</h1>");
  fs.writeFileSync(path.join(uiDir, "app.js"), "//app");
  fs.writeFileSync(path.join(uiDir, "auth.json"), '{"secret":true}');
  fs.writeFileSync(path.join(path.dirname(uiDir), "hubui-outside.txt"), "outside");
});
test.after(() => fs.rmSync(uiDir, { recursive: true, force: true }));

async function start(extra = {}) {
  const auth = fakeAuth(), supervisor = fakeSupervisor();
  const hub = createHubServer({
    auth, supervisor, uiDir, helpers,
    models: () => [{ id: "m", size: 1 }],
    config: { heartbeatMs: 40, ...extra.config },
    ...extra.opts,
  });
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  return { auth, supervisor, hub, port, close: () => hub.close() };
}

function req(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function login(s) {
  const r = await req(s.port, {
    method: "POST", path: "/api/login",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "correct-horse-1" }),
  });
  assert.strictEqual(r.status, 200);
  const cookie = r.headers["set-cookie"][0].split(";")[0];
  return { cookie, csrf: r.json.csrf, r };
}

const jsonPost = (s, a, p, body, extra = {}) => req(s.port, {
  method: "POST", path: p,
  headers: { "Content-Type": "application/json", Cookie: a.cookie, "X-CSRF-Token": a.csrf, ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("isPrivateAddress accepts loopback/private and rejects public, incl. mapped forms", () => {
  for (const ok of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "169.254.1.1",
    "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1",
    "::ffff:127.0.0.1", "::ffff:192.168.0.9", "::ffff:10.0.0.1", "::ffff:c0a8:0101", "::FFFF:A00:1"]) {
    assert.strictEqual(isPrivateAddress(ok), true, ok);
  }
  for (const bad of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "11.0.0.1", "100.64.0.1",
    "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808", "fec0::1", "fbff::1", "::", "::2",
    "", "garbage", "999.1.1.1", undefined, null, 42]) {
    assert.strictEqual(isPrivateAddress(bad), false, String(bad));
  }
});

test("public remote address is refused unless allowRemote", async () => {
  const s = await start({ opts: { getRemoteAddress: () => "8.8.8.8" } });
  const r = await req(s.port, { path: "/api/status" });
  assert.strictEqual(r.status, 403);
  assert.ok(r.headers["content-security-policy"]);
  await s.close();
  const s2 = await start({ opts: { getRemoteAddress: () => "8.8.8.8" }, config: { allowRemote: true } });
  assert.strictEqual((await req(s2.port, { path: "/api/status" })).status, 200);
  await s2.close();
});

test("X-Forwarded-For is ignored by the address gate", async () => {
  const s = await start({ opts: { getRemoteAddress: () => "8.8.8.8" } });
  const r = await req(s.port, { path: "/api/status", headers: { "X-Forwarded-For": "127.0.0.1" } });
  assert.strictEqual(r.status, 403);
  await s.close();
});

test("Host allowlist: 421 for foreign hosts, ok for localhost/IP/.local/allowedHosts", async () => {
  const s = await start({ config: { allowedHosts: ["hub.example.org"] } });
  const get = (host) => req(s.port, { path: "/api/status", headers: { Host: host } });
  assert.strictEqual((await get("evil.example")).status, 421);
  assert.strictEqual((await get("evil.example:80")).status, 421);
  assert.strictEqual((await get("localhost:8080")).status, 200);
  assert.strictEqual((await get("192.168.1.2:8080")).status, 200);
  assert.strictEqual((await get("[::1]:8080")).status, 200);
  assert.strictEqual((await get("my-box.local")).status, 200);
  assert.strictEqual((await get("hub.example.org")).status, 200);
  assert.strictEqual((await get("local")).status, 421);
  // A public IP literal is not "your own network": refused unless remote access is on or it is listed.
  assert.strictEqual((await get("8.8.8.8:8080")).status, 421);
  assert.strictEqual((await get("[2001:4860:4860::8888]:8080")).status, 421);
  assert.strictEqual((await get("10.1.2.3:8080")).status, 200);
  assert.strictEqual((await get("172.20.0.4")).status, 200);
  await s.close();
  const remote = await start({ config: { allowRemote: true } });
  assert.strictEqual((await req(remote.port, { path: "/api/status", headers: { Host: "8.8.8.8:8080" } })).status, 200);
  await remote.close();
  const listed = await start({ config: { allowedHosts: ["203.0.113.9"] } });
  assert.strictEqual((await req(listed.port, { path: "/api/status", headers: { Host: "203.0.113.9:8080" } })).status, 200);
  await listed.close();
});

test("a model server that will not start is a 503 with fixed wording, not a bare 500", async () => {
  const s = await start();
  s.supervisor.start = async () => { throw Object.assign(new Error("llama-server did not come up /home/u/secret"), { code: "SERVER_DOWN" }); };
  const a = await login(s);
  const r = await jsonPost(s, a, "/api/agents/a1/start", {});
  assert.strictEqual(r.status, 503);
  assert.match(r.text, /model server/i);
  assert.ok(!/secret/.test(r.text), "no raw error text");
  await s.close();
});

test("security headers on api, static and errors; never any Access-Control-*", async () => {
  const s = await start();
  for (const p of ["/api/status", "/", "/nope", "/api/agents"]) {
    const r = await req(s.port, { path: p, headers: { Origin: "http://evil.example" } });
    assert.match(r.headers["content-security-policy"], /default-src 'none'.*frame-ancestors 'none'; base-uri 'none'/);
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    assert.strictEqual(r.headers["referrer-policy"], "no-referrer");
    assert.strictEqual(r.headers["x-frame-options"], "DENY");
    assert.strictEqual(r.headers["cross-origin-resource-policy"], "same-origin");
    if (p.startsWith("/api")) assert.strictEqual(r.headers["cache-control"], "no-store");
    assert.deepStrictEqual(Object.keys(r.headers).filter((h) => h.startsWith("access-control-")), [], p);
  }
  const pre = await req(s.port, { method: "OPTIONS", path: "/api/agents", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.deepStrictEqual(Object.keys(pre.headers).filter((h) => h.startsWith("access-control-")), []);
  await s.close();
});

test("unauthenticated api is 401; /api/status is open and minimal", async () => {
  const s = await start();
  for (const p of ["/api/agents", "/api/me", "/api/models", "/api/sessions", "/api/events", "/api/agents/a1/events"]) {
    assert.strictEqual((await req(s.port, { path: p })).status, 401, p);
  }
  const st = await req(s.port, { path: "/api/status" });
  assert.deepStrictEqual(st.json, { setup: true });
  await s.close();
});

test("login: 200 sets HttpOnly strict cookie, 401 generic, 429 with Retry-After", async () => {
  const s = await start();
  const a = await login(s);
  assert.match(a.r.headers["set-cookie"][0], /HttpOnly/);
  assert.match(a.r.headers["set-cookie"][0], /SameSite=Strict/);
  assert.deepStrictEqual(a.r.json.user, { username: "alice", role: "owner" });
  assert.ok(a.csrf);
  const me = await req(s.port, { path: "/api/me", headers: { Cookie: a.cookie } });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.csrf, a.csrf);

  const j = { "Content-Type": "application/json" };
  const bad = await req(s.port, { method: "POST", path: "/api/login", headers: j, body: JSON.stringify({ username: "alice", password: "nope" }) });
  const unk = await req(s.port, { method: "POST", path: "/api/login", headers: j, body: JSON.stringify({ username: "zed", password: "nope" }) });
  assert.strictEqual(bad.status, 401);
  assert.deepStrictEqual(bad.json, { error: "Wrong username or password" });
  assert.deepStrictEqual(unk.json, bad.json);
  assert.strictEqual(bad.headers["set-cookie"], undefined);

  const lk = await req(s.port, { method: "POST", path: "/api/login", headers: j, body: JSON.stringify({ username: "locked", password: "x" }) });
  assert.strictEqual(lk.status, 429);
  assert.strictEqual(lk.headers["retry-after"], "3");
  assert.strictEqual(lk.json.retryAfterSec, 3);
  assert.ok(lk.json.error);

  const cross = await req(s.port, { method: "POST", path: "/api/login", headers: { ...j, Origin: "http://evil.example" }, body: "{}" });
  assert.strictEqual(cross.status, 403);
  await s.close();
});

test("CSRF: required on POST (missing/wrong -> 403), ok when right", async () => {
  const s = await start();
  const a = await login(s);
  const h = { "Content-Type": "application/json", Cookie: a.cookie };
  const none = await req(s.port, { method: "POST", path: "/api/agents/a1/stop", headers: h, body: "{}" });
  assert.strictEqual(none.status, 403);
  const wrong = await req(s.port, { method: "POST", path: "/api/agents/a1/stop", headers: { ...h, "X-CSRF-Token": "nope" }, body: "{}" });
  assert.strictEqual(wrong.status, 403);
  const noCookie = await req(s.port, { method: "POST", path: "/api/agents", headers: { "Content-Type": "application/json", "X-CSRF-Token": a.csrf }, body: "{}" });
  assert.strictEqual(noCookie.status, 401);
  const del = await req(s.port, { method: "DELETE", path: "/api/agents/a1", headers: { Cookie: a.cookie } });
  assert.strictEqual(del.status, 403);
  const ok = await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: true });
  assert.strictEqual(ok.status, 200);
  await s.close();
});

test("Origin must match Host when present", async () => {
  const s = await start();
  const a = await login(s);
  const host = `127.0.0.1:${s.port}`;
  const bad = await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: true }, { Origin: "http://evil.example" });
  assert.strictEqual(bad.status, 403);
  const nul = await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: true }, { Origin: "null" });
  assert.strictEqual(nul.status, 403);
  const https = await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: true }, { Origin: `https://${host}` });
  assert.strictEqual(https.status, 403);
  const good = await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: true }, { Origin: `http://${host}` });
  assert.strictEqual(good.status, 200);
  await s.close();
});

test("non-JSON content type is 415; malformed JSON 400; oversized body 413", async () => {
  const s = await start();
  const a = await login(s);
  const base = { Cookie: a.cookie, "X-CSRF-Token": a.csrf };
  const t = await req(s.port, { method: "POST", path: "/api/agents", headers: { ...base, "Content-Type": "text/plain" }, body: "{}" });
  assert.strictEqual(t.status, 415);
  const f = await req(s.port, { method: "POST", path: "/api/agents", headers: { ...base, "Content-Type": "application/x-www-form-urlencoded" }, body: "a=b" });
  assert.strictEqual(f.status, 415);
  const bad = await req(s.port, { method: "POST", path: "/api/agents", headers: { ...base, "Content-Type": "application/json" }, body: "{nope" });
  assert.strictEqual(bad.status, 400);
  const big = await req(s.port, {
    method: "POST", path: "/api/agents",
    headers: { ...base, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", cwd: "/tmp", task: "y".repeat(70 * 1024) }),
  });
  assert.strictEqual(big.status, 413);
  const edge = await req(s.port, {
    method: "POST", path: "/api/agents",
    headers: { ...base, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ name: "x", cwd: "/tmp", task: "y".repeat(60 * 1024) }),
  });
  assert.strictEqual(edge.status, 201);
  await s.close();
});

test("static allowlist: serves ui files, never leaks traversal/auth.json, unknown 404", async () => {
  const s = await start();
  const idx = await req(s.port, { path: "/" });
  assert.strictEqual(idx.status, 200);
  assert.match(idx.headers["content-type"], /text\/html/);
  assert.strictEqual(idx.text, "<h1>hub</h1>");
  const js = await req(s.port, { path: "/app.js" });
  assert.match(js.headers["content-type"], /javascript/);
  assert.strictEqual((await req(s.port, { path: "/style.css" })).status, 404); // allowed name, file absent
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/%2e%2e/", "/auth.json", "/..%2fhubui-outside.txt",
    "/app.js/../auth.json", "//auth.json", "/index.html%00.png", "/.", "/nope.txt", "/%2e%2e%2fauth.json", "/ui/auth.json"]) {
    const r = await req(s.port, { path: p });
    assert.strictEqual(r.status, 404, p);
    assert.ok(!/secret|outside|"name"/.test(r.text), p);
  }
  const post = await req(s.port, { method: "POST", path: "/", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.strictEqual(post.status, 404);
  await s.close();
});

test("static assets: fonts and images are served with the right type; near-miss paths 404", async () => {
  const assets = {
    "/assets/bitcount-single.ttf": "font/ttf",
    "/assets/geist-latin.woff2": "font/woff2",
    "/assets/geist-mono-latin.woff2": "font/woff2",
    "/assets/mascot-light.png": "image/png",
    "/assets/mascot-dark.png": "image/png",
    "/assets/panda-search.png": "image/png",
  };
  fs.mkdirSync(path.join(uiDir, "assets"), { recursive: true });
  for (const p of Object.keys(assets)) fs.writeFileSync(path.join(uiDir, p.slice(1)), "bytes:" + p);
  const s = await start();
  for (const [p, type] of Object.entries(assets)) {
    const r = await req(s.port, { path: p });
    assert.strictEqual(r.status, 200, p);
    assert.strictEqual(r.headers["content-type"], type, p);
    assert.strictEqual(r.text, "bytes:" + p);
    assert.match(r.headers["content-security-policy"], /font-src 'self'/);
  }
  for (const p of ["/assets/", "/assets", "/assets/../auth.json", "/assets/%2e%2e/auth.json", "/assets/..%2fauth.json",
    "/assets/mascot-light.png/../../auth.json", "/assets//mascot-light.png", "/assets/mascot-light.PNG",
    "/assets/mascot-light.png%00.txt", "/assets/other.png", "/%2e%2e/assets/mascot-light.png/../../hubui-outside.txt"]) {
    const r = await req(s.port, { path: p });
    assert.strictEqual(r.status, 404, p);
    assert.ok(!/secret|outside|bytes:/.test(r.text), p);
  }
  await s.close();
});

// Minimal SSE client: collects raw text until `until(text)` or timeout.
function sse(port, p, headers, until, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, headers, agent: false }, (res) => {
      let text = "";
      const done = () => { clearTimeout(t); resolve({ res, text, destroy: () => r.destroy() }); };
      const t = setTimeout(done, timeoutMs);
      res.on("data", (c) => { text += c; if (until(text)) done(); });
      res.on("error", () => {});
      if (res.statusCode !== 200) res.on("end", done);
    });
    r.on("error", reject);
    r.end();
  });
}
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return fn();
};

test("SSE replays history after N, streams live events, heartbeats, and cleans up on disconnect", async () => {
  const s = await start();
  const a = await login(s);
  const c = await sse(s.port, "/api/agents/a1/events?after=1", { Cookie: a.cookie }, (t) => t.includes(": hb"));
  assert.strictEqual(c.res.statusCode, 200);
  assert.match(c.res.headers["content-type"], /text\/event-stream/);
  assert.match(c.text, /id: 2\n/);
  assert.match(c.text, /id: 3\n/);
  assert.ok(!/id: 1\n/.test(c.text));
  assert.ok(c.text.includes(": hb"));
  assert.strictEqual(s.supervisor.listenerCount("event"), 1);

  const live = await new Promise((resolve) => {
    let text = "";
    c.res.on("data", (d) => { text += d; if (text.includes("live-one")) resolve(text); });
    s.supervisor.emit("event", { agentId: "a2", seq: 1, type: "delta", text: "other-agent" });
    s.supervisor.emit("event", { agentId: "a1", seq: 4, type: "delta", text: "live-one" });
  });
  assert.ok(live.includes("id: 4"));
  assert.ok(!live.includes("other-agent"));

  c.destroy();
  assert.ok(await waitFor(() => s.supervisor.listenerCount("event") === 0), "listener removed after disconnect");
  await s.close();
});

test("SSE honours Last-Event-ID and 404s an unknown agent", async () => {
  const s = await start();
  const a = await login(s);
  const c = await sse(s.port, "/api/agents/a1/events", { Cookie: a.cookie, "Last-Event-ID": "2" }, (t) => t.includes("id: 3"));
  assert.ok(!/id: [12]\n/.test(c.text) && c.text.includes("id: 3"));
  c.destroy();
  const nf = await req(s.port, { path: "/api/agents/zzz/events", headers: { Cookie: a.cookie } });
  assert.strictEqual(nf.status, 404);
  await s.close();
});

test("SSE closes when the session is revoked", async () => {
  const s = await start();
  const a = await login(s);
  const c = await sse(s.port, "/api/events", { Cookie: a.cookie }, (t) => t.includes("retry:"));
  const ended = new Promise((r) => c.res.on("end", () => r(true)));
  s.auth.sessions.clear();
  assert.strictEqual(await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 1000))]), true);
  assert.ok(await waitFor(() => s.supervisor.listenerCount("event") === 0));
  await s.close();
});

test("/api/events forwards only dashboard event types", async () => {
  const s = await start();
  const a = await login(s);
  const c = await sse(s.port, "/api/events", { Cookie: a.cookie }, () => false, 150);
  const got = new Promise((resolve) => {
    let t = "";
    c.res.on("data", (d) => { t += d; if (t.includes("approval")) resolve(t); });
  });
  s.supervisor.emit("event", { agentId: "a1", seq: 9, type: "delta", text: "noisy" });
  s.supervisor.emit("event", { agentId: "a1", seq: 10, type: "approval", id: "p1" });
  const t = await got;
  assert.ok(!t.includes("noisy"));
  c.destroy();
  await s.close();
});

test("supervisor errors map by code; nothing leaks", async () => {
  const s = await start();
  const a = await login(s);
  const bad = await jsonPost(s, a, "/api/agents", { name: "n", cwd: "/bad" });
  assert.strictEqual(bad.status, 400);
  assert.ok(!bad.text.includes("/secret"));
  const busy = await jsonPost(s, a, "/api/agents/a1/wake", { text: "hi" });
  assert.strictEqual(busy.status, 409);
  const nf = await jsonPost(s, a, "/api/agents/a1/start", {});
  assert.strictEqual(nf.status, 404);
  const boom = await jsonPost(s, a, "/api/agents/a1/stop", {});
  assert.strictEqual(boom.status, 500);
  assert.deepStrictEqual(boom.json, { error: "Internal error" });
  assert.ok(!/STACKTRACE|secret|home\/user|boom/.test(boom.text));
  assert.strictEqual((await jsonPost(s, a, "/api/agents/nope/stop", {})).status, 404);
  assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "n", cwd: "/tmp", tier: "ultra" })).status, 400);
  assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: "yes" })).status, 400);
  await s.close();
});

test("sessions: list flags current, revoke, logout clears cookie", async () => {
  const s = await start();
  const a = await login(s);
  const b = await login(s);
  const list = await req(s.port, { path: "/api/sessions", headers: { Cookie: a.cookie } });
  assert.strictEqual(list.json.length, 2);
  assert.deepStrictEqual(list.json.map((x) => x.current), [true, false]);
  assert.ok(!/tok\d|csrf\d/.test(list.text));
  const rev = await req(s.port, { method: "DELETE", path: "/api/sessions/s2", headers: { Cookie: a.cookie, "X-CSRF-Token": a.csrf } });
  assert.strictEqual(rev.status, 200);
  assert.strictEqual((await req(s.port, { path: "/api/me", headers: { Cookie: b.cookie } })).status, 401);
  const out = await jsonPost(s, a, "/api/logout");
  assert.strictEqual(out.status, 200);
  assert.match(out.headers["set-cookie"][0], /Max-Age=0/);
  assert.strictEqual((await req(s.port, { path: "/api/me", headers: { Cookie: a.cookie } })).status, 401);
  await s.close();
});

test("models and agents list pass through", async () => {
  const s = await start();
  const a = await login(s);
  assert.deepStrictEqual((await req(s.port, { path: "/api/models", headers: { Cookie: a.cookie } })).json, [{ id: "m", size: 1 }]);
  const ag = await req(s.port, { path: "/api/agents", headers: { Cookie: a.cookie } });
  assert.strictEqual(ag.json[0].id, "a1");
  assert.strictEqual((await req(s.port, { path: "/api/agents/a1", headers: { Cookie: a.cookie } })).json.id, "a1");
  await s.close();
});

// ------------------------------------------------- red-team regressions ----

test("a body that never arrives is cut off, with no login needed", async () => {
  const net = require("node:net");
  const s = await start({ config: { bodyIdleMs: 150 } });
  const sock = net.connect(s.port, "127.0.0.1");
  let got = "";
  sock.on("data", (d) => { got += d; });
  sock.write("POST /api/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n");
  const closed = await Promise.race([
    new Promise((r) => sock.on("close", () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 2000)),
  ]);
  sock.destroy();
  assert.strictEqual(closed, true, "the stalled connection is closed by the server");
  await s.close();
});

test("revoking a device closes its live stream immediately, not at the next beat", async () => {
  const s = await start({ config: { heartbeatMs: 60000 } });
  const a = await login(s);
  const b = await login(s);
  const c = await sse(s.port, "/api/events", { Cookie: a.cookie }, (t) => t.includes("retry:"));
  const ended = new Promise((r) => c.res.on("end", () => r(true)));
  const id = s.auth.sessions.get(a.cookie.split("=")[1]).session.id;
  const r = await req(s.port, { method: "DELETE", path: "/api/sessions/" + id,
    headers: { Cookie: b.cookie, "X-CSRF-Token": b.csrf } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await Promise.race([ended, new Promise((x) => setTimeout(() => x(false), 1000))]), true);
  await s.close();
});

test("one session cannot hold more than a handful of streams open", async () => {
  const s = await start({ config: { heartbeatMs: 60000 } });
  const a = await login(s);
  const open = [];
  for (let i = 0; i < 8; i++) open.push(await sse(s.port, "/api/events", { Cookie: a.cookie }, (t) => t.includes("retry:")));
  const ninth = await req(s.port, { path: "/api/events", headers: { Cookie: a.cookie } });
  assert.strictEqual(ninth.status, 429);
  for (const c of open) c.res.destroy();
  await s.close();
});

// ---- phone app updates (lib/hub/appupdate.js) ----

test("app update: sign-in required; version and parts reassemble to the published APK", async () => {
  const au = require("../lib/hub/appupdate");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-app-"));
  const apk = path.join(dir, "in.apk");
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), require("node:crypto").randomBytes(au.CHUNK * 2 + 1234)]);
  fs.writeFileSync(apk, bytes);
  au.publish(dir, apk, { versionCode: 7, versionName: "1.0.7" });
  const s = await start({ opts: { appUpdates: au.forHub(dir) } });
  try {
    assert.strictEqual((await req(s.port, { path: "/api/app/version" })).status, 401, "not without a session");
    assert.strictEqual((await req(s.port, { path: "/api/app/apk?part=0" })).status, 401);
    const a = await login(s);
    const get = (p) => req(s.port, { path: p, headers: { Cookie: a.cookie } });
    const v = (await get("/api/app/version")).json;
    assert.strictEqual(v.available, true);
    assert.strictEqual(v.versionCode, 7);
    assert.strictEqual(v.parts, 3);
    assert.strictEqual(v.sha256, require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
    const parts = [];
    for (let i = 0; i < v.parts; i++) {
      const p = (await get("/api/app/apk?part=" + i)).json;
      assert.strictEqual(p.part, i);
      assert.strictEqual(p.sha256, v.sha256);
      parts.push(Buffer.from(p.data, "base64"));
    }
    assert.ok(Buffer.concat(parts).equals(bytes));
    for (const bad of ["3", "-1", "1e2", "", "x", "0x1", "../current.json", "1234567"]) {
      assert.strictEqual((await get("/api/app/apk?part=" + encodeURIComponent(bad))).status, 404, bad);
    }
  } finally { await s.close(); }
});

test("app update: no update published, or no updater wired in: available false", async () => {
  const s = await start();
  try {
    const a = await login(s);
    assert.deepStrictEqual((await req(s.port, { path: "/api/app/version", headers: { Cookie: a.cookie } })).json, { available: false });
  } finally { await s.close(); }
});

test("app update publish: refuses downgrades, non-APKs and bad version codes; a truncated file is not offered", () => {
  const au = require("../lib/hub/appupdate");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-app-"));
  const apk = path.join(dir, "in.apk");
  fs.writeFileSync(apk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(5000, 7)]));
  assert.throws(() => au.publish(dir, apk, { versionCode: 0 }), /version-code/);
  assert.throws(() => au.publish(dir, apk, { versionCode: 1.5 }), /version-code/);
  au.publish(dir, apk, { versionCode: 5 });
  assert.throws(() => au.publish(dir, apk, { versionCode: 5 }), /downgrade/);
  assert.throws(() => au.publish(dir, apk, { versionCode: 4 }), /downgrade/);
  const txt = path.join(dir, "x.apk");
  fs.writeFileSync(txt, Buffer.alloc(5000, 65));
  assert.throws(() => au.publish(dir, txt, { versionCode: 9 }), /not an APK/);
  fs.truncateSync(path.join(dir, "app", "current.apk"), 100);
  assert.strictEqual(au.info(dir), null, "size no longer matches: not offered");
});

// ---- chat (lib/hub/chat.js) ----

/** A fake llama-server: streams `words` one per `gapMs`, reasoning first. Records the request bodies. */
function fakeLlama({ words = ["Hello", " there", "!"], reasoning = ["thinking"], gapMs = 5 } = {}) {
  const seen = { bodies: [], aborted: 0 };
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", async () => {
      seen.bodies.push(JSON.parse(b));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let closed = false;
      res.on("close", () => { if (!res.writableEnded) { closed = true; seen.aborted++; } });
      const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      for (const r of reasoning) { if (closed) return; send({ reasoning_content: r }); await new Promise((x) => setTimeout(x, gapMs)); }
      for (const w of words) { if (closed) return; send({ content: w }); await new Promise((x) => setTimeout(x, gapMs)); }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, seen })));
}

async function chatHub(llama, extra = {}) {
  const { ChatManager } = require("../lib/hub/chat");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-chat-"));
  const loads = [];
  const backend = async (arg) => { loads.push(arg); return { port: llama.port, model: "served", nCtx: 8192, modelRef: (arg && arg.modelRef) || "default-model", sampling: { temperature: 0.7 } }; };
  const chats = new ChatManager({ dir, backend, models: () => [{ id: "flint:ud-q6_k_xl" }, { id: "default-model" }] });
  let unloaded = 0;
  const ai = { status: async () => ({ modelRef: "flint:ud-q6_k_xl", running: true }), stop: async () => { const n = chats.stopAll(); unloaded++; return { ok: true, chats: n }; },
    unload: async () => { const n = chats.stopAll(); unloaded++; return { ok: true, chats: n, server: true, model: "flint:ud-q6_k_xl" }; } };
  const s = await start({ opts: { chats, ai, ...extra } });
  const a = await login(s);
  return { s, a, chats, loads, dir, unloadedCount: () => unloaded };
}

async function chatWait(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timed out");
}

test("chat: create with a model, send, the answer streams and is saved with its reasoning", async () => {
  const llama = await fakeLlama();
  const { s, a, loads } = await chatHub(llama);
  try {
    const get = (p) => req(s.port, { path: p, headers: { Cookie: a.cookie } });
    assert.strictEqual((await req(s.port, { path: "/api/chats" })).status, 401, "sign-in required");
    const c = (await jsonPost(s, a, "/api/chats", { model: "flint:ud-q6_k_xl" })).json;
    assert.match(c.id, /^[0-9a-f]{16}$/);
    assert.strictEqual(c.model, "flint:ud-q6_k_xl");
    const r = await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "Hi!" });
    assert.strictEqual(r.status, 200);
    const done = await chatWait(async () => { const g = (await get(`/api/chats/${c.id}`)).json; return g.status === "idle" && g.messages.length === 2 ? g : null; });
    assert.strictEqual(done.messages[1].content, "Hello there!");
    assert.strictEqual(done.messages[1].reasoning, "thinking");
    assert.strictEqual(done.title, "Hi!");
    assert.deepStrictEqual(loads[0], { modelRef: "flint:ud-q6_k_xl" });
    assert.deepStrictEqual(llama.seen.bodies[0].messages, [{ role: "user", content: "Hi!" }]);
    assert.strictEqual(llama.seen.bodies[0].stream, true);
    assert.strictEqual(llama.seen.bodies[0].temperature, 0.7);
    assert.strictEqual((await get("/api/chats")).json.length, 1);
  } finally { await s.close(); llama.srv.close(); }
});

test("chat: the model load is reported as progress events, and the answer is saved with its speed", async () => {
  const llama = await fakeLlama();
  const { ChatManager } = require("../lib/hub/chat");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-chat-"));
  const backend = async (arg, o) => {
    o.onProgress({ phase: "loading", stage: "weights", model: "default-model", size: 5e9, ctx: 8192, pct: 40, elapsedMs: 400, estMs: 1000 });
    o.onProgress({ phase: "loaded", model: "default-model", ctx: 8192, pct: 100, elapsedMs: 900 });
    return { port: llama.port, model: "served", nCtx: 8192, modelRef: "default-model" };
  };
  const chats = new ChatManager({ dir, backend, models: () => [{ id: "default-model" }] });
  try {
    const c = chats.create({});
    await chats.send(c.id, "Hi");
    await chatWait(() => chats.get(c.id).status === "idle");
    const evs = chats.history(c.id);
    const loads = evs.filter((e) => e.kind === "load");
    assert.deepStrictEqual(loads.map((e) => [e.phase, e.pct]), [["loading", 40], ["loaded", 100]]);
    assert.strictEqual(loads[0].stage, "weights");
    assert.strictEqual(loads[0].size, 5e9);
    const done = evs.find((e) => e.kind === "done");
    assert.ok(done.stats && done.stats.tokens > 0, "token count");
    assert.strictEqual(done.stats.loadMs, 900);
    assert.ok(typeof done.stats.ttftMs === "number");
    const saved = chats.get(c.id).messages[1];
    assert.deepStrictEqual(saved.stats, done.stats, "stats are kept with the message");
    assert.deepStrictEqual(llama.seen.bodies[0].stream_options, { include_usage: true });
  } finally { llama.srv.close(); }
});

test("agents: a pinned model must be installed; it can be changed later", async () => {
  const llama = await fakeLlama();
  const { s, a } = await chatHub(llama, { models: () => [{ id: "flint:ud-q6_k_xl", size: 1 }] });
  try {
    const cwd = s.roots ? s.roots[0] : null;
    const list = (await req(s.port, { path: "/api/agents", headers: { Cookie: a.cookie } })).json;
    assert.ok(Array.isArray(list));
    const bad = await jsonPost(s, a, "/api/agents", { name: "x", cwd: cwd || process.cwd(), model: "not-here" });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error || "", /not on this computer/);
  } finally { await s.close(); llama.srv.close(); }
});

test("chat: stop cuts the answer off, keeps what was said, and closes the model request", async () => {
  const llama = await fakeLlama({ words: Array.from({ length: 200 }, (_, i) => ` w${i}`), reasoning: [], gapMs: 15 });
  const { s, a } = await chatHub(llama);
  try {
    const get = (p) => req(s.port, { path: p, headers: { Cookie: a.cookie } });
    const c = (await jsonPost(s, a, "/api/chats", {})).json;
    await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "count", model: "default-model" });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual((await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "again" })).status, 409, "one answer at a time");
    const st = (await jsonPost(s, a, `/api/chats/${c.id}/stop`, {})).json;
    assert.strictEqual(st.stopped, true);
    const g = await chatWait(async () => { const x = (await get(`/api/chats/${c.id}`)).json; return x.status === "idle" ? x : null; });
    assert.strictEqual(g.messages.length, 2);
    assert.strictEqual(g.messages[1].stopped, true);
    assert.ok(g.messages[1].content.length > 0 && g.messages[1].content.split(" w").length < 150, "cut off early");
    await chatWait(() => llama.seen.aborted > 0);
  } finally { await s.close(); llama.srv.close(); }
});

test("chat: models must be on this computer; bad ids, CSRF and oversize messages are refused", async () => {
  const llama = await fakeLlama();
  const { s, a } = await chatHub(llama);
  try {
    assert.strictEqual((await jsonPost(s, a, "/api/chats", { model: "../../etc" })).status, 400);
    assert.strictEqual((await jsonPost(s, a, "/api/chats", { model: 5 })).status, 400);
    const c = (await jsonPost(s, a, "/api/chats", {})).json;
    assert.strictEqual((await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "x", model: "not-installed" })).status, 400);
    assert.strictEqual((await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "x".repeat(40000) })).status, 413);
    assert.strictEqual((await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "  " })).status, 400);
    assert.strictEqual((await jsonPost(s, a, "/api/chats/0123456789abcdef/send", { text: "hi" })).status, 404);
    assert.strictEqual((await req(s.port, { path: "/api/chats/..%2f..%2fx", headers: { Cookie: a.cookie } })).status, 404);
    assert.strictEqual((await jsonPost(s, a, "/api/chats", {}, { "X-CSRF-Token": "wrong" })).status, 403);
    const del = await req(s.port, { method: "DELETE", path: `/api/chats/${c.id}`, headers: { Cookie: a.cookie, "X-CSRF-Token": a.csrf } });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await req(s.port, { path: `/api/chats/${c.id}`, headers: { Cookie: a.cookie } })).status, 404);
  } finally { await s.close(); llama.srv.close(); }
});

test("chat: the event stream replays and follows one chat", async () => {
  const llama = await fakeLlama();
  const { s, a } = await chatHub(llama);
  try {
    const c = (await jsonPost(s, a, "/api/chats", {})).json;
    await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "Hi" });
    await chatWait(async () => (await req(s.port, { path: `/api/chats/${c.id}`, headers: { Cookie: a.cookie } })).json.status === "idle");
    const text = await new Promise((resolve, reject) => {
      const r = http.get({ host: "127.0.0.1", port: s.port, path: `/api/chats/${c.id}/events?after=0`, headers: { Cookie: a.cookie }, agent: false }, (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; if (buf.includes("\"kind\":\"done\"")) { r.destroy(); resolve(buf); } });
      });
      r.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    });
    const evs = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    assert.deepStrictEqual(evs.map((e) => e.kind), ["start", "reasoning", "delta", "delta", "delta", "done"]);
    assert.ok(evs.every((e) => e.chatId === c.id));
  } finally { await s.close(); llama.srv.close(); }
});

test("stop AI: one call stops every answer and the model server", async () => {
  const llama = await fakeLlama({ words: Array.from({ length: 200 }, (_, i) => ` w${i}`), gapMs: 15 });
  const { s, a, unloadedCount } = await chatHub(llama);
  try {
    const c = (await jsonPost(s, a, "/api/chats", {})).json;
    await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "go" });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual((await req(s.port, { path: "/api/ai/stop", method: "POST", headers: { Cookie: a.cookie } })).status, 403, "CSRF required");
    const r = (await jsonPost(s, a, "/api/ai/stop", {})).json;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.chats, 1);
    assert.strictEqual(unloadedCount(), 1);
    assert.deepStrictEqual((await req(s.port, { path: "/api/ai/status", headers: { Cookie: a.cookie } })).json, { modelRef: "flint:ud-q6_k_xl", running: true });
  } finally { await s.close(); llama.srv.close(); }
});

test("chat stop with unload: stops the answer and frees the GPU; plain stop does not unload", async () => {
  const llama = await fakeLlama({ words: Array.from({ length: 200 }, (_, i) => ` w${i}`), gapMs: 15 });
  const { s, a, unloadedCount } = await chatHub(llama);
  try {
    const c = (await jsonPost(s, a, "/api/chats", {})).json;
    await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "go" });
    await new Promise((r) => setTimeout(r, 80));
    const plain = (await jsonPost(s, a, `/api/chats/${c.id}/stop`, {})).json;
    assert.strictEqual(plain.stopped, true);
    assert.strictEqual(unloadedCount(), 0, "without unload the weights stay loaded");
    const r = (await jsonPost(s, a, `/api/chats/${c.id}/stop`, { unload: true })).json;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.unloaded, true);
    assert.strictEqual(r.model, "flint:ud-q6_k_xl");
    assert.strictEqual(unloadedCount(), 1);
    assert.strictEqual((await jsonPost(s, a, `/api/chats/${c.id}/stop`, { unload: "yes" })).json.unloaded, undefined, "only a real true unloads");
  } finally { await s.close(); llama.srv.close(); }
});

// ---- local API for agents (lib/hub/local.js) ----

async function localHub(extra = {}) {
  const L = require("../lib/hub/local");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-local-"));
  const token = L.ensureToken(dir);
  const questions = new L.QuestionBox();
  let unloaded = 0;
  const backend = async () => ({ port: extra.llamaPort || 1, model: "served", modelRef: "m1", nCtx: 4096, sampling: {} });
  backend.status = async () => ({ modelRef: "m1", running: true });
  backend.unload = async () => { unloaded++; return { stopped: true, modelRef: "m1" }; };
  const srv = require("../lib/hub/server");
  const api = L.makeLocalApi({ questions, backend, models: () => [{ id: "m1", size: 5 }], readJson: (r) => srv.readJson(r), sendJson: srv.sendJson });
  const s = await start({ opts: { local: { token, questions, api }, ...(extra.opts || {}) } });
  return { s, token, questions, dir, unloaded: () => unloaded };
}

const bearerReq = (s, method, p, token, body) => req(s.port, {
  method, path: p,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("local API: token required and constant-time checked; the token file is private and stable", async () => {
  const { s, token, dir } = await localHub();
  try {
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.strictEqual(require("../lib/hub/local").ensureToken(dir), token, "reused, not rotated on every start");
    assert.strictEqual((await bearerReq(s, "GET", "/api/local/models")).status, 401);
    assert.strictEqual((await bearerReq(s, "GET", "/api/local/models", "0".repeat(64))).status, 401);
    assert.strictEqual((await bearerReq(s, "GET", "/api/local/models", token.slice(0, 63))).status, 401);
    const r = await bearerReq(s, "GET", "/api/local/models", token);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { models: [{ id: "m1", size: 5 }], loaded: "m1" });
    // A browser session cookie is not enough: the local API ignores cookies.
    const a = await login(s);
    assert.strictEqual((await req(s.port, { path: "/api/local/models", headers: { Cookie: a.cookie } })).status, 401);
  } finally { await s.close(); }
});

test("local API: only this computer: a LAN address or a tunnelled request gets 404", async () => {
  const L = require("../lib/hub/local");
  assert.ok(L.isLoopback("127.0.0.1") && L.isLoopback("::1") && L.isLoopback("::ffff:127.0.0.1"));
  assert.ok(!L.isLoopback("192.168.0.5") && !L.isLoopback("10.0.0.1") && !L.isLoopback("") && !L.isLoopback(undefined));
  const { s, token } = await localHub({ opts: { getRemoteAddress: () => "192.168.0.5" } });
  try {
    assert.strictEqual((await bearerReq(s, "GET", "/api/local/models", token)).status, 404);
  } finally { await s.close(); }
});

test("ask_phone round trip: agent asks, the phone sees it and answers, the agent gets the answer", async () => {
  const { s, token } = await localHub();
  try {
    const asked = await bearerReq(s, "POST", "/api/local/ask", token, { question: "Deploy now?", options: ["Yes", "No"], timeoutSec: 60 });
    assert.strictEqual(asked.status, 200);
    const id = asked.json.id;
    assert.match(id, /^[0-9a-f]{16}$/);
    const a = await login(s);
    const pending = (await req(s.port, { path: "/api/questions", headers: { Cookie: a.cookie } })).json;
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].question, "Deploy now?");
    assert.deepStrictEqual(pending[0].options, ["Yes", "No"]);
    // Waiting on it from the agent side while the phone answers.
    const waiting = bearerReq(s, "GET", `/api/local/ask/${id}?wait=5`, token);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual((await jsonPost(s, a, `/api/questions/${id}/answer`, { answer: "Yes" })).status, 200);
    const got = await waiting;
    assert.deepStrictEqual([got.json.status, got.json.answer], ["answered", "Yes"]);
    assert.strictEqual((await jsonPost(s, a, `/api/questions/${id}/answer`, { answer: "No" })).status, 409, "answered once");
    assert.strictEqual((await jsonPost(s, a, `/api/questions/${id}/answer`, { answer: "No" }, { "X-CSRF-Token": "x" })).status, 403);
    assert.strictEqual((await req(s.port, { path: "/api/questions" })).status, 401, "the phone side needs a session");
  } finally { await s.close(); }
});

test("ask_phone limits: bad input refused, questions expire, at most 20 open", async () => {
  const { s, token, questions } = await localHub();
  try {
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/ask", token, { question: "" })).status, 400);
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/ask", token, { question: "x".repeat(2001) })).status, 413);
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/ask", token, { question: "q", options: Array(9).fill("a") })).status, 400);
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/ask", token, { question: "q", options: [5] })).status, 400);
    for (let i = 0; i < 20; i++) assert.strictEqual((await bearerReq(s, "POST", "/api/local/ask", token, { question: "q" + i })).status, 200);
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/ask", token, { question: "one too many" })).status, 429);
    // Expiry, with a clock we control.
    let t = 1000;
    const L = require("../lib/hub/local");
    const qb = new L.QuestionBox({ now: () => t });
    const { id } = qb.ask({ question: "q", timeoutSec: 10 });
    t += 11000;
    assert.strictEqual(qb.get(id).status, "expired");
    assert.throws(() => qb.answer(id, "late"), /expired/);
    assert.ok(questions.pending().length === 20);
  } finally { await s.close(); }
});

test("local API: notify reaches the phone's event stream; unload calls the backend", async () => {
  const { s, token, unloaded } = await localHub();
  try {
    const a = await login(s);
    const got = new Promise((resolve, reject) => {
      const r = http.get({ host: "127.0.0.1", port: s.port, path: "/api/events", headers: { Cookie: a.cookie }, agent: false }, (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; if (buf.includes("\"type\":\"notice\"")) { r.destroy(); resolve(buf); } });
      });
      r.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/notify", token, { title: "Build done", body: "all green" })).status, 200);
    const text = await got;
    assert.match(text, /"title":"Build done"/);
    const u = await bearerReq(s, "POST", "/api/local/unload", token, {});
    assert.deepStrictEqual(u.json, { stopped: true, modelRef: "m1" });
    assert.strictEqual(unloaded(), 1);
  } finally { await s.close(); }
});

test("local_generate: runs the prompt on the local model server and returns the text", async () => {
  const llama = await new Promise((resolve) => {
    const srv = http.createServer((q, r) => {
      let b = ""; q.on("data", (d) => { b += d; });
      q.on("end", () => {
        const j = JSON.parse(b);
        r.writeHead(200, { "Content-Type": "text/event-stream" });
        r.write("data: " + JSON.stringify({ choices: [{ delta: { content: j.stream === true ? "echo: " : "NOT STREAMED " } }] }) + "\n\n");
        r.end("data: " + JSON.stringify({ choices: [{ delta: { content: j.messages.at(-1).content }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const { s, token } = await localHub({ llamaPort: llama.address().port });
  try {
    // A job: POST starts it, GET collects it (a long answer must not depend on one long request).
    const started = await bearerReq(s, "POST", "/api/local/generate", token, { prompt: "hi", system: "be brief" });
    assert.strictEqual(started.status, 200);
    assert.match(started.json.id, /^[0-9a-f]{16}$/);
    const r = await bearerReq(s, "GET", "/api/local/generate/" + started.json.id + "?wait=5", token);
    assert.strictEqual(r.json.status, "done");
    assert.strictEqual(r.json.text, "echo: hi");
    assert.strictEqual(r.json.model, "m1");
    assert.strictEqual(r.json.finish, "stop");
    assert.strictEqual((await bearerReq(s, "GET", "/api/local/generate/0123456789abcdef", token)).status, 404);
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/generate", token, { prompt: "hi", model: "not-here" })).status, 400);
    assert.strictEqual((await bearerReq(s, "POST", "/api/local/generate", token, { prompt: "" })).status, 400);
  } finally { await s.close(); llama.close(); }
});

test("readJson: a body over 64 KB is read when the caller allows more, and refused when it does not", async () => {
  const { readJson } = require("../lib/hub/server");
  const body = JSON.stringify({ prompt: "x".repeat(100000) });
  const run = (max) => new Promise((resolve) => {
    const srv = http.createServer((q, r) => {
      readJson(q, 2000, max).then((v) => { r.end(String(v.prompt.length)); }, (e) => { r.statusCode = e.status || 500; r.end("err"); });
    });
    srv.listen(0, "127.0.0.1", () => {
      const rq = http.request({ host: "127.0.0.1", port: srv.address().port, method: "POST", path: "/", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        let t = ""; res.on("data", (d) => { t += d; }); res.on("end", () => { srv.close(); resolve([res.statusCode, t]); });
      });
      rq.on("error", () => { srv.close(); resolve(["error", ""]); });
      rq.end(body);
    });
  });
  assert.deepStrictEqual(await run(2 * 1024 * 1024), [200, "100000"]);
  assert.strictEqual((await run(undefined))[0], 413);
});

test("account routes: details, wrong password refused, CSRF required, delete signs you out", async () => {
  const { AuthStore } = require("../lib/hub/auth");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-acct-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("alice", "correct-horse-1");
  auth.createAccount("bob", "correct-horse-2", { role: "user" });
  const s = await start({ opts: { auth } });
  try {
    const a = await login(s);
    const me = (await req(s.port, { path: "/api/account", headers: { Cookie: a.cookie } })).json;
    assert.strictEqual(me.username, "alice");
    assert.strictEqual(me.role, "owner");
    assert.deepStrictEqual(me.others.map((o) => o.username), ["bob"]);
    assert.ok(!JSON.stringify(me).includes("hash"), "no password hashes");
    assert.strictEqual((await jsonPost(s, a, "/api/accounts/bob/delete", { password: "x" }, { "X-CSRF-Token": "bad" })).status, 403, "CSRF");
    assert.strictEqual((await jsonPost(s, a, "/api/accounts/bob/delete", { password: "wrong-password" })).status, 403);
    assert.strictEqual((await jsonPost(s, a, "/api/account/delete", { password: "correct-horse-1" })).status, 409, "last owner");
    assert.strictEqual((await jsonPost(s, a, "/api/accounts/bob/delete", { password: "correct-horse-1" })).status, 200);
    const del = await jsonPost(s, a, "/api/account/delete", { password: "correct-horse-1" });
    assert.strictEqual(del.status, 200);
    assert.match(String(del.headers["set-cookie"]), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    assert.strictEqual((await req(s.port, { path: "/api/account", headers: { Cookie: a.cookie } })).status, 401);
  } finally { await s.close(); }
});

test("chat: instructions go first as the system message; regenerate replaces the last answer", async () => {
  const llama = await fakeLlama({ reasoning: [] });
  const { s, a } = await chatHub(llama);
  try {
    const get = (p) => req(s.port, { path: p, headers: { Cookie: a.cookie } });
    const patch = (p, body) => req(s.port, { method: "PATCH", path: p, headers: { "Content-Type": "application/json", Cookie: a.cookie, "X-CSRF-Token": a.csrf }, body: JSON.stringify(body) });
    const c = (await jsonPost(s, a, "/api/chats", {})).json;
    assert.strictEqual((await jsonPost(s, a, `/api/chats/${c.id}/regenerate`, {})).status, 409, "nothing to answer yet");
    const sys = await patch(`/api/chats/${c.id}`, { system: "  Be brief.  " });
    assert.strictEqual(sys.status, 200);
    assert.strictEqual(sys.json.system, "Be brief.");
    assert.strictEqual((await patch(`/api/chats/${c.id}`, { system: 5 })).status, 400);
    assert.strictEqual((await patch(`/api/chats/${c.id}`, { system: "x".repeat(8001) })).status, 413);
    await jsonPost(s, a, `/api/chats/${c.id}/send`, { text: "Hi" });
    await chatWait(async () => { const g = (await get(`/api/chats/${c.id}`)).json; return g.status === "idle" && g.messages.length === 2; });
    assert.deepStrictEqual(llama.seen.bodies[0].messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }]);
    const r = await jsonPost(s, a, `/api/chats/${c.id}/regenerate`, {});
    assert.strictEqual(r.status, 200);
    const g = await chatWait(async () => { const x = (await get(`/api/chats/${c.id}`)).json; return x.status === "idle" && x.messages.length === 2 ? x : null; });
    assert.strictEqual(g.messages[1].role, "assistant");
    assert.strictEqual(llama.seen.bodies.length, 2);
    assert.deepStrictEqual(llama.seen.bodies[1].messages.map((m) => m.role), ["system", "user"], "the old answer is not sent back");
    // Clearing the instructions: the next request has no system message.
    assert.strictEqual((await patch(`/api/chats/${c.id}`, { system: "" })).json.system, "");
    await jsonPost(s, a, `/api/chats/${c.id}/regenerate`, {});
    await chatWait(async () => llama.seen.bodies.length === 3 && (await get(`/api/chats/${c.id}`)).json.status === "idle");
    assert.deepStrictEqual(llama.seen.bodies[2].messages.map((m) => m.role), ["user"]);
  } finally { await s.close(); llama.srv.close(); }
});

test("workspace: no folder means the workspace, a name makes a project in it, bad names and odd paths are refused", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hub-ws-"));
  fs.mkdirSync(path.join(ws, "older"));
  fs.mkdirSync(path.join(ws, ".hidden"));
  const s = await start({ config: { workspace: ws, roots: [ws, "/elsewhere"] } });
  const seen = [];
  s.supervisor.create = async (o) => { seen.push(o.cwd); return { id: "a9", ...o }; };
  try {
    const a = await login(s);
    const w = (await req(s.port, { path: "/api/workspace", headers: { Cookie: a.cookie } })).json;
    assert.strictEqual(w.path, ws);
    assert.deepStrictEqual(w.folders.map((f) => f.name), ["older"], "hidden folders are not listed");
    assert.deepStrictEqual(w.roots, [ws, "/elsewhere"]);
    assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "x" })).status, 201);
    assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "x", cwd: "  " })).status, 201);
    assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "x", cwd: "my game" })).status, 201);
    assert.ok(fs.statSync(path.join(ws, "my game")).isDirectory(), "the project folder was made");
    assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "x", cwd: "/elsewhere/p" })).status, 201);
    assert.deepStrictEqual(seen, [ws, ws, path.join(ws, "my game"), "/elsewhere/p"]);
    for (const bad of ["..", ".git", "a..b", "con", "NUL.txt", "x.", "x".repeat(70), "a*b"]) {
      assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "x", cwd: bad })).status, 400, bad);
    }
    assert.ok(!fs.existsSync(path.join(ws, "a..b")));
    assert.strictEqual((await jsonPost(s, a, "/api/agents", { name: "x", cwd: 5 })).status, 400);
  } finally { await s.close(); fs.rmSync(ws, { recursive: true, force: true }); }
});

test("YOLO mode can only be switched by an owner, with a true/false body", async () => {
  const s = await start();
  const calls = [];
  s.supervisor.setYolo = (id, on) => { calls.push([id, on]); return { id, yolo: on }; };
  try {
    const a = await login(s);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/yolo", { on: "yes" })).status, 400);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/nope/yolo", { on: true })).status, 404);
    const r = await jsonPost(s, a, "/api/agents/a1/yolo", { on: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.yolo, true);
    for (const v of s.auth.sessions.values()) v.user.role = "user";
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/yolo", { on: true })).status, 403);
    assert.deepStrictEqual(calls, [["a1", true]]);
    // Nor can a second account hand work to an agent an owner put in YOLO mode.
    const real = s.supervisor.get.bind(s.supervisor);
    s.supervisor.get = (id) => { const g = real(id); return g && { ...g, yolo: true }; };
    for (const [act, body] of [["wake", { text: "rm -rf ~" }], ["queue", { text: "x" }], ["start", {}]]) {
      assert.strictEqual((await jsonPost(s, a, `/api/agents/a1/${act}`, body)).status, 403, act);
    }
    // And a second account can say no to a request, but never allow one.
    s.supervisor.approve = async () => true;
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: true })).status, 403);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/approve", { approvalId: "x", allow: false })).status, 200);
  } finally { await s.close(); }
});

test("queue routes: add needs text, remove takes a whole-number position or nothing, Stop clears the queue", async () => {
  const s = await start();
  const calls = [];
  s.supervisor.enqueue = async (id, text) => { calls.push(["q", id, text]); return { id, queue: [text], queued: true }; };
  s.supervisor.unqueue = (id, index) => { calls.push(["u", id, index]); return { id, queue: [] }; };
  s.supervisor.stop = async (id, o) => { calls.push(["s", id, o]); return { id, status: "stopped" }; };
  try {
    const a = await login(s);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/queue", { text: "" })).status, 400);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/nope/queue", { text: "hi" })).status, 404);
    const r = await jsonPost(s, a, "/api/agents/a1/queue", { text: "next" });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.queue, ["next"]);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/unqueue", { index: "0" })).status, 400);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/unqueue", { index: 0 })).status, 200);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/unqueue", {})).status, 200);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/stop", {})).status, 200);
    assert.deepStrictEqual(calls, [["q", "a1", "next"], ["u", "a1", 0], ["u", "a1", undefined], ["s", "a1", { clearQueue: true }]]);
  } finally { await s.close(); }
});

test("Team mode route: true/false body, unknown agent is 404", async () => {
  const s = await start();
  const calls = [];
  s.supervisor.setTeam = async (id, on) => { calls.push([id, on]); return { id, team: on, status: "stopped" }; };
  try {
    const a = await login(s);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/a1/team", { on: 1 })).status, 400);
    assert.strictEqual((await jsonPost(s, a, "/api/agents/nope/team", { on: true })).status, 404);
    const r = await jsonPost(s, a, "/api/agents/a1/team", { on: true });
    assert.deepStrictEqual([r.status, r.json.team], [200, true]);
    assert.deepStrictEqual(calls, [["a1", true]]);
  } finally { await s.close(); }
});

test("chat: a failure in the middle of an answer is reported as an error, and the part that arrived is kept", async () => {
  const { ChatManager } = require("../lib/hub/chat");
  // A model server that says two words and then fails the way llama-server does: an error object in the stream.
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.headers["x-refuse"] || srv.refuse) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "the request exceeds the available context size" } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Half an " } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ error: { message: "out of memory" } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-chat-"));
  const chats = new ChatManager({ dir, backend: async () => ({ port: srv.address().port, model: "served", nCtx: 8192, modelRef: "default-model" }), models: () => [{ id: "default-model" }] });
  const events = [];
  chats.on("event", (e) => events.push(e));
  try {
    const c = chats.create({});
    await chats.send(c.id, "Hi");
    await chatWait(() => events.find((e) => e.kind === "error" || e.kind === "done"));
    const end = events.find((e) => e.kind === "error" || e.kind === "done");
    assert.strictEqual(end.kind, "error", "not reported as a finished answer");
    assert.match(end.error, /out of memory/);
    assert.strictEqual(chats.get(c.id).messages[1].content, "Half an ");

    // A refusal before any text: the reason from the body reaches the person.
    srv.refuse = true;
    events.length = 0;
    await chats.send(c.id, "Again");
    await chatWait(() => events.find((e) => e.kind === "error"));
    assert.match(events.find((e) => e.kind === "error").error, /400.*exceeds the available context/);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
