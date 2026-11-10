// Deleting an agent really deletes it, and one-time agents and chats leave nothing behind.
// No model runs: the backend and the agent factory are fakes, so this takes milliseconds.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-onetime-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");

const { Supervisor, oneTimeDir } = require("../lib/hub/supervisor");
const { ChatManager } = require("../lib/hub/chat");
const sessions = require("../lib/agent/sessions");

const ROOT = path.join(TMP, "root");
const PROJ = path.join(ROOT, "proj");
fs.mkdirSync(PROJ, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fakeFactory(log = []) {
  return (o) => {
    const a = {
      opts: o, messages: [], busy: false, aborted: 0,
      conversation() { return this.messages.slice(); },
      loadConversation(m) { this.messages = m.slice(); },
      abort() { this.aborted++; if (this._release) this._release(); },
      async send(text) {
        this.busy = true;
        try {
          this.messages.push({ role: "user", content: text });
          if (text === "hang") { await new Promise((r) => { this._release = r; }); return { ok: false, aborted: true }; }
          this.messages.push({ role: "assistant", content: `echo ${text}` });
          return { ok: true, content: `echo ${text}` };
        } finally { this.busy = false; }
      },
    };
    log.push(a);
    return a;
  };
}
const backend = async (tier) => ({ port: 1, model: `m-${tier}`, nCtx: 4096, modelRef: `ref-${tier}` });
function make(extra = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const log = [];
  const sup = new Supervisor({ dir, roots: [ROOT], backend, makeAgent: fakeFactory(log), ...extra });
  const events = [];
  sup.on("event", (e) => events.push(e));
  return { sup, dir, log, events };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(10); } return false; };
const sessionId = (sup, id) => sup.agents.get(id).sessionId;
const onDisk = (sid) => ({ file: fs.existsSync(sessions.fileFor(sid)), folder: fs.existsSync(sessions.folderFor(sid)), temp: fs.existsSync(oneTimeDir(sid)) });

// ------------------------------------------------------------- deleting --

test("deleting an agent erases its saved conversation and undo snapshots, not only its record", async () => {
  const { sup, dir, events } = make();
  const a = sup.create({ name: "private", cwd: PROJ });
  await sup.wake(a.id, "my secret plan");
  await sup.whenIdle(a.id);
  const sid = sessionId(sup, a.id);
  fs.mkdirSync(sessions.folderFor(sid), { recursive: true });                 // what Checkpoints writes
  fs.writeFileSync(path.join(sessions.folderFor(sid), "checkpoints.json"), "{}");
  assert.strictEqual(onDisk(sid).file, true, "the conversation was saved");
  assert.match(fs.readFileSync(sessions.fileFor(sid), "utf8"), /my secret plan/);

  await sup.remove(a.id);

  assert.deepStrictEqual(onDisk(sid), { file: false, folder: false, temp: false });
  assert.deepStrictEqual(sup.list(), []);
  assert.ok(!fs.readFileSync(path.join(dir, "agents.json"), "utf8").includes(a.id), "gone from agents.json");
  assert.ok(events.some((e) => e.type === "removed" && e.agentId === a.id), "the phone is told");
  assert.throws(() => sup.history(a.id), { code: "NOT_FOUND" });
});

test("deleting a running agent stops it first", async () => {
  const { sup, log } = make();
  const a = sup.create({ name: "busy", cwd: PROJ });
  await sup.wake(a.id, "hang");
  await sup.remove(a.id);
  assert.strictEqual(log[0].aborted, 1);
  assert.deepStrictEqual(sup.list(), []);
});

// ------------------------------------------------------- one-time agents --

test("a one-time agent is never written to disk: no agents.json entry, no saved conversation", async () => {
  const { sup, dir } = make();
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  assert.strictEqual(a.oneTime, true);
  assert.strictEqual(a.ttlMinutes, 10);
  await sup.wake(a.id, "burn after reading");
  await sup.whenIdle(a.id);
  const sid = sessionId(sup, a.id);
  assert.strictEqual(onDisk(sid).file, false);
  assert.strictEqual(onDisk(sid).folder, false);
  let saved = "";
  try { saved = fs.readFileSync(path.join(dir, "agents.json"), "utf8"); } catch { /* never written is fine */ }
  assert.ok(!saved.includes("burn after reading") && !saved.includes(a.id), "not in agents.json");
  assert.strictEqual(sup.list().length, 1, "but it is in the live list");
  await sup.stopAll();
});

test("stopping a one-time agent deletes it", async () => {
  const { sup, events } = make();
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.wake(a.id, "hello");
  await sup.whenIdle(a.id);
  const snap = await sup.stop(a.id);
  assert.strictEqual(snap.status, "stopped");
  assert.deepStrictEqual(sup.list(), []);
  assert.ok(events.some((e) => e.type === "removed" && e.agentId === a.id && e.oneTime === true));
  assert.throws(() => sup.history(a.id), { code: "NOT_FOUND" });
});

test("a one-time agent that was never started deletes itself when stopped", async () => {
  const { sup } = make();
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.stop(a.id);
  assert.deepStrictEqual(sup.list(), []);
});

test("a one-time agent deletes itself after it sits idle", async () => {
  const { sup, events } = make({ oneTimeTtlMs: 60 });
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.wake(a.id, "hi");
  await sup.whenIdle(a.id);
  assert.strictEqual(sup.list().length, 1);
  assert.ok(await waitFor(() => sup.list().length === 0), "expired");
  assert.ok(events.some((e) => e.type === "removed" && e.agentId === a.id));
});

test("activity keeps a one-time agent alive; a turn in progress is not idle", async () => {
  const { sup } = make({ oneTimeTtlMs: 80 });
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.wake(a.id, "hang");                       // a turn that does not end
  await sleep(250);                                    // three clocks have run out
  assert.strictEqual(sup.list().length, 1, "busy, so still here");
  sup.agents.get(a.id); await sup.stop(a.id, { keep: true });   // end the turn without deleting
  assert.strictEqual(sup.list().length, 1, "restart-style stop keeps it");
  assert.ok(await waitFor(() => sup.list().length === 0), "and once idle it goes");
});

test("an agent waiting on an approval is not idle", async () => {
  const { sup } = make({ oneTimeTtlMs: 60, approveTimeoutMs: 5000 });
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.wake(a.id, "hang");
  sup.rt.get(a.id).approvals.set("x", { id: "x", kind: "bash", detail: "ls", timer: setTimeout(() => {}, 1), resolve() {} });
  await sleep(200);
  assert.strictEqual(sup.list().length, 1, "waiting on you");
  sup.rt.get(a.id).approvals.clear();
  await sup.stop(a.id);
});

test("shutting the hub down deletes every one-time agent and keeps the others", async () => {
  const { sup } = make();
  const keep = sup.create({ name: "keep", cwd: PROJ });
  const once = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.stopAll();
  assert.deepStrictEqual(sup.list().map((x) => x.id), [keep.id]);
  assert.ok(!sup.agents.has(once.id));
});

test("a restarted hub has no one-time agents and no leftover scratch files", () => {
  const { sup, dir } = make();
  const once = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  const sid = sessionId(sup, once.id);
  fs.mkdirSync(oneTimeDir(sid), { recursive: true });
  fs.writeFileSync(path.join(oneTimeDir(sid), "checkpoints.json"), "{}");
  const again = new Supervisor({ dir, roots: [ROOT], backend, makeAgent: fakeFactory() });   // the hub restarts
  assert.deepStrictEqual(again.list(), []);
  assert.strictEqual(fs.existsSync(oneTimeDir(sid)), false, "the temp folder was swept");
});

test("a one-time agent keeps its undo snapshots in the temp folder, and they go with it", async () => {
  const { sup, log } = make();
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.wake(a.id, "hi");
  assert.strictEqual(log[0].opts.oneTime, true, "the factory is told, so it keeps snapshots out of the saved sessions");
  const sid = sessionId(sup, a.id);
  fs.mkdirSync(oneTimeDir(sid), { recursive: true });
  fs.writeFileSync(path.join(oneTimeDir(sid), "checkpoints.json"), "{}");
  await sup.stop(a.id);
  assert.strictEqual(fs.existsSync(oneTimeDir(sid)), false);
});

test("changing the model of a one-time agent restarts it and keeps it", async () => {
  const { sup } = make({ backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }) });
  const a = sup.create({ name: "once", cwd: PROJ, oneTime: true });
  await sup.wake(a.id, "hi");
  await sup.whenIdle(a.id);
  await sup.setModel(a.id, null);
  assert.strictEqual(sup.list().length, 1);
  assert.strictEqual(sup.list()[0].status, "stopped");
  await sup.stopAll();
});

test("ttlMinutes is checked", () => {
  const { sup } = make();
  assert.throws(() => sup.create({ name: "x", cwd: PROJ, oneTime: true, ttlMinutes: 0 }), { code: "BAD_TTL" });
  assert.throws(() => sup.create({ name: "x", cwd: PROJ, oneTime: true, ttlMinutes: 241 }), { code: "BAD_TTL" });
  assert.throws(() => sup.create({ name: "x", cwd: PROJ, oneTime: true, ttlMinutes: "soon" }), { code: "BAD_TTL" });
  assert.strictEqual(sup.create({ name: "y", cwd: PROJ, oneTime: true, ttlMinutes: 3 }).ttlMinutes, 3);
  assert.strictEqual(sup.create({ name: "z", cwd: PROJ, ttlMinutes: 3 }).oneTime, false, "ttl means nothing without oneTime");
});

// ----------------------------------------------------------- one-time chats --

function chatMgr(extra = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, "chat-"));
  const chats = new ChatManager({ dir, backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "m" }), models: () => [{ id: "m" }], ...extra });
  return { chats, dir };
}
const chatFiles = (dir) => { try { return fs.readdirSync(path.join(dir, "chats")); } catch { return []; } };

test("a one-time chat is kept in memory only", () => {
  const { chats, dir } = chatMgr();
  const keep = chats.create({ title: "normal" });
  const once = chats.create({ oneTime: true });
  assert.strictEqual(once.oneTime, true);
  assert.strictEqual(once.title, "One-time chat");
  assert.strictEqual(once.ttlMinutes, 10);
  chats.setSystem(once.id, "you are a secret keeper");
  chats.rename(once.id, "private");
  assert.deepStrictEqual(chatFiles(dir), [`${keep.id}.json`], "only the normal chat has a file");
  assert.strictEqual(chats.get(once.id).system, "you are a secret keeper");
  assert.strictEqual(chats.get(once.id).title, "private");
  assert.strictEqual(chats.list().length, 2, "but it is in the list");
  assert.strictEqual(chats.list().find((c) => c.id === once.id).oneTime, true);
  chats.remove(once.id);
  chats.remove(keep.id);
});

test("deleting a one-time chat forgets it and its history; the open screen is told", () => {
  const { chats } = chatMgr();
  const once = chats.create({ oneTime: true });
  const seen = [];
  chats.on("event", (e) => seen.push(e));
  chats.remove(once.id);
  assert.ok(seen.some((e) => e.kind === "removed" && e.chatId === once.id));
  assert.throws(() => chats.get(once.id), { status: 404 });
  assert.deepStrictEqual(chats.history(once.id), []);
  assert.deepStrictEqual(chats.list(), []);
});

test("a one-time chat deletes itself after it sits idle, but not while answering", async () => {
  const { chats } = chatMgr({ oneTimeTtlMs: 60 });
  const once = chats.create({ oneTime: true });
  chats.running.set(once.id, { abort: new AbortController() });   // pretend an answer is streaming
  await sleep(200);
  assert.strictEqual(chats.list().length, 1, "still answering, so still here");
  chats.running.delete(once.id);
  assert.ok(await waitFor(() => chats.list().length === 0), "idle, so it goes");
});

test("stopping the model deletes every one-time chat and keeps the others", () => {
  const { chats, dir } = chatMgr();
  const keep = chats.create({ title: "normal" });
  chats.create({ oneTime: true });
  chats.create({ oneTime: true });
  assert.strictEqual(chats.purgeOneTime(), 2);
  assert.deepStrictEqual(chats.list().map((c) => c.id), [keep.id]);
  assert.deepStrictEqual(chatFiles(dir), [`${keep.id}.json`]);
});

test("a one-time chat's ttlMinutes is checked", () => {
  const { chats } = chatMgr();
  assert.throws(() => chats.create({ oneTime: true, ttlMinutes: 0 }), { status: 400 });
  assert.throws(() => chats.create({ oneTime: true, ttlMinutes: 1000 }), { status: 400 });
  assert.strictEqual(chats.create({ oneTime: true, ttlMinutes: 2 }).ttlMinutes, 2);
  chats.purgeOneTime();
});
