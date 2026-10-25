"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fingerprint } = require("../www/fingerprint.js");
const { b64u } = require("./helpers.js");

const CLI = path.join(__dirname, "..", "..", "lib", "hub", "cli.js");

/** Pull the CLI's own keyFingerprint() out of its source and run it, so the test follows the CLI. */
function cliFingerprint() {
  const src = fs.readFileSync(CLI, "utf8");
  const m = /function keyFingerprint\(pub\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "keyFingerprint not found in lib/hub/cli.js");
  return vm.runInNewContext("(" + m[0].replace(/^function keyFingerprint/, "function") + ")", { require });
}

test("fingerprint equals the CLI's for random keys", async () => {
  const cli = cliFingerprint();
  for (let i = 0; i < 25; i++) {
    const pub = crypto.randomBytes(32);
    assert.equal(await fingerprint(b64u(pub)), cli(pub));
  }
});

test("shape: 20 hex digits in five groups of four; SHA-256 of the raw key, first 10 bytes", async () => {
  const pub = Buffer.alloc(32, 1);
  const fp = await fingerprint(b64u(pub));
  assert.match(fp, /^([0-9a-f]{4} ){4}[0-9a-f]{4}$/);
  assert.equal(fp.replace(/ /g, ""), crypto.createHash("sha256").update(pub).digest("hex").slice(0, 20));
});

test("a value that is not a 32-byte key is refused", async () => {
  await assert.rejects(fingerprint("abc"));
  await assert.rejects(fingerprint(b64u(Buffer.alloc(31))));
  await assert.rejects(fingerprint(null));
});
