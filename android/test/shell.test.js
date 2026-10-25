"use strict";
// Behaviour tests of the real shell.js (see shell-harness.js). The first four are the regression tests for the
// independent review's finding M1 (script shell-race.js: replace-by-one-tap, swapped confirm screen, dedupe).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makeShell, link, key, pairedRecord, LAN, RELAY } = require("./shell-harness.js");

const fpOf = (k) => crypto.createHash("sha256").update(Buffer.alloc(32, k)).digest("hex").slice(0, 20).match(/.{4}/g).join(" ");
const REAL = 3, EVIL = 5;

// ---------------------------------------------------------------- M1 race 1: replacing an existing pairing

test("M1/1: with a pairing, a link shows 'Replace the computer <old> with <new>?'; the old pairing survives pairing, a pending approval and Cancel", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), behave: (base) => (base === LAN ? "PENDING" : "PENDING") });
  await s.start();
  assert.equal(s.visible(), "v-status", "paired + nothing answering approved: status screen");
  await s.deepLink(link({ hk: key(EVIL), relay: "https://evil-relay.example", lan: "http://192.168.1.77:8765" }));
  assert.equal(s.visible(), "v-confirm");
  const lead = s.text("cf-lead");
  assert.ok(lead.startsWith(`Replace the computer ${fpOf(REAL)} with ${fpOf(EVIL)}?`), lead);
  assert.equal(s.text("cf-title"), "Replace this computer?");
  assert.equal(s.els["cf-old-row"].hidden, false);
  assert.equal(s.text("cf-old-fp"), fpOf(REAL));
  assert.equal(s.text("cf-fp"), fpOf(EVIL));
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick();
  assert.equal(s.pairs.length, 1);
  s.pairs[0].resolve(); await s.tick();
  assert.equal(s.visible(), "v-code");
  assert.equal(s.text("code-digits"), "123456");
  assert.equal(s.storeCalls.save, 0, "the new pairing is NOT stored when the code appears");
  assert.equal(s.state.stored.hubKey, key(REAL), "the old pairing is untouched");
  // 'I confirmed it' before the computer approved (PENDING): still untouched
  s.els["code-done"].click(); await s.tick();
  assert.match(s.text("code-error"), /has not confirmed this phone yet/);
  assert.equal(s.storeCalls.save, 0);
  assert.equal(s.state.stored.hubKey, key(REAL));
  // Cancel: nothing wiped, back to the old computer's settings
  s.els["code-cancel"].click(); await s.tick();
  assert.equal(s.state.stored.hubKey, key(REAL));
  assert.equal(s.storeCalls.wipe, 0, "Cancel never wipes");
  assert.equal(s.visible(), "v-status");
  assert.equal(s.text("st-title"), "This computer");
});

test("M1/1: the old pairing is replaced only after the computer approved the new one", async () => {
  let approved = false;
  const s = makeShell({ store: pairedRecord(key(REAL)), behave: (base, e) => (e.hubKey === key(EVIL) ? (approved ? "ok" : "PENDING") : "OFFLINE") });
  await s.start();
  await s.deepLink(link({ hk: key(EVIL) }));
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick(); s.pairs[0].resolve(); await s.tick();
  assert.equal(s.state.stored.hubKey, key(REAL));
  approved = true;
  s.els["code-done"].click(); await s.tick(10);
  assert.equal(s.storeCalls.save, 1);
  assert.equal(s.state.stored.hubKey, key(EVIL), "replaced now");
  assert.equal(s.state.stored.relay, RELAY);
  assert.equal(s.state.stored.lan, LAN);
  assert.deepEqual(s.assigned, ["ui/index.html?via=home"], "then it boots into the new pairing");
});

test("M1/1: a failed pairing (timeout) or a failed save never wipes the old pairing", async () => {
  let s = makeShell({ store: pairedRecord(key(REAL)) });
  await s.start();
  await s.deepLink(link({ hk: key(EVIL) }));
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick();
  s.pairs[0].reject("TIMEOUT"); await s.tick();
  // LAN attempt failed with TIMEOUT: the relay is tried next
  assert.equal(s.pairs.length, 2);
  s.pairs[1].reject("HANDSHAKE"); await s.tick();
  assert.equal(s.text("code-title"), "Pairing failed");
  assert.match(s.text("code-error"), /did not match this computer's key/);
  s.els["code-cancel"].click(); await s.tick();
  assert.equal(s.state.stored.hubKey, key(REAL));
  assert.equal(s.storeCalls.wipe, 0);
  // save failing after approval: old one stays
  s = makeShell({ store: pairedRecord(key(REAL)), saveFails: true });
  await s.start();
  await s.deepLink(link({ hk: key(EVIL) }));
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick(); s.pairs[0].resolve(); await s.tick();
  s.els["code-done"].click(); await s.tick(10);
  assert.match(s.text("code-error"), /could not save/);
  assert.equal(s.state.stored.hubKey, key(REAL));
});

test("a first pairing (nothing stored) keeps the plain wording and stores only after approval", async () => {
  const s = makeShell({});
  await s.start();
  assert.equal(s.visible(), "v-pair");
  await s.deepLink(link({ hk: key(EVIL) }));
  assert.equal(s.text("cf-title"), "Pair with this computer?");
  assert.ok(s.text("cf-lead").startsWith(`Pair with the computer showing fingerprint ${fpOf(EVIL).split(" ")[0]}…?`));
  assert.equal(s.els["cf-old-row"].hidden, true);
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick(); s.pairs[0].resolve(); await s.tick();
  assert.equal(s.state.stored, null, "not stored before the computer approves");
  s.els["code-cancel"].click(); await s.tick();
  assert.equal(s.visible(), "v-pair");
  assert.equal(s.state.stored, null);
});

// ---------------------------------------------------------------- M1 race 2: links arriving while a screen is up

test("M1/2: while the confirm screen shows link A, link B is ignored (with a notice) and Pair pairs A, not B", async () => {
  const s = makeShell({});
  await s.start();
  const A = link({ hk: key(11) }), B = link({ hk: key(13) });
  await s.deepLink(A);
  assert.equal(s.text("cf-fp"), fpOf(11));
  await s.deepLink(B);
  assert.equal(s.text("cf-fp"), fpOf(11), "the screen content did not change");
  assert.equal(s.els["cf-notice"].hidden, false);
  assert.match(s.text("cf-notice"), /ignored/);
  assert.ok(!s.text("cf-notice").includes(key(13)), "the notice never echoes the link");
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick();
  assert.equal(s.pairs.length, 1);
  assert.ok(s.pairs[0].link.includes("hk=" + key(11)) && !s.pairs[0].link.includes(key(13)), "pairs A");
});

test("M1/2: links arriving while the code screen or the 'pairing...' wait is up are ignored too", async () => {
  const s = makeShell({});
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick();
  assert.equal(s.visible(), "v-code");
  await s.deepLink(link({ hk: key(13) }));
  assert.equal(s.visible(), "v-code");
  assert.match(s.text("code-notice"), /ignored/);
  s.pairs[0].resolve(); await s.tick();
  assert.equal(s.text("code-digits"), "123456");
  await s.deepLink(link({ hk: key(15) }));
  assert.equal(s.visible(), "v-code");
  assert.equal(s.pairs.length, 1);
});

test("M1/2: the same link delivered twice (cold start: launch URL + appUrlOpen) is one flow, no notice", async () => {
  const L = link({ hk: key(11) });
  const s = makeShell({ launchUrl: L });
  await s.start();
  assert.equal(s.visible(), "v-confirm");
  await s.deepLink(L);
  assert.equal(s.visible(), "v-confirm");
  assert.equal(s.els["cf-notice"].hidden, true, "no notice for the same link");
});

test("M1/2: the pending pairing is bound to its link: a swapped confirm screen is caught on the Pair click", async () => {
  const s = makeShell({});
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  await s.advance(1500);
  s.els["cf-fp"].textContent = fpOf(13);          // something rewrote the fingerprint the person is looking at
  s.els["cf-pair"].click(); await s.tick();
  assert.equal(s.pairs.length, 0, "pair() was not called");
  assert.equal(s.visible(), "v-pair");
  assert.match(s.text("pair-error"), /changed/);
});

// ---------------------------------------------------------------- M1 race 3: dedupe after Cancel

test("M1/3: the same link works again after Cancel (the old lastLink dedupe swallowed it)", async () => {
  const s = makeShell({});
  await s.start();
  const C = link({ hk: key(15) });
  await s.deepLink(C);
  assert.equal(s.visible(), "v-confirm");
  s.els["cf-cancel"].click(); await s.tick();
  assert.equal(s.visible(), "v-pair");
  await s.deepLink(C);
  assert.equal(s.visible(), "v-confirm", "the same link is accepted again");
  assert.equal(s.text("cf-fp"), fpOf(15));
  // and after a failed pairing and Back
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick(); s.pairs[0].reject("REFUSED"); await s.tick();
  s.els["code-cancel"].click(); await s.tick();
  assert.equal(s.visible(), "v-pair");
  await s.deepLink(C);
  assert.equal(s.visible(), "v-confirm");
});

// ---------------------------------------------------------------- Pair button lock

test("the Pair button is disabled for 1.5 s after the confirm screen renders, and a forced click does nothing", async () => {
  const s = makeShell({});
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  assert.equal(s.els["cf-pair"].disabled, true);
  s.els["cf-pair"].click(); s.els["cf-pair"].forceClick(); await s.tick();
  assert.equal(s.pairs.length, 0);
  await s.advance(1400);
  assert.equal(s.els["cf-pair"].disabled, true, "still locked at 1.4 s");
  s.els["cf-pair"].forceClick(); await s.tick();
  assert.equal(s.pairs.length, 0);
  await s.advance(100);
  assert.equal(s.els["cf-pair"].disabled, false, "unlocked at 1.5 s");
  s.els["cf-pair"].click(); await s.tick();
  assert.equal(s.pairs.length, 1);
});

test("a second flow re-locks the Pair button (the lock follows every render of the confirm content)", async () => {
  const s = makeShell({});
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  await s.advance(1500);
  assert.equal(s.els["cf-pair"].disabled, false);
  s.els["cf-cancel"].click(); await s.tick();
  await s.deepLink(link({ hk: key(13) }));
  assert.equal(s.els["cf-pair"].disabled, true);
});

// ---------------------------------------------------------------- stale links

test("a link held while the app is in the background: fresh foreground opens it; later foreground drops it; >5 min drops it", async () => {
  // opened by the link itself: foreground right after
  let s = makeShell({ hidden: true });
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  assert.notEqual(s.visible(), "v-confirm", "held, not shown while hidden");
  await s.advance(1000);
  await s.toForeground();
  assert.equal(s.visible(), "v-confirm");
  // the person comes back 10 s later for another reason: the old link must not pop up
  s = makeShell({ hidden: true });
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  await s.advance(10000);
  await s.toForeground();
  assert.notEqual(s.visible(), "v-confirm");
  // an hour later
  s = makeShell({ hidden: true });
  await s.start();
  await s.deepLink(link({ hk: key(11) }));
  await s.advance(3600_000);
  await s.toForeground();
  assert.notEqual(s.visible(), "v-confirm");
});

// ---------------------------------------------------------------- launch: two targets

test("launch: home handshake succeeds -> bundled UI with via=home; the relay is never contacted", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)) });
  await s.start();
  assert.deepEqual(s.connects.map((c) => c.base), [LAN]);
  assert.equal(s.connects[0].hasLanFetch, true, "the home attempt uses the native LAN fetch");
  assert.equal(s.connects[0].opts.handshakeTimeoutMs, 3000);
  assert.equal(s.connects[0].hubKey, key(REAL));
  assert.deepEqual(s.assigned, ["ui/index.html?via=home"]);
});

test("launch: home fails -> relay handshake -> bundled UI with via=relay", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), behave: (base) => (base === LAN ? "TIMEOUT" : "ok") });
  await s.start();
  assert.deepEqual(s.connects.map((c) => c.base), [LAN, RELAY]);
  assert.equal(s.connects[1].hasLanFetch, false);
  assert.deepEqual(s.assigned, ["ui/index.html?via=relay"]);
});

test("launch: neither works -> the 'Can't reach your computer' screen with Retry / Re-pair / Forget; nothing navigates", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), behave: () => "TIMEOUT" });
  await s.start();
  assert.equal(s.visible(), "v-status");
  assert.equal(s.text("st-title"), "Can't reach your computer");
  assert.deepEqual(s.assigned, []);
  for (const id of ["st-retry", "st-repair", "st-forget"]) assert.equal(s.els[id].hidden, false);
  const before = s.connects.length;
  s.els["st-retry"].click(); await s.tick(10);
  assert.ok(s.connects.length > before, "Retry runs the whole decision again");
});

test("launch: internet relay off (relay == LAN): one attempt, then the unreachable screen", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL), { relay: LAN }), behave: () => "TIMEOUT" });
  await s.start();
  assert.deepEqual(s.connects.map((c) => c.base), [LAN]);
  assert.equal(s.visible(), "v-status");
  assert.match(s.text("st-msg"), /did not answer on your home network/);
  assert.match(s.text("st-relay"), /Not set up/);
});

test("launch: no LAN base stored -> relay only, no LAN fetch is built", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL), { lan: null }) });
  await s.start();
  assert.deepEqual(s.connects.map((c) => c.base), [RELAY]);
  assert.deepEqual(s.assigned, ["ui/index.html?via=relay"]);
});

test("launch: home says PENDING (hub proven, phone not approved yet) -> the relay is not asked; message explains", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), behave: () => "PENDING" });
  await s.start();
  assert.deepEqual(s.connects.map((c) => c.base), [LAN]);
  assert.match(s.text("st-msg"), /not confirmed it yet/);
});

test("launch: relay REFUSED explains that the phone was removed; HANDSHAKE explains the key mismatch", async () => {
  let s = makeShell({ store: pairedRecord(key(REAL)), behave: (b) => (b === LAN ? "TIMEOUT" : "REFUSED") });
  await s.start();
  assert.match(s.text("st-msg"), /no longer accepts this phone/);
  s = makeShell({ store: pairedRecord(key(REAL)), behave: (b) => (b === LAN ? "TIMEOUT" : "HANDSHAKE") });
  await s.start();
  assert.match(s.text("st-msg"), /did not match your computer's key/);
});

test("nothing in the shell ever sends the WebView anywhere but the bundled UI, whatever the record holds", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL), { lan: "http://192.168.1.20:8765" }) });
  await s.start();
  for (const u of s.assigned) assert.match(u, /^ui\/index\.html(\?via=(home|relay))?$/);
  assert.equal(s.assigned.filter((u) => /^https?:/.test(u)).length, 0);
});

test("a link arriving while the launch check is still running stops the boot from navigating away", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), holdConnect: true });
  const started = s.start();
  await s.tick(10);
  assert.equal(s.connects.length, 1);
  await s.deepLink(link({ hk: key(EVIL) }));
  assert.equal(s.visible(), "v-confirm");
  s.connects[0].release(); await s.tick(10);
  assert.deepEqual(s.assigned, [], "boot did not navigate over the confirm screen");
  assert.equal(s.visible(), "v-confirm");
  await started;
});

test("Back from the bundled UI shows settings (Open), it does not bounce forward", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), navType: "back_forward" });
  await s.start();
  assert.equal(s.text("st-title"), "This computer");
  assert.equal(s.text("st-retry"), "Open");
  assert.equal(s.connects.length, 0);
});

// ---------------------------------------------------------------- M2: WebView gate

test("M2: a WebView without X25519 gets a clear screen; no connect, no navigation, no pairing, links ignored", async () => {
  const s = makeShell({ store: pairedRecord(key(REAL)), x25519: false });
  await s.start();
  assert.equal(s.visible(), "v-status");
  assert.equal(s.text("st-title"), "Update Android System WebView");
  assert.match(s.text("st-msg"), /version 133 or newer/);
  assert.equal(s.els["st-forget"].hidden, true);
  assert.equal(s.els["st-repair"].hidden, true);
  await s.deepLink(link({ hk: key(EVIL) }));
  assert.equal(s.visible(), "v-status");
  assert.equal(s.connects.length, 0);
  assert.equal(s.pairs.length, 0);
  assert.deepEqual(s.assigned, []);
  // also for a launch link on first run
  const t = makeShell({ x25519: false, launchUrl: link({ hk: key(EVIL) }) });
  await t.start();
  assert.equal(t.visible(), "v-status");
  assert.equal(t.pairs.length, 0);
});

// ---------------------------------------------------------------- Forget (L5)

test("Forget: success -> pairing screen; failure -> says what failed, stays on the Forget screen, never claims success", async () => {
  let s = makeShell({ store: pairedRecord(key(REAL)), behave: () => "TIMEOUT" });
  await s.start();
  s.els["st-forget"].click(); await s.tick();
  assert.equal(s.visible(), "v-forget");
  s.els["fg-go"].click(); await s.tick(10);
  assert.equal(s.visible(), "v-pair");
  assert.equal(s.state.stored, null);

  s = makeShell({ store: pairedRecord(key(REAL)), behave: () => "TIMEOUT", wipe: () => ({ ok: false, failed: ["cookies", "database other-db"] }) });
  await s.start();
  s.els["st-forget"].click(); await s.tick();
  s.els["fg-go"].click(); await s.tick(10);
  assert.equal(s.visible(), "v-forget", "not the pairing screen");
  assert.equal(s.els["fg-error"].hidden, false);
  assert.match(s.text("fg-error"), /cookies, database other-db/);
  assert.match(s.text("fg-error"), /NOT fully forgotten/);
  // an unexpected exception is a failure too
  s = makeShell({ store: pairedRecord(key(REAL)), behave: () => "TIMEOUT", wipe: () => { throw new Error("boom"); } });
  await s.start();
  s.els["st-forget"].click(); await s.tick(); s.els["fg-go"].click(); await s.tick(10);
  assert.equal(s.visible(), "v-forget");
  assert.equal(s.els["fg-error"].hidden, false);
});

// ---------------------------------------------------------------- bad links

test("a bad link shows an error and starts no flow; a later good link works", async () => {
  const s = makeShell({});
  await s.start();
  for (const bad of ["arcflare://pair?v=2", link({ hk: key(11), lan: "http://8.8.8.8:8765" }), link({ hk: key(11), lan: "http://192.168.1.20:80" })]) {
    await s.deepLink(bad);
    assert.equal(s.visible(), "v-pair");
    assert.ok(s.text("pair-error").length > 10);
  }
  await s.deepLink(link({ hk: key(11) }));
  assert.equal(s.visible(), "v-confirm");
  assert.equal(s.pairs.length, 0);
});

test("LAN-only link (r = l): the confirm screen says the relay is not used; pair() gets r = the LAN base", async () => {
  const s = makeShell({});
  await s.start();
  await s.deepLink(link({ hk: key(11), relay: LAN, lan: LAN }));
  assert.match(s.text("cf-relay"), /internet relay is off/);
  assert.equal(s.text("cf-lan"), LAN);
  await s.advance(1500);
  s.els["cf-pair"].click(); await s.tick();
  assert.equal(s.pairs.length, 1);
  assert.ok(s.pairs[0].link.includes("r=" + encodeURIComponent(LAN)));
  assert.equal(typeof s.pairs[0].opts.fetch, "function", "paired over the native LAN fetch");
});
