// Calls from agents to the phone (lib/hub/calls.js): the turns, who may do what when, the two recordings,
// and that mute and the user's hours stop the phone ringing at all.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CallBox } = require("../lib/hub/calls");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "af-calls-"));
const b64 = (s) => Buffer.from(s).toString("base64");

test("a call: ring, answer, reply, the agent's next line, hang up, then both recordings saved with a transcript", async () => {
  const dir = tmp();
  const box = new CallBox({ dir });
  const events = [];
  box.on("event", (e) => events.push(e));
  const { id } = box.start({ say: "The build failed. Retry?", from: "Claude Code" });
  assert.deepStrictEqual(events[0], { type: "call", id, from: "Claude Code", say: "The build failed. Retry?" });
  assert.throws(() => box.start({ say: "again" }), /already in a call/);
  assert.throws(() => box.reply(id, "yes"), /The call is ringing/);

  const v0 = box.current().version;
  const waiting = box.wait(id, v0 + 1, 2000);   // the agent waits past the answer, for the reply
  box.answer(id);
  box.reply(id, " Yes, retry it ");
  const c = await waiting;
  assert.deepStrictEqual([c.status, c.answer], ["waiting", "Yes, retry it"]);

  box.say(id, { say: "Retrying. Bye.", hangUp: true });
  assert.deepStrictEqual(events.at(-1), { type: "call_say", id, say: "Retrying. Bye.", hangUp: true });
  assert.throws(() => box.say(id, { say: "x" }), /The call is talking/);

  box.hangUp(id, ["conversation.wav", "answer-1.wav"]);
  assert.strictEqual(box.current(), null);
  assert.throws(() => box.audio(id, { name: "../x.wav", offset: 0, data: "" }), /Not a recording/);
  box.audio(id, { name: "conversation.wav", offset: 0, data: b64("RIFF") });
  box.audio(id, { name: "conversation.wav", offset: 0, data: b64("RIFF") });                 // a retried piece is not written twice
  assert.throws(() => box.audio(id, { name: "conversation.wav", offset: 99, data: b64("x") }), /Expected offset 4/);
  assert.strictEqual(box.audio(id, { name: "conversation.wav", offset: 4, data: b64("data"), last: true }).saved, false);
  assert.strictEqual(box.audio(id, { name: "answer-1.wav", offset: 0, data: b64("yes"), last: true }).saved, true);

  const done = await box.wait(id, -1, 0);
  assert.strictEqual(done.status, "ended");
  assert.strictEqual(fs.readFileSync(path.join(dir, id, "conversation.wav"), "utf8"), "RIFFdata");
  assert.deepStrictEqual(done.recordings.map((f) => path.basename(f)), ["conversation.wav", "answer-1.wav"]);
  const t = JSON.parse(fs.readFileSync(path.join(dir, id, "transcript.json"), "utf8"));
  assert.deepStrictEqual(t.turns.map((x) => [x.who, x.text]), [["agent", "The build failed. Retry?"], ["user", "Yes, retry it"], ["agent", "Retrying. Bye."]]);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(path.join(dir, id, "answer-1.wav")).mode & 0o077, 0, "recordings are private");
});

test("muted or outside the user's hours: the phone is not rung, and the agent is told why", () => {
  const box = new CallBox({ dir: tmp(), allows: () => ({ ring: false, why: "the user muted calls and notification sounds" }) });
  assert.throws(() => box.start({ say: "hi" }), (e) => e.status === 409 && /muted/.test(e.message));
  assert.strictEqual(box.current(), null);
});

test("declined, missed, and the agent hanging up all end the call and free the line", async () => {
  const box = new CallBox({ dir: tmp() });
  const events = [];
  box.on("event", (e) => events.push(e));
  let { id } = box.start({ say: "hi" });
  box.decline(id);
  assert.strictEqual((await box.wait(id, -1, 0)).status, "declined");
  ({ id } = box.start({ say: "hi" }));
  box.end(id);
  assert.strictEqual((await box.wait(id, -1, 0)).status, "missed");
  assert.strictEqual(events.at(-1).type, "call_end", "the phone stops ringing");
  ({ id } = box.start({ say: "hi" }));
  box.answer(id);
  box.end(id);
  assert.deepStrictEqual([(await box.wait(id, -1, 0)).status, events.at(-1).type], ["ended", "call_end"]);
  assert.throws(() => box.start({ say: "" }), /say is required/);
  assert.throws(() => box.start({ say: "x".repeat(1001) }), /too long/);
});

test("answering or declining with a message: the agent gets the text, marked as typed, and nothing is recorded for it", async () => {
  const box = new CallBox({ dir: tmp() });
  let { id } = box.start({ say: "Deploy now?" });
  assert.throws(() => box.decline(id, "x".repeat(501)), /up to 500/);
  box.decline(id, " In a meeting, text me ");
  let c = await box.wait(id, -1, 0);
  assert.strictEqual(c.why, 'the user declined, with the message "In a meeting, text me"');
  assert.deepStrictEqual(c.turns.at(-1), { who: "user", text: "In a meeting, text me", via: "text" });

  ({ id } = box.start({ say: "Deploy now?" }));
  box.answer(id);
  assert.throws(() => box.reply(id, "yes", "smoke"), /voice or text/);
  assert.throws(() => box.reply(id, "   ", "text"), /text required/);
  box.reply(id, "Yes, go", "text");
  c = await box.wait(id, -1, 0);
  assert.deepStrictEqual([c.status, c.answer, c.via], ["waiting", "Yes, go", "text"]);
  box.say(id, { say: "Deploying." });
  box.reply(id, "thanks");                      // spoken: the default, and it gets a recording name
  box.hangUp(id, []);
  assert.deepStrictEqual((await box.wait(id, -1, 0)).turns.map((t) => t.via), [undefined, "text", undefined, "voice"]);
});

test("what call_phone tells the agent: typed and heard answers, a decline message, and why there is no recording", () => {
  const { callReport } = require("../lib/mcp/tools");
  const base = { id: "c1", folder: "/calls/c1", recordings: [], saved: true, why: "the user hung up" };
  const typed = callReport({ ...base, status: "waiting", answer: "Yes", via: "text", turns: [] });
  assert.match(typed, /The user typed: "Yes"/);
  assert.doesNotMatch(typed, /microphone/);
  assert.match(callReport({ ...base, status: "waiting", answer: "Yes", via: "voice", turns: [] }), /Heard on the phone: "Yes"[\s\S]*anyone near the phone/);
  const declined = callReport({ ...base, status: "declined", why: 'the user declined, with the message "Busy"', turns: [] });
  assert.deepStrictEqual([declined.isError, /"Busy"/.test(declined.text)], [true, true]);
  const ended = (turns) => callReport({ ...base, status: "ended", turns });
  assert.match(ended([{ who: "agent", text: "Hi" }, { who: "user", text: "ok", via: "text" }]), /Typed: ok[\s\S]*answered by message/);
  // No answers at all, or spoken ones that came with no recording: never blamed on a message, and no guess at why.
  assert.match(ended([{ who: "agent", text: "Hi" }]), /the phone sent no recording/);
  assert.match(ended([{ who: "agent", text: "Hi" }, { who: "user", text: "ok", via: "voice" }]), /Heard: ok[\s\S]*sent no recording/);
});
