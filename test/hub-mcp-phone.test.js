// MCP tools for the AI on the phone (lib/hub/mcphub.js phoneTools/callTool and /api/mcp-tools): owner only,
// switched-on servers only, known tools only, arguments checked, results cut short, and no command or env shown.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { McpHub, MAX_RESULT, PHONE_TIMEOUT_MS } = require("../lib/hub/mcphub");
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

test("asking for the tool list again and again tries a server that fails to connect at most once a minute", async (t) => {
  let tries = 0;
  function Failing() { this.servers = new Map(); this.add = async () => { tries++; return { ok: false, error: "exited" }; }; }
  const mcp = new McpHub({ dir: tmp(), load: () => CONFIG, Registry: Failing });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await mcp.setEnabled("clock", true);
  assert.strictEqual(tries, 1);
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await mcp.phoneTools(), []);
  assert.strictEqual(tries, 1, "no new spawn inside the minute");
  now += 61000;
  await mcp.phoneTools();
  await mcp.phoneTools();
  assert.strictEqual(tries, 2, "one try after the minute");
});

test("tool names reach the phone clean and capped, and a call by the clean name runs the real tool", async () => {
  const long = "t".repeat(100);
  const ran = [];
  function Odd() {
    this.servers = new Map();
    this.add = async (name) => {
      this.servers.set(name, {
        tools: [
          { name: "do‮it\u0007", description: "Reversed‮ text​." },
          { name: long },
          { name: "a​b" }, { name: "ab" },                                                      // the same once clean: neither
          { name: "zone", inputSchema: { properties: { "ci‮ty": { type: "string" } } } },      // a parameter shown differently
        ],
        async call(tool) { ran.push(tool); return { content: [{ type: "text", text: "ok" }] }; },
        stop() {},
      });
      return { ok: true };
    };
  }
  const mcp = new McpHub({ dir: tmp(), load: () => CONFIG, Registry: Odd });
  await mcp.setEnabled("clock", true);
  const tools = await mcp.phoneTools();
  assert.deepStrictEqual(tools.map((x) => x.name), ["doit", "t".repeat(80)]);
  assert.strictEqual(tools[0].description, "Reversed text.");
  await mcp.callTool("clock", "doit", {});
  await mcp.callTool("clock", "t".repeat(80), {});
  assert.deepStrictEqual(ran, ["do‮it\u0007", long], "the real names run");
  for (const bad of ["do‮it\u0007", "ab", "a​b", "zone", long]) {
    await assert.rejects(mcp.callTool("clock", bad, {}), (e) => e.status === 404, JSON.stringify(bad));
  }
  assert.strictEqual(ran.length, 2);
});

// A fake server with ArcFlare's phone tools: each call records the timeout the hub gave it.
function PhoneRegistry() {
  this.servers = new Map();
  this.calls = [];
  const reg = this;
  this.add = async (name) => {
    const tool = (n) => ({ name: n, inputSchema: { type: "object", properties: { say: { type: "string" }, call_id: { type: "string" } } } });
    this.servers.set(name, {
      tools: [tool("call_phone"), tool("notify_phone"), tool("ask_phone"), tool("now")],
      async call(t, args, timeoutMs) { reg.calls.push({ t, timeoutMs }); return { content: [{ type: "text", text: "ok" }] }; },
      stop() {},
    });
    return { ok: true };
  };
}

test("tools that ring, notify or ask the phone wait for the person, and other tools keep two minutes", async () => {
  const mcp = new McpHub({ dir: tmp(), load: () => CONFIG, Registry: PhoneRegistry });
  await mcp.setEnabled("clock", true);
  await mcp.callTool("clock", "ask_phone", {});
  await mcp.callTool("clock", "now", {});
  assert.ok(PHONE_TIMEOUT_MS >= 305000, "longer than ask_phone's default wait of 300 s");
  assert.deepStrictEqual(mcp.reg.calls, [{ t: "ask_phone", timeoutMs: PHONE_TIMEOUT_MS }, { t: "now", timeoutMs: 120000 }]);
});

test("an AI on the phone can ring, notify or ask that phone at most 3 times a minute", async (t) => {
  const mcp = new McpHub({ dir: tmp(), load: () => CONFIG, Registry: PhoneRegistry });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await mcp.setEnabled("clock", true);
  await mcp.callTool("clock", "call_phone", { say: "hi" });
  await mcp.callTool("clock", "call_phone", { say: "go on", call_id: "c1" });   // the same call's next turn rings nothing
  await mcp.callTool("clock", "notify_phone", {});
  await mcp.callTool("clock", "ask_phone", {});
  for (const tool of ["call_phone", "notify_phone", "ask_phone"]) {
    await assert.rejects(mcp.callTool("clock", tool, { say: "again" }), (e) => e.status === 429, tool);
  }
  await mcp.callTool("clock", "now", {});   // other tools are not held back
  assert.strictEqual(mcp.reg.calls.length, 5);
  now += 61000;
  await mcp.callTool("clock", "call_phone", { say: "later" });
  assert.strictEqual(mcp.reg.calls.length, 6);
});

test("ArcFlare's phone tools are a built-in server: off at first, and on they reach the hub with its own token", async () => {
  const home = tmp();
  const token = "t".repeat(43);
  const got = [];
  const hubSrv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || "{}") });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, sound: true }));
    });
  });
  await new Promise((r) => hubSrv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(home, "hub"), { recursive: true });
  fs.writeFileSync(path.join(home, "hub", "running.json"), JSON.stringify({ pid: process.pid, port: hubSrv.address().port }));
  fs.writeFileSync(path.join(home, "hub", "local-token"), token, { mode: 0o600 });
  const before = process.env.ARCFLARE_HOME;
  process.env.ARCFLARE_HOME = home;   // as the hub runs: its servers inherit it
  const mcp = new McpHub({ dir: tmp(), home, builtins: true, load: () => ({ servers: {} }) });
  try {
    const row = mcp.list().find((s) => s.name === "arcflare-phone");
    assert.deepStrictEqual([row.builtin, row.enabled, row.status], [true, false, "off"]);
    assert.deepStrictEqual(await mcp.phoneTools(), []);
    assert.strictEqual((await mcp.setEnabled("arcflare-phone", true)).status, "on");
    const tools = await mcp.phoneTools();
    for (const n of ["ask_phone", "notify_phone", "call_phone"]) assert.ok(tools.some((t) => t.server === "arcflare-phone" && t.name === n), n);
    const r = await mcp.callTool("arcflare-phone", "notify_phone", { title: "Build done" });
    assert.deepStrictEqual(r, { text: "sent", isError: false, truncated: false });
    assert.deepStrictEqual(got, [{ url: "/api/local/notify", auth: "Bearer " + token, body: { title: "Build done", body: "" } }]);
    assert.ok(!JSON.stringify([mcp.list(), tools]).includes(token));
  } finally {
    mcp.stopAll();
    if (before === undefined) delete process.env.ARCFLARE_HOME; else process.env.ARCFLARE_HOME = before;
    await new Promise((r) => hubSrv.close(r));
  }
});
