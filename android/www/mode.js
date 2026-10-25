// Launch-mode decision and LAN probe. PURE (the HTTP call is injected).
//
//   unpaired     no valid pairing record: show the pairing screen
//   home         the LAN URL answered like a hub: load it in the WebView
//   relay        LAN unreachable, relay pairing exists: bundled UI over the tunnel
//   unreachable  paired but neither works: calm error screen
//
// The relay is never chosen when the LAN answered (TUNNEL.md section 1).
// window.ArcFlareMode / CommonJS.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareMode = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function link() { return root.ArcFlareLink || require("./link.js"); }

  /** Does a stored record have everything the relay path needs? (Shape only; no secrets are read.) */
  function isPairedRecord(rec) {
    var L = link();
    if (!rec || typeof rec !== "object" || typeof rec.relay !== "string") return false;
    var relayOk = rec.relay.indexOf("https://") === 0 || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(rec.relay);
    return relayOk && L.isB64u32(rec.room) && L.isB64u32(rec.hubKey) &&
      typeof rec.deviceId === "string" && rec.deviceId.length > 0 &&
      typeof rec.roomToken === "string" && /^aftc_[A-Za-z0-9_-]{43}$/.test(rec.roomToken) &&
      !!rec.privateKey && typeof rec.publicKey === "string" &&
      (rec.lan == null || L.validateLanUrl(rec.lan));
  }

  /** Only a JSON object with a boolean `setup` counts as "this is the hub" (GET /api/status). */
  function looksLikeHub(res) {
    if (!res || res.status !== 200) return false;
    var d = res.data;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { return false; } }
    return !!d && typeof d === "object" && !Array.isArray(d) && typeof d.setup === "boolean";
  }

  /**
   * Probe the LAN URL. `get({url, timeoutMs})` is the native HTTP call (CapacitorHttp).
   * Never throws; resolves { ok:boolean }. Enforces its own deadline on top of the native one.
   */
  async function probeLan(get, lan, timeoutMs) {
    if (!link().validateLanUrl(lan)) return { ok: false, reason: "no-lan" };
    var ms = timeoutMs || 2000, timer;
    try {
      var res = await Promise.race([
        get({ url: lan + "/api/status", timeoutMs: ms }),
        new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error("timeout")); }, ms); }),
      ]);
      return looksLikeHub(res) ? { ok: true } : { ok: false, reason: "not-hub" };
    } catch (e) {
      return { ok: false, reason: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** decideMode({ record, probe }) -> "home" | "relay" | "unreachable" | "unpaired" */
  function decideMode(input) {
    var rec = input && input.record, probe = input && input.probe;
    if (!isPairedRecord(rec)) return "unpaired";
    if (rec.lan && probe && probe.ok === true) return "home";
    if (rec.relay && input.relayUsable !== false) return "relay";
    return "unreachable";
  }

  return { decideMode: decideMode, probeLan: probeLan, looksLikeHub: looksLikeHub, isPairedRecord: isPairedRecord };
});
