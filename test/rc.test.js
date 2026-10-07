// Tests for remote control. What matters here is what fails quietly: a message
// typed in a browser that never reaches the session, an approval nobody can
// answer that is treated as a yes, a key that leaks into a request it should
// not be in.
//
// The relay is a fake fetch with the real protocol's shape, so these run with
// no network; the website's own relay is exercised against this client in the
// end-to-end check described in README.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-rc-"));
delete process.env.ARCFLARE_RELAY;
const rc = require("../lib/rc");

/** A relay in memory: host posts land in `posted`, and `toHost` is what polls return. */
function fakeRelay() {
  const r = { posted: [], toHost: [], seq: 0, waiters: [], urls: [] };
  r.give = (ev) => {
    r.toHost.push({ ...ev, seq: ++r.seq });
    r.waiters.splice(0).forEach((w) => w());
  };
  r.fetch = async (url, init = {}) => {
    r.urls.push(url);
    const json = (body, status = 200) => ({
      ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    });
    if ((init.method || "GET") === "POST") {
      r.posted.push(JSON.parse(init.body));
      return json({ ok: true });
    }
    const after = Number(new URL(url).searchParams.get("after"));
    let events = r.toHost.filter((e) => e.seq > after);
    if (!events.length) {
      await new Promise((res) => {
        r.waiters.push(res);
        init.signal?.addEventListener("abort", res, { once: true });
        setTimeout(res, 200);
      });
      events = r.toHost.filter((e) => e.seq > after);
    }
    return json({ events, clients: 1 });
  };
  return r;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- key ----

test("a key is 24 random bytes in a recognisable wrapper", () => {
  const a = rc.newKey();
  const b = rc.newKey();
  assert.match(a, rc.KEY_RE);
  assert.notStrictEqual(a, b);
});

test("the key is kept between sessions until rotated", () => {
  const first = rc.getKey();
  assert.strictEqual(rc.getKey(), first, "a paired device must keep working");
  const rotated = rc.getKey({ rotate: true });
  assert.notStrictEqual(rotated, first);
  assert.strictEqual(rc.getKey(), rotated);
});

test("the link carries the key in the fragment, which browsers never send", () => {
  const url = new URL(rc.linkFor("https://arcflare.example", "afrc_" + "x".repeat(32)));
  assert.strictEqual(url.pathname, "/remote");
  assert.strictEqual(url.search, "");
  assert.match(url.hash, /^#k=afrc_/);
});

test("the relay must be an http(s) URL", () => {
  assert.throws(() => rc.setRelay("ftp://nope"));
  assert.throws(() => rc.setRelay("not a url"));
  assert.strictEqual(rc.setRelay("https://my.site/"), "https://my.site");
  assert.strictEqual(rc.relayUrl(), "https://my.site");
});

// ---------------------------------------------------------------- session ----

test("deltas are coalesced into one batch instead of a request per token", async () => {
  const relay = fakeRelay();
  const s = new rc.RemoteSession({ relay: "http://r", key: rc.newKey(), fetch: relay.fetch });
  await s.open();
  for (const t of ["He", "llo", " there"]) s.emit({ type: "delta", kind: "content", text: t });
  s.emit({ type: "turn_end" });
  await tick(200);
  const batches = relay.posted.filter((p) => p.type === "events");
  assert.strictEqual(batches.length, 1);
  assert.deepStrictEqual(batches[0].events, [
    { type: "delta", kind: "content", text: "Hello there" },
    { type: "turn_end" },
  ]);
  await s.close();
});

test("the key travels in a header, never in a URL", async () => {
  const relay = fakeRelay();
  const key = rc.newKey();
  const s = new rc.RemoteSession({ relay: "http://r", key, fetch: relay.fetch });
  await s.open();
  await tick(50);
  await s.close();
  assert.ok(relay.urls.length > 1);
  for (const u of relay.urls) assert.ok(!u.includes(key), `key leaked into ${u}`);
});

test("a browser message sent while nobody is waiting is not lost", async () => {
  const relay = fakeRelay();
  const s = new rc.RemoteSession({ relay: "http://r", key: rc.newKey(), fetch: relay.fetch });
  await s.open();
  relay.give({ type: "message", text: "first" });
  relay.give({ type: "message", text: "second" });
  await tick(100);
  const a = await s.nextMessage(); s.consumed();
  const b = await s.nextMessage(); s.consumed();
  assert.deepStrictEqual([a.text, b.text], ["first", "second"]);
  await s.close();
});

test("approval: the browser's answer is the answer", async () => {
  const relay = fakeRelay();
  const s = new rc.RemoteSession({ relay: "http://r", key: rc.newKey(), fetch: relay.fetch });
  await s.open();
  const yes = s.askApproval("bash", "npm test");
  const no = s.askApproval("bash", "rm -rf build");
  await tick(200);
  const asked = relay.posted.flatMap((p) => p.events || []).filter((e) => e.type === "approval");
  assert.strictEqual(asked.length, 2);
  relay.give({ type: "approve", id: asked[0].id, allow: true });
  relay.give({ type: "approve", id: asked[1].id, allow: false });
  assert.strictEqual(await yes, true);
  assert.strictEqual(await no, false);
  await s.close();
});

test("approval: silence is a no, and so is closing the session", async () => {
  const relay = fakeRelay();
  const s = new rc.RemoteSession({ relay: "http://r", key: rc.newKey(), fetch: relay.fetch });
  await s.open();
  assert.strictEqual(await s.askApproval("bash", "x", 50), false, "a timeout must not run the command");
  const pending = s.askApproval("bash", "y");
  await s.close();
  assert.strictEqual(await pending, false);
});

test("a relay that forgot the session gets it opened again", async () => {
  const relay = fakeRelay();
  let forgotten = true;
  const inner = relay.fetch;
  relay.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "GET" && forgotten) {
      forgotten = false;
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }
    return inner(url, init);
  };
  const s = new rc.RemoteSession({ relay: "http://r", key: rc.newKey(), fetch: relay.fetch });
  await s.open();
  await tick(100);
  assert.strictEqual(relay.posted.filter((p) => p.type === "open").length, 2);
  await s.close();
});

// ------------------------------------------------------------------ input ----

function fakeReadline() {
  const rl = new EventEmitter();
  rl.asked = 0;
  rl.question = (prompt, cb) => { rl.asked++; rl.answer = cb; };
  return rl;
}

test("InputMux: a line typed during a remote turn is still there afterwards", async () => {
  const relay = fakeRelay();
  const s = new rc.RemoteSession({ relay: "http://r", key: rc.newKey(), fetch: relay.fetch });
  await s.open();
  const rl = fakeReadline();
  const mux = new rc.InputMux(rl, "> ");

  const first = mux.next(s);
  relay.give({ type: "message", text: "from the phone" });
  assert.deepStrictEqual(await first, { from: "remote", text: "from the phone" });

  // The terminal's question is still pending from the race it lost; typing
  // now must answer the *next* call, and must not ask a second question.
  rl.answer("from the keyboard");
  assert.deepStrictEqual(await mux.next(s), { from: "terminal", text: "from the keyboard" });
  assert.strictEqual(rl.asked, 1);
  await s.close();
});

test("InputMux: closing stdin ends the loop", async () => {
  const rl = fakeReadline();
  const mux = new rc.InputMux(rl, "> ");
  const p = mux.next(null);
  rl.emit("close");
  assert.deepStrictEqual(await p, { from: "terminal", text: null });
});

// -------------------------------------------------------------- translate ----

test("agent events become small browser events", () => {
  assert.deepStrictEqual(rc.toRemote({ type: "content", text: "hi" }), { type: "delta", kind: "content", text: "hi" });
  assert.strictEqual(rc.toRemote({ type: "content", text: "" }), null);
  const res = rc.toRemote({ type: "tool_result", name: "bash", out: "ERROR: nope\nmore\nlines" });
  assert.deepStrictEqual(res, { type: "tool_result", name: "bash", line: "ERROR: nope", lines: 3, error: true });
  assert.strictEqual(rc.toRemote({ type: "tool", name: "read_file", args: { path: "a.js" } }).detail, "a.js");
  assert.strictEqual(rc.toRemote({ type: "done" }), null);
});
