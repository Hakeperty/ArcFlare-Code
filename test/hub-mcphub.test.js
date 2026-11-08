// MCP servers for hub agents (lib/hub/mcphub.js): the switches, the shared
// registry, the phone API, and that the supervisor hands the registry to agents.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { McpHub, loadHomeConfig, shortError } = require("../lib/hub/mcphub");
const { createHubServer } = require("../lib/hub/server");
const { Supervisor } = require("../lib/hub/supervisor");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcphub-"));

// A registry that "connects" instantly; servers named bad* fail.
function FakeRegistry() {
  this.servers = new Map();
  this.added = [];
  this.add = async (name, cfg) => {
    this.added.push(name);
    if (/^bad/.test(name)) return { ok: false, name, error: "spawn C:\\Users\\x\\secret\\server.exe ENOENT" };
    const s = { tools: [{ name: "look", description: "Look at things.\nMore text." }, { name: "poke" }], stopped: false, stop() { this.stopped = true; } };
    this.servers.set(name, s);
    return { ok: true, name, tools: 2 };
  };
}

const CONFIG = { file: "x", servers: { blender: { command: "py", env: { TOKEN: "s3cret" } }, web: { url: "https://example.test/mcp" }, badone: { command: "nope" }, "bad name!": { command: "x" } } };

function hub(dir = tmp()) {
  return new McpHub({ dir, load: () => CONFIG, Registry: FakeRegistry });
}

test("every server starts off; list shows transport and never the command or env", () => {
  const h = hub();
  const list = h.list();
  assert.deepStrictEqual(list.map((s) => s.name), ["badone", "blender", "web"]); // the bad name is dropped
  assert.ok(list.every((s) => s.enabled === false && s.status === "off" && s.tools === 0));
  assert.strictEqual(list.find((s) => s.name === "web").transport, "http");
  assert.ok(!JSON.stringify(list).includes("s3cret") && !JSON.stringify(list).includes("py"));
});

test("switching on connects and is remembered; off stops the server", async () => {
  const dir = tmp();
  const h = hub(dir);
  const on = await h.setEnabled("blender", true);
  assert.strictEqual(on.status, "on");
  assert.strictEqual(on.tools, 2);
  assert.deepStrictEqual(h.tools("blender"), [{ name: "look", description: "Look at things." }, { name: "poke", description: "" }]);
  // A fresh hub (a restart) remembers the switch but connects only when an agent needs it.
  const h2 = hub(dir);
  assert.strictEqual(h2.list().find((s) => s.name === "blender").enabled, true);
  assert.strictEqual(h2.reg.added.length, 0);
  const reg = await h2.registry();
  assert.ok(reg && reg.servers.has("blender"));
  const s = h.reg.servers.get("blender");
  const off = await h.setEnabled("blender", false);
  assert.strictEqual(off.status, "off");
  assert.ok(s.stopped);
  assert.ok(!h.reg.servers.has("blender"));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")), { enabled: {} });
});

test("a server that fails is an error with the path cut out, and does not stop the others", async () => {
  const h = hub();
  const bad = await h.setEnabled("badone", true);
  assert.strictEqual(bad.status, "error");
  assert.ok(!bad.error.includes("secret"), bad.error);
  assert.strictEqual(await h.registry(), null); // nothing connected
  await h.setEnabled("blender", true);
  const reg = await h.registry();
  assert.deepStrictEqual([...reg.servers.keys()], ["blender"]);
});

test("unknown names are 404; restart needs the switch on", async () => {
  const h = hub();
  await assert.rejects(h.setEnabled("nope", true), (e) => e.status === 404);
  await assert.rejects(h.setEnabled("../x", true), (e) => e.status === 404);
  assert.throws(() => h.tools("nope"), (e) => e.status === 404);
  await assert.rejects(h.restart("blender"), (e) => e.status === 409);
  await h.setEnabled("blender", true);
  const r = await h.restart("blender");
  assert.strictEqual(r.status, "on");
  assert.strictEqual(h.reg.added.filter((n) => n === "blender").length, 2);
});

test("no switch on means no registry at all, and nothing is spawned", async () => {
  const h = hub();
  assert.strictEqual(await h.registry(), null);
  assert.strictEqual(h.reg.added.length, 0);
});

test("only the computer's own config is read, never a workspace file", () => {
  const home = tmp(), user = tmp();
  fs.writeFileSync(path.join(user, ".claude.json"), JSON.stringify({ mcpServers: { fromClaude: { command: "a" } } }));
  assert.deepStrictEqual(Object.keys(loadHomeConfig({ home, userHome: user }).servers), ["fromClaude"]);
  fs.writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "b" } } }));
  assert.deepStrictEqual(Object.keys(loadHomeConfig({ home, userHome: user }).servers), ["mine"]);
  assert.deepStrictEqual(loadHomeConfig({ home: tmp(), userHome: tmp() }).servers, {});
});

test("shortError keeps the reason and drops paths", () => {
  assert.strictEqual(shortError(new Error("spawn /usr/local/bin/thing ENOENT")), "spawn … ENOENT");
  assert.ok(shortError("x".repeat(500)).length <= 200);
});

test("the supervisor hands switched-on servers to the agents it boots", async () => {
  const dir = tmp();
  const h = hub(dir);
  await h.setEnabled("blender", true);
  let got;
  const sup = new Supervisor({
    dir, roots: [dir], mcp: h,
    backend: async () => ({ port: 1, model: "m", nCtx: 4096 }),
    makeAgent: (o) => { got = o.mcp; return { busy: false, loadConversation() {}, async run() { return ""; }, stop() {} }; },
  });
  const a = await sup.create({ name: "x", cwd: dir });
  await sup.start(a.id).catch(() => {});
  assert.ok(got && got.servers.has("blender"));
});

// ------------------------------------------------------------- phone API --

const helpers = {
  cookieName: () => "sid",
  cookieHeader: (t, { maxAgeSec }) => `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`,
  clearCookieHeader: () => "sid=; Path=/; Max-Age=0",
  parseCookies: (v) => Object.fromEntries(String(v || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0])),
  checkCsrf: (s, h) => !!s && typeof h === "string" && s.csrf === h,
};

function fakeAuth(role) {
  const sessions = new Map();
  return {
    hasAccounts: () => true,
    async login() { sessions.set("t1", { user: { username: "alice", role }, session: { id: "s1" }, csrf: "c1" }); return { ok: true, token: "t1", csrf: "c1", session: { id: "s1" } }; },
    authenticate: (t) => sessions.get(t) || null,
    logout: () => {}, listSessions: () => [], revokeSession: () => false, revokeAll: () => 0,
  };
}

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, agent: false,
      headers: { Cookie: "sid=t1", "X-CSRF-Token": "c1", ...(body ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks)); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function serve(role) {
  const sup = new EventEmitter();
  sup.list = () => [];
  const auth = fakeAuth(role);
  const mcp = hub();
  const s = createHubServer({ auth, supervisor: sup, helpers, mcp, uiDir: tmp() });
  const { port } = await s.listen({ port: 0, host: "127.0.0.1" });
  await auth.login();
  return { s, port, mcp };
}

test("API: list, switch on, tools, restart, off", async () => {
  const { s, port } = await serve("owner");
  const l = await call(port, "GET", "/api/mcp");
  assert.strictEqual(l.status, 200);
  assert.strictEqual(l.json.canEdit, true);
  assert.strictEqual(l.json.servers.length, 3);
  const on = await call(port, "POST", "/api/mcp/blender", { enabled: true });
  assert.strictEqual(on.status, 200);
  assert.strictEqual(on.json.status, "on");
  assert.strictEqual((await call(port, "GET", "/api/mcp/blender/tools")).json.length, 2);
  assert.strictEqual((await call(port, "POST", "/api/mcp/blender/restart", {})).json.status, "on");
  assert.strictEqual((await call(port, "POST", "/api/mcp/blender", { enabled: "yes" })).status, 400);
  assert.strictEqual((await call(port, "POST", "/api/mcp/nope", { enabled: true })).status, 404);
  assert.strictEqual((await call(port, "POST", "/api/mcp/blender", { enabled: false })).json.status, "off");
  await s.close();
});

test("API: a non-owner can look but not switch", async () => {
  const { s, port, mcp } = await serve("user");
  const l = await call(port, "GET", "/api/mcp");
  assert.strictEqual(l.json.canEdit, false);
  assert.strictEqual((await call(port, "POST", "/api/mcp/blender", { enabled: true })).status, 403);
  assert.strictEqual((await call(port, "POST", "/api/mcp/blender/restart", {})).status, 403);
  assert.strictEqual(mcp.reg.added.length, 0);
  await s.close();
});
