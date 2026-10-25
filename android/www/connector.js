// Connecting and pairing over the two tunnel targets (see mode.js). All dependencies are injected so this runs
// in Node tests: deps = { Tunnel: ArcFlareTunnel, lanFetch(lanBase) -> fetch }.
//
//   home   : handshake over the hub's LAN mailbox with the native LAN fetch, capped at 3 s. Success proves the hub
//            (its key is pinned) and nothing was sent in clear. Tried first, always.
//   relay  : handshake over the https relay (browser fetch), capped at 10 s. Only tried when home failed and the
//            record has a relay base different from the LAN base.
//
// The relay is never contacted when the home handshake succeeded. Nothing here stores or logs anything.
// window.ArcFlareConnector / CommonJS.

(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ArcFlareConnector = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var HOME_MS = 3000, RELAY_MS = 10000, PAIR_HOME_MS = 8000, PAIR_MS = 30000;

  function mode() { return root.ArcFlareMode || require("./mode.js"); }
  function link() { return root.ArcFlareLink || require("./link.js"); }
  function codeOf(e) { return (e && e.code) || "FAILED"; }
  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }

  /** Rejects after `ms` even if `p` never settles; a late success is closed/ignored through `late`. */
  function cap(p, ms, late) {
    var timer;
    return Promise.race([
      p.then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; }),
      new Promise(function (_, rej) {
        timer = setTimeout(function () {
          p.then(function (v) { try { late(v); } catch (e) { /* closing */ } }, function () {});
          rej(fail("TIMEOUT", "no answer in time"));
        }, ms);
      }),
    ]);
  }

  /** fetch that refuses any request whose Authorization carries `secret` (a token that belongs to the other carrier). */
  function guardFetch(fetchFn, secret) {
    return function (url, init) {
      var h = init && init.headers, a = h && (h.Authorization || h.authorization);
      if (typeof a === "string" && a.indexOf(secret) !== -1) return Promise.reject(fail("TOKEN_MISUSE", "refused: a token for the other network"));
      return fetchFn(url, init);
    };
  }

  /**
   * Open one tunnel to one target of the record. Resolves to an open Tunnel; rejects with .code.
   * Token rule (TUNNEL.md 16.5): requests to the HOME base carry only the record's lanToken, requests to the RELAY
   * only its roomToken. tunnel-client picks the token by base; the guards below refuse the wrong one as well.
   */
  function connectTarget(deps, rec, target) {
    var home = target.kind === "home";
    var opts = { handshakeTimeoutMs: home ? HOME_MS : RELAY_MS };
    if (home) opts.fetch = deps.lanFetch(target.base, { refuse: [rec.roomToken] }).fetch;
    else if (rec.lanToken) {
      var plain = deps.relayFetch || (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
      if (plain) opts.fetch = guardFetch(plain, rec.lanToken);
    }
    if (deps.extra) Object.assign(opts, deps.extra);          // tests only (poll timing)
    // The tunnel client reads the base from device.relay: point it at this target, nothing else changes.
    var device = Object.assign({}, rec, { relay: target.base });
    return cap(Promise.resolve().then(function () { return deps.Tunnel.connect(device, opts); }), opts.handshakeTimeoutMs + 500, function (t) { t.close(); });
  }

  /**
   * Home first, relay only after home failed. Resolves { kind, tunnel } (tunnel open: the caller closes it or uses it)
   * or rejects with { code, attempts:[{kind, code}] }. PENDING (the hub answered and knows this phone, but the
   * person has not confirmed it on the computer) ends the search: the hub identity is proven and the relay would say
   * the same. `skipHome` is for a page the shell has just checked: its first connect goes straight to the relay.
   */
  async function connectBest(deps, rec, o) {
    o = o || {};
    var list = mode().targets(rec), attempts = [];
    if (o.skipHome) list = list.filter(function (t) { return t.kind !== "home"; });
    for (var i = 0; i < list.length; i++) {
      try {
        var tunnel = await connectTarget(deps, rec, list[i]);
        return { kind: list[i].kind, tunnel: tunnel, attempts: attempts };
      } catch (e) {
        attempts.push({ kind: list[i].kind, code: codeOf(e) });
        if (codeOf(e) === "PENDING") break;
      }
    }
    var err = fail(attempts.length ? attempts[attempts.length - 1].code : "UNREACHABLE", "no target answered");
    err.attempts = attempts;
    throw err;
  }

  /** One check of one kind ("home" | "relay") for the shell's launch decision. Never throws: { ok, code }. */
  async function check(deps, rec, kind) {
    var t = mode().targets(rec).filter(function (x) { return x.kind === kind; })[0];
    if (!t) return { ok: false, code: "NO_TARGET" };
    try {
      var tunnel = await connectTarget(deps, rec, t);
      try { tunnel.close(); } catch (e) { /* closing */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, code: codeOf(e) };
    }
  }

  /**
   * Pair through the LAN mailbox first (short cap when a relay exists), then the relay. Only network-type failures
   * fall through to the next target: a wrong key (HANDSHAKE) or a refused/used secret (REFUSED) end it at once, as
   * a wrong key is a warning. Exception: when the HOME attempt ends that way and a relay target remains, the relay is tried
   * (an impostor at the LAN address must not be able to block pairing). `value` is link.js's accepted value.
   * Resolves { sas, device, via }.
   */
  async function pairBest(deps, value, label) {
    var L = link(), bases = [];
    if (value.lan) bases.push({ kind: "home", base: value.lan });
    if (value.relay !== value.lan) bases.push({ kind: "relay", base: value.relay });
    var last = null;
    for (var i = 0; i < bases.length; i++) {
      var b = bases[i], home = b.kind === "home";
      var opts = { link: L.canonicalFor(value, b.base), label: label, timeoutMs: home && bases.length > 1 ? PAIR_HOME_MS : PAIR_MS };
      if (home) opts.fetch = deps.lanFetch(b.base).fetch;
      if (deps.extra) Object.assign(opts, deps.extra);        // tests only (poll timing)
      try {
        var res = await deps.Tunnel.pair(opts);
        res.via = b.kind;
        return res;
      } catch (e) {
        last = e;
        var c = codeOf(e);
        // A bad answer or a refusal from the HOME address proves nothing about the relay: whoever answers at a stored
        // LAN address can say anything. With a relay still to try, try it. Only the last target's verdict is final.
        if (c === "BAD_LINK" || c === "BAD_VERSION" || c === "NO_X25519") break;
        if ((c === "HANDSHAKE" || c === "REFUSED") && !(home && i < bases.length - 1)) break;
      }
    }
    throw last || fail("FAILED", "pairing failed");
  }

  return { connectBest: connectBest, connectTarget: connectTarget, check: check, pairBest: pairBest, HOME_MS: HOME_MS, RELAY_MS: RELAY_MS };
});
