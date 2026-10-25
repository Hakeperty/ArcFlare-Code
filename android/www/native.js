// Thin wrappers over Capacitor's bridge. Everything native the shell uses is here.
// Capacitor's core runtime (vendor/capacitor.js, copied at build time) provides registerPlugin();
// the native side (CapacitorHttp, CapacitorCookies, App) answers over Capacitor's own bridge.
// window.ArcFlareNative.
//
// CapacitorHttp is exposed ONLY as the object lanfetch.js wraps (which refuses everything but the stored LAN
// mailbox); no other file calls it. There is no navigation plugin any more: the native navigation guard
// (MainActivity / NavPolicy.java) has no settable exception, and the WebView only ever shows https://localhost.
(function () {
  "use strict";

  function plugin(name) {
    var cap = window.Capacitor;
    if (!cap) throw new Error("not running inside the app");
    var p = (cap.Plugins && cap.Plugins[name]) || (typeof cap.registerPlugin === "function" && cap.registerPlugin(name));
    if (!p) throw new Error("plugin missing: " + name);
    return p;
  }

  // The only page the shell may send the WebView to: the bundled UI, optionally with the connection hint.
  var NAV_OK = /^ui\/index\.html(\?via=(home|relay))?$/;

  window.ArcFlareNative = {
    /** Capacitor's native HTTP, handed to ArcFlareLanFetch.create({ http }) and to nothing else. */
    nativeHttp: function () {
      var p = plugin("CapacitorHttp");
      return { get: function (o) { return p.get(o); }, post: function (o) { return p.post(o); } };
    },
    /** The arcflare:// URL the app was started with, or null. */
    getLaunchUrl: async function () {
      try { var r = await plugin("App").getLaunchUrl(); return r && r.url ? String(r.url) : null; } catch (e) { return null; }
    },
    /** Calls fn(url) whenever the app is opened by an arcflare:// link while running. */
    onAppUrl: function (fn) {
      try { var h = plugin("App").addListener("appUrlOpen", function (e) { if (e && e.url) fn(String(e.url)); }); if (h && h.catch) h.catch(function () {}); } catch (e) { /* not native */ }
    },
    /** Calls fn() whenever the app comes to the foreground. */
    onForeground: function (fn) {
      try { var h = plugin("App").addListener("appStateChange", function (e) { if (e && e.isActive) fn(); }); if (h && h.catch) h.catch(function () {}); } catch (e) { /* not native */ }
    },
    clearCookies: function () { return plugin("CapacitorCookies").clearAllCookies(); },
    /** TUNNEL.md section 2: feature-detect X25519; never fall back. */
    supportsX25519: async function () {
      try { await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]); return true; } catch (e) { return false; }
    },
    /** Only the bundled UI (the native guard refuses anything else anyway). */
    navigate: function (path) {
      if (!NAV_OK.test(path)) throw new Error("refused navigation target");
      window.location.assign(path);
    },
  };
})();
