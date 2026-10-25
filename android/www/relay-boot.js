// Runs in the BUNDLED UI page (www/ui/index.html) before app.js. app.js reads
// window.ArcFlareTransport exactly once at startup, so it is set here, synchronously.
// The tunnel itself is opened later, on the first request, from the stored pairing record.
(function () {
  "use strict";
  var transport = window.ArcFlareTransportAdapter.create({
    connect: async function () {
      var rec = await window.ArcFlareStore.load();
      if (!rec) throw new Error("not paired");
      return window.ArcFlareTunnel.connect(rec);
    },
  });
  Object.defineProperty(window, "ArcFlareTransport", { value: Object.freeze({ fetch: transport.fetch, eventSource: transport.eventSource }), writable: false, configurable: false });
})();
