"use strict";
// Runs the REAL www/shell.js (with the real link, fingerprint, mode, linkgate, connector, lanfetch and native modules)
// in a vm against the REAL ids of www/index.html (a fake DOM built from it), a fake Capacitor bridge, a fake
// in-memory store and a fake tunnel. A fake clock and fake timers make "1.5 s" and "5 minutes" instant.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const WWW = path.join(__dirname, "..", "www");
const b64u = (b) => Buffer.from(b).toString("base64url");
const key = (n) => b64u(Buffer.alloc(32, n));
const enc = encodeURIComponent;
const LAN = "http://192.168.1.20:8765";
const RELAY = "https://arcflare.net";

/** A pairing link like the hub prints it. lan = null omits l. */
function link({ hk, relay = RELAY, lan = LAN, rm = key(1) } = {}) {
  return `arcflare://pair?v=1&r=${enc(relay)}&rm=${rm}&hk=${hk}&ps=${b64u(crypto.randomBytes(32))}` + (lan ? `&l=${enc(lan)}` : "");
}

function parseHtml() {
  const html = fs.readFileSync(path.join(WWW, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const els = {}, views = [];
  for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*?\bid="([^"]+)"[^>]*)>/g)) {
    const attrs = m[2];
    els[m[3]] = { id: m[3], tag: m[1], hidden: /\bhidden\b/.test(attrs), data: /\bdata-view\b/.test(attrs) };
  }
  return els;
}

function makeEl(spec) {
  const ls = {};
  const el = {
    id: spec.id, hidden: spec.hidden, textContent: "", value: "", scrollTop: 0, dataset: {}, disabled: false,
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    fire(t) { (ls[t] || []).forEach((f) => f({ preventDefault() {} })); },
    /** like a finger: a disabled button does nothing */
    click() { if (!el.disabled) el.fire("click"); },
    /** bypasses `disabled`: the handler's own guard must hold too */
    forceClick() { el.fire("click"); },
  };
  return el;
}

/** opts: tunnel(behave), launchUrl, x25519, store (initial record), hidden */
function makeShell(opts = {}) {
  const specs = parseHtml();
  const els = Object.fromEntries(Object.entries(specs).map(([id, s]) => [id, makeEl(s)]));
  const views = Object.values(specs).filter((s) => s.data).map((s) => els[s.id]);
  const clock = { t: 1_700_000_000_000 };
  let timerId = 0; const timers = [];
  const fakeSetTimeout = (fn, ms) => { timers.push({ id: ++timerId, at: clock.t + (ms || 0), fn }); return timerId; };
  const fakeClearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); };
  const log = [];
  const state = { stored: opts.store || null, appUrl: null, docListeners: {}, appState: null };
  const doc = {
    hidden: !!opts.hidden,
    getElementById: (id) => { if (!els[id]) throw new Error("shell asked for an element that index.html does not have: " + id); return els[id]; },
    querySelectorAll: () => views,
    addEventListener: (t, f) => { (state.docListeners[t] = state.docListeners[t] || []).push(f); },
  };
  const assigned = [];
  const nativeCalls = [];
  const plugin = (name, impl) => impl;
  const ctx = {
    console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Promise, URL, Uint8Array, TextEncoder, TextDecoder, JSON, Object, Error, Math, Number, String, Array, Date: { now: () => clock.t },
    crypto: globalThis.crypto,
    performance: { getEntriesByType: () => [{ type: opts.navType || "navigate" }] },
    navigator: {},
    document: doc,
    location: { assign: (u) => assigned.push(u), search: "" },
    Capacitor: { Plugins: {
      App: {
        getLaunchUrl: async () => (opts.launchUrl ? { url: opts.launchUrl } : {}),
        addListener: (n, f) => { state[n] = f; return Promise.resolve({ remove() {} }); },
      },
      CapacitorHttp: { get: async (o) => { nativeCalls.push(["get", o.url]); throw new Error("offline"); }, post: async (o) => { nativeCalls.push(["post", o.url]); throw new Error("offline"); } },
      CapacitorCookies: { clearAllCookies: async () => { log.push("cookies cleared"); if (opts.cookiesFail) throw new Error("no"); } },
    } },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["config.js", "link.js", "fingerprint.js", "mode.js", "linkgate.js", "lanfetch.js", "connector.js", "native.js"]) {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), "utf8"), ctx, { filename: f });
  }
  ctx.ArcFlareNative.supportsX25519 = async () => opts.x25519 !== false;

  // in-memory store (the real store.js is covered in store.test.js)
  const storeCalls = { save: 0, wipe: 0 };
  ctx.ArcFlareStore = {
    load: async () => state.stored,
    save: async (d, bases) => { storeCalls.save++; log.push("STORE.save hubKey=" + d.hubKey.slice(0, 6)); if (opts.saveFails) throw new Error("disk"); state.stored = Object.assign({}, d, { relay: bases.relay, lan: bases.lan }); },
    wipeAll: async () => { storeCalls.wipe++; if (opts.wipe) return opts.wipe(); state.stored = null; return { ok: true, failed: [] }; },
  };

  // fake tunnel: pair() waits for resolvePair(); connect() asks behave(base)
  const pairs = [], connects = [];
  const tunnel = {
    behave: opts.behave || (() => "ok"),
    pair: (o) => new Promise((res, rej) => {
      const u = new URL(o.link.replace("arcflare://", "https://"));
      const device = { v: 1, relay: u.searchParams.get("r"), room: u.searchParams.get("rm"), hubKey: u.searchParams.get("hk"), deviceId: "AAAAAAAAAAAAAAAAAAAAAA", roomToken: "aftc_" + key(9), label: "x", privateKey: { k: 1 }, publicKey: key(4) };
      pairs.push({ link: o.link, opts: o, resolve: () => res({ sas: "123456", device }), reject: (code) => rej(Object.assign(new Error(code), { code })) });
    }),
    connect: (device, o) => new Promise((res, rej) => {
      const entry = { base: device.relay, hubKey: device.hubKey, opts: o, hasLanFetch: typeof (o && o.fetch) === "function" };
      connects.push(entry);
      const done = () => {
        const b = tunnel.behave(device.relay, entry);
        if (b === "ok") res({ close() { entry.closed = true; } });
        else rej(Object.assign(new Error(b), { code: b }));
      };
      if (opts.holdConnect) entry.release = done; else Promise.resolve().then(done);
    }),
  };
  ctx.ArcFlareTunnel = tunnel;

  const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 3)); };
  const api = {
    els, clock, log, state, assigned, pairs, connects, storeCalls, nativeCalls, tunnel, ctx, tick,
    visible: () => views.filter((v) => !v.hidden).map((v) => v.id).join(","),
    text: (id) => els[id].textContent,
    async advance(ms) {
      clock.t += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= clock.t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      await tick();
    },
    /** a link from outside (QR scan) while the app runs */
    async deepLink(url) { state.appUrlOpen({ url }); await tick(); },
    setHidden(h) { doc.hidden = h; },
    async toForeground() { doc.hidden = false; (state.docListeners.visibilitychange || []).forEach((f) => f()); await tick(); },
    async start() {
      vm.runInContext(fs.readFileSync(path.join(WWW, "shell.js"), "utf8"), ctx, { filename: "shell.js" });
      await tick(10);
    },
  };
  return api;
}

/** A stored pairing the way store.save writes it. */
function pairedRecord(hk, o = {}) {
  return Object.assign({ v: 1, relay: RELAY, room: key(1), hubKey: hk, lan: LAN, deviceId: "AAAAAAAAAAAAAAAAAAAAAA", roomToken: "aftc_" + key(9), label: "Android phone", privateKey: { k: 1 }, publicKey: key(4), pairedAt: 1 }, o);
}

module.exports = { makeShell, link, key, pairedRecord, LAN, RELAY };
