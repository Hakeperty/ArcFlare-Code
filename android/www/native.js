// Thin wrappers over Capacitor's bridge. Everything native the shell uses is here.
// Capacitor's core runtime (vendor/capacitor.js, copied at build time) provides registerPlugin();
// the native side (CapacitorHttp, CapacitorCookies, App, NavGuard) answers over Capacitor's own bridge.
// window.ArcFlareNative.
(function () {
  "use strict";

  function plugin(name) {
    var cap = window.Capacitor;
    if (!cap) throw new Error("not running inside the app");
    var p = (cap.Plugins && cap.Plugins[name]) || (typeof cap.registerPlugin === "function" && cap.registerPlugin(name));
    if (!p) throw new Error("plugin missing: " + name);
    return p;
  }

  window.ArcFlareNative = {
    /** GET with the native HTTP stack: no CORS, no mixed-content rules. Redirects are not followed. */
    httpGet: function (o) {
      return plugin("CapacitorHttp").get({
        url: o.url, connectTimeout: o.timeoutMs, readTimeout: o.timeoutMs, disableRedirects: true,
        responseType: "json", headers: { Accept: "application/json" },
      });
    },
    /** The arcflare:// URL the app was started with, or null. */
    getLaunchUrl: async function () {
      try { var r = await plugin("App").getLaunchUrl(); return r && r.url ? String(r.url) : null; } catch (e) { return null; }
    },
    /** Calls fn(url) whenever the app is opened by an arcflare:// link while running. */
    onAppUrl: function (fn) {
      try { var h = plugin("App").addListener("appUrlOpen", function (e) { if (e && e.url) fn(String(e.url)); }); if (h && h.catch) h.catch(function () {}); } catch (e) { /* not native */ }
    },
    /** Tell MainActivity which exact origin the WebView may navigate to (null = none). */
    setLan: function (url) { return plugin("NavGuard").setLan({ url: url || "" }); },
    clearCookies: function () { return plugin("CapacitorCookies").clearAllCookies(); },
    /** TUNNEL.md section 2: feature-detect X25519; never fall back. */
    supportsX25519: async function () {
      try { await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]); return true; } catch (e) { return false; }
    },
    navigate: function (url) { window.location.assign(url); },
  };
})();
