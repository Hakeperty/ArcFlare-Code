// The fetch() the tunnel client uses to reach the hub's mailbox on the HOME network.
//
// Why it exists: the bundled app runs at https://localhost, so the WebView cannot fetch http://<lan-ip>
// (mixed content) and CORS would be awkward. tunnel-client.js takes an injectable `fetch` option
// (Mailbox: `o.fetch || root.fetch`; connect(device, { fetch }) and pair({ fetch })). The shell supplies this one,
// which uses Capacitor's NATIVE HTTP stack (CapacitorHttp) for exactly one kind of request:
//
//    GET or POST to  <stored LAN base>/api/tunnel/...        (exact scheme + host + port, path under /api/tunnel/)
//
// and refuses everything else (other host, other port, https, other path, userinfo, fragment, dot segments,
// other methods). It sends no cookies and keeps none: only Authorization, Content-Type and Accept are passed on,
// every Set-Cookie of an answer is dropped. Redirects are refused (disableRedirects, and any 3xx is an error).
// Answers over 3 MB are refused (TUNNEL.md section 12). Native timeouts cover the 25 s long polls.
//
// AbortSignal is not supported by the native plugin: on abort this rejects at once with an AbortError and a late
// native answer is ignored (the native request itself runs to its timeout).
//
// What this file cannot do: stop the native side from using its own cookie jar (see README "Residual risks"),
// or limit how much the native layer buffers before it hands the answer over (the cap is applied afterwards).
// The mailbox is blind and never sets cookies, so nothing in the jar can matter to it.
//
// window.ArcFlareLanFetch / CommonJS. `http` is { get(options), post(options) } = Capacitor's CapacitorHttp.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareLanFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var MAX_BYTES = 3 * 1024 * 1024;
  var CONNECT_MS = 3000;
  var READ_GET_MS = 40000;        // 25 s long poll + margin
  var READ_POST_MS = 15000;
  var MAX_INFLIGHT = 8;
  var PREFIX_PATH = "/api/tunnel/";
  var SEND = { authorization: 1, "content-type": 1, accept: 1 };

  function link() { return root.ArcFlareLink || require("./link.js"); }
  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function abortError() { var e = new Error("aborted"); e.name = "AbortError"; e.code = "ABORTED"; return e; }

  function byteLength(s) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(s).length;
    return s.length;
  }

  /** Throws unless `url` is exactly <lanBase>/api/tunnel/... . Pure; exported for tests. */
  function checkUrl(url, lanBase) {
    if (typeof url !== "string" || url.length > 2200 || /[\u0000- \u007f-\u009f\\"'<>`]/.test(url)) throw fail("LAN_REFUSED", "refused: bad URL");
    if (url.indexOf(lanBase + PREFIX_PATH) !== 0) throw fail("LAN_REFUSED", "refused: not the home network mailbox");
    var u, b;
    try { u = new URL(url); b = new URL(lanBase); } catch (e) { throw fail("LAN_REFUSED", "refused: bad URL"); }
    if (u.protocol !== "http:" || u.origin !== b.origin || u.username || u.password || u.hash) throw fail("LAN_REFUSED", "refused: not the home network mailbox");
    if (u.pathname.indexOf(PREFIX_PATH) !== 0 || /%2e|%2f|%5c/i.test(u.pathname) || /(^|\/)\.\.?(\/|$)/.test(u.pathname)) throw fail("LAN_REFUSED", "refused: path");
    return u;
  }

  function sendHeaders(init) {
    var out = {}, h = init && init.headers;
    if (!h) return out;
    function put(k, v) {
      k = String(k).toLowerCase(); v = String(v);
      if (SEND[k] && !/[\r\n\u0000]/.test(v)) out[k === "authorization" ? "Authorization" : k === "content-type" ? "Content-Type" : "Accept"] = v;   // cookie and everything else: dropped
    }
    if (typeof h.forEach === "function" && typeof h.get === "function") h.forEach(function (v, k) { put(k, v); });
    else Object.keys(h).forEach(function (k) { put(k, h[k]); });
    return out;
  }

  function responseHeaders(raw) {
    var map = {};
    if (raw && typeof raw === "object") Object.keys(raw).forEach(function (k) {
      var l = String(k).toLowerCase();
      if (l === "set-cookie" || l === "set-cookie2") return;           // never surfaced, never stored by us
      map[l] = String(raw[k]);
    });
    return { get: function (name) { var k = String(name).toLowerCase(); return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
  }

  /**
   * create({ http, lanBase }) -> { fetch(url, init) }. `lanBase` must be a stored/validated LAN base
   * (http://<private IPv4 | name.local>:<port>); anything else throws here.
   */
  function create(opts) {
    var http = opts && opts.http, lanBase = opts && opts.lanBase;
    if (!http || typeof http.get !== "function" || typeof http.post !== "function") throw fail("LAN_REFUSED", "no native http");
    if (!link().validateLanUrl(lanBase)) throw fail("LAN_REFUSED", "not a home network base URL");
    var maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
    var inflight = 0;
    // Secrets that must NEVER travel to the home mailbox (the internet-relay token): a request whose Authorization
    // carries one is refused here, whatever the caller above meant. Defence in depth behind tunnel-client's token choice.
    var refuse = ((opts && opts.refuse) || []).filter(function (x) { return typeof x === "string" && x.length > 8; });

    function lanFetch(url, init) {
      init = init || {};
      var u, method, body, signal = init.signal;
      try {
        u = checkUrl(url, lanBase);
        method = String(init.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "POST") throw fail("LAN_REFUSED", "refused: method");
        if (method === "POST") {
          if (typeof init.body !== "string") throw fail("LAN_REFUSED", "refused: body");
          try { body = JSON.parse(init.body); } catch (e) { throw fail("LAN_REFUSED", "refused: body is not JSON"); }
        } else if (init.body !== undefined && init.body !== null) throw fail("LAN_REFUSED", "refused: body on GET");
        if (inflight >= MAX_INFLIGHT) throw fail("LAN_REFUSED", "refused: too many requests");
      } catch (e) { return Promise.reject(e); }
      if (signal && signal.aborted) return Promise.reject(abortError());
      var sent = sendHeaders(init);
      for (var k = 0; k < refuse.length; k++) {
        if (sent.Authorization && sent.Authorization.indexOf(refuse[k]) !== -1) return Promise.reject(fail("LAN_REFUSED", "refused: the relay token is never sent to the home network"));
      }

      return new Promise(function (resolve, reject) {
        var settled = false, timer, onAbort;
        function done(fn, v) {
          if (settled) return;                   // late native result after abort/timeout: ignored
          settled = true;
          clearTimeout(timer);
          if (signal && onAbort) { try { signal.removeEventListener("abort", onAbort); } catch (e) { /* old signal */ } }
          fn(v);
        }
        var readMs = method === "GET" ? READ_GET_MS : READ_POST_MS;
        timer = setTimeout(function () { done(reject, fail("TIMEOUT", "no answer from the home network")); }, readMs + 5000);
        if (signal) { onAbort = function () { done(reject, abortError()); }; signal.addEventListener("abort", onAbort, { once: true }); }

        var req = {
          url: u.href, headers: sent, connectTimeout: CONNECT_MS, readTimeout: readMs,
          disableRedirects: true, responseType: "text", shouldEncodeUrlParams: false,
        };
        var call;
        try { if (method === "POST") req.data = body; call = method === "POST" ? http.post(req) : http.get(req); } catch (e) { done(reject, e); return; }
        inflight++;
        Promise.resolve(call).then(function (res) {
          inflight--;
          if (settled) return;
          try { done(resolve, toResponse(res, maxBytes)); } catch (e) { done(reject, e); }
        }, function (err) {
          inflight--;
          done(reject, err instanceof Error ? err : fail("NETWORK", "home network request failed"));
        });
      });
    }
    return { fetch: lanFetch };
  }

  /** Native answer -> a Response-like object, or throws (redirect, oversize, nonsense). */
  function toResponse(res, maxBytes) {
    if (!res || typeof res.status !== "number") throw fail("NETWORK", "bad answer");
    if (res.status >= 300 && res.status < 400) throw fail("LAN_REFUSED", "refused: redirect");
    var headers = responseHeaders(res.headers);
    var len = Number(headers.get("content-length"));
    if (len > maxBytes) throw fail("TOO_BIG", "relay reply too large");
    var text = res.data === undefined || res.data === null ? "" : typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    if (byteLength(text) > maxBytes) throw fail("TOO_BIG", "relay reply too large");
    return {
      ok: res.status >= 200 && res.status < 300, status: res.status, statusText: "", headers: headers,
      text: function () { return Promise.resolve(text); },
      json: function () { return Promise.resolve().then(function () { return JSON.parse(text); }); },
    };
  }

  return { create: create, checkUrl: checkUrl, MAX_BYTES: MAX_BYTES };
});
