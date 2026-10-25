// Pairing-link validator (TUNNEL.md section 5.1, 11). PURE: no DOM, no storage,
// no network, no logging. Everything that touches a pairing link goes through
// validateLink() first; on any problem it returns { ok:false } and the caller
// stores and sends nothing.
//
//   arcflare://pair?v=1&r=<urlenc relay>&rm=<roomId>&hk=<b64u hub key>&ps=<b64u secret>[&l=<urlenc LAN URL>]
//
// Works as a classic <script> (window.ArcFlareLink) and under CommonJS.

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareLink = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_LINK = 1024;                       // total size, bytes of the pasted text
  var PREFIX = "arcflare://pair?";
  var ALLOWED = { v: 1, r: 1, rm: 1, hk: 1, ps: 1, l: 1 };
  var B64U_43 = /^[A-Za-z0-9_-]{43}$/;       // 32 bytes, unpadded base64url
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function fail(code, message) { return { ok: false, code: code, error: message }; }

  /** 32 bytes = 256 bits = 42 chars + 4 bits; the last char must carry two zero bits (canonical). */
  function isB64u32(s) {
    if (typeof s !== "string" || !B64U_43.test(s)) return false;
    return (B64.indexOf(s[42]) & 3) === 0;
  }

  /** base64url -> Uint8Array (32 bytes) or null. */
  function decodeB64u32(s) {
    if (!isB64u32(s)) return null;
    var out = new Uint8Array(32), acc = 0, bits = 0, o = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64.indexOf(s[i]); bits += 6;
      if (bits >= 8) { bits -= 8; if (o < 32) out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
    }
    return o === 32 ? out : null;
  }

  /** Strict dotted-decimal IPv4 (no leading zeros, no hex, no short forms) -> [a,b,c,d] or null. */
  function parseIPv4(h) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return null;
    var out = [];
    for (var i = 1; i <= 4; i++) {
      if (m[i].length > 1 && m[i][0] === "0") return null;
      var n = Number(m[i]);
      if (n > 255) return null;
      out.push(n);
    }
    return out;
  }

  /** RFC 1918 only: 10/8, 172.16/12, 192.168/16. */
  function isPrivateIPv4(a) {
    return a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168);
  }

  function pctDecode(s) {
    if (/%(?![0-9A-Fa-f]{2})/.test(s)) return null;
    try { return decodeURIComponent(s); } catch (e) { return null; }
  }

  // Characters that never belong in either URL: controls, whitespace, backslash, quotes, angle brackets.
  var BAD_CHARS = /[\u0000-\u0020\u007f-\u009f\\"'<>`\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

  /** Relay: https (http only for loopback in a dev build), plain origin + optional path. */
  function checkRelay(raw, dev) {
    if (raw.length === 0 || raw.length > 300 || BAD_CHARS.test(raw)) return fail("BAD_RELAY", "The relay address is not valid.");
    if (raw.indexOf("@") !== -1 || raw.indexOf("?") !== -1 || raw.indexOf("#") !== -1) return fail("BAD_RELAY", "The relay address must not contain a user name, query or fragment.");
    var m = /^(https?):\/\/([^\/]+)(\/.*)?$/.exec(raw);
    if (!m) return fail("BAD_RELAY", "The relay address must start with https://.");
    var u;
    try { u = new URL(raw); } catch (e) { return fail("BAD_RELAY", "The relay address is not valid."); }
    if (u.username || u.password || u.search || u.hash) return fail("BAD_RELAY", "The relay address must not contain a user name, query or fragment.");
    var host = u.hostname.toLowerCase();
    var loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (u.protocol === "http:") {
      if (!(dev && loopback)) return fail("BAD_RELAY", "The relay must use https://.");
      return { ok: true, relay: u.origin + u.pathname.replace(/\/+$/, ""), host: u.host };
    }
    if (u.protocol !== "https:") return fail("BAD_RELAY", "The relay must use https://.");
    if (dev && loopback) return { ok: true, relay: u.origin + u.pathname.replace(/\/+$/, ""), host: u.host };
    // No IP literals at all (private ranges are the dangerous ones; a public IP cannot hold a valid certificate for us anyway).
    if (host[0] === "[" || parseIPv4(host) || /^[0-9.]+$/.test(host)) return fail("BAD_RELAY", "The relay must be a host name, not an IP address.");
    if (host.indexOf(".") === -1 || /(^|\.)(localhost|local|internal|lan|home|arpa|corp|intranet)$/.test(host)) {
      return fail("BAD_RELAY", "The relay must be a public host name.");
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return fail("BAD_RELAY", "The relay host name is not valid.");
    return { ok: true, relay: u.origin + u.pathname.replace(/\/+$/, ""), host: u.host };
  }

  /** LAN URL: http(s)://<RFC1918 IPv4 | name.local>:<port>, nothing else. */
  function checkLan(raw) {
    if (raw.length === 0 || raw.length > 100 || BAD_CHARS.test(raw)) return fail("BAD_LAN", "The home network address is not valid.");
    var m = /^(https?):\/\/([^\/?#@:\[\]]+):(\d{1,5})$/.exec(raw);
    if (!m) return fail("BAD_LAN", "The home network address must look like http://192.168.1.20:8765.");
    var host = m[2].toLowerCase(), port = m[3];
    if (port[0] === "0" || Number(port) < 1 || Number(port) > 65535) return fail("BAD_LAN", "The home network port is not valid.");
    var ip = parseIPv4(host);
    if (ip) {
      if (!isPrivateIPv4(ip)) return fail("BAD_LAN", "The home network address must be a private address (192.168.x.x, 10.x.x.x or 172.16-31.x.x).");
    } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.local$/.test(host) || host.length > 80) {
      return fail("BAD_LAN", "The home network address must be a private IP address or a .local name.");
    }
    return { ok: true, lan: m[1] + "://" + host + ":" + String(Number(port)) };
  }

  /**
   * validateLink(text, { dev }) ->
   *   { ok:true, value:{ relay, relayHost, room, hubKey, secret, lan|null }, canonical }
   *   { ok:false, code, error }
   * `dev` allows an http:// relay on loopback; production builds pass false.
   */
  function validateLink(text, opts) {
    var dev = !!(opts && opts.dev);
    if (typeof text !== "string") return fail("BAD_LINK", "That is not an ArcFlare pairing link.");
    if (text.length > MAX_LINK + 64) return fail("TOO_BIG", "That link is far too long to be an ArcFlare pairing link.");
    var s = text.trim();
    if (s.length > MAX_LINK) return fail("TOO_BIG", "That link is too long to be an ArcFlare pairing link.");
    if (/[\u0000-\u001f\u007f-\u009f\s]/.test(s)) return fail("BAD_LINK", "The link contains spaces or control characters.");
    if (s.indexOf(PREFIX) !== 0) return fail("BAD_LINK", "That is not an ArcFlare pairing link. It should start with arcflare://pair?");
    if (s.indexOf("#") !== -1) return fail("BAD_LINK", "The link contains a fragment, which a pairing link never has.");
    var query = s.slice(PREFIX.length);
    if (query.length === 0) return fail("BAD_LINK", "The link has no details in it.");
    var parts = query.split("&"), q = Object.create(null), i;
    if (parts.length > 6) return fail("BAD_LINK", "The link has too many parts.");
    for (i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq < 1) return fail("BAD_LINK", "The link is damaged.");
      var k = parts[i].slice(0, eq), v = parts[i].slice(eq + 1);
      if (!Object.prototype.hasOwnProperty.call(ALLOWED, k)) return fail("BAD_LINK", "The link has a part this app does not know (" + k.slice(0, 8).replace(/[^A-Za-z0-9_]/g, "?") + ").");
      if (k in q) return fail("BAD_LINK", "The link repeats a part.");
      q[k] = v;
    }
    if (q.v !== "1") return fail("BAD_VERSION", "This pairing link is for a different version of ArcFlare. Update the app and the computer, then try again.");
    if (!("r" in q) || !("rm" in q) || !("hk" in q) || !("ps" in q)) return fail("BAD_LINK", "The link is missing something.");
    if (!isB64u32(q.rm)) return fail("BAD_LINK", "The link is damaged (room).");
    if (!isB64u32(q.hk)) return fail("BAD_LINK", "The link is damaged (computer key).");
    if (!isB64u32(q.ps)) return fail("BAD_LINK", "The link is damaged (pairing secret).");
    var r = pctDecode(q.r);
    if (r === null) return fail("BAD_RELAY", "The relay address is not valid.");
    var relay = checkRelay(r, dev);
    if (!relay.ok) return relay;
    var lan = null;
    if ("l" in q) {
      var l = pctDecode(q.l);
      if (l === null) return fail("BAD_LAN", "The home network address is not valid.");
      var lr = checkLan(l);
      if (!lr.ok) return lr;
      lan = lr.lan;
    }
    var value = { relay: relay.relay, relayHost: relay.host, room: q.rm, hubKey: q.hk, secret: q.ps, lan: lan };
    var canonical = PREFIX + "v=1&r=" + encodeURIComponent(value.relay) + "&rm=" + value.room + "&hk=" + value.hubKey +
      "&ps=" + value.secret + (lan ? "&l=" + encodeURIComponent(lan) : "");
    return { ok: true, value: value, canonical: canonical };
  }

  /** True when a stored LAN URL still passes the same rules (checked again before it is ever used). */
  function validateLanUrl(url) {
    return typeof url === "string" && checkLan(url).ok;
  }

  return { validateLink: validateLink, validateLanUrl: validateLanUrl, isB64u32: isB64u32, decodeB64u32: decodeB64u32, MAX_LINK: MAX_LINK };
});
