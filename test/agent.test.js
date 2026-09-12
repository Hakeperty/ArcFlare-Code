// Tests for the agent: tool behaviour, context compaction, skill loading and
// the MCP index. The emphasis is on the properties that keep a local model
// usable — a stable prompt prefix and a small token footprint.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tools = require("../lib/agent/tools");
const ctxmod = require("../lib/agent/context");
const skills = require("../lib/agent/skills");
const { McpRegistry } = require("../lib/agent/mcp");
const { buildSystem } = require("../lib/agent/agent");

function tmpdir(n) { return fs.mkdtempSync(path.join(os.tmpdir(), "af-" + n + "-")); }

// ----------------------------------------------------------------- tools ----

test("tool schemas are a small, fixed set", () => {
  const names = tools.SCHEMAS.map((t) => t.function.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("mcp_call"), "MCP reached through one stable entry point");
  assert.ok(names.includes("tool_search"));
  assert.ok(names.length <= 12, `expected a compact tool set, got ${names.length}`);
});

test("edit_file refuses an ambiguous match instead of guessing", async () => {
  const d = tmpdir("edit");
  const f = path.join(d, "a.txt");
  fs.writeFileSync(f, "x\nfoo\ny\nfoo\n");
  const exec = tools.makeExecutor({ cwd: d });
  const out = await exec("edit_file", { path: "a.txt", old_string: "foo", new_string: "bar" });
  assert.match(out, /appears 2 times/);
  assert.strictEqual(fs.readFileSync(f, "utf8"), "x\nfoo\ny\nfoo\n", "file untouched");

  const ok = await exec("edit_file",
    { path: "a.txt", old_string: "foo", new_string: "bar", replace_all: true });
  assert.match(ok, /2 replacements/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("edit_file reports a missing target rather than appending", async () => {
  const d = tmpdir("edit2");
  fs.writeFileSync(path.join(d, "a.txt"), "hello\n");
  const exec = tools.makeExecutor({ cwd: d });
  const out = await exec("edit_file", { path: "a.txt", old_string: "nope", new_string: "x" });
  assert.match(out, /not found/);
  assert.strictEqual(fs.readFileSync(path.join(d, "a.txt"), "utf8"), "hello\n");
  fs.rmSync(d, { recursive: true, force: true });
});

test("read_file paginates and numbers lines", async () => {
  const d = tmpdir("read");
  fs.writeFileSync(path.join(d, "b.txt"),
    Array.from({ length: 50 }, (_, i) => "line" + (i + 1)).join("\n"));
  const exec = tools.makeExecutor({ cwd: d });
  const out = await exec("read_file", { path: "b.txt", offset: 10, limit: 3 });
  assert.match(out, /^10\tline10/m);
  assert.match(out, /12\tline12/);
  assert.ok(!/13\tline13/.test(out));
  fs.rmSync(d, { recursive: true, force: true });
});

test("destructive shell commands are refused", async () => {
  const exec = tools.makeExecutor({ cwd: os.tmpdir() });
  for (const cmd of ["rm -rf /", "mkfs.ext4 /dev/sda", ":(){ :|:& };:"]) {
    const out = await exec("bash", { command: cmd });
    assert.match(out, /refused/, `should refuse: ${cmd}`);
  }
});

test("an ordinary shell command still runs", async () => {
  const exec = tools.makeExecutor({ cwd: os.tmpdir() });
  const out = await exec("bash", { command: "echo arcflare-ok" });
  assert.match(out, /arcflare-ok/);
});

test("a declined approval blocks the command", async () => {
  const exec = tools.makeExecutor({ cwd: os.tmpdir(), approve: async () => false });
  const out = await exec("bash", { command: "echo should-not-run" });
  assert.match(out, /declined/);
  assert.ok(!/should-not-run/.test(out));
});

test("glob patterns translate correctly", () => {
  assert.ok(tools.globToRe("**/*.js").test("src/a/b.js"));
  assert.ok(tools.globToRe("*.js").test("a.js"));
  assert.ok(!tools.globToRe("*.js").test("a/b.js"));
  assert.ok(tools.globToRe("src/**/*.test.js").test("src/x/y.test.js"));
});

test("unknown tools fail loudly rather than silently", async () => {
  const exec = tools.makeExecutor({ cwd: os.tmpdir() });
  assert.match(await exec("no_such_tool", {}), /unknown tool/);
});

// --------------------------------------------------------------- context ----

function convo(nToolResults, size) {
  const m = [{ role: "system", content: "sys" }];
  for (let i = 0; i < nToolResults; i++) {
    m.push({ role: "user", content: "do a thing" });
    m.push({ role: "assistant", content: "", tool_calls: [{ id: "t" + i, function: { name: "read_file", arguments: "{}" } }] });
    m.push({ role: "tool", tool_call_id: "t" + i, content: "x".repeat(size) });
  }
  return m;
}

test("compaction leaves a conversation that already fits alone", () => {
  const m = convo(1, 100);
  const r = ctxmod.compact(m, 100000);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.messages, m);
});

test("compaction trims the oldest tool results first", () => {
  const m = convo(8, 8000);
  const before = ctxmod.totalTokens(m);
  const r = ctxmod.compact(m, Math.floor(before / 3));
  assert.ok(r.changed);
  assert.ok(ctxmod.totalTokens(r.messages) < before);
  // The system prompt must survive — it is the cached prefix.
  assert.strictEqual(r.messages[0].role, "system");
  assert.strictEqual(r.messages[0].content, "sys");
  // The newest tool result must not be trimmed.
  const last = r.messages[r.messages.length - 1];
  assert.strictEqual(last.content.length, 8000, "most recent result kept whole");
});

test("compaction explains what it did", () => {
  const m = convo(8, 8000);
  const r = ctxmod.compact(m, 500);
  assert.ok(r.actions.length > 0);
  assert.ok(r.actions.every((a) => typeof a === "string"));
});

test("token estimate is in a sane range", () => {
  const text = "const x = 1;\n".repeat(100); // 1300 chars
  const n = ctxmod.estimate(text);
  assert.ok(n > 200 && n < 700, `got ${n}`);
});

test("budget reserves room for the reply", () => {
  const b = ctxmod.planBudget(262144, 4096);
  assert.strictEqual(b.promptBudget, 262144 - 4096);
  // Never returns a negative or absurdly small budget for a tiny window.
  assert.ok(ctxmod.planBudget(2048, 4096).promptBudget >= 2048);
});

// ---------------------------------------------------------------- skills ----

test("skills are indexed without reading their bodies", () => {
  const d = tmpdir("skills");
  const sk = path.join(d, ".arcflare", "skills", "deploy");
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, "SKILL.md"),
    "---\nname: deploy\ndescription: Ship it and roll back\n---\n" + "BODY ".repeat(3000));

  const found = skills.discover(d);
  const mine = found.find((s) => s.name === "deploy");
  assert.ok(mine, "skill discovered");
  assert.strictEqual(mine.description, "Ship it and roll back");
  assert.strictEqual(mine.body, undefined, "body must not be loaded during discovery");

  const idx = skills.index([mine]);
  assert.ok(idx[0].length < 200, "index line stays tiny");

  const loaded = skills.load(found, "deploy");
  assert.match(loaded.body, /^BODY/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("frontmatter parsing handles quotes and ignores the body", () => {
  const { meta, body } = skills.parseFrontmatter(
    '---\nname: "a b"\ndescription: \'c: d\'\n---\nhello\n');
  assert.strictEqual(meta.name, "a b");
  assert.strictEqual(meta.description, "c: d");
  assert.strictEqual(body.trim(), "hello");
});

test("a file with no frontmatter is still readable", () => {
  const { meta, body } = skills.parseFrontmatter("just text");
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body, "just text");
});

// ------------------------------------------------------------------- mcp ----

function fakeRegistry(n) {
  const reg = new McpRegistry();
  reg.servers.set("blender", {
    tools: Array.from({ length: n }, (_, i) => ({
      name: "tool_" + i,
      description: `Does thing ${i}. Extra prose that would cost tokens if inlined.`,
      inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    })),
  });
  return reg;
}

test("the MCP index is far cheaper than real tool definitions", () => {
  const reg = fakeRegistry(120);
  const idx = reg.index().join("\n");
  // Compare against what these tools would actually cost in a `tools` array,
  // not against the bare schemas — the descriptions are most of the weight.
  const full = JSON.stringify(reg.all().map((t) => ({
    type: "function",
    function: { name: t.id, description: t.description, parameters: t.schema },
  })));
  const ratio = full.length / idx.length;
  assert.ok(ratio > 3,
    `index should be several times cheaper; got ${ratio.toFixed(1)}x ` +
    `(${idx.length} vs ${full.length} chars)`);
});

test("MCP tool ids are namespaced by server", () => {
  const reg = fakeRegistry(3);
  assert.ok(reg.all().every((t) => t.id.startsWith("blender__")));
  assert.ok(reg.find("blender__tool_1"));
  assert.strictEqual(reg.find("nope__x"), null);
});

test("tool search ranks id matches above description matches", () => {
  const reg = new McpRegistry();
  reg.servers.set("s", {
    tools: [
      { name: "render", description: "unrelated prose", inputSchema: {} },
      { name: "other", description: "this one mentions render in the text", inputSchema: {} },
    ],
  });
  const hits = reg.search("render");
  assert.strictEqual(hits[0].id, "s__render");
});

test("searching for nothing returns nothing, not everything", () => {
  const reg = fakeRegistry(50);
  assert.strictEqual(reg.search("zzzznotathing").length, 0);
});

// ------------------------------------------------------------ system prompt -

test("the system prompt indexes MCP tools rather than inlining schemas", () => {
  const reg = fakeRegistry(200);
  const sys = buildSystem({
    cwd: "/tmp",
    skillIndex: ["deploy: ship it"],
    mcpCount: reg.all().length,
    mcpServers: ["blender"],
    mcpIndexSample: reg.all().slice(0, 5),
  });
  assert.match(sys, /200 tools/);
  assert.match(sys, /tool_search/);
  assert.match(sys, /deploy: ship it/);
  // The whole point: a 200-tool server must not blow up the prefix.
  assert.ok(ctxmod.estimate(sys) < 600, `prefix was ${ctxmod.estimate(sys)} tokens`);
});
