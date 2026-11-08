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
  const ai = { status: async () => ({ modelRef: "flint:ud-q6_k_xl", running: true }), stop: async () => { const n = chats.stopAll(); unloaded++; return { ok: true, chats: n }; } };
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
