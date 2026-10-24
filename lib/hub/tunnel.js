// The relay tunnel: reach the hub from outside the house through arcflare.net
// without the relay being able to read, forge or replay anything.
//
// The normative description is TUNNEL.md next to this file; this comment is the
// map, not the contract.
//
// The hub keeps one long-term X25519 key. A phone learns its public half from a
// QR code shown at the computer, so there is no trust-on-first-use: a relay that
// answers with any other key fails the handshake. Pairing (Noise IKpsk1) proves
// the phone holds the one-time pairing secret from that QR and registers the
// phone's own long-term X25519 key; the person at the computer then confirms a
// six-digit code both screens show. Every later connection is Noise KK: both
// static keys known in advance, fresh ephemeral keys each time (forward
// secrecy), one AES-256-GCM key per direction, and a strict counter per
// direction as the nonce. A frame whose counter is lower than expected is a
// duplicate and is dropped; higher means one went missing and the session ends.
//
// Inside the tunnel travel ordinary HTTP-shaped requests. They are fed to the
// hub's existing request handler in-process (server.dispatchTunnel), so login,
// session cookies, CSRF and lockout all still apply. Two things differ, both
// set here and never from anything the phone sends: the private-address gate is
// skipped because the request did not come from a socket, and the login
// lockout is keyed on the paired device's id. The session cookie never leaves
// this process: Set-Cookie is caught into a per-device jar here and replayed on
// that device's later requests, so the phone (and the relay) never hold it.
//
// The relay sees opaque frames, a room id, a per-tunnel channel id and bearer
// tokens that open the mailbox and nothing else. It stores only SHA-256 hashes
// of those tokens.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");

// ------------------------------------------------------------- constants ----

const VERSION = 1;
const NAME_KK = "Noise_KK_25519_AESGCM_SHA256";
const NAME_PAIR = "Noise_IKpsk1_25519_AESGCM_SHA256";
const PROLOGUE_LABEL = "ArcFlare-Tunnel/1";
const SAS_LABEL = "ArcFlare-Tunnel SAS";
const T = Object.freeze({ HS1: 1, HS2: 2, DATA: 3, RESET: 4 });
const MODE = Object.freeze({ KK: 1, PAIR: 2 });
const DATA_HEADER = 26; // ver, type, sid(16), n(8)

const LIMITS = Object.freeze({
  frameBytes: 32 * 1024 + 128,   // one decoded frame
  frameChars: 44000,             // its base64url text (the relay's limit too)
  plaintext: 24 * 1024,          // one decrypted message, padding included
  chunk: 12 * 1024,              // raw body bytes per body/data message
  pad: 256,                      // plaintext is padded to a multiple of this
  reqBody: 128 * 1024,           // whole request body (the handler caps at 64 KiB)
  reqsPerSession: 16,
  sessionsPerDevice: 4,
  sessions: 64,
  devices: 16,
  pendingPairings: 4,
  clockSkewMs: 10 * 60 * 1000,
  pairTtlMs: 10 * 60 * 1000,
  approveTtlMs: 15 * 60 * 1000,
  sessionMaxMs: 24 * 60 * 60 * 1000,
  sessionIdleMs: 30 * 60 * 1000,
  rekeyFrames: 1024,
  rekeyMs: 10 * 60 * 1000,
  maxCounter: 2 ** 48,
  outboxBytes: 8 * 1024 * 1024,
  outboxFrames: 4096,            // the outbox is capped by count as well as bytes
  pendingSessions: 128,          // handshaken, not yet proven by a first DATA frame
  pendingSessionMs: 2 * 60 * 1000,
  resetsPerSecond: 10,           // RESETs for unknown sessions, all channels together
  relayReplyBytes: 3 * 1024 * 1024,
  relayFramesPerPoll: 256,
  batchFrames: 64,
  handshakesPerMinute: 60,
  pairFailures: 5,
  pairGraceMs: 2 * 60 * 1000,
});

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQ_HEADERS = ["content-type", "accept", "x-csrf-token", "last-event-id"];
const RES_HEADERS = ["content-type", "retry-after", "cache-control"];
const CLIENT_TOKEN_RE = /^aftc_[A-Za-z0-9_-]{43}$/;
const HUB_TOKEN_RE = /^afth_[A-Za-z0-9_-]{43}$/;

// -------------------------------------------------------------- encoding ----

const b64u = (b) => Buffer.from(b).toString("base64url");

/** Strict base64url: canonical text only, optional exact length. */
function unb64u(s, len) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  if (b64u(b) !== s) return null;
  if (len !== undefined && b.length !== len) return null;
  return b;
}

function sha256(...parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function hmac(key, ...parts) {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** HKDF-Expand(PRK=secret, info=label, L=32): one HMAC block. */
function kdf(secret, label) {
  return hmac(secret, Buffer.from(label, "utf8"), Buffer.from([1]));
}

/** Noise HKDF(ck, ikm, n) == RFC 5869 HKDF with salt=ck, info="" (n*32 bytes). */
function hkdf(ck, ikm, n) {
  const temp = hmac(ck, ikm);
  const out = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    prev = hmac(temp, prev, Buffer.from([i]));
    out.push(prev);
  }
  return out;
}

/** What the relay stores and compares: base64url(SHA-256(token as UTF-8)). */
function tokenHash(token) {
  return b64u(sha256(Buffer.from(String(token), "utf8")));
}

const MAX_NONCE = (1n << 64n) - 1n;

function nonce(n) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64BE(BigInt(n), 4);
  return b;
}

function aeadSeal(k, n, ad, pt) {
  const c = crypto.createCipheriv("aes-256-gcm", k, nonce(n), { authTagLength: 16 });
  c.setAAD(ad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

function aeadOpen(k, n, ad, ct) {
  if (ct.length < 16) throw tunnelError("AEAD", "short ciphertext");
  const d = crypto.createDecipheriv("aes-256-gcm", k, nonce(n), { authTagLength: 16 });
  d.setAAD(ad);
  d.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw tunnelError("AEAD", "authentication failed");
  }
}

/** Noise REKEY(k): the first 32 bytes of ENCRYPT(k, 2^64-1, "", 32 zero bytes). */
function rekeyKey(k) {
  return aeadSeal(k, MAX_NONCE, Buffer.alloc(0), Buffer.alloc(32)).subarray(0, 32);
}

function tunnelError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** JSON, then ASCII spaces up to a multiple of LIMITS.pad. */
function encodeMessage(obj) {
  const raw = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Math.ceil((raw.length + 1) / LIMITS.pad) * LIMITS.pad;
  if (len > LIMITS.plaintext) throw tunnelError("TOO_BIG", "message too large");
  const out = Buffer.alloc(len, 0x20);
  raw.copy(out);
  return out;
}

function decodeMessage(buf) {
  if (buf.length > LIMITS.plaintext) throw tunnelError("TOO_BIG", "message too large");
  const v = JSON.parse(buf.toString("utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.t !== "string") throw tunnelError("BAD_MESSAGE", "bad message");
  return v;
}

// ---------------------------------------------------------------- x25519 ----

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function x25519Generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    priv: privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_X25519.length),
    pub: publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length),
  };
}

function x25519Public(privRaw) {
  const k = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privRaw]), format: "der", type: "pkcs8" });
  return crypto.createPublicKey(k).export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
}

/** X25519, refusing low-order points (an all-zero shared secret). */
function dh(privRaw, pubRaw) {
  if (!Buffer.isBuffer(pubRaw) || pubRaw.length !== 32 || privRaw.length !== 32) throw tunnelError("DH", "bad key");
  let out;
  try {
    out = crypto.diffieHellman({
      privateKey: crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privRaw]), format: "der", type: "pkcs8" }),
      publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, pubRaw]), format: "der", type: "spki" }),
    });
  } catch {
    throw tunnelError("DH", "bad public key");
  }
  if (out.every((x) => x === 0)) throw tunnelError("DH", "low-order public key");
  return out;
}

// ----------------------------------------------------------------- noise ----

class SymmetricState {
  constructor(name) {
    const nb = Buffer.from(name, "ascii");
    let h;
    if (nb.length <= 32) { h = Buffer.alloc(32); nb.copy(h); } else h = sha256(nb);
    this.h = h;
    this.ck = h;
    this.k = null;
    this.n = 0;
  }
  mixHash(data) { this.h = sha256(this.h, data); }
  mixKey(ikm) { const [ck, k] = hkdf(this.ck, ikm, 2); this.ck = ck; this.k = k; this.n = 0; }
  mixKeyAndHash(ikm) {
    const [ck, th, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(th);
    this.k = k;
    this.n = 0;
  }
  encryptAndHash(pt) {
    const ct = this.k ? aeadSeal(this.k, this.n++, this.h, pt) : Buffer.from(pt);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct) {
    const pt = this.k ? aeadOpen(this.k, this.n++, this.h, ct) : Buffer.from(ct);
    this.mixHash(ct);
    return pt;
  }
  split() { return hkdf(this.ck, Buffer.alloc(0), 2); }
}

/** One direction of a transport session. */
class CipherState {
  constructor(k, now = Date.now()) {
    this.k = k;
    this.n = 0;
    this.sinceRekey = 0;
    this.rekeyedAt = now;
  }
  rekey(now = Date.now()) { this.k = rekeyKey(this.k); this.sinceRekey = 0; this.rekeyedAt = now; }
}

function prologue(mode, roomRaw, idField, sid) {
  return Buffer.concat([Buffer.from(PROLOGUE_LABEL, "ascii"), Buffer.from([0, VERSION, mode]), roomRaw, idField, sid]);
}

function sasFromHash(h) {
  const d = sha256(Buffer.from(SAS_LABEL, "ascii"), h);
  return String(d.readUInt32BE(0) % 1000000).padStart(6, "0");
}

// ---------------------------------------------------------------- frames ----

function parseFrame(buf) {
  if (!buf || buf.length < 18 || buf.length > LIMITS.frameBytes || buf[0] !== VERSION) return null;
  const type = buf[1];
  if (type === T.HS1) {
    if (buf.length < 67 + 16) return null;
    const mode = buf[2];
    if (mode !== MODE.KK && mode !== MODE.PAIR) return null;
    return { type, mode, sid: buf.subarray(3, 19), idField: buf.subarray(19, 35), e: buf.subarray(35, 67), body: buf.subarray(67) };
  }
  if (type === T.HS2) {
    if (buf.length < 50 + 16) return null;
    return { type, sid: buf.subarray(2, 18), e: buf.subarray(18, 50), body: buf.subarray(50) };
  }
  if (type === T.DATA) {
    if (buf.length < DATA_HEADER + 16) return null;
    const n = buf.readBigUInt64BE(18);
    if (n >= BigInt(LIMITS.maxCounter)) return null;
    return { type, sid: buf.subarray(2, 18), n: Number(n), ad: buf.subarray(0, DATA_HEADER), body: buf.subarray(DATA_HEADER) };
  }
  if (type === T.RESET) {
    if (buf.length !== 18) return null;
    return { type, sid: buf.subarray(2, 18) };
  }
  return null;
}

function dataHeader(sid, n) {
  const h = Buffer.alloc(DATA_HEADER);
  h[0] = VERSION;
  h[1] = T.DATA;
  sid.copy(h, 2);
  h.writeBigUInt64BE(BigInt(n), 18);
  return h;
}

// --------------------------------------------------------------- storage ----

/**
 * A label a phone chose, made safe to store and to print on a terminal:
 * printable characters only. Control characters (C0, DEL, C1), format
 * characters (bidi overrides and isolates, zero-width, BOM), line/paragraph
 * separators, unassigned and private-use code points are removed; other
 * spaces become one plain space; at most 60 characters.
 */
function sanitizeLabel(v, fallback = "phone") {
  let s = typeof v === "string" ? v : "";
  s = s.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "").replace(/\p{Zs}+/gu, " ").trim();
  s = Array.from(s).slice(0, 60).join("").trim();
  return s || fallback;
}

/**
 * Read a state file. Missing is null; present but unreadable or damaged THROWS
 * (code CORRUPT): the callers must never treat a damaged file as empty, or the
 * next write would destroy what is left of it (and silently unpair every phone).
 */
function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw tunnelError("CORRUPT", `${file} cannot be read (${e.code || e.message}); the tunnel will not start until that is fixed`);
  }
  let v;
  try { v = JSON.parse(text); } catch { v = undefined; }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw tunnelError("CORRUPT", `${file} is damaged (not valid JSON). The tunnel will not start and nothing was overwritten. Restore it from a backup, or delete it only if you accept the consequences (tunnel-key.json: every phone must be paired again).`);
  }
  return v;
}

/** Write atomically and durably: temp file, fsync, rename. */
function writeJsonFile(dir, file, data) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: ACLs, not modes */ }
  fs.renameSync(tmp, file);
}

const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 5 * 1000;

/**
 * Run fn() holding <file>.lock (created with O_EXCL), so the hub and the CLI
 * cannot lose each other's updates. A lock older than LOCK_STALE_MS belongs to
 * a process that died and is taken over. Synchronous: the store is.
 */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const end = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, "wx", 0o600); break; } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
    } catch { continue; /* it was just released: try again */ }
    if (Date.now() > end) throw tunnelError("LOCKED", `${lock} is held by another process`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  try {
    try { fs.writeSync(fd, String(process.pid)); } catch { /* informational */ }
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function stamp(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; }
}

/**
 * Everything the tunnel keeps on disk, under <home>/hub:
 *   tunnel-key.json  hub static X25519 key + room secret        (0600, secret)
 *   devices.json     paired devices: public key, token hash     (0600, no secrets)
 *   pairing.json     pending pairings: psk, token hash, expiry  (0600, ≤10 min)
 * Both the CLI and the running hub write these; every write takes a lock
 * (<file>.lock), re-reads, and replaces the file atomically (fsync, rename).
 * A file that exists but is damaged is never treated as empty or regenerated:
 * the tunnel refuses to start (CORRUPT) and the file is left for the owner.
 */
class TunnelStore {
  constructor({ dir, now = Date.now } = {}) {
    if (!dir) throw new Error("TunnelStore needs a dir");
    this.dir = dir;
    this.now = now;
    this.keyFile = path.join(dir, "tunnel-key.json");
    this.devFile = path.join(dir, "devices.json");
    this.pairFile = path.join(dir, "pairing.json");
  }

  hasKeys() { return !!this._loadKeys(); }

  /** null only when there is no key file; a damaged one throws (never regenerated). */
  _loadKeys() {
    const k = readJsonFile(this.keyFile);
    if (!k) return null;
    const priv = k.v === 1 ? unb64u(k.hubPriv, 32) : null, secret = k.v === 1 ? unb64u(k.roomSecret, 32) : null;
    if (!priv || !secret) throw tunnelError("CORRUPT", `${this.keyFile} is damaged (unknown format). The tunnel will not start and the file was left alone; restore it from a backup.`);
    return { priv, pub: x25519Public(priv), roomSecret: secret };
  }

  /** Throws CORRUPT if any state file exists but is damaged. */
  check() {
    this._loadKeys();
    this._devices();
    this._pairings();
  }

  /** The hub's keys, made on first use. Rotating = deleting the file (unpairs everyone). */
  keys() {
    let k = this._loadKeys();
    if (k) return k;
    const kp = x25519Generate();
    const roomSecret = crypto.randomBytes(32);
    writeJsonFile(this.dir, this.keyFile, {
      v: 1, hubPriv: b64u(kp.priv), hubPub: b64u(kp.pub), roomSecret: b64u(roomSecret), created: this.now(),
    });
    k = this._loadKeys();
    if (!k) throw new Error("could not write tunnel-key.json");
    return k;
  }

  /** Derived identifiers: hub token, room id, room raw bytes. */
  room() {
    const k = this.keys();
    const hubToken = "afth_" + b64u(kdf(k.roomSecret, "arcflare-tunnel hub-token"));
    const roomRaw = sha256(Buffer.from(hubToken, "utf8"));
    return { hubToken, roomId: b64u(roomRaw), roomRaw, hubPub: k.pub, hubPriv: k.priv };
  }

  // ---- devices ----

  /** Parsed devices.json (missing = none; damaged throws). Expired pending ones are dropped from the copy. */
  _devices() {
    const d = readJsonFile(this.devFile);
    if (d && (d.v !== 1 || !d.devices || typeof d.devices !== "object" || Array.isArray(d.devices))) {
      throw tunnelError("CORRUPT", `${this.devFile} is damaged (unknown format). The tunnel will not start and the file was left alone.`);
    }
    const devices = d ? d.devices : {};
    const t = this.now();
    let pruned = false;
    for (const [id, dev] of Object.entries(devices)) {
      if (!dev || typeof dev !== "object") { delete devices[id]; pruned = true; continue; }
      if (!dev.approved && t - (dev.pairedAt || 0) > LIMITS.approveTtlMs) { delete devices[id]; pruned = true; }
    }
    return { v: 1, devices, pruned };
  }

  devicesStamp() { return `${stamp(this.devFile)}|${stamp(this.pairFile)}`; }

  /** Live devices; pending ones past the approval window are dropped (and the file is rewritten without them). */
  devices() {
    const data = this._devices();
    if (data.pruned) this._mutateDevices(() => {});
    return data.devices;
  }

  listDevices() {
    return Object.values(this.devices()).map((d) => ({
      id: d.id, label: sanitizeLabel(d.label), approved: !!d.approved, pairedAt: d.pairedAt, lastSeen: d.lastSeen || null,
      sas: d.approved ? undefined : d.sas, pairing: d.approved ? undefined : d.pairing,
    }));
  }

  /** Read-modify-write under a cross-process lock, so the hub and the CLI cannot lose each other's updates. */
  _mutateDevices(fn) {
    return withLock(this.devFile, () => {
      const data = this._devices();
      const r = fn(data.devices);
      writeJsonFile(this.dir, this.devFile, { v: 1, devices: data.devices });
      return r;
    });
  }

  addDevice(rec) {
    return this._mutateDevices((devs) => {
      if (Object.keys(devs).length >= LIMITS.devices) throw tunnelError("FULL", "too many paired devices");
      devs[rec.id] = rec;
      return rec;
    });
  }

  approve(id) {
    return this._mutateDevices((devs) => {
      const d = devs[id];
      if (!d) return false;
      d.approved = true;
      d.approvedAt = this.now();
      delete d.sas;
      delete d.pairing;
      return true;
    });
  }

  /** Remove a device (revoke, or reject a pending one). True if it existed. */
  revoke(id) {
    return this._mutateDevices((devs) => {
      if (!Object.prototype.hasOwnProperty.call(devs, id)) return false;
      delete devs[id];
      return true;
    });
  }

  touch(id, t) {
    this._mutateDevices((devs) => { if (devs[id]) devs[id].lastSeen = t; });
  }

  // ---- pairings ----

  _pairings() {
    const d = readJsonFile(this.pairFile);
    if (d && (d.v !== 1 || !d.pairings || typeof d.pairings !== "object" || Array.isArray(d.pairings))) {
      throw tunnelError("CORRUPT", `${this.pairFile} is damaged (unknown format). The tunnel will not start and the file was left alone.`);
    }
    const pairings = d ? d.pairings : {};
    const t = this.now();
    let pruned = false;
    for (const [pid, p] of Object.entries(pairings)) {
      if (!p || typeof p !== "object" || !(this._mailboxUntil(p) > t)) { delete pairings[pid]; pruned = true; }
    }
    return { v: 1, pairings, pruned };
  }

  /** Read-modify-write of pairing.json under the lock. fn gets the pairings map; it may return {write:false}. */
  _mutatePairings(fn) {
    return withLock(this.pairFile, () => {
      const data = this._pairings();
      const r = fn(data.pairings);
      writeJsonFile(this.dir, this.pairFile, { v: 1, pairings: data.pairings });
      return r;
    });
  }

  /**
   * How long the relay should accept this pairing's token. A used pairing
   * keeps it for a short grace so the phone can collect the hub's reply on
   * the same channel; it can never be used for a handshake again.
   */
  _mailboxUntil(p) {
    return p.used ? Math.min(p.expires, p.used + LIMITS.pairGraceMs) : p.expires;
  }

  /** Pairings the relay should still accept tokens for: {pid: {tokenHash, until}}. */
  pendingPairings() {
    const out = {};
    const data = this._pairings();
    // Write the pruned file back: an expired psk must not stay on disk.
    if (data.pruned) this._mutatePairings(() => {});
    for (const [pid, p] of Object.entries(data.pairings)) out[pid] = { tokenHash: p.tokenHash, expires: this._mailboxUntil(p), used: !!p.used };
    return out;
  }

  /** A fresh one-time pairing secret. Only derived values are written. */
  createPairing({ ttlMs = LIMITS.pairTtlMs } = {}) {
    this.keys();
    const secret = crypto.randomBytes(32);
    const d = derivePairing(secret);
    const expires = this.now() + Math.min(ttlMs, LIMITS.pairTtlMs);
    this._mutatePairings((pairings) => {
      const ids = Object.keys(pairings).filter((id) => !pairings[id].used);
      while (ids.length >= LIMITS.pendingPairings) delete pairings[ids.shift()];
      pairings[d.pid] = { psk: b64u(d.psk), tokenHash: tokenHash(d.pairToken), created: this.now(), expires, fails: 0 };
    });
    return { secret: b64u(secret), pid: d.pid, expires };
  }

  /** Consume a pending pairing (one-time use): its psk is erased, never usable again. */
  takePairing(pid) {
    return this._mutatePairings((pairings) => {
      const p = pairings[pid];
      if (!p || p.used) return null;
      pairings[pid] = { tokenHash: p.tokenHash, created: p.created, expires: p.expires, used: this.now() };
      return p;
    });
  }

  peekPairing(pid) {
    const p = this._pairings().pairings[pid];
    return p && !p.used ? p : null;
  }

  failPairing(pid) {
    this._mutatePairings((pairings) => {
      const p = pairings[pid];
      if (!p || p.used) return;
      p.fails = (p.fails || 0) + 1;
      if (p.fails >= LIMITS.pairFailures) delete pairings[pid];
    });
  }

  cancelPairings() {
    withLock(this.pairFile, () => writeJsonFile(this.dir, this.pairFile, { v: 1, pairings: {} }));
  }
}

function derivePairing(secret) {
  return {
    pid: b64u(kdf(secret, "arcflare-tunnel pair-id").subarray(0, 16)),
    psk: kdf(secret, "arcflare-tunnel pair-psk"),
    pairToken: "aftc_" + b64u(kdf(secret, "arcflare-tunnel pair-token")),
  };
}

/** The QR payload. A custom scheme, so no web page (the relay's included) ever sees it. */
function pairingLink({ relay, roomId, hubPub, secret, lan }) {
  const q = [`v=${VERSION}`, `r=${encodeURIComponent(relay)}`, `rm=${roomId}`, `hk=${b64u(hubPub)}`, `ps=${secret}`];
  if (lan) q.push(`l=${encodeURIComponent(lan)}`);
  return `arcflare://pair?${q.join("&")}`;
}

/** https only, except loopback for development. */
function checkRelayUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  const loop = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) throw new Error("the relay must be https://");
  if (u.username || u.password || u.search || u.hash) throw new Error("the relay URL must be a plain origin and path");
  return u.toString().replace(/\/+$/, "");
}

// ------------------------------------------------------- request bridging ----

/** A request object the hub handler can consume; built only by this file. */
class TunnelRequest extends Readable {
  constructor({ method, url, headers, body }) {
    super({ read() {}, emitClose: false, autoDestroy: false });
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.rawHeaders = [];
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = true;
    const noop = () => {};
    // remoteAddress is undefined: if this object ever reached the handler
    // without the tunnel mark, the private-address gate would refuse it.
    this.socket = this.connection = {
      remoteAddress: undefined, remotePort: undefined, encrypted: false,
      setTimeout: noop, setNoDelay: noop, setKeepAlive: noop, destroy: noop,
    };
    if (body && body.length) this.push(body);
    this.push(null);
  }
}

/** The subset of http.ServerResponse that server.js uses, streaming into a sink. */
class TunnelResponse extends EventEmitter {
  constructor(sink) {
    super();
    this._sink = sink;
    this._h = new Map();
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.finished = false;
    this.destroyed = false;
    this._closed = false;
  }
  setHeader(k, v) { if (!this.headersSent) this._h.set(String(k).toLowerCase(), v); return this; }
  getHeader(k) { return this._h.get(String(k).toLowerCase()); }
  hasHeader(k) { return this._h.has(String(k).toLowerCase()); }
  removeHeader(k) { this._h.delete(String(k).toLowerCase()); }
  getHeaders() { return Object.fromEntries(this._h); }
  get writableLength() { return this._sink.backlog(); }
  writeHead(status, a, b) {
    const headers = a && typeof a === "object" ? a : b;
    this.statusCode = status;
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this._head();
    return this;
  }
  _head() {
    if (this.headersSent || this.destroyed) return;
    this.headersSent = true;
    this._sink.head(this.statusCode, Object.fromEntries(this._h));
  }
  write(chunk, enc) {
    if (this.writableEnded || this.destroyed) return false;
    this._head();
    if (chunk !== undefined && chunk !== null) this._sink.data(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === "string" ? enc : "utf8"));
    return true;
  }
  end(chunk, enc) {
    if (typeof chunk === "function") chunk = undefined;
    if (this.writableEnded || this.destroyed) return this;
    if (chunk !== undefined && chunk !== null) this.write(chunk, enc); else this._head();
    this.writableEnded = true;
    this.finished = true;
    this._sink.end();
    this.emit("finish");
    this._close();
    return this;
  }
  destroy() {
    if (this.destroyed) return this;
    const wasOpen = !this.writableEnded;
    this.destroyed = true;
    this.writableEnded = true;
    if (wasOpen) this._sink.abort();
    this._close();
    return this;
  }
  /** The phone cancelled, or the session died: stop quietly. */
  _cancel() {
    this.destroyed = true;
    this.writableEnded = true;
    this._close();
  }
  _close() {
    if (this._closed) return;
    this._closed = true;
    process.nextTick(() => this.emit("close"));
  }
}

function parseSetCookie(v) {
  const first = String(v).split(";")[0];
  const i = first.indexOf("=");
  if (i < 1) return null;
  const name = first.slice(0, i).trim(), value = first.slice(i + 1).trim();
  const cleared = !value || /;\s*max-age=0\b/i.test(String(v));
  return { name, value, cleared };
}

// ------------------------------------------------------------------- hub ----

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * The hub's half of the tunnel.
 *
 * Inbound frames arrive through receive(ch, c) — from the relay poll loop, or
 * straight from a test. Outbound frames go through the relay outbox.
 */
class HubTunnel extends EventEmitter {
  /**
   * @param {object} o
   * @param {TunnelStore} o.store
   * @param {string} [o.relay]           relay base URL (required for start())
   * @param {function} o.dispatch        (req, res, {deviceId}) => void — server.dispatchTunnel
   * @param {object} [o.auth]            AuthStore, to end jar sessions on revoke
   * @param {function} [o.fetch]
   * @param {function} [o.log]
   * @param {object} [o.limits]          overrides for LIMITS (tests)
   * @param {number} [o.pollWaitSec]     relay long-poll wait
   */
  constructor(o) {
    super();
    this.store = o.store;
    this.relay = o.relay ? checkRelayUrl(o.relay) : null;
    this.dispatch = o.dispatch;
    this.auth = o.auth || null;
    this.fetch = o.fetch || globalThis.fetch;
    this.log = o.log || (() => {});
    this.limits = Object.assign({}, LIMITS, o.limits);
    this.pollWaitSec = o.pollWaitSec || 25;
    this.now = o.now || Date.now;
    this.store.check();          // a damaged state file throws here: no tunnel, nothing overwritten
    this.room = this.store.room();
    this.sessions = new Map();   // sid b64u -> session
    this.jar = new Map();        // deviceId -> {name, value}
    this.seenE = new Map();      // ephemeral key b64u -> expiry
    this.hsTimes = [];
    this.resetSent = new Map();
    this.resetTokens = this.limits.resetsPerSecond;
    this.resetRefilled = this.now();
    this.pending = new Map();    // sid b64u -> handshaken session not yet proven by a DATA frame
    this.outbox = [];            // {seq, ch, c, type}, in seq order
    this.outBytes = 0;           // always the sum of c.length over outbox
    this.outData = 0;            // how many outbox entries are DATA
    this.outSeq = 0;
    this.active = false;
    this.connected = false;
    this.after = 0;
    this._devStamp = null;
    this._devices = {};
    this._allow = null;
    this._flushing = null;
    this._abort = null;
    this._reload(true);
    this._ready = true;
  }

  // ---------------------------------------------------------- devices ----

  /** Pick up CLI changes (pair, approve, revoke). Cuts off removed devices. */
  _reload(force) {
    const st = this.store.devicesStamp();
    if (!force && st === this._devStamp) return false;
    const before = this._devices;
    try {
      this._devices = this.store.devices();
    } catch (e) {
      if (force && !this._ready) throw e;     // at construction: refuse to start
      this._devices = {};                      // later: fail closed, keep the file as it is
      this.log(`tunnel: ${e.message}`);
    }
    this._devStamp = this.store.devicesStamp();
    for (const id of Object.keys(before)) {
      const now = this._devices[id];
      if (!now || (before[id].approved && !now.approved) || now.pub !== before[id].pub) this._cutOff(id);
    }
    for (const [id, d] of Object.entries(this._devices)) {
      if (!d.approved) for (const s of [...this.sessions.values(), ...this.pending.values()]) if (s.deviceId === id) this._kill(s, "device not approved");
    }
    return true;
  }

  /** A device is gone: end its sessions, sign its jar session out. */
  _cutOff(id) {
    for (const s of [...this.sessions.values(), ...this.pending.values()]) if (s.deviceId === id) this._kill(s, "device revoked", true);
    const j = this.jar.get(id);
    this.jar.delete(id);
    if (j && this.auth && typeof this.auth.logout === "function") {
      try { this.auth.logout(j.value); } catch { /* best effort */ }
    }
    this.emit("revoked", id);
  }

  /** Revoke from inside the hub process (and on disk). */
  revokeDevice(id) {
    const had = this.store.revoke(id);
    this._reload(true);
    if (had) this._cutOff(id);
    this._syncRoom().catch(() => {});
    return had;
  }

  /** Token hashes the relay should accept from clients. */
  _allowlist() {
    const clients = [];
    for (const d of Object.values(this._devices)) if (d.tokenHash) clients.push({ h: d.tokenHash });
    for (const p of Object.values(this.store.pendingPairings())) clients.push({ h: p.tokenHash, exp: p.expires });
    return clients;
  }

  // ------------------------------------------------------------ inbound ----

  /** Handle one frame from the relay. Never throws; bad frames are dropped. */
  receive(ch, c) {
    try {
      if (typeof ch !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(ch)) return;
      if (typeof c !== "string" || c.length > this.limits.frameChars) return;
      const buf = unb64u(c);
      const f = buf && parseFrame(buf);
      if (!f) return;
      if (f.type === T.HS1) return this._handshake(ch, f);
      if (f.type === T.DATA) return this._data(ch, f);
      // HS2 and RESET only ever travel hub -> phone.
    } catch (e) {
      this.log(`tunnel: dropped frame (${e.code || e.message})`);
    }
  }

  _rateOk() {
    const t = this.now();
    this.hsTimes = this.hsTimes.filter((x) => t - x < 60000);
    if (this.hsTimes.length >= this.limits.handshakesPerMinute) return false;
    this.hsTimes.push(t);
    return true;
  }

  _freshEphemeral(e) {
    const t = this.now();
    for (const [k, exp] of this.seenE) if (exp < t) this.seenE.delete(k); else break;
    const key = b64u(e);
    if (this.seenE.has(key)) return false;
    this.seenE.set(key, t + 2 * this.limits.clockSkewMs);
    if (this.seenE.size > 10000) this.seenE.delete(this.seenE.keys().next().value);
    return true;
  }

  _checkTs(payload) {
    return payload && Number.isFinite(payload.ts) && Math.abs(payload.ts - this.now()) <= this.limits.clockSkewMs;
  }

  _handshake(ch, f) {
    if (!this._rateOk()) return;
    if (this.sessions.has(b64u(f.sid)) || this.pending.has(b64u(f.sid))) return;
    if (!this._freshEphemeral(f.e)) return;
    this._reload(false);
    if (f.mode === MODE.KK) return this._handshakeKK(ch, f);
    return this._handshakePair(ch, f);
  }

  _handshakeKK(ch, f) {
    const deviceId = b64u(f.idField);
    const dev = Object.prototype.hasOwnProperty.call(this._devices, deviceId) ? this._devices[deviceId] : null;
    if (!dev) return;
    const devPub = unb64u(dev.pub, 32);
    if (!devPub) return;
    const { hubPub, hubPriv, roomRaw } = this.room;

    const ss = new SymmetricState(NAME_KK);
    ss.mixHash(prologue(MODE.KK, roomRaw, f.idField, f.sid));
    ss.mixHash(devPub);
    ss.mixHash(hubPub);
    ss.mixHash(f.e);
    ss.mixKey(dh(hubPriv, f.e));        // es
    ss.mixKey(dh(hubPriv, devPub));     // ss
    let payload;
    try { payload = decodeMessage(ss.decryptAndHash(f.body)); } catch { return; }
    if (payload.t !== "hello" || !this._checkTs(payload)) return;

    const eh = x25519Generate();
    ss.mixHash(eh.pub);
    ss.mixKey(dh(eh.priv, f.e));        // ee
    ss.mixKey(dh(eh.priv, devPub));     // se
    const status = dev.approved ? "ok" : "pending";
    const reply = { t: "welcome", ts: this.now(), status, rekeyFrames: this.limits.rekeyFrames, maxAgeMs: this.limits.sessionMaxMs };
    const ct = ss.encryptAndHash(encodeMessage(reply));
    this._queue(ch, Buffer.concat([Buffer.from([VERSION, T.HS2]), f.sid, eh.pub, ct]));
    if (!dev.approved) return;

    const [k1, k2] = ss.split();
    // Not a session yet: it counts toward no cap and evicts nothing until the
    // phone proves it holds the keys with a first authenticated DATA frame
    // (a replayed HS1 never gets that far).
    this._addPending({
      sid: Buffer.from(f.sid), key: b64u(f.sid), deviceId, label: sanitizeLabel(dev.label), ch,
      recv: new CipherState(k1, this.now()), send: new CipherState(k2, this.now()),
      created: this.now(), lastRx: this.now(), reqs: new Map(), refused: new Map(), maxReqId: 0, alive: true,
    });
  }

  _addPending(s) {
    const t = this.now();
    for (const [k, p] of this.pending) if (t - p.created > this.limits.pendingSessionMs) this._kill(p, "never used");
    while (this.pending.size >= this.limits.pendingSessions) this._kill(this.pending.values().next().value, "too many unused");
    this.pending.set(s.key, s);
  }

  _handshakePair(ch, f) {
    const pid = b64u(f.idField);
    const pending = this.store.peekPairing(pid);
    if (!pending) return;
    const psk = unb64u(pending.psk, 32);
    if (!psk) return;
    const { hubPub, hubPriv, roomRaw } = this.room;
    if (f.body.length < 48 + 16) return;

    const ss = new SymmetricState(NAME_PAIR);
    let devPub, payload;
    try {
      ss.mixHash(prologue(MODE.PAIR, roomRaw, f.idField, f.sid));
      ss.mixHash(hubPub);
      ss.mixHash(f.e);
      ss.mixKey(f.e);                     // psk patterns also MixKey(e)
      ss.mixKey(dh(hubPriv, f.e));        // es
      devPub = ss.decryptAndHash(f.body.subarray(0, 48)); // s
      ss.mixKey(dh(hubPriv, devPub));     // ss
      ss.mixKeyAndHash(psk);              // psk
      payload = decodeMessage(ss.decryptAndHash(f.body.subarray(48)));
    } catch {
      this.store.failPairing(pid);
      return;
    }
    if (payload.t !== "pair" || !this._checkTs(payload)) return;
    // One-time: consume before answering, so a replay or a race loses.
    if (!this.store.takePairing(pid)) return;

    const eh = x25519Generate();
    ss.mixHash(eh.pub);
    ss.mixKey(eh.pub);
    ss.mixKey(dh(eh.priv, f.e));          // ee
    ss.mixKey(dh(eh.priv, devPub));       // se

    const deviceId = b64u(crypto.randomBytes(16));
    const roomToken = "aftc_" + b64u(crypto.randomBytes(32));
    const label = sanitizeLabel(payload.label);
    const reply = { t: "paired", ts: this.now(), deviceId, roomToken, status: "pending" };
    const ct = ss.encryptAndHash(encodeMessage(reply));
    const sas = sasFromHash(ss.h);
    try {
      this.store.addDevice({
        id: deviceId, label, pub: b64u(devPub), tokenHash: tokenHash(roomToken),
        pairedAt: this.now(), approved: false, sas, pairing: pid,
      });
    } catch (e) {
      this.log(`tunnel: pairing refused (${e.message})`);
      return;
    }
    this._reload(true);
    this.emit("paired", { id: deviceId, label, sas });
    // The relay must accept the new device token before the phone uses it.
    const send = () => this._queue(ch, Buffer.concat([Buffer.from([VERSION, T.HS2]), f.sid, eh.pub, ct]));
    if (this.relay && this.active) this._syncRoom().then(send, send); else send();
  }

  _addSession(s) {
    const mine = [...this.sessions.values()].filter((x) => x.deviceId === s.deviceId);
    while (mine.length >= this.limits.sessionsPerDevice) this._kill(mine.shift(), "too many sessions");
    while (this.sessions.size >= this.limits.sessions) this._kill(this.sessions.values().next().value, "too many sessions");
    this.sessions.set(s.key, s);
    const d = this._devices[s.deviceId];
    if (d && (!d.lastSeen || this.now() - d.lastSeen > 10 * 60 * 1000)) {
      d.lastSeen = this.now();
      try { this.store.touch(s.deviceId, d.lastSeen); this._devStamp = this.store.devicesStamp(); } catch { /* not critical */ }
    }
    this.emit("session", { deviceId: s.deviceId });
  }

  _reset(ch, sid, force) {
    const key = b64u(sid);
    const t = this.now();
    if ((this.resetSent.get(key) || 0) > t - 5000) return;
    if (!force) {
      // One budget for every channel together: a relay inventing session ids
      // cannot make the hub answer more than resetsPerSecond of them.
      const per = this.limits.resetsPerSecond;
      this.resetTokens = Math.min(per, this.resetTokens + (t - this.resetRefilled) * per / 1000);
      this.resetRefilled = t;
      if (this.resetTokens < 1) return;
      this.resetTokens -= 1;
    }
    this.resetSent.set(key, t);
    if (this.resetSent.size > 1000) this.resetSent.delete(this.resetSent.keys().next().value);
    this._queue(ch, Buffer.concat([Buffer.from([VERSION, T.RESET]), sid]));
  }

  _data(ch, f) {
    // Revocation lands on the very next frame: a cheap stat, a reload only if a file changed.
    if (this._reload(false)) this._syncRoom().catch(() => {});
    const key = b64u(f.sid);
    const s = this.sessions.get(key) || this.pending.get(key);
    if (!s) return this._reset(ch, f.sid);
    if (s.ch !== ch) return; // a frame for this session from another channel: not ours
    if (f.n < s.recv.n) return; // duplicate or replay: drop, keep the session
    if (f.n > s.recv.n) return this._kill(s, "frame missing", true);
    let msg;
    try {
      msg = decodeMessage(aeadOpen(s.recv.k, f.n, f.ad, f.body));
    } catch {
      return this._kill(s, "authentication failed", true);
    }
    s.recv.n++;
    s.lastRx = this.now();
    if (this.pending.delete(key)) this._addSession(s); // first proof of the keys: now it counts
    if (this.now() - s.created > this.limits.sessionMaxMs) return this._kill(s, "session too old", true);
    try {
      this._message(s, msg);
    } catch (e) {
      this._kill(s, `protocol error (${e.code || e.message})`, true);
    }
  }

  _message(s, m) {
    switch (m.t) {
      case "rekey": s.recv.rekey(); return;
      case "ping": this._send(s, { t: "pong" }); return;
      case "bye": this._kill(s, "closed by phone"); return;
      case "req": return this._req(s, m);
      case "body": return this._body(s, m);
      case "end": return this._end(s, m);
      case "cancel": s.refused.delete(m.id); return this._cancelReq(s, m.id);
      default: throw tunnelError("BAD_MESSAGE", "unknown message");
    }
  }

  _req(s, m) {
    const id = m.id;
    if (!Number.isSafeInteger(id) || id <= s.maxReqId) throw tunnelError("BAD_ID", "request id must increase");
    s.maxReqId = id;
    // Answered up front: the phone still sends this request's body/end, which
    // must be swallowed, not treated as a protocol error that kills the session.
    const fail = (status, error) => {
      this._fail(s, id, status, error);
      if (m.end !== true) {
        s.refused.set(id, true);
        while (s.refused.size > 4 * this.limits.reqsPerSession) s.refused.delete(s.refused.keys().next().value);
      }
    };
    if (s.reqs.size >= this.limits.reqsPerSession) return fail(429, "Too many requests in flight");
    const method = typeof m.m === "string" ? m.m.toUpperCase() : "";
    const p = m.p;
    if (!ALLOWED_METHODS.has(method)) return fail(405, "Method not allowed");
    if (typeof p !== "string" || p.length > 2048 || !/^\/api(\/|\?|$)/.test(p) || !/^[\x21-\x7e]+$/.test(p)) return fail(404, "Not found");
    const headers = {};
    const src = m.h && typeof m.h === "object" ? m.h : {};
    for (const k of REQ_HEADERS) {
      const v = src[k];
      if (typeof v === "string" && v.length <= 4096 && !/[\r\n\0]/.test(v)) headers[k] = v;
    }
    s.reqs.set(id, { id, method, path: p, headers, body: [], size: 0, dispatched: false, req: null, res: null });
    if (m.end === true) this._dispatch(s, id);
  }

  _body(s, m) {
    const r = s.reqs.get(m.id);
    if (!r && s.refused.has(m.id)) return;
    if (!r || r.dispatched) throw tunnelError("BAD_ID", "no such request");
    const chunk = unb64u(m.d);
    if (!chunk) throw tunnelError("BAD_MESSAGE", "bad body chunk");
    if (chunk.length > this.limits.chunk) throw tunnelError("BAD_MESSAGE", "body chunk too large");
    r.size += chunk.length;
    if (r.size > this.limits.reqBody) {
      // Answer now and keep swallowing its remaining chunks until "end".
      if (!r.dropped) this._fail(s, m.id, 413, "Request too large");
      r.dropped = true;
      r.body = [];
      return;
    }
    r.body.push(chunk);
  }

  _end(s, m) {
    const r = s.reqs.get(m.id);
    if (!r && s.refused.delete(m.id)) return;
    if (!r || r.dispatched) throw tunnelError("BAD_ID", "no such request");
    if (r.dropped) { s.reqs.delete(m.id); return; }
    this._dispatch(s, m.id);
  }

  _fail(s, id, status, error) {
    this._send(s, { t: "res", id, s: status, h: { "content-type": "application/json; charset=utf-8" } });
    this._send(s, { t: "data", id, d: b64u(Buffer.from(JSON.stringify({ error }))) });
    this._send(s, { t: "end", id });
  }

  _dispatch(s, id) {
    const r = s.reqs.get(id);
    r.dispatched = true;
    const body = Buffer.concat(r.body);
    r.body = null;
    const headers = Object.assign({}, r.headers, {
      host: "localhost",
      "user-agent": `ArcFlare-Tunnel/1 (${s.label})`,
    });
    if (body.length) headers["content-length"] = String(body.length);
    const j = this.jar.get(s.deviceId);
    if (j) headers.cookie = `${j.name}=${j.value}`;

    const tunnel = this;
    let buf = [], bufLen = 0, timer = null, done = false;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!bufLen || !s.alive) return;
      const all = Buffer.concat(buf);
      buf = []; bufLen = 0;
      for (let i = 0; i < all.length; i += tunnel.limits.chunk) {
        tunnel._send(s, { t: "data", id, d: b64u(all.subarray(i, i + tunnel.limits.chunk)) });
      }
    };
    const finish = () => { done = true; s.reqs.delete(id); };
    const sink = {
      head(status, h) {
        if (done || !s.alive) return;
        const out = {};
        for (const [k, v] of Object.entries(h)) {
          if (k === "set-cookie") {
            for (const one of [].concat(v)) {
              const c = parseSetCookie(one);
              if (!c) continue;
              if (c.cleared) tunnel.jar.delete(s.deviceId); else tunnel.jar.set(s.deviceId, { name: c.name, value: c.value });
            }
          } else if (RES_HEADERS.includes(k)) out[k] = String(v);
        }
        tunnel._send(s, { t: "res", id, s: status, h: out });
      },
      data(chunk) {
        if (done || !s.alive) return;
        buf.push(chunk); bufLen += chunk.length;
        if (bufLen >= tunnel.limits.chunk) flush();
        else if (!timer) timer = setTimeout(flush, 20);
      },
      end() {
        if (done) return;
        flush();
        if (s.alive) tunnel._send(s, { t: "end", id });
        finish();
      },
      abort() {
        if (done) return;
        if (timer) clearTimeout(timer);
        if (s.alive) tunnel._send(s, { t: "err", id, e: "aborted" });
        finish();
      },
      backlog() { return bufLen + tunnel.outBytes; },
    };
    r.req = new TunnelRequest({ method: r.method, url: r.path, headers, body });
    r.res = new TunnelResponse(sink);
    r.cancel = () => { if (!done) { if (timer) clearTimeout(timer); finish(); r.res._cancel(); r.req.emit("close"); } };
    try {
      this.dispatch(r.req, r.res, { deviceId: s.deviceId });
    } catch (e) {
      this.log(e);
      sink.abort();
    }
  }

  _cancelReq(s, id) {
    const r = s.reqs.get(id);
    if (!r) return;
    if (r.cancel) r.cancel(); else s.reqs.delete(id);
  }

  _kill(s, why, tellPhone) {
    if (!s || !s.alive) return;
    s.alive = false;
    this.sessions.delete(s.key);
    this.pending.delete(s.key);
    for (const r of [...s.reqs.values()]) if (r.cancel) r.cancel();
    s.reqs.clear();
    if (tellPhone) this._reset(s.ch, s.sid, true);
    this.log(`tunnel: session for ${s.deviceId} ended (${why})`);
    this.emit("session_end", { deviceId: s.deviceId, why });
  }

  // ----------------------------------------------------------- outbound ----

  _send(s, msg) {
    if (!s.alive) return;
    const pt = encodeMessage(msg);
    if (s.send.n >= this.limits.maxCounter - 2) return this._kill(s, "counter exhausted", true);
    this._seal(s, pt);
    if (!s.alive) return;
    const due = s.send.sinceRekey >= this.limits.rekeyFrames || this.now() - s.send.rekeyedAt >= this.limits.rekeyMs;
    if (due) {
      this._seal(s, encodeMessage({ t: "rekey" }));
      s.send.rekey(this.now());
    }
  }

  _seal(s, pt) {
    if (!s.alive) return;
    const ad = dataHeader(s.sid, s.send.n);
    const ct = aeadSeal(s.send.k, s.send.n, ad, pt);
    s.send.n++;
    s.send.sinceRekey++;
    this._queue(s.ch, Buffer.concat([ad, ct]));
  }

  /**
   * Put a frame in the relay outbox, which is capped by bytes AND frame count
   * for every frame type. When it is full: if DATA frames are in it, the relay
   * is not taking them, so every session is shed and the DATA frames dropped
   * (once, not per frame); then, and for any other frame type, the NEW frame is
   * the one dropped. The frame type is kept with the entry, never re-decoded.
   */
  _queue(ch, buf) {
    const c = b64u(buf);
    const type = buf[1];
    const full = () => this.outBytes + c.length > this.limits.outboxBytes || this.outbox.length >= this.limits.outboxFrames;
    if (full()) {
      if (this.outData > 0) this._shed();
      if (full() || type === T.DATA) return false; // a DATA frame's session was just shed
    }
    this.outbox.push({ seq: ++this.outSeq, ch, c, type });
    this.outBytes += c.length;
    if (type === T.DATA) this.outData++;
    this.emit("frame", { ch, c });
    if (this.active) this._kick();
    return true;
  }

  /** The relay is not taking our frames: end every session, forget the queued DATA. Phones re-handshake later. */
  _shed() {
    for (const s of [...this.sessions.values(), ...this.pending.values()]) this._kill(s, "relay backlog");
    const keep = [];
    let bytes = 0;
    for (const f of this.outbox) if (f.type !== T.DATA) { keep.push(f); bytes += f.c.length; }
    this.outbox = keep;
    this.outBytes = bytes;
    this.outData = 0;
  }

  /** Remove sent frames by sequence number (never by count: the outbox may have been rebuilt while we awaited). */
  _sent(lastSeq) {
    let k = 0;
    while (k < this.outbox.length && this.outbox[k].seq <= lastSeq) k++;
    for (const f of this.outbox.splice(0, k)) {
      this.outBytes -= f.c.length;
      if (f.type === T.DATA) this.outData--;
    }
  }

  _kick() {
    if (this._flushing) return;
    this._flushing = (async () => {
      let backoff = 500;
      while (this.active && this.outbox.length) {
        const batch = [];
        let bytes = 0;
        while (batch.length < this.limits.batchFrames && batch.length < this.outbox.length && bytes < 1024 * 1024) {
          const f = this.outbox[batch.length];
          batch.push(f);
          bytes += f.c.length;
        }
        try {
          const res = await this._relay("POST", "hub", { frames: batch.map((f) => ({ ch: f.ch, c: f.c })) });
          if (res.status === 404) { await this._syncRoom(true); continue; }
          if (!res.ok) throw new Error(`relay answered ${res.status}`);
          this._sent(batch[batch.length - 1].seq);
          backoff = 500;
        } catch (e) {
          if (!this.active) break;
          this.log(`tunnel: send failed (${e.message})`);
          await sleep(backoff, this._abort && this._abort.signal);
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    })().finally(() => { this._flushing = null; if (this.active && this.outbox.length) this._kick(); });
  }

  // -------------------------------------------------------------- relay ----

  _relay(method, part, body, query) {
    const url = `${this.relay}/api/tunnel/room/${this.room.roomId}${part ? "/" + part : ""}${query ? "?" + query : ""}`;
    const init = {
      method,
      headers: { Authorization: `Bearer ${this.room.hubToken}`, "Content-Type": "application/json" },
      // Node 18 lacks AbortSignal.any: there the timeout alone bounds a request,
      // and stop() waits at most one poll.
      signal: AbortSignal.any
        ? AbortSignal.any([this._abort.signal, AbortSignal.timeout((this.pollWaitSec + 15) * 1000)])
        : AbortSignal.timeout((this.pollWaitSec + 15) * 1000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.fetch(url, init);
  }

  /** A relay reply as parsed JSON, refusing to buffer more than relayReplyBytes of it. */
  async _readReply(res) {
    return JSON.parse(await readTextCapped(res, this.limits.relayReplyBytes));
  }

  async _syncRoom(force) {
    if (!this.relay || !this._abort) return;
    const clients = this._allowlist();
    const sig = JSON.stringify(clients);
    if (!force && sig === this._allow) return;
    const res = await this._relay("PUT", "", { v: VERSION, clients });
    if (!res.ok) throw new Error(`relay answered ${res.status}`);
    this._allow = sig;
  }

  /**
   * Register the room and start polling. An unreachable relay is not fatal:
   * the hub keeps serving the LAN and the loop keeps retrying with backoff.
   */
  async start() {
    if (!this.relay) throw new Error("no relay URL");
    if (typeof this.fetch !== "function") throw new Error("the relay tunnel needs Node 18 or newer (global fetch)");
    this._abort = new AbortController();
    this.active = true;
    try {
      await this._syncRoom(true);
      this.connected = true;
    } catch (e) {
      this.connected = false;
      this.emit("status", `relay unreachable (${e.message}) — retrying`);
    }
    this._loop = this._pollLoop();
    this._tick = setInterval(() => this._housekeeping(), 2000);
    if (this._tick.unref) this._tick.unref();
    this._kick();
    return this;
  }

  _housekeeping() {
    try {
      if (this._reload(false)) this._syncRoom().catch(() => {});
      else if (JSON.stringify(this._allowlist()) !== this._allow) this._syncRoom().catch(() => {});
      const t = this.now();
      for (const s of [...this.pending.values()]) if (t - s.created > this.limits.pendingSessionMs) this._kill(s, "never used");
      for (const s of [...this.sessions.values()]) {
        // A running handler (an SSE stream) keeps a quiet session alive; a half-sent request does not.
        if (t - s.lastRx > this.limits.sessionIdleMs && ![...s.reqs.values()].some((r) => r.dispatched)) this._kill(s, "idle");
        else if (t - s.created > this.limits.sessionMaxMs) this._kill(s, "session too old", true);
      }
    } catch (e) { this.log(e); }
  }

  async _pollLoop() {
    let backoff = 1000;
    while (this.active) {
      try {
        const res = await this._relay("GET", "hub", undefined, `after=${this.after}&wait=${this.pollWaitSec}`);
        if (res.status === 404) { await this._syncRoom(true); this.after = 0; continue; }
        if (!res.ok) throw new Error(`relay answered ${res.status}`);
        const j = await this._readReply(res);
        if (!j || typeof j !== "object") throw new Error("relay sent a bad reply");
        if (!this.connected) { this.connected = true; this.emit("status", "relay connected"); }
        backoff = 1000;
        if (typeof j.head === "number" && j.head < this.after) this.after = 0; // relay restarted
        // At most relayFramesPerPoll per poll; the rest stay on the relay for the next one.
        for (const f of (Array.isArray(j.frames) ? j.frames : []).slice(0, this.limits.relayFramesPerPoll)) {
          if (!f || !Number.isSafeInteger(f.seq) || f.seq <= this.after) continue;
          this.after = f.seq;
          this.receive(f.ch, f.c);
        }
        this._housekeeping();
      } catch (e) {
        if (!this.active) break;
        if (this.connected) { this.connected = false; this.emit("status", `relay unreachable (${e.message}) — retrying`); }
        await sleep(backoff, this._abort.signal);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  async stop() {
    if (!this.active) return;
    for (const s of [...this.sessions.values(), ...this.pending.values()]) this._kill(s, "hub stopping", true);
    try { await Promise.race([this._flushing, sleep(1000)]); } catch { /* best effort */ }
    this.active = false;
    clearInterval(this._tick);
    this._abort.abort();
    try { await this._loop; } catch { /* stopping */ }
  }
}

/** Read a fetch Response body as text, giving up as soon as it passes `cap` bytes. */
async function readTextCapped(res, cap) {
  const len = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
  if (len > cap) throw tunnelError("TOO_BIG", "relay reply too large");
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw tunnelError("TOO_BIG", "relay reply too large"); }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.length));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > cap) throw tunnelError("TOO_BIG", "relay reply too large");
  return text;
}

module.exports = {
  HubTunnel, TunnelStore, TunnelRequest, TunnelResponse,
  pairingLink, derivePairing, checkRelayUrl, tokenHash, sasFromHash, sanitizeLabel,
  // primitives, exported for tests and for anyone checking the spec
  _internal: {
    b64u, unb64u, kdf, hkdf, sha256, aeadSeal, aeadOpen, rekeyKey, dh, x25519Generate, x25519Public,
    SymmetricState, prologue, parseFrame, dataHeader, encodeMessage, decodeMessage,
  },
  VERSION, NAME_KK, NAME_PAIR, T, MODE, LIMITS, CLIENT_TOKEN_RE, HUB_TOKEN_RE,
};
