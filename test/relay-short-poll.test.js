"use strict";
// Short polling against a relay that answers at once with a `next` hint (arcflare.net does, to stay in a
// free serverless tier): the hub and the phone follow the hint within clamps, send short=1, never spin on
// a relay that always answers "nothing", and the phone looks for an answer right after it sends.
const test = require("node:test");
const assert = require("node:assert/strict");
const { nextPollDelay } = require("../lib/hub/tunnel");
const TC = require("../lib/hub/ui/tunnel-client");

const L = { relayNextMinMs: 250, relayNextMaxMs: 60000, relayMinPollMs: 1000 };

test("hub: a relay hint is followed, within clamps", () => {
  assert.equal(nextPollDelay(30000, 0, 40, L), 30000);
  assert.equal(nextPollDelay(500, 3, 40, L), 500);
  assert.equal(nextPollDelay(0, 0, 40, L), 250, "a zero hint cannot spin the hub");
  assert.equal(nextPollDelay(-5, 0, 40, L), 250);
  assert.equal(nextPollDelay(1e12, 0, 40, L), 60000, "a huge hint cannot stall the hub");
  assert.equal(nextPollDelay(NaN, 1, 40, L), 0, "not a number: treated as no hint");
  assert.equal(nextPollDelay("500", 1, 40, L), 0, "a string is not a hint");
});

test("hub: without a hint, re-poll at once unless the relay keeps answering early and empty", () => {
  assert.equal(nextPollDelay(undefined, 2, 10, L, 0), 0, "frames: at once");
  assert.equal(nextPollDelay(undefined, 0, 25000, L, 0), 0, "a full long-poll: at once");
  assert.equal(nextPollDelay(undefined, 0, 10, L, 1), 0, "one spurious early wake-up is fine");
  assert.equal(nextPollDelay(undefined, 0, 10, L, 3), 990, "three in a row: wait out the minimum");
});

function fakeRelay(replies) {
  const urls = [];
  const fetch = async (url, init) => {
    urls.push({ url, method: init.method, at: Date.now() });
    if (init.method === "POST") return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{\"ok\":true}" };
    const body = replies.length > 1 ? replies.shift() : replies[0];
    const text = JSON.stringify(body);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === "content-length" ? String(text.length) : null) }, text: async () => text };
  };
  return { fetch, urls };
}

test("phone: sends short=1, follows `next` within clamps", async () => {
  const relay = fakeRelay([{ frames: [], head: 0, online: true, next: 0 }]);
  const mb = new TC._internal.Mailbox({ relay: "https://r.test", room: "x".repeat(43), token: "t", fetch: relay.fetch, onFrame: async () => {} });
  mb.start();
  await new Promise((r) => setTimeout(r, 1100));
  mb.stop();
  const polls = relay.urls.filter((u) => u.method === "GET");
  assert.ok(polls.every((p) => p.url.includes("short=1")));
  // next: 0 is clamped to 250 ms, so about 4-5 polls in 1.1 s, not hundreds.
  assert.ok(polls.length >= 3 && polls.length <= 6, `polls: ${polls.length}`);
});

test("phone: a long idle pause is cut short when it sends something", async () => {
  const relay = fakeRelay([{ frames: [], head: 0, online: true, next: 30000 }]);
  const mb = new TC._internal.Mailbox({ relay: "https://r.test", room: "x".repeat(43), token: "t", fetch: relay.fetch, onFrame: async () => {} });
  mb.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(relay.urls.filter((u) => u.method === "GET").length, 1, "first poll, then a 30 s pause");
  await mb.send(new Uint8Array([1, 2, 3]));
  await new Promise((r) => setTimeout(r, 100));
  mb.stop();
  assert.equal(relay.urls.filter((u) => u.method === "GET").length, 2, "polled again right after the send");
});

test("phone: stop() ends a long pause at once", async () => {
  const relay = fakeRelay([{ frames: [], head: 0, online: true, next: 30000 }]);
  const mb = new TC._internal.Mailbox({ relay: "https://r.test", room: "x".repeat(43), token: "t", fetch: relay.fetch, onFrame: async () => {} });
  mb.start();
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  mb.stop();
  await mb.loop;
  assert.ok(Date.now() - t0 < 500, "the loop ended without waiting out the pause");
});
