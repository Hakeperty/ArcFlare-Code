// Adapter: ArcFlareTunnel.connect() session -> the UI's window.ArcFlareTransport contract.
//
//   fetch(path, init)  -> { ok, status, statusText, headers.get(name), json(), text() }
//   eventSource(path)  -> { addEventListener, removeEventListener, onopen, onmessage, onerror,
//                           readyState, lastEventId, close() }
//
// What it adds on top of tunnel-client.js:
//  - the session is opened lazily on first use and shared; when it closes (reset, tamper, hub
//    restart, 24 h limit) the next call opens a fresh one. Concurrent first calls share one connect.
//  - fetch is built on tunnel.request(), so it never depends on a global Response and always has
//    headers.get(); only Accept, Content-Type and X-CSRF-Token are passed on (the hub ignores the rest).
//  - tunnel eventSource has no addEventListener; this wrapper supplies it. Unnamed SSE events arrive
//    through onmessage and are also delivered to "message" listeners. Named events are never produced
//    by tunnel-client (it only emits type "message"), so listeners for other names are accepted and
//    simply never fire (the hub only sends unnamed events).
//  - no retry inside eventSource: when the session is unavailable it reports onerror once and the UI
//    does its own /api/me check and backoff.
// Classic script (window.ArcFlareTransportAdapter) and CommonJS.

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareTransportAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SEND_HEADERS = { "accept": 1, "content-type": 1, "x-csrf-token": 1 };

  function headersOf(init) {
    var out = {}, h = init && init.headers;
    if (!h) return out;
    function put(k, v) { k = String(k).toLowerCase(); if (SEND_HEADERS[k]) out[k] = String(v); }
    if (typeof h.forEach === "function" && typeof h.get === "function") h.forEach(function (v, k) { put(k, v); });
    else Object.keys(h).forEach(function (k) { put(k, h[k]); });
    return out;
  }

  function wrapHeaders(raw) {
    var map = {};
    if (raw && typeof raw === "object") {
      if (typeof raw.forEach === "function" && typeof raw.get === "function") raw.forEach(function (v, k) { map[String(k).toLowerCase()] = String(v); });
      else Object.keys(raw).forEach(function (k) { map[String(k).toLowerCase()] = String(raw[k]); });
    }
    return { get: function (name) { var k = String(name).toLowerCase(); return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
  }

  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }

  /** opts.connect: async () => tunnel (ArcFlareTunnel.connect(device)). */
  function create(opts) {
    var connect = opts.connect;
    var current = null;          // promise of the open tunnel

    function get() {
      if (current) return current;
      var p = Promise.resolve().then(connect).then(function (t) {
        t.onclose = function () { if (current === p) current = null; };
        return t;
      });
      current = p;
      p.catch(function () { if (current === p) current = null; });
      return p;
    }

    async function doFetch(path, init) {
      if (typeof path !== "string" || path.charAt(0) !== "/" || path.charAt(1) === "/") throw fail("BAD_PATH", "only /api paths go through the tunnel");
      init = init || {};
      var method = String(init.method || "GET").toUpperCase();
      var body = init.body === undefined || init.body === null ? undefined : init.body;
      var ro = { headers: headersOf(init), body: body };
      var r;
      for (var attempt = 0; ; attempt++) {
        var t = await get();
        try { r = await t.request(method, path, ro); break; }
        catch (e) {
          // CLOSED before anything was sent (session ended between calls): reconnect once, only if re-sending is safe.
          if (attempt === 0 && e && e.code === "CLOSED" && (method === "GET" || method === "HEAD")) { if (current) { current.catch(function () {}); } current = null; continue; }
          throw e;
        }
      }
      var headers = wrapHeaders(r.headers);
      return {
        ok: r.status >= 200 && r.status < 300, status: r.status, statusText: "", headers: headers,
        text: async function () { return r.text(); },
        json: async function () { return r.json(); },
      };
    }

    function doEventSource(path) {
      var listeners = Object.create(null);
      var inner = null, closed = false;
      var es = {
        readyState: 0, lastEventId: "", onopen: null, onmessage: null, onerror: null,
        addEventListener: function (type, fn) {
          if (typeof fn !== "function") return;
          var a = (listeners[type] = listeners[type] || []);
          if (a.indexOf(fn) === -1) a.push(fn);
        },
        removeEventListener: function (type, fn) {
          var a = listeners[type]; if (!a) return;
          var i = a.indexOf(fn); if (i !== -1) a.splice(i, 1);
        },
        close: function () { closed = true; es.readyState = 2; if (inner) { try { inner.close(); } catch (e) { /* already closed */ } } },
      };
      function dispatch(type, ev) {
        var h = es["on" + type];
        if (typeof h === "function") try { h.call(es, ev); } catch (e) { /* UI callback */ }
        (listeners[type] || []).slice().forEach(function (fn) { try { fn.call(es, ev); } catch (e) { /* UI callback */ } });
      }
      function failOnce() { if (closed) return; es.readyState = 2; dispatch("error", { type: "error" }); }
      get().then(function (t) {
        if (closed) return;
        inner = t.eventSource(path);
        inner.onopen = function (ev) { if (closed) return; es.readyState = 1; dispatch("open", ev || { type: "open" }); };
        inner.onmessage = function (ev) { if (closed) return; if (ev && ev.lastEventId) es.lastEventId = ev.lastEventId; dispatch("message", ev); };
        inner.onerror = function (ev) { if (closed) return; es.readyState = 2; dispatch("error", ev || { type: "error" }); };
      }, function () { if (!closed) setTimeout(failOnce, 0); });
      return es;
    }

    return { fetch: doFetch, eventSource: doEventSource, _reset: function () { current = null; } };
  }

  return { create: create };
});
