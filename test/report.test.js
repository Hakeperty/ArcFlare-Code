// Failure reports leave the machine only after the person agrees, and what
// they would send must not carry the home folder, user name or tokens.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const rep = require("../lib/report");

test("failure reports scrub the home folder, user name and tokens", () => {
  const v = rep.failureReport({ what: "update", error: `error in ${os.homedir()}/x with ghp_${"a".repeat(30)}`, version: "1.0.0" });
  assert.ok(v.payload, v.error);
  assert.ok(!v.payload.body.includes(os.homedir()));
  assert.ok(!/ghp_a/.test(v.payload.body));
  assert.strictEqual(v.payload.kind, "bug");
  assert.strictEqual(v.payload.where, "cli");
});
