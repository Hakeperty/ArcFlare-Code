// Tests for the Blender group.
//
// The interesting failures here are quiet ones. Blender exits 0 after a script
// raises, so a green exit code is not a working render; it decides the real
// output filename itself, so the path we asked for is not the path that
// appeared; and the folder a build lives in is not its version. Each of those
// would be reported as success by anything that trusted the obvious signal, so
// each gets a test.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const blender = require("../lib/mcp/blender");

function tmpdir(n) { return fs.mkdtempSync(path.join(os.tmpdir(), "afb-" + n + "-")); }

// ----------------------------------------------------------------- finding --

test("versions sort newest first, including three-part ones", () => {
  const v = blender.versionFromPath("C:/Program Files/Blender Foundation/Blender 5.2");
  assert.deepStrictEqual(v, [5, 2, 0]);
  assert.deepStrictEqual(blender.versionFromPath("/opt/blender-4.11.3"), [4, 11, 3]);
  // 4.11 is newer than 4.2, which a string sort gets backwards.
  const a = blender.versionFromPath("blender-4.11");
  const b = blender.versionFromPath("blender-4.2");
  assert.ok(a[1] > b[1], "4.11 should outrank 4.2");
});

test("a version is read from Blender's own output, not its folder name", () => {
  assert.strictEqual(blender.parseVersion("Blender 5.2.1 LTS (hash 9e2066aef7ef)"), "5.2.1");
  assert.strictEqual(blender.parseVersion("Blender 4.2"), "4.2");
  assert.strictEqual(blender.parseVersion("no version here"), null);
});

// ------------------------------------------------------------------ headless --

test("headless arguments put the blend file before the script", () => {
  const a = blender.headlessArgs({ blend: "scene.blend", expr: "print(1)" });
  assert.ok(a.includes("--background"));
  assert.ok(a.indexOf("--python-expr") > a.findIndex((x) => /scene\.blend$/.test(x)),
    "Blender must open the file before running the script against it");
});

test("script arguments go after --, where Blender stops parsing them", () => {
  const a = blender.headlessArgs({ expr: "print(1)", args: ["--background", "x"] });
  const sep = a.indexOf("--");
  assert.ok(sep > 0, "there should be a -- separator");
  // Without it, this argument would be read as a Blender flag.
  assert.ok(a.indexOf("--background", sep) > sep);
});

test("headless refuses to run with nothing to run", () => {
  assert.throws(() => blender.headlessArgs({}), /expr or script/);
});

test("factory startup is the default and can be turned off", () => {
  assert.ok(blender.headlessArgs({ expr: "x" }).includes("--factory-startup"));
  assert.ok(!blender.headlessArgs({ expr: "x", factoryStartup: false })
    .includes("--factory-startup"));
});

test("Blender's own startup chatter is stripped, and writes are kept", () => {
  const raw = [
    "Blender 5.2.1 LTS (hash 9e2066aef7ef built 2026-08-25)",
    "Read prefs: C:/Users/x/userpref.blend",
    "objects: ['Camera', 'Cube']",
    "Saved: 'C:/tmp/frame_0001.png'",
    "",
    "Blender quit",
  ].join("\n");
  const c = blender.cleanOutput(raw);
  assert.strictEqual(c.text, "objects: ['Camera', 'Cube']");
  assert.deepStrictEqual(c.notes, ["Saved: 'C:/tmp/frame_0001.png'"]);
});

// This is the one that matters: Blender prints the traceback, finishes its
// shutdown and exits 0. Anything reading the exit code calls that a good run.
test("a python traceback is a failure even though Blender exits 0", () => {
  const log = [
    "Blender 5.2.1 LTS",
    "[stderr] Traceback (most recent call last):",
    '[stderr]   File "<string>", line 1, in <module>',
    "[stderr] KeyError: 'NoSuchThing'",
    "Blender quit",
  ].join("\n");
  const e = blender.pythonError(log);
  assert.strictEqual(e.failed, true);
  // The stream label is not part of the error message.
  assert.strictEqual(e.summary, "KeyError: 'NoSuchThing'");
  assert.match(e.detail, /Traceback/);
});

test("a clean run reports no python error", () => {
  assert.strictEqual(blender.pythonError("Blender 5.2.1\nhello\nBlender quit").failed, false);
});

test("an Error: line counts as a failure too", () => {
  const e = blender.pythonError("Error: Cannot read file\nBlender quit");
  assert.strictEqual(e.failed, true);
  assert.match(e.summary, /Cannot read file/);
});

// ------------------------------------------------------------------- render --

test("render arguments set the output before asking for the frame", () => {
  const a = blender.renderArgs({ blend: "s.blend", output: "out/f", frame: 7, engine: "CYCLES" });
  const o = a.indexOf("--render-output");
  const f = a.indexOf("--render-frame");
  assert.ok(o > 0 && f > o,
    "Blender applies these in order; a frame asked for first renders to the saved path");
  assert.strictEqual(a[f + 1], "7");
  assert.strictEqual(a[a.indexOf("--engine") + 1], "CYCLES");
});

test("render refuses without a blend file", () => {
  assert.throws(() => blender.renderArgs({}), /\.blend/);
});

test("rendered files are found by what appeared, not by the name we asked for", () => {
  const dir = tmpdir("render");
  const prefix = path.join(dir, "frame_");
  // Blender appends the frame number and the format's extension itself.
  fs.writeFileSync(prefix + "0001.png", "x".repeat(100));
  fs.writeFileSync(path.join(dir, "unrelated.png"), "y");
  const found = blender.renderedFiles(prefix, Date.now() - 5000);
  assert.strictEqual(found.length, 1);
  assert.match(found[0].path, /frame_0001\.png$/);
  assert.strictEqual(found[0].bytes, 100);
});

test("a stale file from an earlier render is not reported as this one's output", () => {
  const dir = tmpdir("stale");
  const prefix = path.join(dir, "f_");
  const old = prefix + "0001.png";
  fs.writeFileSync(old, "old");
  const longAgo = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
  assert.strictEqual(blender.renderedFiles(prefix, Date.now()).length, 0);
});

// ------------------------------------------------------------------- bridge --

test("the bridge port is read from the driving server's own config", () => {
  const dir = tmpdir("cfg");
  const cfg = path.join(dir, "config.toml");
  fs.writeFileSync(cfg, [
    "[general]",
    "port = 1111",
    "",
    "[blender_bridge]",
    'host = "127.0.0.1"',
    "port = 9886",
    "timeout_seconds = 30",
  ].join("\n"));
  const prev = process.env.BLENDER_MCP_CONFIG;
  const prevPort = process.env.ARCFLARE_BLENDER_PORT;
  delete process.env.ARCFLARE_BLENDER_PORT;
  process.env.BLENDER_MCP_CONFIG = cfg;
  try {
    // Not 1111: the port under [general] belongs to something else.
    assert.strictEqual(blender.bridgePort(), 9886);
  } finally {
    if (prev == null) delete process.env.BLENDER_MCP_CONFIG;
    else process.env.BLENDER_MCP_CONFIG = prev;
    if (prevPort != null) process.env.ARCFLARE_BLENDER_PORT = prevPort;
  }
});

test("nothing listening is reported as Blender being closed, not as a crash", async () => {
  // Port 1 is not going to have a Blender on it.
  const s = await blender.bridgeStatus({ port: 1, timeoutMs: 2000 });
  assert.strictEqual(s.reachable, false);
  assert.match(s.likely, /closed|disabled/);
});

// The addon speaks a length-prefixed frame protocol. Nothing else in ArcFlare
// does, so a wrong header byte order would show up only against a real Blender
// — this stands in for one.
test("a framed request and reply round-trip against a stand-in addon", async () => {
  const seen = [];
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const req = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      seen.push(req);
      const body = Buffer.from(JSON.stringify({
        id: req.id, ok: true, result: { blender: "5.2.1", objects: 3 },
      }), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      sock.end(Buffer.concat([head, body]));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const s = await blender.bridgeStatus({ port });
    assert.strictEqual(s.reachable, true);
    assert.strictEqual(s.status.blender, "5.2.1");
    assert.strictEqual(seen[0].cmd, "system_status");
    assert.ok(seen[0].id, "every request carries an id");
  } finally {
    srv.close();
  }
});

test("an addon that refuses the command is an error, not a reachable bridge", async () => {
  const srv = net.createServer((sock) => {
    sock.on("data", () => {
      const body = Buffer.from(JSON.stringify({
        id: "x", ok: false, error: { type: "RuntimeError", message: "scene is locked" },
      }), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      sock.end(Buffer.concat([head, body]));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await blender.bridgeStatus({ port: srv.address().port });
    assert.strictEqual(s.reachable, false);
    assert.match(s.error, /scene is locked/);
  } finally {
    srv.close();
  }
});

// A port being open is not the same question as the addon answering: something
// else can hold it, and a Blender in a modal operator accepts and never replies.
test("a port that accepts but never answers times out rather than hanging", async () => {
  const srv = net.createServer(() => { /* accept, say nothing */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await blender.bridgeStatus({ port: srv.address().port, timeoutMs: 700 });
    assert.strictEqual(s.reachable, false);
    assert.match(s.error, /timeout/);
    assert.match(s.likely, /did not complete/);
  } finally {
    srv.close();
  }
});

// ------------------------------------------------------------------- tools ---

test("the machine server exposes the Blender group with schemas", () => {
  const { createServer } = require("../lib/mcp/tools");
  const names = createServer({}).list().map((t) => t.name);
  for (const n of ["blender", "blender_launch", "blender_run", "blender_render"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});

test("blender_render will not run without a blend file", () => {
  const { createServer } = require("../lib/mcp/tools");
  const t = createServer({}).list().find((x) => x.name === "blender_render");
  assert.deepStrictEqual(t.inputSchema.required, ["blend"]);
});

test("launching is off when the desktop tools are", async () => {
  const { createServer } = require("../lib/mcp/tools");
  const s = createServer({ allowOpen: false });
  const res = await s.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "blender_launch", arguments: {} },
  });
  assert.strictEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /disabled/);
});
