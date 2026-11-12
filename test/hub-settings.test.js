// The phone's settings and ArcFlare's own servers on the hub: what is
// remembered, who may change it, and that an Arc's instructions reach the
// model without ever reaching a phone.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { HubSettings } = require("../lib/hub/settings");
const { McpHub } = require("../lib/hub/mcphub");
const { ChatManager } = require("../lib/hub/chat");
const arcs = require("../lib/arcs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "af-hubset-"));

test("the Arc chosen on the phone is remembered on the computer", () => {
  const dir = tmp();
  const s = new HubSettings({ dir });
  assert.strictEqual(s.arc(), null);
  assert.strictEqual(s.setArc("code").arc, "arc-code");
  // A new hub process reads the same answer back.
  assert.strictEqual(new HubSettings({ dir }).arc().id, "arc-code");
  assert.throws(() => s.setArc("no-such"), /No such Arc/);
  assert.strictEqual(new HubSettings({ dir }).arc().id, "arc-code", "a refused change leaves the old choice");
  assert.strictEqual(s.setArc(null).arc, null);
  assert.strictEqual(new HubSettings({ dir }).arc(), null);
  // A damaged file is no setting, not a crash.
  fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
  assert.strictEqual(new HubSettings({ dir }).arc(), null);
});

test("what a phone is sent names each Arc and never carries its instructions", () => {
  const view = new HubSettings({ dir: tmp() }).view();
  assert.ok(view.arcs.length >= 7);
  for (const a of view.arcs) assert.deepStrictEqual(Object.keys(a).sort(), ["focus", "group", "id", "name", "side"]);
  assert.doesNotMatch(JSON.stringify(view), /You are Arc|not for sharing/);
});

test("ArcFlare's web and desktop servers are offered, off, and a configured server of the same name wins", () => {
  const dir = tmp();
  const hub = new McpHub({ dir, builtins: true, load: () => ({ servers: { mine: { command: "x" } } }) });
  const list = hub.list();
  assert.deepStrictEqual(list.map((s) => s.name), ["arcflare-browser", "arcflare-desktop", "arcflare-web", "mine"]);
  assert.ok(list.every((s) => s.enabled === false && s.status === "off"));
  assert.strictEqual(list[2].builtin, true);
  assert.match(list[2].about, /Search the web/);
  assert.strictEqual(list[3].builtin, false);
  // Nothing about how a server is started reaches the phone.
  assert.doesNotMatch(JSON.stringify(list), /arcflare-mcp\.js|command|args/);
  // Without the option (as the tests of the hub itself run) there are none.
  assert.deepStrictEqual(new McpHub({ dir, load: () => ({ servers: {} }) }).list(), []);
  const own = new McpHub({ dir, builtins: true, load: () => ({ servers: { "arcflare-web": { url: "https://example.com/mcp" } } }) });
  const mine = own.list().find((s) => s.name === "arcflare-web");
  assert.strictEqual(mine.builtin, false);
  assert.strictEqual(mine.transport, "http");
});

test("switched on, the web server connects, is remembered, and the agent is told it can browse", async () => {
  const dir = tmp();
  const hub = new McpHub({ dir, builtins: true, load: () => ({ servers: {} }) });
  try {
    const row = await hub.setEnabled("arcflare-web", true);
    assert.strictEqual(row.status, "on");
    assert.strictEqual(row.tools, 2);
    const reg = await hub.registry();
    const ids = reg.all().map((t) => t.id);
    assert.deepStrictEqual(ids, ["arcflare-web__web_search", "arcflare-web__web_fetch"]);
    const notes = arcs.capabilityNotes(ids);
    assert.match(notes, /## Web access is on/);
    assert.match(notes, /arcflare-web__web_search/);
    // The switch survives a restart of the hub.
    assert.strictEqual(new McpHub({ dir, builtins: true, load: () => ({ servers: {} }) }).list().find((s) => s.name === "arcflare-web").enabled, true);
  } finally { hub.stopAll(); }
});

test("a phone chat under an Arc gets its instructions first, the chat's own after, and stores neither", () => {
  const dir = tmp();
  let arc = null;
  const chats = new ChatManager({ dir, backend: async () => null, arc: () => arc });
  const doc = { system: "Answer in Swedish.", messages: [{ role: "user", content: "hej" }] };
  assert.deepStrictEqual(chats._withSystem(doc, doc.messages)[0], { role: "system", content: "Answer in Swedish." });
  assert.strictEqual(chats._withSystem({ messages: [] }, []).length, 0);

  arc = arcs.find("arc", { file: path.join(dir, "none.dat") });
  const sys = chats._withSystem(doc, doc.messages)[0].content;
  assert.ok(sys.startsWith("You are Arc,"));
  assert.match(sys, /plain conversation with no tools/);
  assert.ok(sys.endsWith("Answer in Swedish."));
  // The chat's own record is untouched: what is saved and sent to the phone has only the user's part.
  assert.strictEqual(doc.system, "Answer in Swedish.");
  assert.ok(chats._withSystem({ messages: [] }, [])[0].content.startsWith("You are Arc,"));
});

test("calls and sounds from agents: off by default only when muted, and only inside the user's hours", () => {
  const { inHours } = require("../lib/hub/settings");
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.ok(inHours(at(7), "07:00", "23:00") && inHours(at(22, 59), "07:00", "23:00"));
  assert.ok(!inHours(at(6, 59), "07:00", "23:00") && !inHours(at(23), "07:00", "23:00") && !inHours(at(3), "07:00", "23:00"));
  // A window past midnight wraps.
  assert.ok(inHours(at(23, 30), "22:00", "06:00") && inHours(at(5), "22:00", "06:00") && !inHours(at(12), "22:00", "06:00"));

  const dir = tmp();
  const s = new HubSettings({ dir });
  assert.deepStrictEqual(s.phone(), { muted: false, from: "07:00", until: "23:00", voice: null });
  assert.deepStrictEqual(s.phoneAllows(at(12)), { ring: true, sound: true, why: null });
  assert.strictEqual(s.phoneAllows(at(2)).sound, false);
  assert.match(s.phoneAllows(at(2)).why, /07:00 to 23:00/);
  s.setPhone({ muted: true });
  assert.deepStrictEqual(s.phoneAllows(at(12)), { ring: false, sound: false, why: "the user muted calls and notification sounds" });
  // Another process (the CLI) changing the file is seen without a restart.
  new HubSettings({ dir }).setPhone({ muted: false, from: "08:30", until: "20:00" });
  assert.deepStrictEqual(s.phone(), { muted: false, from: "08:30", until: "20:00", voice: null });
  assert.throws(() => s.setPhone({ from: "25:00" }), /HH:MM/);
  assert.throws(() => s.setPhone({ muted: "yes" }), /true or false/);
  assert.deepStrictEqual(new HubSettings({ dir }).phone(), { muted: false, from: "08:30", until: "20:00", voice: null }, "a refused change keeps the old one");
});

test("a notice carries its kind, and no sound when the user muted or it is outside their hours", () => {
  const { QuestionBox } = require("../lib/hub/local");
  let allows = { sound: true };
  const qb = new QuestionBox({ allows: () => allows });
  const seen = [];
  qb.on("event", (e) => seen.push(e));
  assert.deepStrictEqual(qb.notice({ title: "Committed", kind: "commit" }), { ok: true, sound: true });
  allows = { sound: false };
  assert.deepStrictEqual(qb.notice({ title: "Pushed", kind: "push" }), { ok: true, sound: false });
  qb.ask({ question: "Deploy?" });
  assert.deepStrictEqual(seen.map((e) => [e.type, e.kind, e.sound]), [["notice", "commit", true], ["notice", "push", false], ["question", undefined, false]]);
  assert.throws(() => qb.notice({ title: "x", kind: "siren" }), /kind is one of/);
});

test("the agent's voice on calls: only an installed speech model that needs no clip, and one of its voices", () => {
  const MODELS = [
    { id: "kokoro", kind: "tts", label: "Kokoro 82M", voices: ["af_heart", "am_michael"], defaultVoice: "af_heart" },
    { id: "big", kind: "tts", label: "Big", voices: [] },
    { id: "clone", kind: "tts", label: "Clone", needsRefText: true },
    { id: "hunyuan", label: "3D" },
  ];
  const have = new Set(["kokoro", "clone", "hunyuan"]);
  const gen = { MODELS, kindOf: (m) => m.kind || "3d", installed: (m) => have.has(m.id) };
  const s = new HubSettings({ dir: tmp(), gen });
  assert.deepStrictEqual(s.voiceChoices().map((m) => m.id), ["kokoro"]);
  assert.throws(() => s.setPhone({ voice: { model: "big" } }), /not installed/);
  assert.throws(() => s.setPhone({ voice: { model: "clone" } }), /not installed/);
  assert.throws(() => s.setPhone({ voice: { model: "kokoro", voice: "nope" } }), /no voice "nope"/);
  assert.deepStrictEqual(s.setPhone({ voice: { model: "kokoro", voice: "am_michael" } }).voice, { model: "kokoro", voice: "am_michael" });
  assert.deepStrictEqual(s.phone().voice, { model: "kokoro", voice: "am_michael" });
  assert.strictEqual(s.setPhone({ voice: null }).voice, null, "back to the phone's own voice");
});
