// Pairing storage: IndexedDB in the app's private WebView storage, never localStorage.
// One record under one key. The device key inside it is a non-extractable CryptoKey
// (tunnel-client.js generates it that way), which IndexedDB stores as an opaque handle.
// Nothing here logs, and nothing is ever written to a URL.
// window.ArcFlareStore.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (globalRoot) {
  "use strict";

  var DB = "arcflare-pairing", STORE = "kv", KEY = "pairing";
  var DEFAULT_DELETE_WAIT_MS = 3000;

  /** The store for a given global object (tests pass a fake one). */
  function create(root, o) {
  var DELETE_WAIT_MS = (o && o.deleteWaitMs) || DEFAULT_DELETE_WAIT_MS;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("storage blocked")); };
    });
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), out;
        try { out = fn(t.objectStore(STORE)); } catch (e) { db.close(); reject(e); return; }
        t.oncomplete = function () { db.close(); resolve(out && "result" in out ? out.result : undefined); };
        t.onerror = t.onabort = function () { db.close(); reject(t.error || new Error("storage failed")); };
      });
    });
  }

  /** The stored pairing record, or null. */
  function load() { return tx("readonly", function (s) { return s.get(KEY); }).then(function (r) { return r || null; }); }

  /**
   * Keep only the fields the tunnel needs (and nothing else that might come along).
   * `bases` = { relay, lan } as the link validator accepted them (r and l of the pairing link); they, not
   * whatever the tunnel client echoed back, are what is stored. `relay` is https, or the same base as `lan`.
   */
  function save(device, bases) {
    var rec = {
      v: device.v, relay: bases.relay, room: device.room, hubKey: device.hubKey,
      lan: bases.lan || null, deviceId: device.deviceId, roomToken: device.roomToken,
      label: device.label, privateKey: device.privateKey, publicKey: device.publicKey,
      pairedAt: Date.now(),
    };
    return tx("readwrite", function (s) { return s.put(rec, KEY); });
  }

  /** Resolves true only when the database is really gone; false on error, or if still blocked after a while. */
  function deleteDb(name) {
    return new Promise(function (resolve) {
      var req, timer;
      function end(ok) { clearTimeout(timer); resolve(ok); }
      try { req = root.indexedDB.deleteDatabase(name); } catch (e) { resolve(false); return; }
      req.onsuccess = function () { end(true); };
      req.onerror = function () { end(false); };
      // "blocked" only means another connection is still open; the delete goes ahead when it closes. Wait, then give up.
      req.onblocked = function () { timer = setTimeout(function () { resolve(false); }, DELETE_WAIT_MS); };
    });
  }

  /**
   * Forget everything this origin holds and REPORT HONESTLY: every step is awaited, a failed step is named, and the
   * result is { ok:true } only when all of them succeeded and a re-check agrees. Steps: every IndexedDB database
   * (the pairing record and the key inside it), Web Storage, Cache Storage, and (through Capacitor's native cookie
   * manager, which also removes HttpOnly cookies of every site) all cookies.
   * `native` = { clearCookies() } supplied by the shell. Never throws.
   */
  async function wipeAll(native) {
    var failed = [], i;
    var names = [DB], listable = false;
    try {
      if (root.indexedDB && root.indexedDB.databases) {
        listable = true;
        (await root.indexedDB.databases()).forEach(function (d) { if (d && d.name && names.indexOf(d.name) === -1) names.push(d.name); });
      }
    } catch (e) { listable = false; /* keep the known name; verification below is skipped */ }
    var results = await Promise.all(names.map(deleteDb));
    for (i = 0; i < names.length; i++) if (!results[i]) failed.push("database " + names[i]);
    if (listable && !failed.length) {
      try {
        var left = (await root.indexedDB.databases()).filter(function (d) { return d && d.name; });
        if (left.length) failed.push("database " + left[0].name + " is still there");
      } catch (e) { failed.push("could not re-check the databases"); }
    }
    try { root.localStorage.clear(); } catch (e) { failed.push("local storage"); }
    try { root.sessionStorage.clear(); } catch (e) { failed.push("session storage"); }
    try {
      if (root.caches) {
        var keys = await root.caches.keys();
        await Promise.all(keys.map(function (k) { return root.caches.delete(k); }));
        if ((await root.caches.keys()).length) failed.push("cache storage is not empty");
      }
    } catch (e) { failed.push("cache storage"); }
    try {
      if (!native || typeof native.clearCookies !== "function") throw new Error("no cookie manager");
      await native.clearCookies();
    } catch (e) { failed.push("cookies"); }
    return failed.length ? { ok: false, failed: failed } : { ok: true, failed: [] };
  }

  return { load: load, save: save, wipeAll: wipeAll, DB_NAME: DB };
  }

  var api = create(globalRoot);
  api.create = create;
  return api;
});
