"use strict";
// The "Update ArcFlare" screen of the real shell.js (see shell-harness.js): the app updates itself from arcflare.net
// with no pairing, no sign-in and no computer. The native side (AppUpdaterPlugin) is faked; OnlineUpdate.java has its
// own test (onlineupdate.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeShell, key, pairedRecord } = require("./shell-harness.js");

/** A fake AppUpdater: installed 100, arcflare.net offers `offer`. Records every call. */
function fakeUpdater({ installed = 100, offer = { versionCode: 200, versionName: "1.0.200", size: 3 * 1048576 }, canInstall = true, check, download, commit } = {}) {
  const calls = [];
  const u = {
    calls,
    canInstall,
    info: async () => { calls.push("info"); return { versionCode: installed, versionName: "1.0." + installed, canInstall: u.canInstall }; },
    checkOnline: async (...a) => { calls.push("checkOnline"); assert.equal(a.length <= 1 && !a[0], true, "the page passes no address"); if (check) return check(); return offer; },
    downloadOnline: async () => { calls.push("downloadOnline"); if (download) return download(); },
    commit: async () => { calls.push("commit"); return commit ? commit() : { status: "installed" }; },
    abort: async () => { calls.push("abort"); },
    openInstallSettings: async () => { calls.push("openInstallSettings"); },
  };
  return u;
}

async function onUpdateScreen(opts) {
  const s = makeShell(opts);
  await s.start();
  assert.equal(s.visible(), "v-pair");
  assert.equal(s.els["pair-update"].hidden, false);
  s.els["pair-update"].click(); await s.tick();
  assert.equal(s.visible(), "v-update");
  return s;
}

test("outside the app (no updater) the Update the app buttons stay hidden", async () => {
  const s = makeShell();
  await s.start();
  assert.equal(s.visible(), "v-pair");
  assert.equal(s.els["pair-update"].hidden, true);
  assert.equal(s.els["st-update"].hidden, true);
});

test("unpaired: check, then install a newer version from arcflare.net", async () => {
  const u = fakeUpdater();
  const s = await onUpdateScreen({ updater: u });
  s.els["upd-go"].click(); await s.tick();
  assert.match(s.text("upd-text"), /^Version 1\.0\.200 is ready \(3\.0 MB\)\. You have 1\.0\.100\.$/);
  assert.equal(s.text("upd-go"), "Install update");
  assert.deepEqual(u.calls, ["info", "checkOnline"], "nothing is downloaded before the person asks");
  s.els["upd-go"].click(); await s.tick();
  assert.deepEqual(u.calls.slice(2), ["info", "downloadOnline", "commit"]);
  assert.equal(s.text("upd-text"), "Installed.");
  assert.equal(s.els["upd-error"].hidden, true);
});

test("the same or an older version on arcflare.net is not offered", async () => {
  for (const code of [100, 99]) {
    const u = fakeUpdater({ offer: { versionCode: code, versionName: "x", size: 5000 } });
    const s = await onUpdateScreen({ updater: u });
    s.els["upd-go"].click(); await s.tick();
    assert.equal(s.text("upd-text"), "You have the newest version (1.0.100).");
    assert.equal(s.text("upd-go"), "Check again");
    assert.ok(!u.calls.includes("downloadOnline"));
  }
});

test("arcflare.net unreachable: the error is shown and Check can be tried again", async () => {
  const u = fakeUpdater({ check: async () => { throw new Error("could not reach arcflare.net: timeout"); } });
  const s = await onUpdateScreen({ updater: u });
  s.els["upd-go"].click(); await s.tick();
  assert.equal(s.text("upd-error"), "could not reach arcflare.net: timeout");
  assert.equal(s.els["upd-error"].hidden, false);
  assert.equal(s.text("upd-go"), "Check for an update");
  assert.equal(s.els["upd-go"].disabled, false);
});

test("a failed download or a refused install abandons the session and offers Install again", async () => {
  for (const [what, opts] of [["download", { download: async () => { throw new Error("download failed: HTTP 404"); } }], ["install", { commit: async () => ({ status: "failed", message: "signatures do not match" }) }]]) {
    const u = fakeUpdater(opts);
    const s = await onUpdateScreen({ updater: u });
    s.els["upd-go"].click(); await s.tick();
    s.els["upd-go"].click(); await s.tick();
    assert.equal(u.calls.at(-1), "abort", what);
    assert.match(s.text("upd-error"), what === "download" ? /HTTP 404/ : /not installed: signatures do not match/);
    assert.equal(s.text("upd-go"), "Install update");
  }
});

test("installs not allowed yet: the button opens Android's setting first, then installs", async () => {
  const u = fakeUpdater({ canInstall: false });
  const s = await onUpdateScreen({ updater: u });
  s.els["upd-go"].click(); await s.tick();
  assert.match(s.text("upd-text"), /First allow ArcFlare to install apps/);
  assert.equal(s.text("upd-go"), "Allow installs");
  s.els["upd-go"].click(); await s.tick();
  assert.equal(u.calls.at(-1), "openInstallSettings");
  assert.ok(!u.calls.includes("downloadOnline"));
  u.canInstall = true;
  s.els["upd-go"].click(); await s.tick();
  assert.deepEqual(u.calls.slice(-2), ["downloadOnline", "commit"]);
});

test("paired but the computer is off: Update the app is on the status screen, and Back returns there", async () => {
  const u = fakeUpdater();
  const s = makeShell({ store: pairedRecord(key(3)), behave: () => "TIMEOUT", updater: u });
  await s.start();
  await s.advance(60_000);
  assert.equal(s.visible(), "v-status");
  assert.equal(s.els["st-update"].hidden, false);
  s.els["st-update"].click(); await s.tick();
  assert.equal(s.visible(), "v-update");
  s.els["upd-back"].click(); await s.tick();
  assert.equal(s.visible(), "v-status");
});

test("a second tap while one step runs does nothing", async () => {
  let release;
  const u = fakeUpdater({ check: () => new Promise((r) => { release = () => r({ versionCode: 200, versionName: "1.0.200", size: 5000 }); }) });
  const s = await onUpdateScreen({ updater: u });
  s.els["upd-go"].click(); await s.tick();
  s.els["upd-go"].forceClick(); s.els["upd-back"].forceClick(); await s.tick();
  assert.equal(u.calls.filter((c) => c === "checkOnline").length, 1);
  assert.equal(s.visible(), "v-update", "Back waits for the step to finish");
  release(); await s.tick();
  assert.equal(s.text("upd-go"), "Install update");
});
