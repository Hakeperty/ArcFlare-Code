// Approvals: the approver sees the whole call, and can allow, skip, edit or deny.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NO_COLOR = "1";
const tools = require("../lib/agent/tools");
const { lineDiff, diffStat } = require("../lib/agent/diff");
const { makeApprover, approvalPreview } = require("../lib/agent/run");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "af-approve-"));

function executor(dir, approve, extra = {}) {
  return tools.makeExecutor({ cwd: dir, approve, ...extra });
}

test("the approver gets the full command and structured call", async () => {
  const dir = tmp();
  const long = "echo " + "x".repeat(400);
  let seen;
  const run = executor(dir, async (kind, detail, call) => { seen = { kind, detail, call }; return true; });
  const out = await run("bash", { command: long });
  assert.strictEqual(seen.kind, "bash");
  assert.strictEqual(seen.detail, long, "detail is the whole command, not 160 characters");
  assert.strictEqual(seen.call.command, long);
  assert.match(out, /x{400}/);
});

test("an old (kind, detail) approver still works", async () => {
  const dir = tmp();
  const run = executor(dir, async (kind) => kind === "bash");
  assert.match(await run("bash", { command: "echo ok" }), /ok/);
});

test("skip returns a tool result the model can carry on from", async () => {
  const dir = tmp();
  const run = executor(dir, async () => ({ action: "skip", reason: "not now" }));
  const out = await run("bash", { command: "echo should-not-run" });
  assert.match(out, /^SKIPPED: the user chose not to run this command \("not now"\)/);
  assert.doesNotMatch(out, /should-not-run\n/);
  const w = await run("write_file", { path: "a.txt", content: "hi" });
  assert.match(w, /^SKIPPED: the user chose not to write a\.txt/);
  assert.ok(!fs.existsSync(path.join(dir, "a.txt")), "a skipped write writes nothing");
});

test("deny is still an error, distinct from skip", async () => {
  const dir = tmp();
  const run = executor(dir, async () => false);
  assert.match(await run("bash", { command: "echo no" }), /^ERROR: the user declined/);
});

test("edit runs the edited command and tells the model what ran", async () => {
  const dir = tmp();
  const run = executor(dir, async () => ({ action: "edit", command: "echo edited-ran" }));
  const out = await run("bash", { command: "echo original" });
  assert.match(out, /^NOTE: the user edited the command before it ran\. What ran instead:\necho edited-ran\n/);
  assert.match(out, /edited-ran\s*$/);
  assert.doesNotMatch(out, /original/);
});

test("an edited command still goes through the destructive-command guard", async () => {
  const dir = tmp();
  const run = executor(dir, async () => ({ action: "edit", command: "rm -rf /" }));
  assert.match(await run("bash", { command: "echo hi" }), /^ERROR: refused — the edited command looks destructive/);
});

test("writes are approved with a diff of the change", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "f.js"), "one\ntwo\nthree\n");
  const calls = [];
  const run = executor(dir, async (kind, detail, call) => { calls.push({ kind, detail, call }); return true; });
  await run("edit_file", { path: "f.js", old_string: "two", new_string: "TWO" });
  assert.strictEqual(calls[0].kind, "write");
  assert.strictEqual(calls[0].call.oldText, "one\ntwo\nthree\n");
  assert.strictEqual(calls[0].call.newText, "one\nTWO\nthree\n");
  assert.match(calls[0].detail, /- two\n\+ TWO/);
  await run("write_file", { path: "new.txt", content: "a\nb" });
  assert.strictEqual(calls[1].call.isNew, true);
  assert.match(calls[1].detail, /new file, 2 lines/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "f.js"), "utf8"), "one\nTWO\nthree\n");
});

test("approveWrites: false lets writes through without asking", async () => {
  const dir = tmp();
  let asked = 0;
  const run = executor(dir, async () => { asked++; return false; }, { approveWrites: false });
  assert.match(await run("write_file", { path: "x.txt", content: "y" }), /^wrote/);
  assert.strictEqual(asked, 0);
});

test("lineDiff trims shared lines and keeps a little context", () => {
  const rows = lineDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nD\ne\nf\n", { context: 1 });
  assert.deepStrictEqual(rows.map((r) => r.sign + r.text), ["…2 unchanged lines", " c", "-d", "+D", " e", "…1 unchanged line"]);
  assert.deepStrictEqual(diffStat(rows), { del: 1, add: 1 });
});

test("terminal approver: allow-for-session is per kind", async () => {
  const answers = ["a"];
  const asked = [];
  const approve = makeApprover("ask", {
    isTTY: true, write: () => {},
    select: async (title, items) => { asked.push(items.map((i) => i.value)); return answers.shift(); },
  });
  assert.strictEqual(await approve("bash", "ls", { command: "ls" }), true);
  assert.strictEqual(await approve("bash", "pwd", { command: "pwd" }), true, "bash is now allowed without asking");
  assert.strictEqual(asked.length, 1);
  answers.push("n");
  assert.strictEqual(await approve("write", "f", { kind: "write", isNew: true, newText: "x", rel: "f" }), false, "writes still ask");
  assert.strictEqual(asked.length, 2);
});

test("terminal approver: edit and skip choices", async () => {
  const picks = ["e", "s"];
  const approve = makeApprover("ask", {
    isTTY: true, write: () => {},
    select: async (title, items) => {
      assert.ok(items.some((i) => i.value === "e"), "bash offers Edit");
      return picks.shift();
    },
    editLine: async (prompt, initial) => (initial === "" ? "too slow" : initial.replace("x", "y")),
  });
  assert.deepStrictEqual(await approve("bash", "echo x", { command: "echo x" }), { action: "edit", command: "echo y" });
  assert.deepStrictEqual(await approve("bash", "echo x", { command: "echo x" }), { action: "skip", reason: "too slow" });
});

test("terminal approver: writes offer no Edit; non-interactive writes go ahead", async () => {
  const approve = makeApprover("ask", {
    isTTY: true, write: () => {}, editLine: async () => "",
    select: async (title, items) => { assert.ok(!items.some((i) => i.value === "e")); return "y"; },
  });
  assert.strictEqual(await approve("write", "f", { kind: "write", isNew: true, newText: "x", rel: "f" }), true);
  const headless = makeApprover("ask", { isTTY: false });
  assert.strictEqual(await headless("write", "f"), true);
  assert.strictEqual(await headless("bash", "ls"), false);
});

test("the preview shows a long command in full, wrapped", () => {
  const cmd = "echo " + "y".repeat(300);
  const text = approvalPreview("bash", cmd, { command: cmd });
  assert.strictEqual((text.match(/y/g) || []).length, 300);
  const huge = "echo " + "z".repeat(5000);
  assert.match(approvalPreview("bash", huge, { command: huge }), /… 1005 more characters/);
});
