// Is a retained pairing link still fresh enough to show? PURE (the clock is injected).
//
// A link the shell has HELD (it arrived while the app was in the background, or it was kept for later) is dropped
// when it is older than 5 minutes, or when it predates the moment the app was last brought to the foreground by
// more than a short grace (a link that opens the app arrives within moments of the foreground event; a link that
// sat there while the person came back later for another reason must not pop up as a pairing request).
// What this cannot do: age a launch URL that Android re-delivers when it restores a task from recents; the
// shell has no timestamp for it (README "Residual risks"). The hub's own 10 minute expiry and the Replace screen
// are the protection there.
// window.ArcFlareLinkGate / CommonJS.

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareLinkGate = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_AGE_MS = 5 * 60 * 1000, GRACE_MS = 2000;

  /** create({ now: () => ms }) -> { foreground(), judge(at) } ; judge -> "ok" | "too-old" | "before-foreground" */
  function create(opts) {
    var now = (opts && opts.now) || function () { return Date.now(); };
    var maxAge = (opts && opts.maxAgeMs) || MAX_AGE_MS, grace = (opts && opts.graceMs) || GRACE_MS;
    var foregroundAt = now();
    return {
      foreground: function () { foregroundAt = now(); },
      judge: function (at) {
        if (typeof at !== "number" || !isFinite(at)) return "too-old";
        if (now() - at > maxAge) return "too-old";
        if (at < foregroundAt - grace) return "before-foreground";
        return "ok";
      },
    };
  }

  return { create: create, MAX_AGE_MS: MAX_AGE_MS, GRACE_MS: GRACE_MS };
});
