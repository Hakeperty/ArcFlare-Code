// The hub's own tunnel mailbox: the Relay API of TUNNEL.md section 15, served
// from process memory on the hub's LAN listener, so a phone on the same Wi-Fi
// reaches the hub through the SAME Noise tunnel as through arcflare.net, with no
// internet at all (pairing included).
//
// Ported from the website's reference implementation (ArcFlare lib/tunnelRelay.ts,
// memory store). Same endpoints, validation, limits and error codes.
//
// Blind means blind. Frames are opaque base64url strings: checked against a
// character-class regex and a length, stored, forwarded, never decoded, parsed,
// logged or echoed. Tokens are never stored (only their SHA-256) and compared in
// constant time. This file never logs anything.
//
// Differences from the website, all about being a small box on a LAN:
//   * One room only: the hub's own room id. PUT for any other room is 403.
//   * The caller's address is the socket address handed in by server.js, never
//     X-Forwarded-For (a header the client writes).
//   * Extra memory bounds: a byte cap per channel queue and for all channel
//     queues together (oldest frames dropped first, which the protocol detects
//     and survives), bounded failed-auth and rate tables, and a small budget of
//     concurrent requests (total and per address), so a flood against the
//     mailbox cannot starve the hub's web UI. Over budget: 429 + Retry-After.
//   * The hub talks to its own mailbox in-process through `local` (no HTTP hop,
//     no token). The room PUT and the /hub endpoints are NOT served over HTTP
//     (404) unless a test asks for them (`serveHub`): the socket is plain HTTP on
//     a LAN and only ever needs the phone endpoints.

"use strict";

const crypto = require("node:crypto");

// ------------------------------------------------------------------ limits ----

const LIMITS = Object.freeze({
  putBody: 8 * 1024,
  hubPostBody: 3 * 1024 * 1024,
  clientPostBody: 800 * 1024,
  clients: 32,
  hubPostFrames: 64,
  clientPostFrames: 16,
  pollFrames: 256,
  pollReplyBytes: 2_500_000,    // the hub refuses a reply over 3 MB
  maxWaitS: 25,
  hubQueueFrames: 1024,
  hubQueueBytes: 16 * 1024 * 1024,
  chanQueueFrames: 512,
  chanQueueBytes: 8 * 1024 * 1024,   // LAN hardening (not in the API table)
  chanBytesTotal: 32 * 1024 * 1024,  // LAN hardening
  frameAgeMs: 5 * 60_000,
  chanIdleMs: 15 * 60_000,
  roomIdleMs: 30 * 24 * 3600_000,
  hubOnlineMs: 45_000,
  channelsPerToken: 8,
  channelsPerRoom: 64,
  ratePerS: 20,
  rateBurst: 60,
  failedAuthPerMin: 30,
  failTable: 4096,              // LAN hardening
  inflight: 48,                 // LAN hardening: concurrent mailbox requests
  inflightPerIp: 16,
  bodyIdleMs: 8000,
  drainMax: 4 * 1024 * 1024,    // an oversized body is read and discarded up to this much before the 413
  sweepMs: 10_000,
});

/** Exact origins of the app (Capacitor WebView). Never "*". */
const ALLOWED_ORIGINS = new Set(["https://localhost", "capacitor://localhost"]);

const ROOM_RE = /^[A-Za-z0-9_-]{43}$/;
const HUB_TOKEN_RE = /^afth_[A-Za-z0-9_-]{43}$/;
// aftc_ = the one-time pairing token (also valid on the internet relay), aftl_ = the per-device LAN token (this mailbox only).
const CLIENT_TOKEN_RE = /^aft[cl]_[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const CH_RE = /^[A-Za-z0-9_-]{22}$/;
const FRAME_RE = /^[A-Za-z0-9_-]{24,44000}$/;

// ----------------------------------------------------------------- helpers ----

/** H(t) = base64url(SHA-256(UTF-8 t)), no padding. */
const tokenHash = (t) => crypto.createHash("sha256").update(t, "utf8").digest("base64url");

function sameString(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Is `h` on the allowlist right now? Walks the whole list: no early exit. */
function allowed(clients, h, now) {
  let ok = false;
  for (const e of clients) if (sameString(e.h, h) && (e.exp === undefined || e.exp > now)) ok = true;
  return ok;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function intParam(v, def) {
  if (v === null) return def;
  return /^-?\d{1,15}$/.test(v) ? Number(v) : null;
}

function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

function capReply(frames) {
  let bytes = 0;
  const out = [];
  for (const f of frames) {
    bytes += f.c.length + 64;
    if (out.length && bytes > LIMITS.pollReplyBytes) break;
    out.push(f);
  }
  return out;
}

/** Validate an allowlist body. Returns the entries or null. */
function parseAllowlist(j) {
  if (!isObj(j) || j.v !== 1 || !Array.isArray(j.clients) || j.clients.length > LIMITS.clients) return { err: "malformed allowlist" };
  const clients = [];
  for (const e of j.clients) {
    if (!isObj(e) || typeof e.h !== "string" || !HASH_RE.test(e.h)) return { err: "malformed allowlist entry" };
    if (e.exp !== undefined && !(typeof e.exp === "number" && Number.isSafeInteger(e.exp) && e.exp > 0)) return { err: "malformed allowlist expiry" };
    clients.push(e.exp === undefined ? { h: e.h } : { h: e.h, exp: e.exp });
  }
  return { clients };
}

// ----------------------------------------------------------------- mailbox ----

/**
 * @param {object} o
 * @param {string} o.roomId   the hub's own room id (H(hubToken)); the only room served
 * @param {function} [o.now]  clock for stored state (tests)
 * @param {object} [o.limits] overrides (tests)
 * @param {boolean} [o.serveHub] TEST ONLY: also answer the room PUT and the /hub endpoints over HTTP (so this module
 *   can stand in for the internet relay). The hub's own mailbox never sets it: its owner talks to it in-process
 *   through `local`, so over the (plain-HTTP, LAN) socket those paths are 404 and a LAN token can neither rewrite the
 *   allowlist nor read or inject frames.
 */
function createLanRelay(o) {
  if (!o || !ROOM_RE.test(String(o.roomId))) throw new Error("createLanRelay needs the hub's roomId");
  const roomId = o.roomId;
  const now = o.now || Date.now;
  const L = Object.assign({}, LIMITS, o.limits);
  const serveHub = o.serveHub === true;

  let room = null; // { clients, hubSeen, hseq, hubQ, hubBytes, chans, waiters }
  const rate = new Map();   // key -> { tk, ts }
  const fails = new Map();  // ipKey -> { win, n }
  let swept = 0;
  let closed = false;
  let inflight = 0;
  const perIp = new Map();

  const ipKey = (ip) => crypto.createHash("sha256").update("lan-ip\0" + String(ip)).digest("hex").slice(0, 24);

  // ---- store (the memory store of the reference, one room) ----

  const wake = (r) => { for (const w of [...r.waiters]) w(); r.waiters.clear(); };

  function dropChanFrame(c) { c.bytes -= c.q.shift().size; }

  function prune(r, t) {
    while (r.hubQ.length && (r.hubQ[0].t < t - L.frameAgeMs || r.hubQ.length > L.hubQueueFrames || r.hubBytes > L.hubQueueBytes)) {
      r.hubBytes -= r.hubQ.shift().size;
    }
    let total = 0;
    for (const [ch, c] of r.chans) {
      if (c.seen < t - L.chanIdleMs) { r.chans.delete(ch); continue; }
      while (c.q.length && (c.q[0].t < t - L.frameAgeMs || c.q.length > L.chanQueueFrames || c.bytes > L.chanQueueBytes)) dropChanFrame(c);
      total += c.bytes;
    }
    while (total > L.chanBytesTotal) {
      let big = null;
      for (const c of r.chans.values()) if (c.q.length && (!big || c.bytes > big.bytes)) big = c;
      if (!big) break;
      total -= big.q[0].size;
      dropChanFrame(big);
    }
  }

  function sweep(t, force) {
    if (!force && t - swept < L.sweepMs) return;
    swept = t;
    if (room) {
      if (t - room.hubSeen > L.roomIdleMs) { const r = room; room = null; wake(r); } else prune(room, t);
    }
    for (const [k, b] of rate) if (t - b.ts > 10_000) rate.delete(k);
    for (const [k, f] of fails) if (f.win < Math.floor(t / 60_000) - 1) fails.delete(k);
  }

  async function waitUntil(r, ms, signal, ready) {
    const deadline = Date.now() + ms;
    while (!ready() && Date.now() < deadline && !(signal && signal.aborted) && room === r && !closed) {
      await new Promise((resolve) => {
        let t = null;
        const w = () => { clearTimeout(t); if (signal) signal.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { r.waiters.delete(w); w(); };
        t = setTimeout(() => { r.waiters.delete(w); w(); }, Math.max(0, deadline - Date.now()));
        r.waiters.add(w);
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  const store = {
    /** ms to wait before the next request is allowed; 0 = allowed now. */
    rate(key) {
      const t = now();
      sweep(t);
      const b = rate.get(key) || { tk: L.rateBurst, ts: t };
      b.tk = Math.min(L.rateBurst, b.tk + (Math.max(0, t - b.ts) / 1000) * L.ratePerS);
      b.ts = t;
      rate.set(key, b);
      if (b.tk >= 1) { b.tk -= 1; return 0; }
      return Math.ceil(((1 - b.tk) / L.ratePerS) * 1000);
    },
    authBlocked(ip) {
      const f = fails.get(ip);
      return !!f && f.win === Math.floor(now() / 60_000) && f.n >= L.failedAuthPerMin;
    },
    authFailed(ip) {
      const win = Math.floor(now() / 60_000);
      const f = fails.get(ip);
      if (!f || f.win !== win) {
        fails.delete(ip);
        fails.set(ip, { win, n: 1 });
        while (fails.size > L.failTable) fails.delete(fails.keys().next().value);
      } else f.n++;
    },
    putRoom(clients) {
      const t = now();
      sweep(t);
      if (!room) room = { clients, hubSeen: t, hseq: 0, hubQ: [], hubBytes: 0, chans: new Map(), waiters: new Set() };
      const r = room;
      r.clients = clients;
      r.hubSeen = t;
      for (const [ch, c] of r.chans) if (!clients.some((e) => e.h === c.owner)) r.chans.delete(ch);
      wake(r); // pollers re-check the allowlist
    },
    room() { return room ? { clients: room.clients, hubSeen: room.hubSeen } : null; },
    async hubPoll(after, ms, signal) {
      const r = room;
      if (!r) return null;
      r.hubSeen = now();
      const pending = () => { prune(r, now()); return r.hubQ.filter((f) => f.seq > after).slice(0, L.pollFrames); };
      if (!pending().length && ms > 0) await waitUntil(r, ms, signal, () => pending().length > 0);
      if (room !== r) return null;
      r.hubSeen = now();
      return { frames: pending().map(({ seq, ch, c }) => ({ seq, ch, c })), head: r.hseq };
    },
    hubSend(frames) {
      const r = room;
      if (!r) return null;
      const t = now();
      r.hubSeen = t;
      prune(r, t);
      let accepted = 0;
      for (const f of frames) {
        const c = r.chans.get(f.ch);
        if (!c) continue; // unknown (or idle-expired) channel: dropped silently
        c.q.push({ t, seq: ++c.seq, c: f.c, size: f.c.length + 64 });
        c.bytes += f.c.length + 64;
        accepted++;
      }
      prune(r, t);
      wake(r);
      return accepted;
    },
    /** Bind or touch a channel. null = no room. */
    bind(ch, owner, checkOffline) {
      const r = room;
      if (!r) return null;
      const t = now();
      prune(r, t); // also drops channels idle for 15 minutes
      const c = r.chans.get(ch);
      if (c && c.owner !== owner) return "forbidden";
      if (checkOffline && t - r.hubSeen >= L.hubOnlineMs) return "offline";
      if (c) { c.seen = t; return "ok"; }
      let mine = 0;
      for (const x of r.chans.values()) if (x.owner === owner) mine++;
      if (mine >= L.channelsPerToken || r.chans.size >= L.channelsPerRoom) return "limit";
      r.chans.set(ch, { owner, seen: t, seq: 0, q: [], bytes: 0 });
      return "ok";
    },
    clientAppend(ch, frames) {
      const r = room;
      if (!r) return;
      const t = now();
      for (const c of frames) {
        r.hubQ.push({ t, seq: ++r.hseq, ch, c, size: c.length + 80 });
        r.hubBytes += c.length + 80;
      }
      prune(r, t);
      wake(r);
    },
    async clientPoll(owner, ch, after, ms, signal) {
      const first = room;
      if (!first) return { status: "noroom" };
      const look = () => {
        const r = room;
        if (r !== first) return { status: "noroom" };
        const t = now();
        if (!allowed(r.clients, owner, t)) return { status: "revoked" };
        prune(r, t);
        const c = r.chans.get(ch);
        if (c) c.seen = t;
        return {
          status: "ok",
          frames: (c ? c.q : []).filter((f) => f.seq > after).slice(0, L.pollFrames).map(({ seq, c: x }) => ({ seq, c: x })),
          head: c ? c.seq : 0,
          online: t - r.hubSeen < L.hubOnlineMs,
        };
      };
      let res = look();
      if (res.status === "ok" && !res.frames.length && ms > 0) {
        await waitUntil(first, ms, signal, () => { const x = look(); return x.status !== "ok" || x.frames.length > 0; });
        res = look();
      }
      return res;
    },
  };

  // ---- responses ----

  function corsFor(req) {
    const origin = req.headers.origin;
    return origin && ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Retry-After", Vary: "Origin" }
      : { Vary: "Origin" };
  }

  function reply(res, status, body, extra, cors) {
    if (res.headersSent) return;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ "Cache-Control": "no-store" }, cors, extra);
    if (data) { h["Content-Type"] = "application/json; charset=utf-8"; h["Content-Length"] = data.length; }
    res.writeHead(status, h);
    res.end(data || undefined);
  }
  const err = (res, status, msg, extra, cors) => reply(res, status, { error: msg }, extra, cors);
  const tooMany = (res, waitMs, cors) =>
    err(res, 429, "too many requests", { "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))) }, cors);

  /** Reads at most `max` bytes (never trusting Content-Length alone), with an
   * inactivity deadline: a client that promises a body and stalls is dropped.
   * An oversized body is drained (up to L.drainMax past `max`) before the 413:
   * closing a socket with unread data makes Windows send a reset, and the
   * client then sees "connection reset" instead of the answer. */
  function readJson(req, max) {
    return new Promise((resolve) => {
      const bad = (status, msg, close) => resolve({ ok: false, status, msg, close });
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return bad(400, "the body must be application/json");
      const tooBig = { ok: false, status: 413, msg: "the request body is too large", close: true };
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > max + L.drainMax) return resolve(tooBig);
      const chunks = [];
      let total = 0, idle = null, done = false, over = Number.isFinite(declared) && declared > max;
      const finish = (v) => { if (done) return; done = true; clearTimeout(idle); req.removeAllListeners("data"); resolve(v); };
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { finish({ ok: false, status: 408, msg: "the request timed out", close: true }); try { req.socket.destroy(); } catch { /* gone */ } }, L.bodyIdleMs);
      };
      arm();
      req.on("data", (c) => {
        arm();
        total += c.length;
        if (total > max) over = true;
        if (!over) { chunks.push(c); return; }
        chunks.length = 0;
        if (total > max + L.drainMax) { finish(tooBig); try { req.socket.destroy(); } catch { /* gone */ } }
      });
      req.on("end", () => {
        if (over) return finish(tooBig);
        try { finish({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { finish({ ok: false, status: 400, msg: "the body is not valid JSON" }); }
      });
      req.on("error", () => finish({ ok: false, status: 400, msg: "bad request" }));
      req.on("close", () => clearTimeout(idle));
    });
  }

  async function body(req, res, max, cors) {
    const b = await readJson(req, max);
    if (b.ok) return b;
    err(res, b.status, b.msg, b.close ? { Connection: "close" } : {}, cors);
    return null;
  }

  // ---- routes ----

  /** Common hub checks. Returns true if the request may go on. */
  function hubGate(req, res, id, own) {
    if (!ROOM_RE.test(id)) { err(res, 400, "malformed room id"); return false; }
    const ip = req.__ipKey;
    // The token is checked FIRST; the lockout only applies to a token that was presented and is wrong.
    const tok = bearer(req);
    if (!tok) { err(res, 401, "missing or invalid token"); return false; }
    if (!HUB_TOKEN_RE.test(tok) || !sameString(tokenHash(tok), id)) {
      if (store.authBlocked(ip)) { tooMany(res, 60_000 - (now() % 60_000)); return false; }
      store.authFailed(ip);
      err(res, 401, "missing or invalid token");
      return false;
    }
    if (id !== own) {
      // A valid token for a room this hub does not host: one room per hub.
      store.authFailed(ip);
      return "other";
    }
    const wait = store.rate(id);
    if (wait) { tooMany(res, wait); return false; }
    return true;
  }

  async function putRoom(req, res, id) {
    const g = hubGate(req, res, id, roomId);
    if (g === "other") return err(res, 403, "this hub serves only its own room");
    if (!g) return;
    const b = await body(req, res, L.putBody);
    if (!b) return;
    const p = parseAllowlist(b.json);
    if (p.err) return err(res, 400, p.err);
    store.putRoom(p.clients);
    reply(res, 200, { ok: true });
  }

  async function hubPoll(req, res, id, q, signal) {
    const g = hubGate(req, res, id, roomId);
    if (g === "other") return err(res, 404, "unknown room");
    if (!g) return;
    const after = intParam(q.get("after"), 0), wait = intParam(q.get("wait"), 0);
    if (after === null || wait === null) return err(res, 400, "malformed query");
    const out = await store.hubPoll(Math.max(0, after), Math.min(L.maxWaitS, Math.max(0, wait)) * 1000, signal);
    if (!out) return err(res, 404, "unknown room");
    reply(res, 200, Object.assign({}, out, { frames: capReply(out.frames) }));
  }

  async function hubSend(req, res, id) {
    const g = hubGate(req, res, id, roomId);
    if (g === "other") return err(res, 404, "unknown room");
    if (!g) return;
    const b = await body(req, res, L.hubPostBody);
    if (!b) return;
    const j = b.json;
    if (!isObj(j) || !Array.isArray(j.frames) || j.frames.length > L.hubPostFrames) return err(res, 400, "malformed frames");
    const frames = [];
    for (const f of j.frames) {
      if (!isObj(f) || typeof f.ch !== "string" || !CH_RE.test(f.ch) || typeof f.c !== "string" || !FRAME_RE.test(f.c)) return err(res, 400, "malformed frame");
      frames.push({ ch: f.ch, c: f.c });
    }
    const accepted = store.hubSend(frames);
    if (accepted === null) return err(res, 404, "unknown room");
    reply(res, 200, { ok: true, accepted });
  }

  /** Common phone checks. Returns { hash } or null (response sent). */
  function clientGate(req, res, id, cors) {
    if (!ROOM_RE.test(id)) { err(res, 400, "malformed room id", {}, cors); return null; }
    const ip = req.__ipKey;
    // Order matters (a web page or a neighbour can send junk from the phone's own address): 1. no token at all is a
    // plain 401 and counts for nothing, 2. a VALID token is served whatever else this address has sent,
    // 3. only a token that was presented and is wrong feeds (and is answered by) the failed-auth lockout.
    const tok = bearer(req);
    if (!tok) { err(res, 401, "missing or invalid token", {}, cors); return null; }
    const fail = () => {
      if (store.authBlocked(ip)) { tooMany(res, 60_000 - (now() % 60_000), cors); return null; }
      store.authFailed(ip);
      err(res, 401, "missing or invalid token", {}, cors);
      return null;
    };
    if (!CLIENT_TOKEN_RE.test(tok)) return fail();
    const r = id === roomId ? store.room() : null;
    if (!r) { err(res, 404, "unknown room", {}, cors); return null; }
    const hash = tokenHash(tok);
    if (!allowed(r.clients, hash, now())) return fail();
    const wait = store.rate(hash);
    if (wait) { tooMany(res, wait, cors); return null; }
    return { hash };
  }

  /** true if a response was sent for a bind failure. */
  function bindError(res, r, cors) {
    switch (r) {
      case null: err(res, 404, "unknown room", {}, cors); return true;
      case "forbidden": err(res, 403, "that channel belongs to another device", {}, cors); return true;
      case "offline": err(res, 409, "the computer is offline", {}, cors); return true;
      case "limit": err(res, 429, "too many channels", { "Retry-After": "60" }, cors); return true;
      default: return false;
    }
  }

  async function clientPoll(req, res, id, q, signal) {
    const cors = corsFor(req);
    const g = clientGate(req, res, id, cors);
    if (!g) return;
    const ch = q.get("ch");
    const after = intParam(q.get("after"), 0), wait = intParam(q.get("wait"), 0);
    if (ch === null || !CH_RE.test(ch) || after === null || wait === null) return err(res, 400, "malformed query", {}, cors);
    if (bindError(res, store.bind(ch, g.hash, false), cors)) return;
    const out = await store.clientPoll(g.hash, ch, Math.max(0, after), Math.min(L.maxWaitS, Math.max(0, wait)) * 1000, signal);
    if (out.status === "noroom") return err(res, 404, "unknown room", {}, cors);
    if (out.status === "revoked") return err(res, 401, "missing or invalid token", {}, cors);
    reply(res, 200, { frames: capReply(out.frames), online: out.online, head: out.head }, {}, cors);
  }

  async function clientSend(req, res, id) {
    const cors = corsFor(req);
    const g = clientGate(req, res, id, cors);
    if (!g) return;
    const b = await body(req, res, L.clientPostBody, cors);
    if (!b) return;
    const j = b.json;
    if (!isObj(j) || typeof j.ch !== "string" || !CH_RE.test(j.ch) || !Array.isArray(j.frames) || j.frames.length > L.clientPostFrames) {
      return err(res, 400, "malformed frames", {}, cors);
    }
    const frames = [];
    for (const f of j.frames) {
      if (typeof f !== "string" || !FRAME_RE.test(f)) return err(res, 400, "malformed frame", {}, cors);
      frames.push(f);
    }
    // Forbidden, then offline (nothing stored, not even a binding), then limits.
    if (bindError(res, store.bind(j.ch, g.hash, true), cors)) return;
    store.clientAppend(j.ch, frames);
    reply(res, 200, { ok: true }, {}, cors);
  }

  function preflight(req, res) {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return err(res, 403, "origin not allowed");
    const method = req.headers["access-control-request-method"];
    if (method && method !== "GET" && method !== "POST") return err(res, 405, "method not allowed", { Allow: "GET, POST, OPTIONS" });
    const h = {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
    if (req.headers["access-control-request-private-network"] === "true") h["Access-Control-Allow-Private-Network"] = "true";
    res.writeHead(204, h);
    res.end();
  }

  const notAllowed = (req, res, allow, withCors) => err(res, 405, "method not allowed", { Allow: allow }, withCors ? corsFor(req) : undefined);

  async function route(req, res) {
    let u;
    try { u = new URL(req.url, "http://hub.invalid"); } catch { return err(res, 400, "bad request"); }
    const m = /^\/api\/tunnel\/room\/([^/]+)(?:\/(hub|client))?$/.exec(u.pathname);
    if (!m) {
      // Nothing else lives here. No token: 401 like everything in this API. Never counted as an auth failure
      // (any web page can make the phone's address send these; they must not lock the phone out).
      if (!bearer(req)) return err(res, 401, "missing or invalid token");
      return err(res, 404, "not found");
    }
    const id = m[1], part = m[2], method = req.method;
    // The hub side (allowlist PUT, /hub) is in-process only: no token, no failure count, nothing to learn.
    if (!serveHub && part !== "client") return err(res, 404, "not found");
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    if (!part) return method === "PUT" ? putRoom(req, res, id) : notAllowed(req, res, "PUT");
    if (part === "hub") {
      if (method === "GET") return hubPoll(req, res, id, u.searchParams, ac.signal);
      if (method === "POST") return hubSend(req, res, id);
      return notAllowed(req, res, "GET, POST");
    }
    if (method === "GET") return clientPoll(req, res, id, u.searchParams, ac.signal);
    if (method === "POST") return clientSend(req, res, id);
    if (method === "OPTIONS") return preflight(req, res);
    return notAllowed(req, res, "GET, POST, OPTIONS", true);
  }

  /**
   * Serve one request under /api/tunnel/. `ip` is the socket address (server.js
   * passes it; never an X-Forwarded-For value). Never throws.
   */
  async function handle(req, res, ip) {
    const key = String(ip);
    const mine = perIp.get(key) || 0;
    if (closed) return err(res, 503, "the mailbox is closed", { "Retry-After": "5" });
    if (inflight >= L.inflight || mine >= L.inflightPerIp) return tooMany(res, 1000, corsFor(req));
    inflight++;
    perIp.set(key, mine + 1);
    req.__ipKey = ipKey(ip);
    try {
      await route(req, res);
    } catch {
      if (!res.headersSent) err(res, 503, "the tunnel relay store is unavailable", { "Retry-After": "5" });
      else { try { res.destroy(); } catch { /* gone */ } }
    } finally {
      inflight--;
      const n = (perIp.get(key) || 1) - 1;
      if (n > 0) perIp.set(key, n); else perIp.delete(key);
    }
  }

  // ---- in-process side for the hub's own tunnel ----

  const local = {
    roomId,
    /** Replace the allowlist (entries { h, exp? }); creates the room. */
    putRoom(clients) {
      const p = parseAllowlist({ v: 1, clients });
      if (p.err) throw new Error(p.err);
      store.putRoom(p.clients);
    },
    /** The allowlist the mailbox holds right now, as the same JSON the hub compares against ("null" = no room). */
    allowlistSig() {
      return JSON.stringify(room ? room.clients : null);
    },
    /** Frames the phones sent, seq > after: { frames: [{seq,ch,c}], head } or null (no room). */
    hubPoll(after, waitMs, signal) {
      return store.hubPoll(Math.max(0, after | 0), Math.max(0, waitMs), signal);
    },
    /** Frames for phones. Returns how many were accepted, or null (no room). */
    hubSend(frames) {
      const ok = [];
      for (const f of frames) if (f && CH_RE.test(f.ch) && typeof f.c === "string" && FRAME_RE.test(f.c)) ok.push({ ch: f.ch, c: f.c });
      return store.hubSend(ok);
    },
  };

  const timer = setInterval(() => sweep(now(), true), L.sweepMs);
  if (timer.unref) timer.unref();

  function close() {
    closed = true;
    clearInterval(timer);
    if (room) { const r = room; room = null; wake(r); }
    rate.clear();
    fails.clear();
  }

  return {
    handle, local, close, roomId,
    stats: () => ({ inflight, hasRoom: !!room, channels: room ? room.chans.size : 0, hubQueued: room ? room.hubQ.length : 0 }),
    // For tests that must prove the box held no plaintext: everything it holds, as text.
    _dump: () => JSON.stringify(room ? { clients: room.clients, hubQ: room.hubQ, chans: [...room.chans].map(([k, c]) => [k, c.owner, c.q]) } : null),
  };
}

module.exports = { createLanRelay, tokenHash, LIMITS, ALLOWED_ORIGINS };
