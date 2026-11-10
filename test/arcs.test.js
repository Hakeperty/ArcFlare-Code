// Tests for Arcs: the list, the base a machine gets, the instructions a model
// runs under, what the hub may change, and what the agent is told is on.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const arcs = require("../lib/arcs");
const { Agent, buildSystem } = require("../lib/agent/agent");
const run = require("../lib/agent/run");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-arcs-")), "arcs.dat");
const none = { file: path.join(os.tmpdir(), "af-arcs-none", "arcs.dat") };

test("every Arc has a name, a side, bases it may be built on, and instructions", () => {
  const list = arcs.all(none);
  assert.ok(list.length >= 7);
  const ids = new Set();
  for (const a of list) {
    assert.match(a.id, /^arc(-[a-z0-9]+)*$/);
    assert.ok(!ids.has(a.id), `duplicate ${a.id}`);
    ids.add(a.id);
    assert.ok(a.name.startsWith("Arc"));
    assert.ok(["standard", "abliterated"].includes(a.side));
    assert.ok(["general", "task", "security"].includes(a.group));
    assert.ok(a.prompt.includes(`You are ${a.name},`), `${a.id} says who it is`);
    assert.ok(a.bases.length >= 1);
    for (const b of a.bases) {
      // "Free to change and call our own" is a licence question: only these two.
      assert.ok(["Apache-2.0", "MIT"].includes(b.license), `${a.id} on ${b.slug}: ${b.license}`);
      assert.match(b.ref, /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/);
      // A standard Arc never sits on an abliterated build, and the other side always does.
      assert.strictEqual(/abliterat|uncensored|heretic|obliterated/i.test(b.ref), a.side === "abliterated", `${a.id} on ${b.ref}`);
    }
  }
  for (const side of ["standard", "abliterated"]) {
    assert.ok(list.some((a) => a.side === side && a.group === "security"), `${side} has a security Arc`);
    assert.ok(list.some((a) => a.side === side && a.group !== "security"), `${side} has general Arcs`);
  }
});

test("an Arc is found by id, short name or display name", () => {
  assert.strictEqual(arcs.find("arc-code", none).id, "arc-code");
  assert.strictEqual(arcs.find("code", none).id, "arc-code");
  assert.strictEqual(arcs.find("Arc Code", none).id, "arc-code");
  assert.strictEqual(arcs.find("arc", none).id, "arc");
  assert.strictEqual(arcs.find("qwen3", none), null);
  assert.ok(arcs.looksLikeArc("arc-code") && arcs.looksLikeArc("arc"));
  assert.ok(!arcs.looksLikeArc("arctic-7b") && !arcs.looksLikeArc("qwen3"));
});

test("the base is the largest one here that fits, else the one worth downloading", () => {
  const arc = arcs.find("arc", none);
  const small = { id: "qwen3.5-4b:q4_k_m", file: "/m/Qwen3.5-4B-Q4_K_M.gguf" };
  const mid = { id: "qwen3.5-9b:q4_k_m", file: "/m/Qwen3.5-9B-Q4_K_M.gguf" };
  const uncensored = { id: "huihui-qwen3.5-9b-abliterated:q4_k_m", file: "/m/Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf" };

  let p = arcs.pickBase(arc, { local: [small, mid], freeGb: 12 });
  assert.strictEqual(p.model, mid);
  assert.strictEqual(p.installed, true);
  p = arcs.pickBase(arc, { local: [small, mid], freeGb: 6 });
  assert.strictEqual(p.model, small);
  // Nothing here: recommend the biggest that fits, and say it is not installed.
  p = arcs.pickBase(arc, { local: [], freeGb: 24 });
  assert.strictEqual(p.installed, false);
  assert.strictEqual(p.base.slug, "qwen3.8-27b");
  p = arcs.pickBase(arc, { local: [], freeGb: 2 });
  assert.strictEqual(p.base.slug, "qwen3.5-4b");
  assert.strictEqual(p.fits, false);
  // The abliterated build of the same model is not the standard Arc's base, nor the reverse.
  assert.strictEqual(arcs.pickBase(arc, { local: [uncensored], freeGb: 12 }).installed, false);
  assert.strictEqual(arcs.pickBase(arcs.find("unbound", none), { local: [mid], freeGb: 12 }).installed, false);
  assert.strictEqual(arcs.pickBase(arcs.find("unbound", none), { local: [uncensored], freeGb: 12 }).model, uncensored);
  // A file in the Hugging Face cache is recognised by its repo folder, whatever it is called.
  const cached = { id: "weights:q4", file: "/c/models--ornith-ai--Ornith-1.5-9B-GGUF/snapshots/abc/weights.gguf" };
  assert.strictEqual(arcs.pickBase(arcs.find("code", none), { local: [cached], freeGb: 10 }).model, cached);
});

test("instructions say where the model is running and to keep them to itself", () => {
  const arc = arcs.find("scout", none);
  const chat = arcs.compose(arc, { surface: "chat" });
  const agent = arcs.compose(arc, { surface: "agent", extra: "Answer in Swedish." });
  assert.ok(chat.startsWith(arc.prompt.trim()));
  assert.match(chat, /plain conversation with no tools/);
  assert.match(agent, /working as an agent/);
  assert.doesNotMatch(agent, /plain conversation with no tools/);
  assert.match(chat, /not for sharing/);
  // Hiding the instructions is not hiding what the model is.
  assert.match(chat, /you are Arc Scout, ArcFlare's configuration of an open model/);
  assert.ok(agent.endsWith("Answer in Swedish."));
  // What an app may show has everything but the instructions.
  assert.strictEqual("prompt" in arcs.publicView(arc), false);
  assert.strictEqual(arcs.publicView(arc).name, "Arc Scout");
});

test("the hub's copy is kept unreadable at a glance, and replaces the built-in instructions", async () => {
  const file = tmp();
  const fetchImpl = async (url) => {
    assert.match(url, /\/api\/arcs$/);
    return new Response(JSON.stringify({ schema: 1, arcs: [
      { id: "arc-code", prompt: "You are Arc Code, the long version.", sampling: { temperature: 0.2 } },
      { id: "arc-new", name: "Arc New", side: "standard", group: "task", focus: "New", prompt: "You are Arc New, x.",
        bases: [{ slug: "b", ref: "o/r-GGUF:Q4_K_M", gb: 6, license: "MIT" }] },
      { id: "arc-bad", name: "Arc Bad", side: "standard", prompt: "x", bases: [{ slug: "b", ref: "o/r; rm -rf ~", gb: 6 }] },
      { id: "not-an-arc", prompt: "x" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await arcs.sync({ fetchImpl, file, refresh: true });
  assert.strictEqual(r.source, "live");
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /long version/);
  assert.strictEqual(arcs.decode(raw).arcs.length, 3);

  const list = arcs.all({ file });
  const code = list.find((a) => a.id === "arc-code");
  assert.strictEqual(code.prompt, "You are Arc Code, the long version.");
  assert.strictEqual(code.full, true);
  assert.strictEqual(code.bases.length, 4, "what the hub did not send stays as built in");
  assert.ok(list.some((a) => a.id === "arc-new"));
  // A download reference that is not a repo name is dropped, and with it an Arc that then has no base.
  assert.ok(!list.some((a) => a.id === "arc-bad"));
  assert.strictEqual(arcs.find("arc", { file }).full, false);
});

test("offline, the last copy stands; with no copy, the built-in ones do", async () => {
  const file = tmp();
  const down = async () => { throw new Error("offline"); };
  let r = await arcs.sync({ fetchImpl: down, file, refresh: true });
  assert.strictEqual(r.source, "builtin");
  assert.ok(arcs.all({ file }).length >= 7);
  fs.writeFileSync(file, arcs.encode({ fetchedAt: "2020-01-01T00:00:00Z", url: require("../lib/hub").hubUrl({}), arcs: [{ id: "arc", prompt: "You are Arc, cached." }] }));
  r = await arcs.sync({ fetchImpl: down, file });
  assert.strictEqual(r.source, "cache");
  assert.strictEqual(arcs.find("arc", { file }).prompt, "You are Arc, cached.");
  // A cache file someone damaged is ignored rather than trusted.
  fs.writeFileSync(file, "ARCS1:not-base64-gzip");
  assert.strictEqual(arcs.find("arc", { file }).full, false);
});

test("the agent is told which of ArcFlare's tools are on, by exact id", () => {
  const notes = arcs.capabilityNotes(["arcflare__web_search", "arcflare__web_fetch", "arcflare__run"]);
  assert.match(notes, /## Web access is on/);
  assert.match(notes, /arcflare__web_search {2}\{"query"/);
  assert.doesNotMatch(notes, /Desktop control|Machine tools/);
  const desk = arcs.capabilityNotes(["arcflare-desktop__screenshot", "arcflare-desktop__mouse", "arcflare-desktop__type", "arcflare-desktop__key", "arcflare-desktop__focus"]);
  assert.match(desk, /## Desktop control is on/);
  assert.match(desk, /arcflare-desktop__screenshot/);
  assert.match(desk, /wait for a yes/);
  const br = arcs.capabilityNotes(["arcflare__browser_open", "arcflare__browser_click", "arcflare__browser_type", "arcflare__browser_read", "arcflare__web_fetch", "arcflare__web_search"]);
  assert.match(br, /## The browser is on/);
  assert.match(br, /arcflare__browser_click {2}\{"target": "12"\}/);
  assert.match(br, /nearly empty from arcflare__web_fetch/);
  assert.strictEqual(arcs.capabilityNotes([]), "");
  assert.strictEqual(arcs.capabilityNotes(["blender__render"]), "");

  // And it reaches the system prompt, after the MCP section, with an Arc's instructions first.
  const fakeMcp = { servers: new Map([["arcflare", {}]]), all: () => ["web_search", "web_fetch"].map((n) => ({ id: `arcflare__${n}`, server: "arcflare", name: n })) };
  const agent = new Agent({ port: 1, model: "m", cwd: "/tmp", mcp: fakeMcp, systemPrompt: arcs.compose(arcs.find("scout", none), { surface: "agent" }) });
  assert.ok(agent.system.startsWith("You are Arc Scout"));
  assert.ok(agent.system.indexOf("## MCP tools") < agent.system.indexOf("## Web access is on"));
  assert.ok(agent.usage().mcp > 0);
  // The conversation that gets saved never carries the instructions.
  assert.deepStrictEqual(agent.conversation(), []);
  assert.strictEqual(buildSystem({ cwd: "/x" }).includes("is on"), false);
});

test("desktop control and the web switch on and off apart from the machine server", () => {
  assert.deepStrictEqual(run.toolSwitches({}), { machine: true, desktop: true, web: true });
  assert.deepStrictEqual(run.toolSwitches({ machine: false }), { machine: false, desktop: false, web: true });
  assert.deepStrictEqual(run.toolSwitches({ machine: false, desktop: true }), { machine: false, desktop: true, web: true });
  assert.deepStrictEqual(run.toolSwitches({ web: false }, { web: true }), { machine: true, desktop: true, web: true });
  assert.deepStrictEqual(run.toolSwitches({}, { desktop: false }), { machine: true, desktop: false, web: true });

  assert.strictEqual(run.serverParts({}), null);
  assert.deepStrictEqual(run.serverParts({ machine: false }), []);
  // The web switch brings search, fetch and the headless browser together.
  assert.deepStrictEqual(run.serverParts({ machine: false, web: true }), ["web", "browser"]);
  assert.deepStrictEqual(run.serverParts({ machine: false, desktop: true, web: true }), ["desktop", "open", "web", "browser"]);
  assert.ok(!run.serverParts({ machine: true, web: false }).includes("browser"));
  const noDesk = run.serverParts({ machine: true, desktop: false, web: true });
  assert.ok(noDesk.includes("run") && noDesk.includes("web") && !noDesk.includes("desktop"));

  const empty = { servers: {} };
  assert.deepStrictEqual(run.withBuiltinServer(empty, { machine: false, web: true }).servers.arcflare.args.slice(1), ["--only", "web,browser"]);
  assert.strictEqual(run.withBuiltinServer(empty, {}).servers.arcflare.args.length, 1);
  assert.strictEqual(Object.keys(run.withBuiltinServer(empty, { machine: false, web: false }).servers).length, 0);
});
