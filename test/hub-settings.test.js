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
  assert.deepStrictEqual(list.map((s) => s.name), ["arcflare-desktop", "arcflare-web", "mine"]);
  assert.ok(list.every((s) => s.enabled === false && s.status === "off"));
  assert.strictEqual(list[1].builtin, true);
  assert.match(list[1].about, /Search the web/);
  assert.strictEqual(list[2].builtin, false);
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
