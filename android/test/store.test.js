"use strict";
// Forget (store.wipeAll) must await every step, name what failed, and never report success after an error.
const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../www/store.js");

/** A fake global with IndexedDB, Web Storage, Cache Storage. behave: per-database "ok" | "error" | "blocked" | "throw". */
function fakeRoot(o = {}) {
  const dbs = new Set(o.dbs || ["arcflare-pairing", "other-db"]);
  const caches = new Set(o.caches || ["c1", "c2"]);
  const log = [];
  const root = {
    log, dbs, cacheNames: caches,
    indexedDB: {
      databases: o.noDatabases ? undefined : async () => { if (o.databasesThrows) throw new Error("nope"); return [...dbs].map((name) => ({ name, version: 1 })); },
      deleteDatabase(name) {
        const req = {};
        const b = (o.behave && o.behave[name]) || "ok";
        log.push("delete " + name + " " + b);
        if (b === "throw") throw new Error("denied");
        setTimeout(() => {
          if (b === "ok") { dbs.delete(name); req.onsuccess && req.onsuccess(); }
          else if (b === "silent") { req.onsuccess && req.onsuccess(); }      // claims success, leaves the db (re-check must catch it)
          else if (b === "error") req.onerror && req.onerror();
          else if (b === "blocked") req.onblocked && req.onblocked();
        }, 1);
        return req;
      },
    },
    localStorage: { clear() { log.push("ls.clear"); if (o.lsThrows) throw new Error("denied"); } },
    sessionStorage: { clear() { log.push("ss.clear"); if (o.ssThrows) throw new Error("denied"); } },
    caches: o.noCaches ? undefined : {
      keys: async () => [...caches],
      delete: async (k) => { log.push("caches.delete " + k); if (o.cachesDeleteRejects) throw new Error("denied"); if (!o.cachesKeep) caches.delete(k); return true; },
    },
  };
  return root;
}
const native = (o = {}) => ({ clearCookies: async () => { if (o.cookiesFail) throw new Error("no"); o.cleared = (o.cleared || 0) + 1; } });

test("everything worked: ok, nothing failed, every database / cache deleted, cookies cleared", async () => {
  const root = fakeRoot(); const n = native();
  const S = Store.create(root, { deleteWaitMs: 20 });
  assert.deepEqual(await S.wipeAll({ clearCookies: async () => { n.done = true; } }), { ok: true, failed: [] });
  assert.equal(root.dbs.size, 0);
  assert.equal(root.cacheNames.size, 0);
  assert.ok(root.log.includes("ls.clear") && root.log.includes("ss.clear"));
  assert.ok(n.done);
});

test("the pairing database is deleted even when databases() is missing (old WebView)", async () => {
  const root = fakeRoot({ noDatabases: true });
  const r = await Store.create(root, { deleteWaitMs: 20 }).wipeAll(native());
  assert.deepEqual(r, { ok: true, failed: [] });
  assert.ok(!root.dbs.has("arcflare-pairing"));
});

test("a failed database delete is named and ok is false (never 'success')", async () => {
  const root = fakeRoot({ behave: { "other-db": "error" } });
  const r = await Store.create(root, { deleteWaitMs: 20 }).wipeAll(native());
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => /other-db/.test(f)), JSON.stringify(r));
  assert.ok(!root.dbs.has("arcflare-pairing"), "the other steps still ran");
});

test("a blocked delete that never completes is a failure after the wait; a throwing delete too", async () => {
  let r = await Store.create(fakeRoot({ behave: { "arcflare-pairing": "blocked" } }), { deleteWaitMs: 30 }).wipeAll(native());
  assert.equal(r.ok, false); assert.ok(r.failed.some((f) => /arcflare-pairing/.test(f)));
  r = await Store.create(fakeRoot({ behave: { "arcflare-pairing": "throw" } }), { deleteWaitMs: 30 }).wipeAll(native());
  assert.equal(r.ok, false);
});

test("a database that claims to be deleted but is still listed is caught by the re-check", async () => {
  const r = await Store.create(fakeRoot({ behave: { "arcflare-pairing": "silent" } }), { deleteWaitMs: 20 }).wipeAll(native());
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => /still there/.test(f)), JSON.stringify(r));
});

test("Web Storage failures are reported", async () => {
  let r = await Store.create(fakeRoot({ lsThrows: true }), { deleteWaitMs: 20 }).wipeAll(native());
  assert.deepEqual(r, { ok: false, failed: ["local storage"] });
  r = await Store.create(fakeRoot({ ssThrows: true }), { deleteWaitMs: 20 }).wipeAll(native());
  assert.deepEqual(r, { ok: false, failed: ["session storage"] });
});

test("Cache Storage: a rejected delete and a cache that stays are both failures (the old code never awaited it)", async () => {
  let r = await Store.create(fakeRoot({ cachesDeleteRejects: true }), { deleteWaitMs: 20 }).wipeAll(native());
  assert.deepEqual(r, { ok: false, failed: ["cache storage"] });
  r = await Store.create(fakeRoot({ cachesKeep: true }), { deleteWaitMs: 20 }).wipeAll(native());
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => /cache storage/.test(f)));
});

test("cookies: a failing cookie manager, or none at all, is reported", async () => {
  let r = await Store.create(fakeRoot(), { deleteWaitMs: 20 }).wipeAll(native({ cookiesFail: true }));
  assert.deepEqual(r, { ok: false, failed: ["cookies"] });
  r = await Store.create(fakeRoot(), { deleteWaitMs: 20 }).wipeAll(null);
  assert.deepEqual(r, { ok: false, failed: ["cookies"] });
  r = await Store.create(fakeRoot(), { deleteWaitMs: 20 }).wipeAll({});
  assert.deepEqual(r, { ok: false, failed: ["cookies"] });
});

test("several things fail: all are listed, in one result, and it still does not throw", async () => {
  const root = fakeRoot({ lsThrows: true, cachesDeleteRejects: true, behave: { "other-db": "error" } });
  const r = await Store.create(root, { deleteWaitMs: 20 }).wipeAll(native({ cookiesFail: true }));
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 4, JSON.stringify(r));
});

test("save keeps only the listed fields and the validated bases; a secret passed along is dropped", async () => {
  const stored = {};
  const root = fakeRoot();
  root.indexedDB.open = () => {
    const req = {};
    const db = { createObjectStore() {}, close() {}, transaction: () => { const t = {}; t.objectStore = () => ({ put: (v, k) => { stored[k] = v; const r = { result: undefined }; setTimeout(() => t.oncomplete && t.oncomplete(), 0); return r; } }); return t; } };
    setTimeout(() => { req.result = db; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess(); }, 0);
    return req;
  };
  await Store.create(root).save({ v: 1, relay: "http://tunnelclient-echo:1", room: "r", hubKey: "h", deviceId: "d", roomToken: "t", label: "l", privateKey: {}, publicKey: "p", secret: "LEAK", ps: "LEAK" },
    { relay: "https://arcflare.net", lan: "http://192.168.1.20:8765" });
  assert.deepEqual(Object.keys(stored.pairing).sort(), ["deviceId", "hubKey", "label", "lan", "lanToken", "pairedAt", "privateKey", "publicKey", "relay", "room", "roomToken", "v"]);
  assert.equal(stored.pairing.relay, "https://arcflare.net");
  assert.equal(stored.pairing.lan, "http://192.168.1.20:8765");
});

test("with no databases() to re-check against, a database that reports an error is still a failure", async () => {
  const r = await Store.create(fakeRoot({ noDatabases: true, behave: { "arcflare-pairing": "error" } }), { deleteWaitMs: 20 }).wipeAll(native());
  assert.deepEqual(r, { ok: false, failed: ["database arcflare-pairing"] });
});

test("N8: the one-time marker lives in IndexedDB (never localStorage): false until set, true after, only for its own name", async () => {
  const kv = {};
  let lsTouched = false;
  const root = fakeRoot();
  root.localStorage = new Proxy({}, { get() { lsTouched = true; throw new Error("localStorage must not be used"); }, set() { lsTouched = true; throw new Error("no"); } });
  root.indexedDB.open = () => {
    const req = {};
    const db = { createObjectStore() {}, close() {}, transaction: () => { const t = {}; t.objectStore = () => ({
      get: (k) => { const r = { result: kv[k] }; setTimeout(() => t.oncomplete && t.oncomplete(), 0); return r; },
      put: (v, k) => { kv[k] = v; const r = { result: undefined }; setTimeout(() => t.oncomplete && t.oncomplete(), 0); return r; },
    }); return t; } };
    setTimeout(() => { req.result = db; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess(); }, 0);
    return req;
  };
  const S = Store.create(root);
  assert.equal(await S.getFlag("cookies-wiped-v1"), false);
  await S.setFlag("cookies-wiped-v1");
  assert.equal(await S.getFlag("cookies-wiped-v1"), true);
  assert.equal(await S.getFlag("other"), false);
  assert.deepEqual(Object.keys(kv), ["flag:cookies-wiped-v1"]);
  assert.equal(lsTouched, false);
});
