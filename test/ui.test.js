// Tests for the arrow-key menu.
//
// The menu only runs on a TTY, so these fake one: stdin becomes an emitter we
// can push keystrokes into, and stdout is captured. That makes the interactive
// path testable without a terminal, which matters because it is the part of the
// CLI a piped process can never exercise.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const ui = require("../lib/ui");

function fakeStreams() {
  const out = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;

  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 40;
  stdout.write = (s) => { out.push(String(s)); return true; };
  // readline.moveCursor/clearLine call these on the stream.
  stdout.cursorTo = () => true;
  stdout.moveCursor = () => true;
  stdout.clearLine = () => true;
  stdout.clearScreenDown = () => true;

  return { stdin, stdout, out };
}

function withFakeTty(keys, fn) {
  const { stdin, stdout, out } = fakeStreams();
  const p = fn({ stdin, stdout });
  // Deliver keystrokes once the menu has attached its listener.
  setImmediate(() => {
    for (const k of keys) stdin.emit("data", Buffer.from(k));
  });
  return p.then((v) => ({ value: v, out: out.join("") }));
}

const ITEMS = [
  { label: "ArcFlare chat", hint: "built in", value: "chat" },
  { label: "OpenCode", value: "opencode" },
  { label: "Hermes", value: "hermes" },
  { label: "Codex CLI", value: "codex", disabled: true },
];

const ENTER = "\r";
const DOWN = "[B";
const UP = "[A";
const ESC = "";

test("enter selects the first item", async () => {
  const { value } = await withFakeTty([ENTER], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, "chat");
});

test("down arrow moves the selection", async () => {
  const { value } = await withFakeTty([DOWN, ENTER], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, "opencode");
});

test("up arrow wraps to the last selectable item", async () => {
  // Codex is disabled, so wrapping upward must land on Hermes.
  const { value } = await withFakeTty([UP, ENTER], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, "hermes");
});

test("disabled items are skipped when moving down", async () => {
  const { value } = await withFakeTty([DOWN, DOWN, DOWN, ENTER],
    (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, "chat", "past Hermes should wrap over Codex back to chat");
});

test("escape cancels and returns null", async () => {
  const { value } = await withFakeTty([ESC], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, null);
});

test("ctrl-c cancels", async () => {
  const { value } = await withFakeTty([""], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, null);
});

test("number keys jump straight to an item", async () => {
  const { value } = await withFakeTty(["3"], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, "hermes");
});

test("a number pointing at a disabled item does nothing", async () => {
  const { value } = await withFakeTty(["4", ENTER], (io) => ui.select("Pick", ITEMS, io));
  assert.strictEqual(value, "chat", "4 is disabled, so enter takes the default");
});

test("the frame renders every label, the title and the key hints", async () => {
  const { out } = await withFakeTty([ENTER],
    (io) => ui.select("Choose a harness", ITEMS, { ...io, subtitle: "point it at your model" }));
  for (const it of ITEMS) assert.ok(out.includes(it.label), `missing ${it.label}`);
  assert.ok(out.includes("Choose a harness"));
  assert.ok(out.includes("point it at your model"));
  assert.ok(out.includes("enter select"));
});

test("preselection starts on the remembered item", async () => {
  const { value } = await withFakeTty([ENTER],
    (io) => ui.select("Pick", ITEMS, { ...io, selected: "hermes" }));
  assert.strictEqual(value, "hermes");
});

test("off a TTY it takes the default instead of hanging", async () => {
  // No fake TTY here: this is the piped / CI path.
  const v = await ui.select("Pick", ITEMS);
  assert.strictEqual(v, "chat");
});

test("a list with nothing selectable resolves rather than blocking", async () => {
  const v = await ui.select("Pick", [{ label: "x", value: "x", disabled: true }]);
  assert.strictEqual(v, null);
});

test("byte formatting is human readable", () => {
  assert.strictEqual(ui.fmtBytes(0), "0 B");
  assert.strictEqual(ui.fmtBytes(1024), "1 KB");
  assert.match(ui.fmtBytes(30.4 * 1024 ** 3), /^30\.4 GB$/);
});

test("token counts abbreviate the way people write them", () => {
  assert.strictEqual(ui.fmtTokens(262144), "256K");
  assert.strictEqual(ui.fmtTokens(131072), "128K");
  assert.strictEqual(ui.fmtTokens(4096), "4K");
  assert.strictEqual(ui.fmtTokens(1048576), "1M");
});

test("hints stay readable without colour", async () => {
  // With NO_COLOR the label and its hint must not run together into one phrase.
  const { out } = await withFakeTty([ENTER], (io) => ui.select("Pick", ITEMS, io));
  if (!ui.useColor) {
    assert.ok(out.includes("(built in)"),
      "hint should be bracketed when colour is unavailable");
    assert.ok(!out.includes("ArcFlare chat built in"),
      "label and hint must not read as one phrase");
  } else {
    assert.ok(out.includes("built in"));
  }
});

test("notes are separated without colour too", async () => {
  const items = [{ label: "Qwen3.6", note: "30.4 GB", value: "a" }];
  const { out } = await withFakeTty([ENTER], (io) => ui.select("Pick", items, io));
  if (!ui.useColor) assert.ok(out.includes("- 30.4 GB"));
  else assert.ok(out.includes("30.4 GB"));
});
