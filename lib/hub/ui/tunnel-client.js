// ArcFlare relay tunnel, the phone's half (WebCrypto). Spec: lib/hub/TUNNEL.md.
//
// A plain classic script with no dependencies, no eval and no inline anything,
// so it loads under the hub's CSP (script-src 'self') and inside the Capacitor
// app alike. In a page it defines window.ArcFlareTunnel; under CommonJS it is
// module.exports.
//
// Needs a secure context (https:// or the Capacitor app's https://localhost)
// with WebCrypto X25519: Chrome / Android System WebView 133 or newer.
//
// What the app keeps per paired hub (store it in IndexedDB, which can hold the
// non-extractable CryptoKey as-is; never in localStorage):
//   { v, relay, room, hubKey, deviceId, roomToken, label, privateKey, publicKey }
// The private key is generated non-extractable: script on the page can use it
// but cannot read it out, and neither can a backup of the app's storage on
// most devices.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareTunnel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var VERSION = 1;
  var NAME_KK = "Noise_KK_25519_AESGCM_SHA256";
  var NAME_PAIR = "Noise_IKpsk1_25519_AESGCM_SHA256";
  var PROLOGUE_LABEL = "ArcFlare-Tunnel/1";
  var SAS_LABEL = "ArcFlare-Tunnel SAS";
  var T = { HS1: 1, HS2: 2, DATA: 3, RESET: 4 };
  var MODE = { KK: 1, PAIR: 2 };
  var DATA_HEADER = 26;
  var LIMITS = {
    frameBytes: 32 * 1024 + 128,
    frameChars: 44000,
    plaintext: 24 * 1024,
    chunk: 12 * 1024,
    pad: 256,
    maxCounter: Math.pow(2, 48),
    rekeyFrames: 1024,
    rekeyMs: 10 * 60 * 1000,
    responseBytes: 32 * 1024 * 1024,
    relayReplyBytes: 3 * 1024 * 1024,   // one relay poll reply, read as text before it is parsed
    relayFramesPerPoll: 256,
  };

  // ------------------------------------------------------------ bytes ----

  var enc = new TextEncoder();
  var dec = new TextDecoder("utf-8", { fatal: true });

  function subtle() {
    var c = root.crypto;
    if (!c || !c.subtle) throw new Error("WebCrypto is not available here (it needs a secure context)");
    return c.subtle;
  }

  function concat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }

  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b;
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  var B64REV = {};
  for (var bi = 0; bi < 64; bi++) B64REV[B64[bi]] = bi;

  function b64u(bytes) {
    bytes = u8(bytes);
    var out = "", i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    var rest = bytes.length - i;
    if (rest === 1) { var a = bytes[i] << 16; out += B64[a >> 18] + B64[(a >> 12) & 63]; }
    else if (rest === 2) { var b = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[b >> 18] + B64[(b >> 12) & 63] + B64[(b >> 6) & 63]; }
    return out;
  }

  /** Strict, canonical base64url; null on anything else. */
  function unb64u(s, len) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, i;
    for (i = 0; i + 3 < s.length; i += 4) {
      var v = (B64REV[s[i]] << 18) | (B64REV[s[i + 1]] << 12) | (B64REV[s[i + 2]] << 6) | B64REV[s[i + 3]];
      out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
    }
    var rest = s.length - i;
    if (rest === 2) { var a = (B64REV[s[i]] << 18) | (B64REV[s[i + 1]] << 12); out[o++] = a >> 16; }
    else if (rest === 3) { var b = (B64REV[s[i]] << 18) | (B64REV[s[i + 1]] << 12) | (B64REV[s[i + 2]] << 6); out[o++] = b >> 16; out[o++] = (b >> 8) & 255; }
    out = out.subarray(0, o);
    if (b64u(out) !== s) return null;
    if (len !== undefined && out.length !== len) return null;
    return out;
  }

  function u64be(n) {
    var b = new Uint8Array(8);
    var hi = Math.floor(n / 4294967296), lo = n >>> 0;
    b[0] = hi >>> 24; b[1] = (hi >>> 16) & 255; b[2] = (hi >>> 8) & 255; b[3] = hi & 255;
    b[4] = lo >>> 24; b[5] = (lo >>> 16) & 255; b[6] = (lo >>> 8) & 255; b[7] = lo & 255;
    return b;
  }

  function readU64(b, off) {
    var hi = ((b[off] << 24) >>> 0) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3];
    var lo = ((b[off + 4] << 24) >>> 0) + (b[off + 5] << 16) + (b[off + 6] << 8) + b[off + 7];
    return hi * 4294967296 + lo;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  // ----------------------------------------------------------- crypto ----

  async function sha256() {
    return u8(await subtle().digest("SHA-256", concat.apply(null, arguments)));
  }

  async function hmac(key, data) {
    var k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return u8(await subtle().sign("HMAC", k, data));
  }

  /** HKDF-Expand(PRK=secret, info=label, L=32). */
  function kdf(secret, label) { return hmac(secret, concat(enc.encode(label), new Uint8Array([1]))); }

  /** Noise HKDF(ck, ikm, n) == RFC 5869 HKDF, salt=ck, info="". */
  async function hkdf(ck, ikm, n) {
    var temp = await hmac(ck, ikm), out = [], prev = new Uint8Array(0);
    for (var i = 1; i <= n; i++) { prev = await hmac(temp, concat(prev, new Uint8Array([i]))); out.push(prev); }
    return out;
  }

  function nonceFor(n) {
    var b = new Uint8Array(12);
    if (n === "max") { for (var i = 4; i < 12; i++) b[i] = 255; } else b.set(u64be(n), 4);
    return b;
  }

  async function aesKey(k) { return subtle().importKey("raw", k, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }

  async function seal(k, n, ad, pt) {
    var key = await aesKey(k);
    return u8(await subtle().encrypt({ name: "AES-GCM", iv: nonceFor(n), additionalData: ad, tagLength: 128 }, key, pt));
  }

  async function open(k, n, ad, ct) {
    var key = await aesKey(k);
    try {
      return u8(await subtle().decrypt({ name: "AES-GCM", iv: nonceFor(n), additionalData: ad, tagLength: 128 }, key, ct));
    } catch (e) {
      throw err("AEAD", "authentication failed");
    }
  }

  async function rekeyKey(k) {
    return (await seal(k, "max", new Uint8Array(0), new Uint8Array(32))).slice(0, 32);
  }

  /** A fresh X25519 pair; the private half is not extractable. */
  async function generateX25519() {
    var kp = await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"]);
    var pub = u8(await subtle().exportKey("raw", kp.publicKey));
    return { privateKey: kp.privateKey, pub: pub };
  }

  async function dh(privateKey, pubRaw) {
    var pub = await subtle().importKey("raw", pubRaw, { name: "X25519" }, true, []);
    var out = u8(await subtle().deriveBits({ name: "X25519", public: pub }, privateKey, 256));
    var zero = true;
    for (var i = 0; i < out.length; i++) if (out[i] !== 0) { zero = false; break; }
    if (zero) throw err("DH", "low-order public key");
    return out;
  }

  function Sym(name) {
    var nb = enc.encode(name);
    var h = new Uint8Array(32);
    if (nb.length > 32) throw new Error("protocol name too long");
    h.set(nb);
    this.h = h; this.ck = h; this.k = null; this.n = 0;
  }
  Sym.prototype.mixHash = async function (d) { this.h = await sha256(this.h, d); };
  Sym.prototype.mixKey = async function (ikm) {
    var o = await hkdf(this.ck, ikm, 2); this.ck = o[0]; this.k = o[1]; this.n = 0;
  };
  Sym.prototype.mixKeyAndHash = async function (ikm) {
    var o = await hkdf(this.ck, ikm, 3); this.ck = o[0]; await this.mixHash(o[1]); this.k = o[2]; this.n = 0;
  };
  Sym.prototype.encryptAndHash = async function (pt) {
    var ct = this.k ? await seal(this.k, this.n++, this.h, pt) : pt;
    await this.mixHash(ct);
    return ct;
  };
  Sym.prototype.decryptAndHash = async function (ct) {
    var pt = this.k ? await open(this.k, this.n++, this.h, ct) : ct;
    await this.mixHash(ct);
    return pt;
  };
  Sym.prototype.split = function () { return hkdf(this.ck, new Uint8Array(0), 2); };

  function prologue(mode, roomRaw, idField, sid) {
    return concat(enc.encode(PROLOGUE_LABEL), new Uint8Array([0, VERSION, mode]), roomRaw, idField, sid);
  }

  async function sasFromHash(h) {
    var d = await sha256(enc.encode(SAS_LABEL), h);
    var v = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
    return String(v % 1000000).padStart(6, "0");
  }

  function encodeMessage(obj) {
    var raw = enc.encode(JSON.stringify(obj));
    var len = Math.ceil((raw.length + 1) / LIMITS.pad) * LIMITS.pad;
    if (len > LIMITS.plaintext) throw err("TOO_BIG", "message too large");
    var out = new Uint8Array(len).fill(0x20);
    out.set(raw);
    return out;
  }

  function decodeMessage(buf) {
    if (buf.length > LIMITS.plaintext) throw err("TOO_BIG", "message too large");
    var v = JSON.parse(dec.decode(buf));
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.t !== "string") throw err("BAD_MESSAGE", "bad message");
    return v;
  }

  async function tokenHash(token) { return b64u(await sha256(enc.encode(token))); }

  // ------------------------------------------------------------ links ----

  /** arcflare://pair?v=1&r=<relay>&rm=<room>&hk=<hub key>&ps=<secret>[&l=<lan>] */
  function parsePairingLink(link) {
    var m = /^arcflare:\/\/pair\?(.*)$/.exec(String(link || "").trim());
    if (!m) throw err("BAD_LINK", "not an ArcFlare pairing link");
    var q = {};
    m[1].split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) { var k = kv.slice(0, i); if (!(k in q)) q[k] = decodeURIComponent(kv.slice(i + 1)); }
    });
    if (q.v !== String(VERSION)) throw err("BAD_VERSION", "this pairing link needs a newer app");
    var relay = checkRelayUrl(q.r);
    var room = unb64u(q.rm, 32), hubKey = unb64u(q.hk, 32), secret = unb64u(q.ps, 32);
    if (!room || !hubKey || !secret) throw err("BAD_LINK", "damaged pairing link");
    // l = the hub's own LAN mailbox base URL (not a page to open); same rules as r.
    var lan = q.l ? checkRelayUrl(q.l) : null;
    return { relay: relay, room: q.rm, hubKey: q.hk, secret: q.ps, lan: lan };
  }

  /** Private IPv4 (RFC 1918), a *.local name, or loopback: the only hosts that may be reached over plain http (LAN mode, TUNNEL.md section 16). */
  function isLanHost(h) {
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return true;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(h)) return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m || +m[1] > 255 || +m[2] > 255 || +m[3] > 255 || +m[4] > 255) return false;
    var a = +m[1], b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }

  /** https for the internet relay; plain http only for the hub's own LAN mailbox (isLanHost). */
  function checkRelayUrl(url) {
    var u;
    try { u = new URL(url); } catch (e) { throw err("BAD_LINK", "bad relay URL"); }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLanHost(u.hostname))) throw err("BAD_LINK", "the relay must be https://");
    if (u.username || u.password || u.search || u.hash) throw err("BAD_LINK", "the relay URL must be a plain origin and path");
    return u.toString().replace(/\/+$/, "");
  }

  async function derivePairing(secretB64) {
    var s = unb64u(secretB64, 32);
    return {
      pid: (await kdf(s, "arcflare-tunnel pair-id")).slice(0, 16),
      psk: await kdf(s, "arcflare-tunnel pair-psk"),
      pairToken: "aftc_" + b64u(await kdf(s, "arcflare-tunnel pair-token")),
    };
  }

  // ---------------------------------------------------------- mailbox ----

  /**
   * One channel on the relay: ordered posts out, a long-poll loop in. Frames
   * are handed to onFrame one at a time, in relay order, each awaited.
   */
  function Mailbox(o) {
    this.relay = o.relay; this.room = o.room; this.token = o.token;
    this.ch = o.ch || b64u(randomBytes(16));
    this.fetch = o.fetch || root.fetch.bind(root);
    this.onFrame = o.onFrame;
    this.onStatus = o.onStatus || function () {};
    this.wait = o.waitSec || 25;
    // A long-poll that comes back early with nothing new must not be re-issued at once: a lying relay
    // (always "no frames", instantly) would make the phone spin. After a poll that returned early with no new
    // frames the next poll waits until minPollMs have passed since the previous one started.
    this.minPollMs = typeof o.minPollMs === "number" ? o.minPollMs : 1000;
    this.after = 0;
    this.active = false;
    this.out = [];
    this.posting = null;
    this.abort = typeof AbortController === "function" ? new AbortController() : null;
  }
  /** Parse a relay reply, refusing to buffer more than LIMITS.relayReplyBytes of it. */
  async function readJsonCapped(res) {
    var cap = LIMITS.relayReplyBytes;
    var len = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
    if (len > cap) throw err("TOO_BIG", "relay reply too large");
    var text;
    if (res.body && typeof res.body.getReader === "function") {
      var reader = res.body.getReader(), parts = [], total = 0;
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        total += r.value.length;
        if (total > cap) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw err("TOO_BIG", "relay reply too large"); }
        parts.push(r.value);
      }
      var all = new Uint8Array(total), off = 0;
      parts.forEach(function (p) { all.set(p, off); off += p.length; });
      text = new TextDecoder().decode(all);
    } else {
      text = await res.text();
      if (text.length > cap) throw err("TOO_BIG", "relay reply too large");
    }
    return JSON.parse(text);
  }
  Mailbox.prototype._url = function (query) {
    return this.relay + "/api/tunnel/room/" + this.room + "/client" + (query ? "?" + query : "");
  };
  Mailbox.prototype._init = function (method, body) {
    var init = { method: method, headers: { Authorization: "Bearer " + this.token }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
    if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    if (this.abort) {
      var A = root.AbortSignal;
      init.signal = A && A.any && A.timeout ? A.any([this.abort.signal, A.timeout((this.wait + 20) * 1000)]) : this.abort.signal;
    }
    return init;
  };
  Mailbox.prototype.start = function () {
    if (this.active) return;
    this.active = true;
    this.loop = this._poll();
  };
  Mailbox.prototype.send = function (frameBytes) {
    this.out.push(b64u(frameBytes));
    return this._kick();
  };
  Mailbox.prototype._kick = function () {
    var self = this;
    if (self.posting) return self.posting;
    self.posting = (async function () {
      var backoff = 300;
      while (self.out.length) {
        var batch = self.out.slice(0, 16);
        try {
          var res = await self.fetch(self._url(), self._init("POST", { ch: self.ch, frames: batch }));
          if (res.status === 409) throw err("OFFLINE", "the computer is offline");
          if (res.status === 401 || res.status === 403) throw err("REFUSED", "the relay refused this device");
          if (!res.ok) throw err("RELAY", "relay answered " + res.status);
          self.out.splice(0, batch.length);
          backoff = 300;
        } catch (e) {
          if (!self.active || e.code === "REFUSED" || e.code === "OFFLINE" || backoff > 8000) { self.out.length = 0; throw e; }
          await sleep(backoff);
          backoff *= 2;
        }
      }
    })();
    var p = self.posting;
    p.then(function () { self.posting = null; }, function () { self.posting = null; });
    return p;
  };
  Mailbox.prototype._poll = async function () {
    var backoff = 500;
    while (this.active) {
      try {
        var startedAt = Date.now(), gotFrames = 0;
        var res = await this.fetch(this._url("ch=" + this.ch + "&after=" + this.after + "&wait=" + this.wait), this._init("GET"));
        if (res.status === 401 || res.status === 403) { this.onStatus("refused"); throw err("REFUSED", "relay refused"); }
        if (!res.ok) throw err("RELAY", "relay answered " + res.status);
        var j = await readJsonCapped(res);
        if (!j || typeof j !== "object") throw err("RELAY", "bad relay reply");
        backoff = 500;
        this.onStatus(j.online === false ? "offline" : "online");
        if (typeof j.head === "number" && j.head < this.after) this.after = 0; // the relay restarted
        var frames = (Array.isArray(j.frames) ? j.frames : []).slice(0, LIMITS.relayFramesPerPoll);
        for (var i = 0; i < frames.length && this.active; i++) {
          var f = frames[i];
          if (!f || typeof f.seq !== "number" || f.seq <= this.after) continue;
          this.after = f.seq;
          gotFrames++;
          if (typeof f.c !== "string" || f.c.length > LIMITS.frameChars) continue;
          var bytes = unb64u(f.c);
          if (bytes) await this.onFrame(bytes);
        }
        if (!gotFrames && this.active) {
          var spent = Date.now() - startedAt;
          if (spent < this.minPollMs) await sleep(this.minPollMs - spent);
        }
      } catch (e) {
        if (!this.active) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  };
  Mailbox.prototype.stop = function () {
    this.active = false;
    if (this.abort) this.abort.abort();
  };

  function waiter(ms, what) {
    var w = {};
    w.promise = new Promise(function (resolve, reject) {
      w.resolve = resolve; w.reject = reject;
      w.timer = setTimeout(function () { reject(err("TIMEOUT", what + " timed out")); }, ms);
    });
    w.promise.then(function () { clearTimeout(w.timer); }, function () { clearTimeout(w.timer); });
    return w;
  }

  // ---------------------------------------------------------- pairing ----

  /**
   * Pair with a hub from its QR link. Resolves to { device, sas }: show `sas`
   * on screen so the person can check it matches the computer, then store
   * `device`. The hub marks the device usable only once the person at the
   * computer confirms that code.
   */
  async function pair(opts) {
    var link = parsePairingLink(opts.link);
    var d = await derivePairing(link.secret);
    var hubKey = unb64u(link.hubKey, 32), roomRaw = unb64u(link.room, 32);
    var stat = await generateX25519();
    var e = await generateX25519();
    var sid = randomBytes(16);
    var label = String(opts.label || "phone").slice(0, 60);

    var ss = new Sym(NAME_PAIR);
    await ss.mixHash(prologue(MODE.PAIR, roomRaw, d.pid, sid));
    await ss.mixHash(hubKey);
    await ss.mixHash(e.pub);
    await ss.mixKey(e.pub);
    await ss.mixKey(await dh(e.privateKey, hubKey));        // es
    var encS = await ss.encryptAndHash(stat.pub);            // s
    await ss.mixKey(await dh(stat.privateKey, hubKey));     // ss
    await ss.mixKeyAndHash(d.psk);                          // psk
    var ct = await ss.encryptAndHash(encodeMessage({ t: "pair", ts: Date.now(), label: label }));
    var hs1 = concat(new Uint8Array([VERSION, T.HS1, MODE.PAIR]), sid, d.pid, e.pub, encS, ct);

    var w = waiter(opts.timeoutMs || 30000, "pairing");
    var mb = new Mailbox({
      relay: link.relay, room: link.room, token: d.pairToken, fetch: opts.fetch, waitSec: opts.pollWaitSec, minPollMs: opts.minPollMs,
      onFrame: async function (f) {
        if (f.length < 66 || f[0] !== VERSION || f[1] !== T.HS2 || !eq(f.subarray(2, 18), sid)) return;
        try {
          var re = f.slice(18, 50);
          await ss.mixHash(re);
          await ss.mixKey(re);
          await ss.mixKey(await dh(e.privateKey, re));            // ee
          await ss.mixKey(await dh(stat.privateKey, re));         // se
          var msg = decodeMessage(await ss.decryptAndHash(f.slice(50)));
          if (msg.t !== "paired" || typeof msg.deviceId !== "string" || !unb64u(msg.deviceId, 16) ||
              typeof msg.roomToken !== "string" || !/^aftc_[A-Za-z0-9_-]{43}$/.test(msg.roomToken)) throw err("BAD_MESSAGE", "bad pairing reply");
          w.resolve({ msg: msg, sas: await sasFromHash(ss.h) });
        } catch (x) {
          w.reject(err("HANDSHAKE", "the computer's answer did not verify — wrong or forged hub key"));
        }
      },
    });
    mb.start();
    try {
      await mb.send(hs1);
      var got = await w.promise;
      return {
        sas: got.sas,
        device: {
          v: VERSION, relay: link.relay, room: link.room, hubKey: link.hubKey, lan: link.lan,
          deviceId: got.msg.deviceId, roomToken: got.msg.roomToken, label: label,
          privateKey: stat.privateKey, publicKey: b64u(stat.pub),
        },
      };
    } finally {
      mb.stop();
    }
  }

  function eq(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  // ----------------------------------------------------------- tunnel ----

  /**
   * An open session with a paired hub. Use request()/fetch() for API calls and
   * eventSource() for the SSE streams. When it closes (relay reset, tamper,
   * hub restart) every pending call fails and onclose fires; connect again.
   */
  function Tunnel(device, opts) {
    opts = opts || {};
    this.device = device;
    this.opts = opts;
    this.state = "new";
    this.reqs = new Map();
    this.nextId = 1;
    this.onclose = null;
    this.onstatus = opts.onStatus || null;
    this.rekeyFrames = opts.rekeyFrames || LIMITS.rekeyFrames;
    this.chain = Promise.resolve();
  }

  Tunnel.prototype._status = function (s) { if (this.onstatus) try { this.onstatus(s); } catch (e) { /* app callback */ } };

  Tunnel.prototype._handshake = async function () {
    var dv = this.device, self = this;
    var hubKey = unb64u(dv.hubKey, 32), roomRaw = unb64u(dv.room, 32), idField = unb64u(dv.deviceId, 16);
    var myPub = unb64u(dv.publicKey, 32);
    if (!hubKey || !roomRaw || !idField || !myPub) throw err("BAD_DEVICE", "damaged device record");
    var e = await generateX25519();
    var sid = randomBytes(16);
    var ss = new Sym(NAME_KK);
    await ss.mixHash(prologue(MODE.KK, roomRaw, idField, sid));
    await ss.mixHash(myPub);
    await ss.mixHash(hubKey);
    await ss.mixHash(e.pub);
    await ss.mixKey(await dh(e.privateKey, hubKey));          // es
    await ss.mixKey(await dh(dv.privateKey, hubKey));         // ss
    var ct = await ss.encryptAndHash(encodeMessage({ t: "hello", ts: Date.now() }));
    var hs1 = concat(new Uint8Array([VERSION, T.HS1, MODE.KK]), sid, idField, e.pub, ct);

    var w = waiter(this.opts.handshakeTimeoutMs || 20000, "connecting");
    this._hsw = w;
    this.sid = sid;
    this._onHs2 = async function (f) {
      self._onHs2 = null;
      try {
        var re = f.slice(18, 50);
        await ss.mixHash(re);
        await ss.mixKey(await dh(e.privateKey, re));          // ee
        await ss.mixKey(await dh(dv.privateKey, re));         // se
        var msg = decodeMessage(await ss.decryptAndHash(f.slice(50)));
        if (msg.t !== "welcome") throw err("BAD_MESSAGE", "bad welcome");
        if (msg.status !== "ok") return w.reject(err("PENDING", "waiting for the computer to approve this phone"));
        var ks = await ss.split();
        self.send = { k: ks[0], n: 0, since: 0, at: Date.now() };
        self.recv = { k: ks[1], n: 0 };
        if (msg.rekeyFrames > 0) self.rekeyFrames = Math.min(self.rekeyFrames, msg.rekeyFrames);
        w.resolve();
      } catch (x) {
        w.reject(err("HANDSHAKE", "the computer's answer did not verify — wrong or forged hub key"));
      }
    };
    await this.mb.send(hs1);
    return w.promise;
  };

  Tunnel.prototype.open = async function () {
    var self = this;
    this.state = "connecting";
    this.mb = new Mailbox({
      relay: this.device.relay, room: this.device.room, token: this.device.roomToken,
      fetch: this.opts.fetch, waitSec: this.opts.pollWaitSec, minPollMs: this.opts.minPollMs,
      onStatus: function (s) { self._status(s); },
      onFrame: function (f) { return self._frame(f); },
    });
    this.mb.start();
    try {
      await this._handshake();
    } catch (e) {
      this.mb.stop();
      this.state = "closed";
      throw e;
    }
    this.state = "open";
    return this;
  };

  Tunnel.prototype._frame = async function (f) {
    if (f.length < 18 || f[0] !== VERSION || !this.sid || !eq(f.subarray(2, 18), this.sid)) return;
    if (f[1] === T.HS2) { if (this._onHs2 && f.length >= 66) await this._onHs2(f); return; }
    if (f[1] === T.RESET) { if (f.length === 18) this._die("RESET", "the computer ended the session"); return; }
    if (f[1] !== T.DATA || this.state !== "open" || f.length < DATA_HEADER + 16 || f.length > LIMITS.frameBytes) return;
    var n = readU64(f, 18);
    if (n < this.recv.n) return;                                      // duplicate / replay
    if (n > this.recv.n) return this._die("GAP", "a message went missing");
    var msg;
    try {
      msg = decodeMessage(await open(this.recv.k, n, f.subarray(0, DATA_HEADER), f.subarray(DATA_HEADER)));
    } catch (e) {
      return this._die("AEAD", "a message failed to verify");
    }
    this.recv.n++;
    try { await this._message(msg); } catch (e) { this._die("PROTOCOL", "protocol error"); }
  };

  Tunnel.prototype._message = async function (m) {
    if (m.t === "rekey") { this.recv.k = await rekeyKey(this.recv.k); return; }
    if (m.t === "pong") return;
    if (m.t !== "res" && m.t !== "data" && m.t !== "end" && m.t !== "err") throw err("PROTOCOL", "unknown message"); // even for an unknown id
    var r = this.reqs.get(m.id);
    if (!r) return; // a request we already cancelled
    if (m.t === "res") {
      if (r.status !== undefined || !Number.isInteger(m.s)) throw err("PROTOCOL", "bad res");
      r.status = m.s; r.headers = m.h && typeof m.h === "object" ? m.h : {};
      if (r.onHead) r.onHead(r.status, r.headers);
    } else if (m.t === "data") {
      var d = unb64u(m.d);
      if (!d || r.status === undefined) throw err("PROTOCOL", "bad data");
      r.size += d.length;
      if (r.size > LIMITS.responseBytes && !r.onData) { this.reqs.delete(m.id); this._sendMsg({ t: "cancel", id: m.id }); return r.reject(err("TOO_BIG", "response too large")); }
      if (r.onData) r.onData(d); else r.chunks.push(d);
    } else if (m.t === "end") {
      this.reqs.delete(m.id);
      r.resolve();
    } else {
      this.reqs.delete(m.id);
      r.reject(err("ABORTED", "the computer aborted the request"));
    }
  };

  /** Encrypt and send, strictly in call order. */
  Tunnel.prototype._sendMsg = function (msg) {
    var self = this;
    var p = this.chain.then(async function () {
      if (self.state !== "open") throw err("CLOSED", "tunnel closed");
      if (self.send.n >= LIMITS.maxCounter - 2) { self._die("COUNTER", "counter exhausted"); throw err("CLOSED", "tunnel closed"); }
      await self._seal(encodeMessage(msg));
      if (self.send.since >= self.rekeyFrames || Date.now() - self.send.at >= LIMITS.rekeyMs) {
        await self._seal(encodeMessage({ t: "rekey" }));
        self.send.k = await rekeyKey(self.send.k);
        self.send.since = 0; self.send.at = Date.now();
      }
    });
    this.chain = p.catch(function () {});
    return p;
  };

  Tunnel.prototype._seal = async function (pt) {
    var ad = concat(new Uint8Array([VERSION, T.DATA]), this.sid, u64be(this.send.n));
    var ct = await seal(this.send.k, this.send.n, ad, pt);
    this.send.n++; this.send.since++;
    var frame = concat(ad, ct);
    // Do not await the relay POST: ordering is kept by the mailbox queue.
    var self = this;
    this.mb.send(frame).catch(function (e) { self._die(e.code || "RELAY", e.message); });
  };

  Tunnel.prototype._die = function (code, message) {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.mb) this.mb.stop();
    var e = err(code, message);
    if (this._hsw) this._hsw.reject(e);
    this.reqs.forEach(function (r) { r.reject(e); });
    this.reqs.clear();
    if (this.onclose) try { this.onclose(e); } catch (x) { /* app callback */ }
  };

  Tunnel.prototype.close = function () {
    var self = this;
    if (this.state !== "open") return this._die("CLOSED", "closed");
    this._sendMsg({ t: "bye" }).then(function () { return self.mb.posting; }).catch(function () {}).then(function () { self._die("CLOSED", "closed"); });
  };

  function bodyBytes(body) {
    if (body === undefined || body === null) return new Uint8Array(0);
    if (typeof body === "string") return enc.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    throw err("BAD_BODY", "body must be a string or bytes");
  }

  /** Low-level: start a request, returns the entry. */
  Tunnel.prototype._start = function (method, path, headers, body, hooks) {
    if (this.state !== "open") return Promise.reject(err("CLOSED", "tunnel closed"));
    var id = this.nextId++;
    var r = { id: id, chunks: [], size: 0, status: undefined, headers: null };
    if (hooks) { r.onHead = hooks.onHead; r.onData = hooks.onData; }
    var done = new Promise(function (resolve, reject) { r.resolve = resolve; r.reject = reject; });
    this.reqs.set(id, r);
    var h = {};
    Object.keys(headers || {}).forEach(function (k) { h[k.toLowerCase()] = String(headers[k]); });
    var bytes = bodyBytes(body);
    var self = this;
    var sends = [this._sendMsg({ t: "req", id: id, m: method, p: path, h: h, end: bytes.length === 0 })];
    if (bytes.length) {
      for (var i = 0; i < bytes.length; i += LIMITS.chunk) sends.push(this._sendMsg({ t: "body", id: id, d: b64u(bytes.subarray(i, i + LIMITS.chunk)) }));
      sends.push(this._sendMsg({ t: "end", id: id }));
    }
    Promise.all(sends).catch(function (e) { if (self.reqs.delete(id)) r.reject(e); });
    r.done = done;
    return r;
  };

  /** -> { status, headers, body: Uint8Array, text(), json() } */
  Tunnel.prototype.request = async function (method, path, o) {
    o = o || {};
    var r = this._start(String(method).toUpperCase(), path, o.headers, o.body);
    if (r instanceof Promise) return r;
    await r.done;
    var body = concat.apply(null, r.chunks);
    return {
      status: r.status, headers: r.headers, body: body,
      text: function () { return new TextDecoder().decode(body); },
      json: function () { return JSON.parse(new TextDecoder().decode(body)); },
    };
  };

  /** A fetch()-shaped wrapper returning a real Response where one exists. */
  Tunnel.prototype.fetch = async function (path, init) {
    init = init || {};
    var r = await this.request(init.method || "GET", path, { headers: init.headers, body: init.body });
    if (typeof root.Response === "function") {
      var nullBody = r.status === 204 || r.status === 304 || (init.method || "GET").toUpperCase() === "HEAD";
      return new root.Response(nullBody ? null : r.body, { status: r.status, headers: r.headers });
    }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: r.headers, text: async function () { return r.text(); }, json: async function () { return r.json(); } };
  };

  /**
   * An EventSource look-alike over the tunnel. No automatic reconnect: on
   * onerror, reopen with the last event id (as app.js already does).
   */
  Tunnel.prototype.eventSource = function (path, o) {
    o = o || {};
    var self = this;
    var es = { readyState: 0, onopen: null, onmessage: null, onerror: null, lastEventId: o.lastEventId || "" };
    var text = "", decoder = new TextDecoder(), reqId = null;
    function fire(name, ev) { if (typeof es[name] === "function") try { es[name](ev); } catch (x) { /* app callback */ } }
    function parse() {
      var i;
      while ((i = text.indexOf("\n\n")) !== -1) {
        var block = text.slice(0, i); text = text.slice(i + 2);
        var data = [], type = "message", id = null;
        block.split("\n").forEach(function (line) {
          if (!line || line[0] === ":") return;
          var c = line.indexOf(":"), field = c === -1 ? line : line.slice(0, c);
          var value = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "event") type = value;
          else if (field === "id") id = value;
        });
        if (id !== null) es.lastEventId = id;
        if (data.length && type === "message") fire("onmessage", { type: type, data: data.join("\n"), lastEventId: es.lastEventId });
      }
    }
    var headers = { accept: "text/event-stream" };
    if (es.lastEventId) headers["last-event-id"] = es.lastEventId;
    var r = this._start("GET", path, headers, null, {
      onHead: function (status, h) {
        if (status !== 200 || !/^text\/event-stream/.test(h["content-type"] || "")) { es.readyState = 2; fire("onerror", { status: status }); return; }
        es.readyState = 1; fire("onopen", {});
      },
      onData: function (d) { if (es.readyState !== 1) return; text += decoder.decode(d, { stream: true }); if (text.length > 4 * 1024 * 1024) text = ""; parse(); },
    });
    if (r instanceof Promise) { r.catch(function () {}); es.readyState = 2; setTimeout(function () { fire("onerror", {}); }, 0); return es; }
    reqId = r.id;
    r.done.then(function () { if (es.readyState !== 2) { es.readyState = 2; fire("onerror", {}); } },
      function () { if (es.readyState !== 2) { es.readyState = 2; fire("onerror", {}); } });
    es.close = function () {
      if (es.readyState === 2 && !self.reqs.has(reqId)) return;
      es.readyState = 2;
      if (self.reqs.delete(reqId)) self._sendMsg({ t: "cancel", id: reqId }).catch(function () {});
    };
    return es;
  };

  Tunnel.prototype.ping = function () { return this._sendMsg({ t: "ping" }); };

  /** Open a session. Rejects with code PENDING while the computer has not approved this phone. */
  async function connect(device, opts) {
    var t = new Tunnel(device, opts);
    return t.open();
  }

  return {
    VERSION: VERSION, LIMITS: LIMITS,
    parsePairingLink: parsePairingLink, pair: pair, connect: connect, Tunnel: Tunnel,
    tokenHash: tokenHash,
    _internal: {
      b64u: b64u, unb64u: unb64u, kdf: kdf, hkdf: hkdf, sha256: sha256, seal: seal, open: open,
      rekeyKey: rekeyKey, dh: dh, generateX25519: generateX25519, Sym: Sym, prologue: prologue,
      encodeMessage: encodeMessage, decodeMessage: decodeMessage, derivePairing: derivePairing, Mailbox: Mailbox,
    },
  };
});
