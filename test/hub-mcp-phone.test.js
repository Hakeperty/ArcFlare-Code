// MCP tools for the AI on the phone (lib/hub/mcphub.js phoneTools/callTool and /api/mcp-tools): owner only,
// switched-on servers only, known tools only, arguments checked, results cut short, and no command or env shown.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { McpHub, MAX_RESULT } = require("../lib/hub/mcphub");
const { createHubServer } = require("../lib/hub/server");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcpphone-"));

function FakeRegistry() {
  this.servers = new Map();
  this.calls = [];
  const reg = this;
  this.add = async (name) => {
    this.servers.set(name, {
      tools: [
        { name: "now", description: "The time in a city.\nLong text.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
        { name: "big", description: "Says a lot." },
        { name: "boom", description: "Fails." },
      ],
      async call(tool, args) {
        reg.calls.push({ server: name, tool, args });
        if (tool === "big") return { content: [{ type: "text", text: "x".repeat(MAX_RESULT * 3) }] };
        if (tool === "boom") throw new Error("spawn /home/me/secret/bin/server ENOENT");
        return { content: [{ type: "text", text: "12:00 in " + args.city }] };
      },
      stop() {},
    });
    return { ok: true, name, tools: 3 };
  };
}

const CONFIG = { file: "x", servers: { clock: { command: "py", env: { TOKEN: "s3cret" } }, other: { command: "node" } } };
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
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks)); } catch { /* */ } resolve({ status: res.statusCode, json, raw: Buffer.concat(chunks).toString() }); });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
async function serve(role) {
  const mcp = new McpHub({ dir: tmp(), load: () => CONFIG, Registry: FakeRegistry });
  await mcp.setEnabled("clock", true);
  const sup = new EventEmitter();
  sup.list = () => [];
  const s = createHubServer({ auth: fakeAuth(role), supervisor: sup, helpers, mcp, uiDir: tmp() });
  const { port } = await s.listen({ port: 0, host: "127.0.0.1" });
  return { s, port, mcp };
}

test("a non-owner account can neither list nor call the tools", async () => {
  const { s, port, mcp } = await serve("member");
  try {
    assert.strictEqual((await call(port, "GET", "/api/mcp-tools")).status, 403);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: { city: "Tokyo" } })).status, 403);
    assert.strictEqual(mcp.reg.calls.length, 0);
  } finally { await s.close(); }
});

test("the owner gets the switched-on servers' tools with their parameters, and nothing of the command or env", async () => {
  const { s, port } = await serve("owner");
  try {
    const r = await call(port, "GET", "/api/mcp-tools");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.tools.map((t) => t.server + "." + t.name), ["clock.now", "clock.big", "clock.boom"]);   // "other" is off
    assert.deepStrictEqual(r.json.tools[0], { server: "clock", name: "now", description: "The time in a city.", params: [{ name: "city", type: "string", required: true }] });
    assert.ok(!r.raw.includes("s3cret") && !r.raw.includes("py"));
  } finally { await s.close(); }
});

test("a call runs on a switched-on server and returns its text", async () => {
  const { s, port, mcp } = await serve("owner");
  try {
    const r = await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: { city: "Tokyo" } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { text: "12:00 in Tokyo", isError: false, truncated: false });
    assert.deepStrictEqual(mcp.reg.calls, [{ server: "clock", tool: "now", args: { city: "Tokyo" } }]);
  } finally { await s.close(); }
});

test("a switched-off or unknown server, or an unknown tool, is refused and nothing runs", async () => {
  const { s, port, mcp } = await serve("owner");
  try {
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "other", tool: "now", args: {} })).status, 404);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "nope", tool: "now", args: {} })).status, 404);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "constructor", tool: "now", args: {} })).status, 404);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "rm", args: {} })).status, 404);
    await mcp.setEnabled("clock", false);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: {} })).status, 404);
    assert.strictEqual(mcp.reg.calls.length, 0);
  } finally { await s.close(); }
});

test("bad arguments are refused before anything runs", async () => {
  const { s, port, mcp } = await serve("owner");
  try {
    for (const args of [[1, 2], "city=Tokyo", null, 5]) {
      assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args })).status, 400, JSON.stringify(args));
    }
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: { city: "x".repeat(1500) } })).status, 413);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { tool: "now" })).status, 400);
    assert.strictEqual(mcp.reg.calls.length, 0);
  } finally { await s.close(); }
});

test("a long result is cut short, and a failure is a short error without paths", async () => {
  const { s, port } = await serve("owner");
  try {
    const big = await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "big" });
    assert.strictEqual(big.status, 200);
    assert.ok(big.json.truncated);
    assert.ok(big.json.text.length < MAX_RESULT + 100, String(big.json.text.length));
    assert.match(big.json.text, /cut off: the result was 12000 characters/);
    const boom = await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "boom" });
    assert.strictEqual(boom.status, 502);
    assert.ok(!boom.raw.includes("secret"), boom.raw);
  } finally { await s.close(); }
});

test("a runaway loop of calls is stopped after 20 a minute", async () => {
  const { s, port, mcp } = await serve("owner");
  try {
    for (let i = 0; i < 20; i++) assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: { city: "A" } })).status, 200);
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: { city: "A" } })).status, 429);
    // The server has stopped since: a refused call does not start it again.
    mcp._drop("clock");
    let started = 0;
    const add = mcp.reg.add;
    mcp.reg.add = (...a) => { started++; return add(...a); };
    assert.strictEqual((await call(port, "POST", "/api/mcp-tools/call", { server: "clock", tool: "now", args: { city: "A" } })).status, 429);
    assert.strictEqual(started, 0);
    assert.ok(!mcp.reg.servers.has("clock"));
  } finally { await s.close(); }
});
