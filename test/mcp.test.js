// Tests for the machine server: the protocol, the process supervisor, the
// project detection, and the parsers that turn a build or test log into a
// verdict. The last group matters most — a wrong summary is worse than no
// summary, because it reports a broken build as green.
//
// The end-to-end test at the bottom drives the real server over stdio using
// ArcFlare's own MCP client, which is the only way to prove the two halves
// actually speak to each other.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Server } = require("../lib/mcp/server");
const { Supervisor, Ring, resolveShell, tailLines } = require("../lib/mcp/procs");
const project = require("../lib/mcp/project");
const probe = require("../lib/mcp/probe");
const { createServer, makePolicy } = require("../lib/mcp/tools");
const desktop = require("../lib/mcp/desktop");
const { McpServer, resultToText } = require("../lib/agent/mcp");
const { withBuiltinServer } = require("../lib/agent/run");

const IS_WIN = process.platform === "win32";
function tmpdir(n) { return fs.mkdtempSync(path.join(os.tmpdir(), "afm-" + n + "-")); }

// Ask the OS for a port rather than guessing one. A guessed port that another
// test just released still accepts connections for a moment on Windows, which
// makes "is it listening?" answer yes for a server that never started.
function freePort() {
  return new Promise((resolve) => {
    const srv = require("net").createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// -------------------------------------------------------------- protocol ----

test("initialize answers with the version the client asked for", async () => {
  const s = new Server({ name: "t", version: "1", instructions: "hello" });
  const res = await s.handle({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {} },
  });
  assert.strictEqual(res.result.protocolVersion, "2024-11-05");
  assert.strictEqual(res.result.serverInfo.name, "t");
  assert.strictEqual(res.result.instructions, "hello");
  assert.ok(res.result.capabilities.tools);
});

test("an unknown protocol version falls back to one we support", async () => {
  const s = new Server({});
  const res = await s.handle({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" },
  });
  assert.match(res.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test("notifications get no reply, unknown methods get an error", async () => {
  const s = new Server({});
  assert.strictEqual(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const err = await s.handle({ jsonrpc: "2.0", id: 2, method: "nope" });
  assert.strictEqual(err.error.code, -32601);
});

test("a tool that throws is a result, not a protocol error", async () => {
  const s = new Server({});
  s.tool("boom", "explodes", { type: "object" }, () => { throw new Error("it broke"); });
  const res = await s.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "boom" } });
  assert.ok(!res.error, "the request itself succeeded");
  assert.strictEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /it broke/);
  // No double labelling: the flag carries the failure, the text carries the reason.
  assert.ok(!/^ERROR: ERROR/.test(res.result.content[0].text));
});

test("calling a tool that does not exist is an invalid-params error", async () => {
  const s = new Server({});
  const res = await s.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ghost" } });
  assert.strictEqual(res.error.code, -32602);
});

test("every tool the machine server exposes has a schema and a description", () => {
  const s = createServer({});
  const tools = s.list();
  assert.ok(tools.length >= 12, `expected a full surface, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
    assert.strictEqual(t.inputSchema.type, "object", `${t.name} schema`);
  }
  const names = tools.map((t) => t.name);
  for (const want of ["run", "start", "stop", "open", "launch", "project", "build", "test", "smoke"]) {
    assert.ok(names.includes(want), `missing ${want}`);
  }
});

// ------------------------------------------------------------------ procs ----

test("run captures stdout, stderr and the exit code", async () => {
  const s = new Supervisor();
  const r = await s.run({
    command: `node -e "console.log('out'); console.error('err'); process.exit(3)"`,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 3);
  assert.match(r.stdout, /out/);
  assert.match(r.stderr, /err/);
  assert.match(r.output, /\[stderr\] err/, "merged output marks stderr");
});

test("run enforces its timeout and says so", async () => {
  const s = new Supervisor();
  const r = await s.run({ command: `node -e "setTimeout(()=>{}, 20000)"`, timeout_ms: 1000 });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.ok, false);
  assert.ok(r.durationMs < 15000, "killed rather than waited out");
});

test("a background process can be started, read, written to and stopped", async () => {
  const s = new Supervisor();
  const rec = s.start({
    command: `node -e "process.stdin.on('data',d=>console.log('echo:'+String(d).trim()))"`,
    name: "echo",
  });
  assert.ok(rec.pid, "has a pid");
  assert.strictEqual(s.list().find((p) => p.id === rec.id).running, true);

  s.write(rec.id, "ping");
  await s.waitFor(rec.id, (r) => /echo:ping/.test(r.ring.text()), 8000);
  assert.match(s.logs(rec.id).text, /echo:ping/);

  s.stop(rec.id);
  await s.waitFor(rec.id, (r) => r.exitedAt != null, 8000);
  assert.ok(s.get(rec.id).exitedAt != null, "stopped");
});

test("stopping a process that already exited is reported, not thrown", async () => {
  const s = new Supervisor();
  const rec = s.start({ command: `node -e "process.exit(0)"` });
  await s.waitFor(rec.id, (r) => r.exitedAt != null, 8000);
  assert.strictEqual(s.stop(rec.id).alreadyExited, true);
});

test("the output ring drops the oldest bytes and admits how many", () => {
  const r = new Ring(100);
  for (let i = 0; i < 50; i++) r.push("out", `line ${i}\n`);
  assert.ok(r.bytes <= 100 + 10, "stays near the cap");
  assert.ok(r.dropped > 0, "reports what it threw away");
  assert.match(r.text(), /line 49/, "keeps the newest");
  assert.ok(!/line 0\n/.test(r.text()), "drops the oldest");
});

test("tailLines keeps the end and says what it cut", () => {
  const text = Array.from({ length: 30 }, (_, i) => "l" + i).join("\n");
  const out = tailLines(text, 5);
  assert.match(out, /l29$/);
  assert.match(out, /25 earlier lines/);
  assert.strictEqual(tailLines("short", 10), "short");
});

test("shell selection avoids PowerShell 5.1 for chained commands", () => {
  const auto = resolveShell("auto", "a && b");
  assert.ok(["bash", "cmd", "sh"].includes(auto.label), `auto picked ${auto.label}`);
  if (IS_WIN) {
    const c = resolveShell("cmd", "npm test");
    assert.strictEqual(c.verbatim, true, "cmd needs verbatim arguments to survive quoting");
    assert.match(c.args[c.args.length - 1], /^".*"$/);
    assert.strictEqual(resolveShell("powershell", "x").label, "powershell");
  }
  assert.strictEqual(resolveShell("none", "x"), null);
});

// -------------------------------------------------------------- detection ----

test("detect reads a node project, its manager and its real commands", () => {
  const d = tmpdir("node");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
    name: "thing", version: "2.0.0",
    scripts: { build: "tsc", test: "vitest run", dev: "vite" },
    dependencies: { vite: "^5" },
  }));
  fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "");
  const info = project.detect(d);
  assert.strictEqual(info.primary.kind, "node");
  assert.strictEqual(info.primary.manager, "pnpm");
  assert.strictEqual(info.commands.build, "pnpm run build");
  assert.strictEqual(info.commands.test, "pnpm test");
  assert.strictEqual(info.commands.start, "pnpm run dev");
  assert.strictEqual(info.commands.install, "pnpm install");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a node project with no test script still gets a way to run its tests", () => {
  const d = tmpdir("node2");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x" }));
  fs.mkdirSync(path.join(d, "test"));
  assert.strictEqual(project.detect(d).commands.test, "node --test");
  fs.rmSync(d, { recursive: true, force: true });
});

test("the placeholder npm test script is not mistaken for a test suite", () => {
  const d = tmpdir("node3");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
    name: "x", scripts: { test: 'echo "Error: no test specified" && exit 1' },
  }));
  assert.strictEqual(project.detect(d).commands.test, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test("detect handles rust, go, python, make and a mixed directory", () => {
  const d = tmpdir("multi");
  fs.writeFileSync(path.join(d, "Cargo.toml"), "[package]\nname = \"x\"\n");
  assert.strictEqual(project.detect(d).commands.test, "cargo test");

  const g = tmpdir("go");
  fs.writeFileSync(path.join(g, "go.mod"), "module x\n");
  assert.strictEqual(project.detect(g).commands.build, "go build ./...");

  const p = tmpdir("py");
  fs.writeFileSync(path.join(p, "requirements.txt"), "pytest\n");
  assert.match(project.detect(p).commands.test, /pytest/);

  const m = tmpdir("make");
  fs.writeFileSync(path.join(m, "Makefile"), "all: build\nbuild:\n\tcc x.c\ntest:\n\t./a.out\n.PHONY: all\n");
  const mi = project.detect(m);
  assert.strictEqual(mi.commands.test, "make test");
  assert.deepStrictEqual(mi.primary.targets, ["all", "build", "test"]);

  // Both at once: node wins as primary, but the rust command is still reachable.
  const both = tmpdir("both");
  fs.writeFileSync(path.join(both, "package.json"), JSON.stringify({ name: "ui" }));
  fs.writeFileSync(path.join(both, "Cargo.toml"), "[package]\n");
  const bi = project.detect(both);
  assert.strictEqual(bi.primary.kind, "node");
  assert.strictEqual(project.commandFor(bi, "test").command, "cargo test");

  for (const x of [d, g, p, m, both]) fs.rmSync(x, { recursive: true, force: true });
});

// ---------------------------------------------------------------- parsing ----

test("summarizeTests reads node:test TAP", () => {
  const s = project.summarizeTests(`
ok 1 - adds
not ok 2 - subtracts
# tests 2
# pass 1
# fail 1
`);
  assert.strictEqual(s.framework, "node:test");
  assert.strictEqual(s.passed, 1);
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(s.ok, false);
  assert.deepStrictEqual(s.failing, ["subtracts"]);
});

test("summarizeTests reads jest, pytest, cargo, go and mocha", () => {
  const jest = project.summarizeTests("Tests:       2 failed, 1 skipped, 5 passed, 8 total");
  assert.strictEqual(jest.failed, 2);
  assert.strictEqual(jest.passed, 5);
  assert.strictEqual(jest.skipped, 1);

  const py = project.summarizeTests(
    "=========== FAILURES ===========\nFAILED tests/test_x.py::test_one - assert 1 == 2\n" +
    "=========== 1 failed, 4 passed in 0.12s ===========");
  assert.strictEqual(py.framework, "pytest");
  assert.strictEqual(py.failed, 1);
  assert.strictEqual(py.passed, 4);
  assert.deepStrictEqual(py.failing, ["tests/test_x.py::test_one"]);

  const rust = project.summarizeTests(
    "---- tests::math stdout ----\ntest result: FAILED. 3 passed; 1 failed; 2 ignored");
  assert.strictEqual(rust.passed, 3);
  assert.strictEqual(rust.failed, 1);
  assert.strictEqual(rust.skipped, 2);
  assert.deepStrictEqual(rust.failing, ["tests::math"]);

  const go = project.summarizeTests("--- FAIL: TestAdd (0.00s)\nFAIL\nFAIL\texample/pkg\t0.2s");
  assert.strictEqual(go.failed, 1);
  assert.deepStrictEqual(go.failing, ["TestAdd"]);

  const mocha = project.summarizeTests("  12 passing (30ms)\n  2 failing\n\n  1) Array indexOf works");
  assert.strictEqual(mocha.passed, 12);
  assert.strictEqual(mocha.failed, 2);
});

test("summarizeTests returns null rather than inventing a green run", () => {
  assert.strictEqual(project.summarizeTests("compiling…\nlinking…\ndone"), null);
  assert.strictEqual(project.summarizeTests(""), null);
});

test("diagnostics pulls the useful lines out of a wall of build log", () => {
  const log = `
> tsc -p .
src/app.ts:10:5 - error TS2304: Cannot find name 'foo'
    at Object.<anonymous> (/x/y.js:1:1)
src/app.ts:10:5 - error TS2304: Cannot find name 'foo'
Traceback (most recent call last):
  File "x.py", line 2, in <module>
ValueError: bad input
npm ERR! code ELIFECYCLE
`;
  const d = project.diagnostics(log);
  assert.ok(d.some((l) => /TS2304/.test(l)), "keeps the compiler error");
  assert.strictEqual(d.filter((l) => /TS2304/.test(l)).length, 1, "deduplicates");
  assert.ok(!d.some((l) => /^\s+at /.test(l)), "drops stack frames");
  assert.ok(d.some((l) => /Traceback.*ValueError: bad input/.test(l)),
    "pairs a traceback with its exception");
  assert.ok(d.some((l) => /npm ERR!/.test(l)));
});

// ----------------------------------------------------------------- policy ----

test("roots confine where commands may run", () => {
  const root = tmpdir("root");
  const p = makePolicy({ roots: [root] });
  assert.strictEqual(p.dir(root), fs.realpathSync(root) === root ? root : path.resolve(root));
  assert.throws(() => p.dir(path.join(root, "..", "elsewhere")), /outside the allowed roots/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unrecoverable commands are refused before they are spawned", () => {
  const p = makePolicy({});
  assert.throws(() => p.command("rm -rf /"), /unrecoverable/);
  assert.throws(() => p.command("mkfs.ext4 /dev/sda"), /unrecoverable/);
  assert.strictEqual(p.command("npm test"), "npm test");
});

test("the agent connects the machine server unless told otherwise", () => {
  const empty = { file: null, servers: {} };
  assert.ok(withBuiltinServer(empty, {}).servers.arcflare, "on by default");
  assert.strictEqual(Object.keys(withBuiltinServer(empty, { machine: false }).servers).length, 0);
  const mine = { file: "x", servers: { arcflare: { command: "mine" } } };
  assert.strictEqual(withBuiltinServer(mine, {}).servers.arcflare.command, "mine",
    "a configured server of the same name wins");
});

// ---------------------------------------------------------------- desktop ----

test("key chords translate to SendKeys, and unknown ones are refused", () => {
  assert.strictEqual(desktop.toSendKeys("enter"), "{ENTER}");
  assert.strictEqual(desktop.toSendKeys("ctrl+s"), "^s");
  assert.strictEqual(desktop.toSendKeys("alt+f4"), "%{F4}");
  assert.strictEqual(desktop.toSendKeys("ctrl+shift+p"), "^+p");
  assert.strictEqual(desktop.toSendKeys("CTRL+A"), "^a");
  assert.throws(() => desktop.toSendKeys("ctrl+nonsense"), /unknown key/);
  assert.throws(() => desktop.toSendKeys("hyper+a"), /unknown modifier/);
});

test("typed text is escaped so SendKeys syntax cannot fire by accident", () => {
  // +^%~(){}[] are SendKeys operators: typed raw, "100%" presses Alt.
  assert.strictEqual(desktop.escapeText("100%"), "100{%}");
  assert.strictEqual(desktop.escapeText("a+b^c~d"), "a{+}b{^}c{~}d");
  assert.strictEqual(desktop.escapeText("fn(x){ y[0] }"), "fn{(}x{)}{{} y{[}0{]} {}}");
  assert.strictEqual(desktop.escapeText("plain text"), "plain text");
});

test("the desktop tools say what this platform supports", () => {
  const s = desktop.support();
  assert.strictEqual(typeof s.how, "string");
  assert.strictEqual(s.ok, process.platform === "win32");
});

// A caller's string becomes part of a PowerShell script, so the question is not
// whether it is escaped but whether it is *parsed*. Base64 is the answer: there
// is no character in it the parser reacts to.
test("strings handed to PowerShell carry no syntax of their own", () => {
  const nasty = `$(Get-Content C:/secret)"; whoami; #\`n'`;
  const expr = desktop.psLiteral(nasty);
  assert.match(expr, /^\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]*'\)\)$/,
    "nothing but base64 inside the quotes");
  const b64 = /'([A-Za-z0-9+/=]*)'/.exec(expr)[1];
  assert.strictEqual(Buffer.from(b64, "base64").toString("utf8"), nasty, "and it survives intact");
});

// The bug this replaced: the title was doubled-quote-escaped for the -like
// pattern, then interpolated again into the thrown message — a double-quoted
// string, where PowerShell evaluates $(...). A window title was a shell.
test("a window title is never evaluated as PowerShell",
  { skip: process.platform !== "win32" ? "windows only" : false }, async () => {
    for (const fn of [
      (t) => desktop.screenshot({ window: t }),
      (t) => desktop.focusWindow(t),
    ]) {
      await assert.rejects(() => fn("$(7*6)-nosuchwindow"), (e) => {
        assert.match(e.message, /\$\(7\*6\)-nosuchwindow/, "the title comes back as written");
        assert.doesNotMatch(e.message, /42/, "not as the result of running it");
        return true;
      });
    }
  });

// Capturing the screen is safe and fast; injecting input into whatever the user
// has open is not, so only the read half runs here.
test("screenshot captures the screen and reports how to convert its coordinates",
  { skip: process.platform !== "win32" ? "windows only" : false }, async () => {
    const shot = await desktop.screenshot({ max_width: 400 });
    assert.ok(shot.width > 0 && shot.height > 0, "the desktop has a size");
    assert.ok(shot.shotWidth <= 400, "scaled down to the requested width");
    assert.ok(shot.scale > 0 && shot.scale <= 1);
    assert.strictEqual(shot.mimeType, "image/png");
    assert.ok(shot.base64.length > 100, "there are pixels in it");
    assert.ok(fs.existsSync(shot.file), "and a file on disk to re-read");
    fs.rmSync(shot.file, { force: true });
  });

test("windows can be listed", { skip: process.platform !== "win32" ? "windows only" : false },
  async () => {
    const list = await desktop.listWindows();
    assert.ok(Array.isArray(list));
    for (const w of list.slice(0, 3)) {
      assert.strictEqual(typeof w.title, "string");
      assert.strictEqual(typeof w.pid, "number");
    }
  });

// ------------------------------------------------------------------- http ----

test("httpProbe reports a real answer and a refused connection differently", async () => {
  const http = require("http");
  const p = await freePort();
  const srv = http.createServer((req, res) => { res.writeHead(204); res.end(); });
  await new Promise((r) => srv.listen(p, "127.0.0.1", r));

  const ok = await probe.httpProbe(`http://127.0.0.1:${p}/`);
  assert.strictEqual(ok.status, 204);
  assert.match(probe.describe(ok), /HTTP 204/);
  assert.strictEqual(await probe.portOpen("127.0.0.1", p), true);

  await new Promise((r) => srv.close(r));
  const dead = await probe.httpProbe(`http://127.0.0.1:${p}/`);
  assert.ok(dead.error, "a refused connection is an error, not a status");
  assert.strictEqual(await probe.portOpen("127.0.0.1", p, 500), false);
});

// -------------------------------------------------------------------- e2e ----

test("end to end: a client spawns the server and tests a project with it", async (t) => {
  const d = tmpdir("e2e");
  const p = await freePort();
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
    name: "demo", version: "1.0.0", scripts: { start: "node server.js" },
  }));
  fs.writeFileSync(path.join(d, "server.js"),
    `const http=require("http");http.createServer((q,s)=>{s.writeHead(200,{"Content-Type":"text/html"});` +
    `s.end("<h1>demo is alive</h1>")}).listen(${p},()=>console.log("listening on ${p}"));`);
  fs.mkdirSync(path.join(d, "test"));
  fs.writeFileSync(path.join(d, "test", "a.test.js"),
    `const test=require("node:test");const a=require("node:assert");\n` +
    `test("passes",()=>a.ok(true));\ntest("fails",()=>a.strictEqual(2+2,5));\n`);

  const client = new McpServer("arcflare", {
    command: process.execPath,
    args: [path.join(__dirname, "..", "bin", "arcflare-mcp.js")],
  });
  await client.start(20000);
  t.after(() => { client.stop(); try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

  assert.ok(client.tools.length >= 12, "tools arrived over the wire");
  assert.match(client.instructions, /machine server/);

  const call = async (name, args) => resultToText(await client.call(name, args, 120000));

  const info = await call("project", { dir: d });
  assert.match(info, /node \(npm\)/);
  assert.match(info, /node --test/);

  const ran = await call("run", { command: `node -e "console.log(6*7)"`, cwd: d });
  assert.match(ran, /\b42\b/);

  // The point of the test tool: a verdict and the failing name, before the log.
  const tested = await call("test", { dir: d });
  assert.match(tested, /tests FAILED · 1 of 2 failed/);
  assert.match(tested, /failing:\s*\n\s*- fails/);

  // And the point of smoke: the app is only "working" if it answered.
  const smoked = await call("smoke", { dir: d, port: p, expect_text: "demo is alive" });
  assert.match(smoked, /smoke: PASS/);
  assert.match(smoked, /HTTP 200/);

  const after = await call("ps", {});
  assert.ok(!/●/.test(after), "smoke stopped what it started");

  const dead = await freePort();
  const bad = await call("smoke", { dir: d, command: `node -e "process.exit(1)"`, port: dead, ready_timeout_ms: 2000 });
  assert.match(bad, /smoke: FAIL/);
  assert.match(bad, /exited early/);
});
