// The agent's session features: project notes, undo checkpoints, saved
// sessions, and interrupting a turn.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const notes = require("../lib/agent/notes");
const { Checkpoints } = require("../lib/agent/checkpoints");
const sessions = require("../lib/agent/sessions");
const tools = require("../lib/agent/tools");
const { Agent, buildSystem, INTERRUPTED_NOTE } = require("../lib/agent/agent");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `af-${name}-`));

// --------------------------------------------------------------- notes ----

test("project notes come from the git root and the working directory", () => {
  const root = tmp("notes");
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "pkg"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Run tests with npm test.\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "ignored: AGENTS.md is here\n");
  fs.writeFileSync(path.join(root, "pkg", "ARCFLARE.md"), "This package is the parser.\n");
  const r = notes.load(path.join(root, "pkg"));
  assert.deepStrictEqual(r.files.map((f) => path.basename(f.path)), ["AGENTS.md", "ARCFLARE.md"]);
  assert.match(r.text, /npm test/);
  assert.match(r.text, /parser/);
  assert.doesNotMatch(r.text, /ignored/);
});

test("CLAUDE.md is read only when a folder has no AGENTS.md or ARCFLARE.md", () => {
  const root = tmp("claude");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use tabs.\n");
  const r = notes.load(root);
  assert.strictEqual(r.files.length, 1);
  assert.match(r.text, /Use tabs/);
  assert.deepStrictEqual(notes.load(tmp("empty")), { text: "", files: [] });
});

test("project notes are capped per file and in total, on a line boundary", () => {
  const root = tmp("caps");
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "sub"));
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i} of the notes`).join("\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), big);
  fs.writeFileSync(path.join(root, "sub", "AGENTS.md"), big);
  const r = notes.load(path.join(root, "sub"), { perFile: 4096, total: 6000 });
  assert.ok(r.files[0].truncated);
  assert.match(r.text, /\[truncated\]/);
  assert.ok(Buffer.byteLength(r.text) < 6000 + 200, `total ${Buffer.byteLength(r.text)}`);
  assert.doesNotMatch(r.text, /line \d+ of the no\n/); // no half lines
});

test("project notes go into the system prompt after the base and before skills", () => {
  const sys = buildSystem({ cwd: "/x", projectNotes: "### AGENTS.md\nAlways run the linter.", skillIndex: ["lint: lint things"] });
  const n = sys.indexOf("## Project notes"), s = sys.indexOf("## Skills");
  assert.ok(n > 0 && s > n);
  assert.match(sys, /Always run the linter/);
  assert.doesNotMatch(buildSystem({ cwd: "/x" }), /Project notes/);
});

// --------------------------------------------------------- checkpoints ----

test("write_file and edit_file are snapshotted, and /undo puts them back", async () => {
  const dir = tmp("undo");
  const kept = path.join(dir, "kept.txt");
  fs.writeFileSync(kept, "original\n");
  const cp = new Checkpoints({ file: path.join(dir, ".cp", "checkpoints.json") });
  const exec = tools.makeExecutor({ cwd: dir, onBeforeWrite: (f) => cp.record(f) });

  cp.begin("turn one");
  await exec("edit_file", { path: "kept.txt", old_string: "original", new_string: "changed" });
  await exec("write_file", { path: "new/made.txt", content: "fresh" });
  await exec("edit_file", { path: "kept.txt", old_string: "changed", new_string: "changed twice" });
  cp.end();
  cp.begin("turn two");
  await exec("write_file", { path: "kept.txt", content: "third\n" });
  cp.end();

  assert.strictEqual(cp.count, 2);
  // One file, recorded once per turn: the state before that turn.
  assert.strictEqual(cp.preview(1)[0].files.length, 1);

  let r = cp.undo(1);
  assert.strictEqual(fs.readFileSync(kept, "utf8"), "changed twice\n");
  assert.deepStrictEqual(r.restored, [kept]);

  // Persisted, so a resumed session can keep undoing.
  const again = Checkpoints.load(path.join(dir, ".cp", "checkpoints.json"));
  assert.strictEqual(again.count, 1);
  r = again.undo(1);
  assert.strictEqual(fs.readFileSync(kept, "utf8"), "original\n");
  assert.ok(!fs.existsSync(path.join(dir, "new", "made.txt")), "a file the turn created is removed");
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(again.count, 0);
});

test("undoing several turns at once ends where the oldest began", async () => {
  const dir = tmp("undo2");
  const f = path.join(dir, "a.txt");
  fs.writeFileSync(f, "v0");
  const cp = new Checkpoints();
  const exec = tools.makeExecutor({ cwd: dir, onBeforeWrite: (p) => cp.record(p) });
  for (const v of ["v1", "v2", "v3"]) { cp.begin(v); await exec("write_file", { path: "a.txt", content: v }); cp.end(); }
  cp.undo(2);
  assert.strictEqual(fs.readFileSync(f, "utf8"), "v1");
  assert.strictEqual(cp.count, 1);
});

test("a turn that changed no files leaves nothing to undo", () => {
  const cp = new Checkpoints();
  cp.begin("just reading");
  cp.end();
  assert.strictEqual(cp.count, 0);
});

// ------------------------------------------------------------ sessions ----

test("sessions save, list by folder, load by prefix, and prune", () => {
  const home = tmp("home");
  const prev = process.env.ARCFLARE_HOME;
  process.env.ARCFLARE_HOME = home;
  try {
    const cwd = tmp("proj");
    assert.strictEqual(sessions.save({ id: "x", cwd, messages: [{ role: "system", content: "s" }] }), null,
      "nothing worth keeping without a user message");
    const id = sessions.newId(new Date(2026, 9, 8, 14, 32));
    assert.match(id, /^20261008-1432-[0-9a-f]{6}$/);
    sessions.save({
      id, cwd, model: "qwen3", modelRef: "qwen3:q4",
      messages: [{ role: "system", content: "old prefix" }, { role: "user", content: "fix the   parser\nplease" }, { role: "assistant", content: "done" }],
    });
    const doc = sessions.load(id);
    assert.strictEqual(doc.title, "fix the parser please");
    assert.ok(!doc.messages.some((m) => m.role === "system"), "the prefix is rebuilt on resume, not saved");
    assert.strictEqual(sessions.find(id.slice(0, 16)).id, id);
    assert.strictEqual(sessions.list({ cwd }).length, 1);
    assert.strictEqual(sessions.list({ cwd: tmp("other") }).length, 0);

    for (let i = 0; i < 4; i++) {
      sessions.save({ id: `p${i}`, cwd, messages: [{ role: "user", content: `q${i}` }] });
      fs.mkdirSync(sessions.folderFor(`p${i}`), { recursive: true });
    }
    sessions.prune(2);
    assert.strictEqual(sessions.list().length, 2);
  } finally {
    if (prev === undefined) delete process.env.ARCFLARE_HOME; else process.env.ARCFLARE_HOME = prev;
  }
});

test("--resume and --continue are taken out of argv before the model is picked", async () => {
  const home = tmp("home2");
  const prev = process.env.ARCFLARE_HOME;
  process.env.ARCFLARE_HOME = home;
  try {
    const cwd = tmp("proj2");
    const { resolveResume } = require("../lib/agent/run");
    sessions.save({ id: "20261008-1000-aaaaaa", cwd, messages: [{ role: "user", content: "older" }] });
    await new Promise((r) => setTimeout(r, 15));
    sessions.save({ id: "20261008-1100-bbbbbb", cwd, messages: [{ role: "user", content: "newer" }] });

    let r = await resolveResume(["agent", "qwen3", "--continue"], cwd);
    assert.deepStrictEqual(r.argv, ["agent", "qwen3"]);
    assert.strictEqual(r.session.id, "20261008-1100-bbbbbb");

    r = await resolveResume(["agent", "--resume", "20261008-1000"], cwd);
    assert.deepStrictEqual(r.argv, ["agent"]);
    assert.strictEqual(r.session.id, "20261008-1000-aaaaaa");

    // A word after --resume that is not a session stays: it's the model.
    r = await resolveResume(["agent", "--resume", "qwen3"], cwd);
    assert.deepStrictEqual(r.argv, ["agent", "qwen3"]);

    r = await resolveResume(["agent", "--continue"], tmp("nothing-here"));
    assert.strictEqual(r.session, null);
    assert.ok(r.none);
  } finally {
    if (prev === undefined) delete process.env.ARCFLARE_HOME; else process.env.ARCFLARE_HOME = prev;
  }
});

// ----------------------------------------------------------- interrupt ----

/** A fake llama-server that streams a few words slowly and never finishes on its own. */
function slowServer() {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let n = 0;
    const words = ["Looking", " at", " the", " parser", " now"];
    const t = setInterval(() => {
      if (res.destroyed) return clearInterval(t);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[n++ % words.length] } }] })}\n\n`);
    }, 40);
    res.on("close", () => clearInterval(t));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test("abort() stops a streaming turn and keeps what was said, marked", async () => {
  const server = await slowServer();
  const events = [];
  const agent = new Agent({ port: server.address().port, model: "m", cwd: os.tmpdir(), onEvent: (e) => events.push(e.type) });
  const turn = agent.send("explain the parser");
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(agent.busy);
  agent.abort();
  const res = await turn;
  server.close();
  assert.strictEqual(res.aborted, true);
  assert.ok(!agent.busy);
  const last = agent.messages[agent.messages.length - 1];
  assert.strictEqual(last.role, "assistant");
  assert.match(last.content, /Looking at/);
  assert.ok(last.content.endsWith(INTERRUPTED_NOTE));
  assert.ok(events.includes("interrupted"));
});

test("a pending note rides along with the next user message", async () => {
  const agent = new Agent({ port: 1, model: "m", cwd: os.tmpdir() });
  agent.pendingNote = "[Note: files were undone]";
  agent.abort(); // idle: harmless
  // Port 1 refuses the connection; only the message that was sent matters here.
  await agent.send("carry on");
  const user = agent.messages.find((m) => m.role === "user");
  assert.match(user.content, /^\[Note: files were undone\]\n\ncarry on$/);
  assert.strictEqual(agent.pendingNote, "");
});

test("reset() starts a new conversation with a rebuilt prefix", () => {
  const agent = new Agent({ port: 1, model: "m", cwd: os.tmpdir(), projectNotes: "old notes" });
  agent.messages.push({ role: "user", content: "hi" });
  agent.reset({ projectNotes: "new notes" });
  assert.strictEqual(agent.messages.length, 1);
  assert.match(agent.system, /new notes/);
  agent.loadConversation([{ role: "system", content: "stale" }, { role: "user", content: "resumed" }]);
  assert.strictEqual(agent.messages[0].content, agent.system);
  assert.strictEqual(agent.conversation().length, 1);
  const u = agent.usage();
  assert.ok(u.notes > 0 && u.system > 0 && u.tools > 0 && u.conversation > 0);
});

test("a running shell command is killed when the turn is interrupted", async () => {
  const ctl = new AbortController();
  const t0 = Date.now();
  const p = tools.runShell("sleep 20", { cwd: os.tmpdir(), timeoutMs: 60000, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 300);
  const r = await p;
  assert.ok(r.aborted || r.error, JSON.stringify(r));
  assert.ok(Date.now() - t0 < 10000, "it stopped well before the command would have");
});
