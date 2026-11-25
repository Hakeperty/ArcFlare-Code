// Adding MCP servers from the phone (lib/hub/mcphub.js catalog/install/remove and the /api/mcp routes):
// owner only, catalogue ids only, the command is the catalogue's, added off, and only store entries removable.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { McpHub, loadHomeConfig } = require("../lib/hub/mcphub");
const { createHubServer } = require("../lib/hub/server");
const store = require("../lib/store");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcpstore-"));

function FakeRegistry() {
  this.servers = new Map();
  this.added = [];
  this.add = async (name) => {
    this.added.push(name);
    this.servers.set(name, { tools: [{ name: "t" }], stop() {} });
    return { ok: true, name, tools: 1 };
  };
}

const helpers = {
  cookieName: () => "sid",
  cookieHeader: (t) => `sid=${t}; Path=/`,
  clearCookieHeader: () => "sid=; Path=/",
  parseCookies: (v) => Object.fromEntries(String(v || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0])),
  checkCsrf: (s, h) => !!s && typeof h === "string" && s.csrf === h,
};

function fakeAuth(role) {
  const sessions = new Map([["t1", { user: { username: "alice", role }, session: { id: "s1" }, csrf: "c1" }]]);
  return {
    hasAccounts: () => true, login: async () => ({ ok: false }),
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

// A computer with a hand-written server, one with a token in its env, and a store-made one under a catalogue id.
const HAND = {
  mcpServers: {
    mine: { command: "npx", args: ["-y", "my-own-server"] },
    git: { command: "uvx", args: ["mcp-server-git"], env: { TOKEN: "s3cret" } },
  },
};

async function serve(role, { offline = false } = {}) {
  const home = tmp();
  fs.writeFileSync(path.join(home, "mcp.json"), JSON.stringify(HAND));
  const mcp = new McpHub({
    dir: tmp(), home, builtins: true, Registry: FakeRegistry,
    load: () => loadHomeConfig({ home, userHome: tmp() }),
    catalog: async () => { if (offline) throw new Error("offline"); return { data: store.bundled(), source: "bundled" }; },
  });
  const sup = new EventEmitter();
  sup.list = () => [];
  const s = createHubServer({ auth: fakeAuth(role), supervisor: sup, helpers, mcp, uiDir: tmp() });
  const { port } = await s.listen({ port: 0, host: "127.0.0.1" });
  return { s, port, mcp, home, file: path.join(home, "mcp.json") };
}

test("catalogue: owner sees the store's servers with the exact command; ArcFlare's own are not offered", async () => {
  const { s, port } = await serve("owner");
  const r = await call(port, "GET", "/api/mcp/catalog");
  assert.strictEqual(r.status, 200);
  const ids = r.json.servers.map((x) => x.id);
  assert.ok(ids.includes("filesystem") && ids.includes("memory"));
  assert.ok(!ids.some((i) => i.startsWith("arcflare")));
  const fsrv = r.json.servers.find((x) => x.id === "filesystem");
  assert.strictEqual(fsrv.command, "npx -y @modelcontextprotocol/server-filesystem <folder>");
  assert.deepStrictEqual(fsrv.argument, { name: "folder", about: "the folder it may use (repeat for more)", required: true });
  assert.strictEqual(fsrv.installed, false);
  const git = r.json.servers.find((x) => x.id === "git");
  assert.strictEqual(git.installed, true);
  assert.strictEqual(git.removable, false);      // hand-edited: it has an env
  assert.doesNotMatch(JSON.stringify(r.json), /s3cret/);
  await s.close();
});

test("catalogue still answers offline, from the copy that ships with ArcFlare", async () => {
  const { s, port } = await serve("owner", { offline: true });
  const r = await call(port, "GET", "/api/mcp/catalog");
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.servers.some((x) => x.id === "memory"));
  await s.close();
});

test("a non-owner can neither see the catalogue, install nor remove", async () => {
  const { s, port, file } = await serve("user");
  const before = fs.readFileSync(file, "utf8");
  assert.strictEqual((await call(port, "GET", "/api/mcp/catalog")).status, 403);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "memory" })).status, 403);
  assert.strictEqual((await call(port, "DELETE", "/api/mcp/mine")).status, 403);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
  await s.close();
});

test("install writes exactly the catalogue's command, nothing from the phone, and the server shows off", async () => {
  const { s, port, mcp, file } = await serve("owner");
  const r = await call(port, "POST", "/api/mcp/install", { id: "memory", command: "rm", args: ["-rf", "/"], env: { X: "1" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.name, "memory");
  assert.strictEqual(r.json.enabled, false);
  assert.strictEqual(r.json.status, "off");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(j.mcpServers.memory, { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] });
  assert.deepStrictEqual(j.mcpServers.mine, HAND.mcpServers.mine);   // the rest of the file is kept
  assert.deepStrictEqual(mcp.reg.added, []);                         // nothing was started
  const list = (await call(port, "GET", "/api/mcp")).json.servers;
  const mem = list.find((x) => x.name === "memory");
  assert.strictEqual(mem.enabled, false);
  assert.strictEqual(mem.store, true);
  assert.strictEqual(list.find((x) => x.name === "mine").store, false);
  assert.strictEqual(list.find((x) => x.name === "arcflare-web").store, false);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "memory" })).status, 409);   // already there
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "git" })).status, 409);      // hand-written one kept
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")));
  await s.close();
});

test("install: unknown ids are 404 and arguments are checked like the CLI's", async () => {
  const { s, port, file } = await serve("owner");
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "nope" })).status, 404);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "arcflare" })).status, 404);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "../x" })).status, 400);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", {})).status, 400);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "filesystem" })).status, 400);         // needs a folder
  for (const bad of ["--allow-all", "/tmp; rm -rf /", "a b", "$(id)", "x".repeat(201), "a\nb"]) {
    assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "filesystem", argument: bad })).status, 400, bad);
  }
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "filesystem", argument: ["/tmp"] })).status, 400);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "memory", argument: "/tmp" })).status, 400);  // takes none
  assert.ok(!("filesystem" in JSON.parse(fs.readFileSync(file, "utf8")).mcpServers));
  const ok = await call(port, "POST", "/api/mcp/install", { id: "filesystem", argument: "/home/me/notes" });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.filesystem,
    { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/notes"] });
  await s.close();
});

test("remove: only store servers; switched off first; built-ins and hand-written ones stay", async () => {
  const { s, port, mcp, file } = await serve("owner");
  await call(port, "POST", "/api/mcp/install", { id: "time" });
  assert.strictEqual((await call(port, "POST", "/api/mcp/time", { enabled: true })).json.status, "on");
  const r = await call(port, "DELETE", "/api/mcp/time");
  assert.strictEqual(r.status, 200);
  assert.ok(!("time" in JSON.parse(fs.readFileSync(file, "utf8")).mcpServers));
  assert.ok(!mcp.enabled.has("time") && !mcp.reg.servers.has("time"));
  assert.ok(!(await call(port, "GET", "/api/mcp")).json.servers.some((x) => x.name === "time"));
  assert.strictEqual((await call(port, "DELETE", "/api/mcp/arcflare-desktop")).status, 403);
  assert.strictEqual((await call(port, "DELETE", "/api/mcp/mine")).status, 409);
  assert.strictEqual((await call(port, "DELETE", "/api/mcp/git")).status, 409);
  assert.strictEqual((await call(port, "DELETE", "/api/mcp/nope")).status, 404);
  const j = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers;
  assert.ok(j.mine && j.git);
  await s.close();
});

test("installs and removes from the phone are rate limited", async () => {
  const { s, port } = await serve("owner");
  const ids = ["memory", "time", "sequential-thinking", "playwright", "context7"];
  for (const id of ids) assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id })).status, 200, id);
  for (const id of ids) assert.strictEqual((await call(port, "DELETE", "/api/mcp/" + id)).status, 200, id);
  assert.strictEqual((await call(port, "POST", "/api/mcp/install", { id: "memory" })).status, 429);
  await s.close();
});

test("store.isStoreSpec: the catalogue command plus allowed arguments only", () => {
  const cat = store.bundled().mcp.map(store.cleanMcp).filter(Boolean);
  const fsrv = cat.find((e) => e.id === "filesystem"), mem = cat.find((e) => e.id === "memory");
  assert.ok(store.isStoreSpec(fsrv, { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/a", "/b"] }));
  assert.ok(!store.isStoreSpec(mem, { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory", "/a"] }));
  assert.ok(!store.isStoreSpec(mem, { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: {} }));
  assert.ok(!store.isStoreSpec(mem, { command: "node", args: ["-y", "@modelcontextprotocol/server-memory"] }));
  assert.ok(!store.isStoreSpec(undefined, { command: "npx", args: [] }));
});
