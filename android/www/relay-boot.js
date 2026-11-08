// Runs in the BUNDLED UI page (www/ui/index.html) before app.js. app.js reads
// window.ArcFlareTransport exactly once at startup, so it is set here, synchronously.
// The tunnel itself is opened later, on the first request, from the stored pairing record: home network first,
// the internet relay only if that fails (connector.js). `?via=relay` (set by the shell after it just checked)
// makes the FIRST connect skip the home attempt; any reconnect starts from the home network again.
(function () {
  "use strict";
  var m = /^\?via=(home|relay)$/.exec(window.location.search);
  var via = m ? m[1] : null, first = true;
  window.ArcFlareConnection = via || "home";                 // what the chip shows until a connect says otherwise

  var deps = {
    get Tunnel() { return window.ArcFlareTunnel; },
    lanFetch: function (lanBase, o) { return window.ArcFlareLanFetch.create({ http: window.ArcFlareNative.nativeHttp(), lanBase: lanBase, refuse: o && o.refuse }); },
  };
  // On the relay with a home address to go back to: check the home network now and then, and on network change or
  // when the app comes back to the front. When it answers, close the relay session; the next request reconnects,
  // home network first, so a phone at home never keeps using the internet relay.
  var watcher = null;
  function watchHome(r, rec) {
    if (watcher) { watcher.stop(); watcher = null; }
    var hasHome = window.ArcFlareMode.targets(rec).some(function (t) { return t.kind === "home"; });
    if (r.kind !== "relay" || !hasHome) return;
    var w = watcher = window.ArcFlareConnector.homeWatcher({
      check: function () { return window.ArcFlareConnector.check(deps, rec, "home"); },
      onHome: function () { if (watcher === w) watcher = null; try { r.tunnel.close(); } catch (e) { /* already closed */ } },
      hidden: function () { return document.hidden; },
    });
    w.start();
  }
  window.addEventListener("online", function () { if (watcher) watcher.kick(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && watcher) watcher.kick(); });

  var transport = window.ArcFlareTransportAdapter.create({
    connect: async function () {
      var rec = await window.ArcFlareStore.load();
      if (!rec) throw new Error("not paired");
      var skipHome = first && via === "relay";
      first = false;
      var r = await window.ArcFlareConnector.connectBest(deps, rec, { skipHome: skipHome });
      watchHome(r, rec);
      window.ArcFlareConnection = r.kind;
      if (typeof window.arcflareSetConnection === "function") window.arcflareSetConnection(r.kind);
      return r.tunnel;
    },
  });
  Object.defineProperty(window, "ArcFlareTransport", { value: Object.freeze({ fetch: transport.fetch, eventSource: transport.eventSource }), writable: false, configurable: false });
})();
