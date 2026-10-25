// Launch-mode decision. PURE: no network, no DOM, no storage (the shell and connector.js do the connecting).
//
// A paired phone has up to two tunnel targets for the SAME hub key, room and device (TUNNEL.md 5.1, 16):
//   home   the hub's own mailbox on the home network (stored `lan`, plain http to a private address; the
//          tunnel is end-to-end encrypted and the hub key is pinned, so a successful handshake proves identity)
//   relay  the internet relay (stored `relay`, https) , only when it differs from the LAN base. With the
//          internet relay off the link carries r = l, so there is no second target.
// Every launch: home first (3 s handshake cap), the relay only if home failed, else "unreachable".
//
//   unpaired     no valid pairing record: show the pairing screen
//   home         the LAN handshake succeeded: bundled UI over the tunnel, chip "Home network"
//   relay        the LAN target failed (or is absent) and the relay handshake succeeded: chip "Relay"
//   unreachable  paired but neither target worked: calm error screen (Retry / Re-pair / Forget)
//
// The relay is never consulted when home succeeded (TUNNEL.md section 1).
// window.ArcFlareMode / CommonJS.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareMode = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function link() { return root.ArcFlareLink || require("./link.js"); }

  /** Does a stored record have everything the tunnel needs? (Shape only; no secrets are read.) */
  function isPairedRecord(rec) {
    var L = link();
    if (!rec || typeof rec !== "object" || typeof rec.relay !== "string") return false;
    var lanOk = rec.lan == null || L.validateLanUrl(rec.lan);
    // relay: https (or loopback http in a dev build), or exactly the LAN base (internet relay off).
    var relayOk = rec.relay.indexOf("https://") === 0 || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(rec.relay) ||
      (rec.lan != null && rec.relay === rec.lan);
    return lanOk && relayOk && L.isB64u32(rec.room) && L.isB64u32(rec.hubKey) &&
      typeof rec.deviceId === "string" && rec.deviceId.length > 0 &&
      typeof rec.roomToken === "string" && /^aftc_[A-Za-z0-9_-]{43}$/.test(rec.roomToken) &&
      !!rec.privateKey && typeof rec.publicKey === "string";
  }

  /**
   * The ordered tunnel targets of a record: [{ kind:"home", base }, { kind:"relay", base }]. The relay target is
   * left out when it equals the LAN base. [] for an unusable record.
   */
  function targets(rec) {
    if (!isPairedRecord(rec)) return [];
    var out = [];
    if (rec.lan) out.push({ kind: "home", base: rec.lan });
    if (rec.relay !== rec.lan) out.push({ kind: "relay", base: rec.relay });
    return out;
  }

  /**
   * decideMode({ record, home, relay }) -> "home" | "relay" | "unreachable" | "unpaired"
   * `home` / `relay` are the handshake results { ok:boolean } (null/undefined = not tried). A result for a target
   * the record does not have means nothing. `relay` is ignored when home succeeded.
   */
  function decideMode(input) {
    var rec = input && input.record;
    if (!isPairedRecord(rec)) return "unpaired";
    var t = targets(rec);
    var hasHome = t.some(function (x) { return x.kind === "home"; });
    var hasRelay = t.some(function (x) { return x.kind === "relay"; });
    if (hasHome && input.home && input.home.ok === true) return "home";
    if (hasRelay && input.relay && input.relay.ok === true) return "relay";
    return "unreachable";
  }

  return { decideMode: decideMode, targets: targets, isPairedRecord: isPairedRecord };
});
