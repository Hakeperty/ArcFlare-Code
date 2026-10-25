"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create, MAX_AGE_MS, GRACE_MS } = require("../www/linkgate.js");

test("defaults: 5 minutes, 2 s grace", () => { assert.equal(MAX_AGE_MS, 300000); assert.equal(GRACE_MS, 2000); });

test("a fresh link is ok; one older than 5 minutes is too old (even right after foregrounding)", () => {
  let t = 1e6; const g = create({ now: () => t });
  assert.equal(g.judge(t), "ok");
  t += 299000; assert.equal(g.judge(1e6), "ok");
  t += 2000; assert.equal(g.judge(1e6), "too-old");
  g.foreground();
  assert.equal(g.judge(1e6), "too-old");
});

test("a link held from before the app was foregrounded is dropped; one within the grace is kept", () => {
  let t = 1e6; const g = create({ now: () => t });
  const heldAt = t;                 // arrived while in the background
  t += 1500; g.foreground();        // the intent that opened the app: foreground within the grace
  assert.equal(g.judge(heldAt), "ok");
  const staleAt = t;
  t += 60000; g.foreground();       // the person came back a minute later for another reason
  assert.equal(g.judge(staleAt), "before-foreground");
});

test("nonsense timestamps are refused", () => {
  const g = create({ now: () => 5 });
  for (const v of [undefined, null, NaN, "1", Infinity]) assert.equal(g.judge(v), "too-old");
});
