// Hub-key fingerprint, identical to `keyFingerprint` in lib/hub/cli.js:
// SHA-256 of the 32 raw key bytes, first 10 bytes as hex, groups of 4 with spaces.
// Needs WebCrypto (the app's https://localhost origin has it). window.ArcFlareFingerprint.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareFingerprint = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function link() { return root.ArcFlareLink || require("./link.js"); }

  /** hubKeyB64u -> "ab12 cd34 ef56 7890 1234" (20 hex digits). Rejects a key that is not 32 canonical bytes. */
  async function fingerprint(hubKeyB64u) {
    var raw = link().decodeB64u32(hubKeyB64u);
    if (!raw) throw new Error("not a hub key");
    var digest = new Uint8Array(await root.crypto.subtle.digest("SHA-256", raw));
    var hex = "";
    for (var i = 0; i < 10; i++) hex += (digest[i] < 16 ? "0" : "") + digest[i].toString(16);
    return hex.match(/.{4}/g).join(" ");
  }

  return { fingerprint: fingerprint };
});
