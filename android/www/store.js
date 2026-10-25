// Pairing storage: IndexedDB in the app's private WebView storage, never localStorage.
// One record under one key. The device key inside it is a non-extractable CryptoKey
// (tunnel-client.js generates it that way), which IndexedDB stores as an opaque handle.
// Nothing here logs, and nothing is ever written to a URL.
// window.ArcFlareStore.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var DB = "arcflare-pairing", STORE = "kv", KEY = "pairing";

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

  /** Keep only the fields the tunnel needs (and nothing else that might come along). */
  function save(device, lan) {
    var rec = {
      v: device.v, relay: device.relay, room: device.room, hubKey: device.hubKey,
      lan: lan || null, deviceId: device.deviceId, roomToken: device.roomToken,
      label: device.label, privateKey: device.privateKey, publicKey: device.publicKey,
      pairedAt: Date.now(),
    };
    return tx("readwrite", function (s) { return s.put(rec, KEY); });
  }

  function deleteDb(name) {
    return new Promise(function (resolve) {
      var req = root.indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
    });
  }

  /**
   * Forget everything: the pairing database and any other IndexedDB of this origin, the
   * key inside it, Web Storage, Cache Storage, and (through Capacitor's native cookie
   * manager, which also removes HttpOnly cookies of every site) all cookies.
   * `native` = { clearCookies(), setLan(url) } supplied by the shell.
   */
  async function wipeAll(native) {
    var names = [DB];
    try {
      if (root.indexedDB.databases) (await root.indexedDB.databases()).forEach(function (d) { if (d && d.name && names.indexOf(d.name) === -1) names.push(d.name); });
    } catch (e) { /* keep the known name */ }
    await Promise.all(names.map(deleteDb));
    try { root.localStorage.clear(); } catch (e) { /* none */ }
    try { root.sessionStorage.clear(); } catch (e) { /* none */ }
    try { if (root.caches) (await root.caches.keys()).forEach(function (k) { root.caches.delete(k); }); } catch (e) { /* none */ }
    if (native) {
      try { await native.setLan(null); } catch (e) { /* guard already empty on a fresh start */ }
      try { await native.clearCookies(); } catch (e) { /* not native */ }
    }
  }

  return { load: load, save: save, wipeAll: wipeAll, DB_NAME: DB };
});
