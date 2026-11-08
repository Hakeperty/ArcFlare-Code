// Team mode: picking helper models, the advisor's view of the session, swarm jobs, the three checkpoints, and the
// agent loop wired to them (against a fake model server, so no GPU is needed).

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const T = require("../lib/agent/team");
const { Agent } = require("../lib/agent/agent");

const GB = 1e9;
const m = (id, gb) => ({ id, file: `/m/${id}.gguf`, size: gb * GB });

test("pick: swarm is the biggest model up to 7 GB, advisor the biggest up to 14 GB, never the lead; team.json wins", () => {
  const all = [m("lead", 33), m("big", 22), m("adv", 12), m("mid", 7.6), m("small", 6.6), m("tiny", 1.9), m("seed", 0.5)];
  const p = T.pick(all, "lead");
  assert.strictEqual(p.swarm.id, "small");
  assert.strictEqual(p.advisor.id, "adv");
  assert.strictEqual(T.pick(all, "adv").advisor.id, "mid", "the lead is never its own advisor");
  const set = T.pick(all, "lead", { swarm: "tiny", advisor: "big" });
  assert.deepStrictEqual([set.swarm.id, set.advisor.id], ["tiny", "big"]);
  assert.strictEqual(T.pick(all, "lead", { swarm: "gone" }).swarm.id, "small", "a set model that is not installed is ignored");
  const only = T.pick([m("lead", 33), m("small", 5)], "lead");
  assert.strictEqual(only.advisor.id, "small", "with nothing bigger, the swarm model advises too");
  assert.strictEqual(T.pick([m("lead", 33)], "lead").swarm, null);
});

test("digest: the advisor sees requests, claims, calls and results; the oldest go first when it is long", () => {
  const msgs = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "make tetris" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "edit_file", arguments: '{"path":"Game1.cs"}' } }] },
    { role: "tool", content: "ERROR: old_string not found" },
    { role: "assistant", content: "I implemented line clearing." },
  ];
  const d = T.digest(msgs);
  assert.ok(!d.includes("SYSTEM"));
  for (const s of ["PERSON: make tetris", "LEAD CALLS edit_file", "RESULT: ERROR: old_string", "LEAD: I implemented"]) assert.ok(d.includes(s), s);
  const long = T.digest([{ role: "user", content: "x".repeat(3000) }, { role: "user", content: "newest" }], 200);
  assert.ok(long.includes("newest") && long.startsWith("[earlier session left out]"));
});

function fakeHelper() {
  const uses = [];
  return { uses, use: async (model, o) => { uses.push([model.id, o.slots]); return 4242; }, stop() {} };
}

test("delegate: up to 4 read-only jobs run side by side on the swarm model, answers come back labelled", async () => {
  const helper = fakeHelper();
  const made = [];
  let running = 0, peak = 0;
  const team = new T.Team({
    helper, swarm: m("small", 6), advisor: m("adv", 12), cwd: "/p",
    makeHelper: (o) => { made.push(o); return { abort() {}, async send(job) {
      running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--;
      return { ok: true, content: `found ${job}` };
    } }; },
  });
  const events = [];
  team.onEvent = (e) => events.push(e);
  const out = await team.run("delegate", { jobs: ["a", "b", "c", "d", "e"] });
  assert.strictEqual(made.length, 4, "capped at 4 jobs");
  assert.strictEqual(peak, 4, "in parallel");
  assert.deepStrictEqual(made[0].toolNames, T.READ_ONLY);
  assert.strictEqual(made[0].noThink, true);
  assert.deepStrictEqual(helper.uses[0], ["small", 4]);
  assert.match(out, /### Job 1: a\nfound a/);
  assert.ok(!out.includes("found e"));
  assert.deepStrictEqual(events.map((e) => e.phase), ["start", "job", "job", "job", "job", "done"]);
  assert.match(await team.run("delegate", { jobs: [] }), /^ERROR/);
  assert.strictEqual(await team.run("read_file", {}), undefined, "other tools are not the team's");
});

test("checkpoints: plan before, advisor on the second identical error only, and a review before done", async () => {
  const asked = [];
  let reply = "1. Read Game1.cs first";
  const team = new T.Team({
    helper: fakeHelper(), swarm: m("small", 6), advisor: m("adv", 12), cwd: "/p",
    chat: async (port, body) => { asked.push(body.messages[1].content); return { content: reply }; },
  });
  assert.match(await team.beforeTurn("make tetris", []), /^\[Advisor's plan.*\n1\. Read Game1\.cs/s);
  assert.match(asked[0], /about to start this task\. .*\nmake tetris/s);
  const err = [{ name: "edit_file", out: "ERROR: old_string not found" }];
  assert.strictEqual(await team.afterTools(err, []), "", "once is not a pattern");
  assert.match(await team.afterTools(err, []), /Advisor, on the repeated error/);
  assert.strictEqual(await team.afterTools(err, []), "", "it does not nag on every repeat after");
  assert.strictEqual(await team.afterTools([{ name: "bash", out: "ok" }], []), "");
  reply = "LGTM";
  assert.strictEqual(await team.beforeDone([]), "");
  reply = "- The edit to Game1.cs failed; line clearing is not in the file.";
  assert.match(await team.beforeDone([]), /review before you finish.*edit to Game1\.cs failed/s);
  // An advisor that cannot be reached never blocks the lead.
  const down = new T.Team({ helper: { use: async () => { throw new Error("no engine"); } }, swarm: m("s", 6), advisor: m("a", 12), cwd: "/p" });
  assert.strictEqual(await down.beforeTurn("x", []), "");
  assert.strictEqual(await down.beforeDone([]), "");
});

/** A fake llama-server that answers from a script and records each request. */
function fakeServer(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const body = JSON.parse(b);
      seen.push(body);
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = step.tool ? { tool_calls: [{ index: 0, id: "c1", function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] } : { content: step.text };
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, port: srv.address().port })));
}

test("the agent loop: plan goes in with the message, a review sends the lead back once, team tools are offered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-team-"));
  const { srv, seen, port } = await fakeServer([{ text: "Done!" }, { text: "Fixed it, now done." }]);
  const calls = [];
  const team = {
    schemas: T.SCHEMAS,
    run: async () => undefined,
    beforeTurn: async (t) => { calls.push("plan"); return "[Advisor's plan: start small]"; },
    afterTools: async () => "",
    beforeDone: async () => { calls.push("done"); return calls.filter((c) => c === "done").length === 1 ? "[Advisor's review: the edit failed]" : ""; },
  };
  try {
    const a = new Agent({ port, model: "lead", cwd: dir, team, approve: async () => true });
    const r = await a.send("make tetris");
    assert.strictEqual(r.content, "Fixed it, now done.");
    assert.deepStrictEqual(calls, ["plan", "done"], "reviewed once per message, not in a loop");
    const names = seen[0].tools.map((t) => t.function.name);
    assert.ok(names.includes("delegate") && names.includes("ask_advisor") && names.includes("write_file"));
    assert.match(seen[0].messages.at(-1).content, /^make tetris\n\n\[Advisor's plan: start small\]$/);
    assert.match(seen[1].messages.at(-1).content, /the edit failed/);
    assert.match(seen[0].messages[0].content, /lead of a small team/);
    // A YOLO "go on" does not plan again.
    await a.send("go on", { plan: false });
    assert.strictEqual(calls.filter((c) => c === "plan").length, 1);
    // A swarm helper: read-only tools only, thinking off, and a write is refused even if asked for.
    const h = new Agent({ port, model: "small", cwd: dir, toolNames: T.READ_ONLY, noThink: true, approve: async () => true });
    assert.deepStrictEqual(h.toolSchemas.map((t) => t.function.name).sort(), [...T.READ_ONLY].sort());
    assert.match(await h.execute("write_file", { path: "x", content: "y" }), /not available/);
    assert.ok(!fs.existsSync(path.join(dir, "x")));
    seen.length = 0;
    await h.send("map the repo");
    assert.deepStrictEqual(seen[0].chat_template_kwargs, { enable_thinking: false });
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("memory: helpers are only picked when they fit beside the lead, and the reserve covers the bigger one", () => {
  const all = [m("lead", 33), m("adv", 12), m("small", 6.6), m("tiny", 2)];
  const room = T.helperRoom(47 * GB, 33 * GB);
  assert.ok(room < 9.1 * GB, "Flint-sized lead on 47 GB leaves under 9 GB");
  const p = T.pick(all, "lead", {}, room);
  assert.strictEqual(p.advisor.id, p.swarm.id, "the 12 GB advisor does not fit, so the swarm model advises");
  assert.strictEqual(p.swarm.id, "tiny");
  assert.strictEqual(p.reserve, T.helperNeed(p.swarm));
  const roomy = T.pick(all, "lead", {}, 20 * GB);
  assert.deepStrictEqual([roomy.swarm.id, roomy.advisor.id, roomy.reserve], ["small", "adv", T.helperNeed(m("adv", 12))]);
});

test("the advisor falls back to the swarm model when it will not load", async () => {
  const tried = [];
  const team = new T.Team({
    helper: { use: async (mm) => { tried.push(mm.id); if (mm.id === "adv") throw new Error("out of memory"); return 1; } },
    swarm: m("small", 6), advisor: m("adv", 12), cwd: "/p", chat: async () => ({ content: "LGTM" }),
  });
  assert.strictEqual(await team.beforeDone([]), "");
  assert.deepStrictEqual(tried, ["adv", "small"]);
  assert.strictEqual(team.advisor.id, "small", "and keeps using it");
});

test("a model server error mid-stream fails the turn instead of passing as an empty answer", async () => {
  const srv = http.createServer((req, res) => {
    req.resume(); req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ error: { code: 500, message: "decode() failed: ErrorOutOfDeviceMemory" } })}\n\n`);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const events = [];
    const a = new Agent({ port: srv.address().port, model: "x", cwd: os.tmpdir(), approve: async () => true, onEvent: (e) => events.push(e) });
    const r = await a.send("hi");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /OutOfDeviceMemory/);
    assert.ok(events.some((e) => e.type === "error"));
  } finally { srv.close(); }
});
