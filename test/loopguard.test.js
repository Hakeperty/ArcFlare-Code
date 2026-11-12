// Tests for the loop guard: thinking that repeats is cut and the step asked
// again without thinking, and a look asked a third time with nothing changed is
// answered without running it. Just as important: ordinary thinking, and
// ordinary repeated work, are left alone.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { ThinkWatch, CallWatch, periodicTail, callKey, defaultCap, settings, NUDGE } = require("../lib/agent/loopguard");
const { Agent, addNote, STUCK_NOTE } = require("../lib/agent/agent");

function tmpdir(n) { return fs.mkdtempSync(path.join(os.tmpdir(), "af-" + n + "-")); }

/** Feed text a few characters at a time, the way a stream delivers it. */
function stream(watch, text, size = 7) {
  for (let i = 0; i < text.length; i += size) {
    const hit = watch.feed(text.slice(i, i + size));
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------- thinking ----

test("the same sentence round and round is a loop", () => {
  const w = new ThinkWatch();
  const hit = stream(w, "First I add the numbers. " + "Wait, let me check that 2 + 2 = 4 again. Yes it is 4. ".repeat(8));
  assert.ok(hit);
  assert.strictEqual(hit.kind, "think-loop");
  assert.ok(hit.chars < 400, `cut early, after ${hit.chars} characters`);
});

test("a passage repeated back to back is a loop even with no full stops", () => {
  const w = new ThinkWatch();
  const hit = stream(w, "so the config is loaded from the home folder and then merged with defaults and ".repeat(6));
  assert.ok(hit);
  assert.strictEqual(hit.kind, "think-loop");
});

test("a short true thing may recur a few times before it counts", () => {
  const w = new ThinkWatch();
  assert.strictEqual(stream(w, "2 + 2 = 4. So the sum is right. Now the product. 2 + 2 = 4. And the product is 6. 2 + 2 = 4. Done. "), null);
});

test("ordinary reasoning is left alone", () => {
  const w = new ThinkWatch({ capTokens: 4096 });
  const text =
    "The test fails in parse.js on line 40. The error says the token is undefined. " +
    "I should read the tokenizer first. The tokenizer returns null at end of input. " +
    "So the parser needs to handle null. I will add a check before the loop. " +
    "Then I will run the test again. If it passes I will run the whole suite. ";
  assert.strictEqual(stream(w, text), null);
});

test("a list of similar lines is not a loop", () => {
  const w = new ThinkWatch();
  const lines = Array.from({ length: 30 }, (_, i) => `- file src/module${i}.js exports a handler and has no tests`).join("\n");
  assert.strictEqual(stream(w, lines + "\n"), null);
});

test("padding is not a loop", () => {
  assert.strictEqual(periodicTail("thinking" + ".".repeat(300)), "");
  assert.strictEqual(periodicTail("a b c " + "- - - - ".repeat(40)), "");
});

test("thinking past the cap is cut, and no cap means no cut", () => {
  const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
  const capped = new ThinkWatch({ capTokens: 1024 });
  const hit = stream(capped, words, 50);
  assert.ok(hit);
  assert.strictEqual(hit.kind, "think-cap");
  assert.ok(hit.chars > 4096 && hit.chars < 4300);
  assert.strictEqual(stream(new ThinkWatch({ capTokens: 0 }), words, 50), null);
});

test("the cap follows the context window, inside fixed bounds", () => {
  assert.strictEqual(defaultCap(4096), 1024);
  assert.strictEqual(defaultCap(16384), 2048);
  assert.strictEqual(defaultCap(131072), 4096);
});

test("the guard can be switched off, and the cap set, by option or environment", () => {
  assert.strictEqual(settings({}, {}).enabled, true);
  assert.strictEqual(settings({ loopGuard: false }, {}).enabled, false);
  assert.strictEqual(settings({}, { ARCFLARE_LOOP_GUARD: "off" }).enabled, false);
  assert.strictEqual(settings({ nCtx: 32768 }, {}).thinkCap, 4096);
  assert.strictEqual(settings({ nCtx: 32768 }, { ARCFLARE_THINK_CAP: "500" }).thinkCap, 500);
  assert.strictEqual(settings({ thinkCap: 0 }, { ARCFLARE_THINK_CAP: "500" }).thinkCap, 0);
});

// ---------------------------------------------------------------- calls ----

test("argument order does not make a different call", () => {
  assert.strictEqual(callKey("grep", { pattern: "x", path: "src" }), callKey("grep", { path: "src", pattern: "x" }));
  assert.notStrictEqual(callKey("grep", { pattern: "x" }), callKey("grep", { pattern: "y" }));
  assert.notStrictEqual(callKey("grep", { opts: { a: 1 } }), callKey("grep", { opts: { a: 2 } }));
});

test("a look is run twice, then answered from memory", () => {
  const w = new CallWatch();
  const args = { path: "a.txt" };
  assert.strictEqual(w.before("read_file", args), null);
  w.after("read_file", args, "hello");
  assert.strictEqual(w.before("read_file", args), null);
  w.after("read_file", args, "hello");
  assert.match(w.before("read_file", args), /not run/);
  assert.match(w.before("read_file", args), /3 times/);
});

test("a look after a change is run again", () => {
  const w = new CallWatch();
  const args = { path: "a.txt" };
  w.after("read_file", args, "hello");
  w.after("read_file", args, "hello");
  w.after("edit_file", { path: "a.txt" }, "1 replacement");
  assert.strictEqual(w.before("read_file", args), null, "the file may have changed");
  w.after("read_file", args, "goodbye");
  assert.strictEqual(w.before("read_file", args), null, "a new result starts the count again");
});

test("a look whose earlier result is far back is run again", () => {
  const w = new CallWatch();
  const args = { path: "a.txt" };
  w.after("read_file", args, "hello");
  w.after("read_file", args, "hello");
  for (let i = 0; i < 9; i++) w.after("grep", { pattern: "p" + i }, "no matches");
  assert.strictEqual(w.before("read_file", args), null, "the earlier result may have been compacted away");
});

test("a command is always run, and told on the third identical result", () => {
  const w = new CallWatch();
  const args = { command: "npm test" };
  for (let i = 0; i < 2; i++) {
    assert.strictEqual(w.before("bash", args), null);
    assert.strictEqual(w.after("bash", args, "exit 1\n1 failing").repeated, false);
  }
  assert.strictEqual(w.before("bash", args), null);
  const third = w.after("bash", args, "exit 1\n1 failing");
  assert.strictEqual(third.repeated, true);
  assert.match(third.out, /^exit 1\n1 failing/);
  assert.match(third.out, /3 times/);
  assert.strictEqual(w.after("bash", args, "exit 0\nall passing").repeated, false, "a new result is not a repeat");
});

// ------------------------------------------------------------ the agent ----

test("a note rides on the last user or tool message", () => {
  const a = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
  addNote(a, "[n]");
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[1].content, "hi\n\n[n]");
  const b = [{ role: "user", content: "hi" }, { role: "assistant", content: "", tool_calls: [] }, { role: "tool", content: "out" }];
  addNote(b, "[n]");
  assert.strictEqual(b[2].content, "out\n\n[n]");
  const c = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  addNote(c, "[n]");
  assert.deepStrictEqual(c[0].content[1], { type: "text", text: "[n]" });
});

const sse = (res, delta, finish) =>
  res.write(`data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`);

/**
 * A fake llama-server. `script` is one handler per request, in order; each gets
 * the parsed request body and the response. A handler that returns "loop"
 * streams the same thought until the client hangs up.
 */
function scripted(script) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const step = script[bodies.length - 1];
      if (step === "loop") {
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          sse(res, { reasoning_content: "Wait, let me check that 2 + 2 = 4 again. Yes it is 4. " });
        }, 2);
        res.on("close", () => clearInterval(t));
        return;
      }
      step(body, res);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, bodies, port: () => server.address().port })));
}

const answer = (text) => (body, res) => sse(res, { content: text }, "stop");
const call = (name, args) => (body, res) =>
  sse(res, { tool_calls: [{ index: 0, id: "c" + Math.random().toString(36).slice(2, 8), function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");

test("looping thought is cut, and the step is asked again without thinking", async () => {
  const fake = await scripted(["loop", answer("4")]);
  const events = [];
  const agent = new Agent({ port: fake.port(), model: "m", cwd: os.tmpdir(), onEvent: (e) => events.push(e) });
  const res = await agent.send("what is 2 + 2?");
  fake.server.close();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.content, "4");
  assert.strictEqual(fake.bodies.length, 2);
  assert.strictEqual(fake.bodies[0].chat_template_kwargs, undefined, "the first try may think");
  assert.deepStrictEqual(fake.bodies[1].chat_template_kwargs, { enable_thinking: false });
  const retry = fake.bodies[1].messages;
  assert.strictEqual(retry.length, 2, "no extra message: the note rides on the user's");
  assert.ok(retry[1].content.startsWith("what is 2 + 2?"));
  assert.ok(retry[1].content.endsWith(NUDGE["think-loop"]));
  assert.strictEqual(retry[0].content, fake.bodies[0].messages[0].content, "the cached prefix is untouched");
  const guard = events.filter((e) => e.type === "guard");
  assert.strictEqual(guard.length, 1);
  assert.strictEqual(guard[0].kind, "think-loop");
  assert.strictEqual(agent.stats.guard.loops, 1);
  const thought = events.filter((e) => e.type === "reasoning").map((e) => e.text).join("");
  assert.ok(thought.length < 600, `the loop was cut early, after ${thought.length} characters`);
});

test("a model that loops again after the nudge is stopped, not asked a third time", async () => {
  const fake = await scripted(["loop", "loop", answer("never reached")]);
  const events = [];
  const agent = new Agent({ port: fake.port(), model: "m", cwd: os.tmpdir(), onEvent: (e) => events.push(e) });
  const res = await agent.send("what is 2 + 2?");
  fake.server.close();

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "thinking in circles");
  assert.strictEqual(fake.bodies.length, 2);
  const last = agent.messages[agent.messages.length - 1];
  assert.deepStrictEqual(last, { role: "assistant", content: STUCK_NOTE });
  assert.ok(events.some((e) => e.type === "error" && /same thought/.test(e.text)));
});

test("with the guard off, thinking is not cut", async () => {
  const fake = await scripted([(body, res) => {
    for (let i = 0; i < 12; i++) sse(res, { reasoning_content: "Wait, let me check that 2 + 2 = 4 again. Yes it is 4. " });
    sse(res, { content: "4" }, "stop");
  }]);
  const agent = new Agent({ port: fake.port(), model: "m", cwd: os.tmpdir(), loopGuard: false });
  const res = await agent.send("what is 2 + 2?");
  fake.server.close();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(fake.bodies.length, 1);
});

test("the third identical read in a turn is answered without reading", async () => {
  const d = tmpdir("guard");
  fs.writeFileSync(path.join(d, "a.txt"), "hello\n");
  const read = call("read_file", { path: "a.txt" });
  const fake = await scripted([read, read, read, answer("done")]);
  const agent = new Agent({ port: fake.port(), model: "m", cwd: d });
  const res = await agent.send("read a.txt");
  fake.server.close();
  fs.rmSync(d, { recursive: true, force: true });

  assert.strictEqual(res.ok, true);
  const results = agent.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.strictEqual(results.length, 3);
  assert.match(results[0], /hello/);
  assert.match(results[1], /hello/);
  assert.match(results[2], /^\[ArcFlare: not run/);
  assert.ok(results[2].length < results[0].length + 200);
  assert.strictEqual(agent.stats.guard.repeats, 1);
});

test("the count of identical calls starts again each turn", async () => {
  const d = tmpdir("guard2");
  fs.writeFileSync(path.join(d, "a.txt"), "hello\n");
  const read = call("read_file", { path: "a.txt" });
  const fake = await scripted([read, read, answer("one"), read, answer("two")]);
  const agent = new Agent({ port: fake.port(), model: "m", cwd: d });
  await agent.send("read a.txt");
  await agent.send("read it again");
  fake.server.close();
  fs.rmSync(d, { recursive: true, force: true });
  const results = agent.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.strictEqual(results.length, 3);
  assert.ok(results.every((r) => /hello/.test(r)), "a new turn may read the file again");
});
