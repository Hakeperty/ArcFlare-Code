// Hub accounts and sessions: who may open the phone UI, and for how long.
//
// The hub listens on the LAN, so a password is the only thing between anyone on
// the Wi-Fi and a coding agent that can run commands. Everything here is about
// making that password hard to guess and a stolen cookie hard to reuse.
//
// Four decisions shape this file.
//
// Passwords are scrypt, with the parameters stored next to each hash. N=32768
// costs about 100 ms and 32 MB, which is nothing to a person logging in and a
// lot to someone trying a million guesses. Storing the parameters means they
// can be raised later without locking anyone out. maxmem is passed explicitly
// because Node's default (32 MB) is exactly the memory this needs and refuses
// to run. A username that does not exist still burns one scrypt against a dummy
// hash, and the error text is the same either way, so response time and wording
// cannot be used to find out which usernames exist.
//
// The session token is 32 random bytes and only its SHA-256 reaches the disk.
// A leaked auth.json (a backup, a screenshot of a file listing) therefore
// contains no usable cookie. A fast hash is right here, unlike for passwords:
// the input is already 256 bits of randomness, so there is nothing to brute
// force. The CSRF value is a second random secret kept with the session; the
// server hands it to the page in a JSON body and the page sends it back in a
// header, which a cross-site form or image cannot do.
//
// Guessing is slowed per IP and per username, in memory. Five failures start a
// lockout that doubles each time up to 15 minutes. Both counters matter: the IP
// one stops one machine trying many usernames, the username one stops many
// machines (or a spoofed address) trying one account. A success clears only
// the username counter, so a phone with the right password cannot be used to
// launder an attacker's failures from the same IP. Counters are not persisted:
// a restart is the owner at the keyboard, and the cost is one free window.
//
// Sessions are persisted so restarting the hub does not log every phone out.
// They expire after 7 idle days or 30 days outright, whichever comes first, and
// changing a password ends every session for that user. auth.json is 0600 and
// written by tmp + rename, so a crash never leaves half a file. The file is
// re-read when it changes on disk, which is how `arcflare hub user add` on the
// computer takes effect without restarting a running hub.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // N*r*128 is 32 MB; leave room
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256;
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

const DAY = 24 * 60 * 60 * 1000;
const IDLE_MS = 7 * DAY;
const ABSOLUTE_MS = 30 * DAY;
// lastSeen slides on every request but is only written to disk this often.
const PERSIST_SEEN_MS = 60 * 1000;

const FREE_FAILURES = 5;
const LOCK_BASE_MS = 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;

const COOKIE_SECURE = "__Host-arcflare";
const COOKIE_PLAIN = "arcflare_sid";

// ------------------------------------------------------------------ helpers ----

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function normUser(u) {
  return typeof u === "string" ? u.trim().toLowerCase() : "";
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) {
    throw fail("WEAK_PASSWORD", `password must be at least ${MIN_PASSWORD} characters`);
  }
  if (pw.length > MAX_PASSWORD) {
    throw fail("WEAK_PASSWORD", `password must be at most ${MAX_PASSWORD} characters`);
  }
}

function scryptOpts(p) {
  return { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT_MAXMEM };
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, scryptOpts(SCRYPT));
  return { alg: "scrypt", ...SCRYPT, salt: salt.toString("base64"), key: key.toString("base64") };
}

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function verifyPassword(password, h) {
  const want = Buffer.from(h.key, "base64");
  const got = await scryptAsync(password, Buffer.from(h.salt, "base64"), want.length, scryptOpts(h));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A hash nobody knows the password for, to spend the same time on a miss.
let dummyHash = null;
function getDummy() {
  if (!dummyHash) dummyHash = hashPasswordSync(crypto.randomBytes(18).toString("base64"));
  return dummyHash;
}

// ------------------------------------------------------------------- store ----

class AuthStore {
  /**
   * @param {object} o
   * @param {string} o.dir          the hub state directory; auth.json lives in it
   * @param {function} [o.now]      clock, injected by tests
   * @param {number} [o.idleMs]     idle timeout, default 7 days
   * @param {number} [o.absoluteMs] lifetime cap, default 30 days
   */
  constructor({ dir, now = Date.now, idleMs = IDLE_MS, absoluteMs = ABSOLUTE_MS } = {}) {
    if (!dir) throw new Error("AuthStore needs a dir");
    this.dir = dir;
    this.file = path.join(dir, "auth.json");
    this.now = now;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.data = { v: 1, users: {}, sessions: {} };
    this._stamp = null;
    this.byIp = new Map();
    this.byUser = new Map();
    this._load();
    if (this._prune()) this._save();
  }

  // ---------------------------------------------------------------- storage ----

  _statStamp() {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch { return null; }
  }

  _load() {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { /* none yet */ }
    this.data = {
      v: 1,
      users: (parsed && typeof parsed.users === "object" && parsed.users) || {},
      sessions: (parsed && typeof parsed.sessions === "object" && parsed.sessions) || {},
    };
    this._stamp = this._statStamp();
  }

  // Pick up edits made by another process (the CLI adding a user).
  _fresh() {
    if (this._statStamp() !== this._stamp) this._load();
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: ACLs, not modes */ }
    fs.renameSync(tmp, this.file);
    this._stamp = this._statStamp();
  }

  _expired(s, t) {
    return t - s.lastSeen > this.idleMs || t - s.created > this.absoluteMs;
  }

  _prune() {
    const t = this.now();
    let changed = false;
    for (const [h, s] of Object.entries(this.data.sessions)) {
      if (!this.data.users[s.username] || this._expired(s, t)) {
        delete this.data.sessions[h];
        changed = true;
      }
    }
    return changed;
  }

  _dropSessions(username, exceptHash) {
    let n = 0;
    for (const [h, s] of Object.entries(this.data.sessions)) {
      if (s.username === username && h !== exceptHash) { delete this.data.sessions[h]; n++; }
    }
    return n;
  }

  // --------------------------------------------------------------- accounts ----

  hasAccounts() {
    this._fresh();
    return Object.keys(this.data.users).length > 0;
  }

  createAccount(username, password, { role = "owner" } = {}) {
    this._fresh();
    const name = normUser(username);
    if (!USERNAME_RE.test(name)) {
      throw fail("BAD_USERNAME", "username must be 2-32 characters: a-z, 0-9, dot, dash, underscore");
    }
    checkPassword(password);
    if (Object.prototype.hasOwnProperty.call(this.data.users, name)) {
      throw fail("EXISTS", "that username already exists");
    }
    this.data.users[name] = { role, created: this.now(), hash: hashPasswordSync(password) };
    this._save();
    return { username: name, role };
  }

  setPassword(username, password) {
    this._fresh();
    const name = normUser(username);
    const u = this.data.users[name];
    if (!u) throw fail("NOT_FOUND", "no such user");
    checkPassword(password);
    u.hash = hashPasswordSync(password);
    this._dropSessions(name);
    this._save();
  }

  deleteAccount(username) {
    this._fresh();
    const name = normUser(username);
    if (!this.data.users[name]) throw fail("NOT_FOUND", "no such user");
    delete this.data.users[name];
    this._dropSessions(name);
    this._save();
  }

  listAccounts() {
    this._fresh();
    return Object.entries(this.data.users).map(([username, u]) => ({
      username, role: u.role, created: u.created,
    }));
  }

  // ------------------------------------------------------------ throttling ----

  _lockedFor(map, key) {
    const e = map.get(key);
    if (!e) return 0;
    return Math.max(0, e.until - this.now());
  }

  _noteFailure(map, key) {
    const e = map.get(key) || { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= FREE_FAILURES) {
      e.until = this.now() + Math.min(LOCK_BASE_MS * 2 ** (e.fails - FREE_FAILURES), LOCK_MAX_MS);
    }
    map.set(key, e);
    // Bound memory against an attacker cycling through names or addresses.
    if (map.size > 10000) map.delete(map.keys().next().value);
  }

  // ----------------------------------------------------------------- login ----

  /**
   * @returns {Promise<{ok:true, token, csrf, session}|{ok:false, code, retryAfterMs?}>}
   */
  async login({ username, password, ip, userAgent, device } = {}) {
    this._fresh();
    const name = normUser(username);
    const ipKey = String(ip || "unknown");

    const wait = Math.max(this._lockedFor(this.byIp, ipKey), this._lockedFor(this.byUser, name));
    if (wait > 0) return { ok: false, code: "LOCKED", retryAfterMs: wait };

    const user = Object.prototype.hasOwnProperty.call(this.data.users, name) ? this.data.users[name] : null;
    const pw = typeof password === "string" && password.length <= MAX_PASSWORD ? password : "";
    // Always one scrypt, whether or not the user exists.
    let good = false;
    try { good = await verifyPassword(pw, user ? user.hash : getDummy()); } catch { good = false; }
    if (!user || !good || pw === "") {
      this._noteFailure(this.byIp, ipKey);
      this._noteFailure(this.byUser, name);
      return { ok: false, code: "BAD_CREDENTIALS" };
    }

    this.byUser.delete(name);
    this._fresh();
    if (!this.data.users[name]) return { ok: false, code: "BAD_CREDENTIALS" };
    this._prune();

    const token = randomToken();
    const csrf = randomToken();
    const t = this.now();
    const label = String(device || userAgent || "unknown device").slice(0, 120);
    const rec = {
      id: crypto.randomBytes(8).toString("hex"),
      username: name,
      csrf,
      device: label,
      ip: ip ? String(ip).slice(0, 64) : "",
      created: t,
      lastSeen: t,
    };
    this.data.sessions[sha256hex(token)] = rec;
    this._save();
    return { ok: true, token, csrf, session: publicSession(rec) };
  }

  /** Resolve a cookie value to a live session, or null. Slides lastSeen. */
  authenticate(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
    this._fresh();
    const h = sha256hex(token);
    const s = this.data.sessions[h];
    if (!s) return null;
    const t = this.now();
    const user = this.data.users[s.username];
    if (!user || this._expired(s, t)) {
      delete this.data.sessions[h];
      this._save();
      return null;
    }
    if (t - s.lastSeen >= PERSIST_SEEN_MS) {
      s.lastSeen = t;
      this._save();
    } else if (t > s.lastSeen) {
      s.lastSeen = t; // in memory only; written with the next change
    }
    return {
      user: { username: s.username, role: user.role },
      session: publicSession(s),
      csrf: s.csrf,
    };
  }

  logout(token) {
    if (typeof token !== "string") return;
    this._fresh();
    const h = sha256hex(token);
    if (this.data.sessions[h]) {
      delete this.data.sessions[h];
      this._save();
    }
  }

  listSessions(username) {
    this._fresh();
    const name = normUser(username);
    const t = this.now();
    return Object.values(this.data.sessions)
      .filter((s) => s.username === name && !this._expired(s, t))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((s) => ({ ...publicSession(s), current: false }));
  }

  /** A user can revoke only their own sessions; anything else is a quiet false. */
  revokeSession(username, sessionId) {
    this._fresh();
    const name = normUser(username);
    for (const [h, s] of Object.entries(this.data.sessions)) {
      if (s.id === sessionId && s.username === name) {
        delete this.data.sessions[h];
        this._save();
        return true;
      }
    }
    return false;
  }

  revokeAll(username, exceptToken) {
    this._fresh();
    const name = normUser(username);
    const keep = typeof exceptToken === "string" ? sha256hex(exceptToken) : null;
    const n = this._dropSessions(name, keep);
    if (n) this._save();
    return n;
  }
}

function publicSession(s) {
  return { id: s.id, device: s.device, created: s.created, lastSeen: s.lastSeen, ip: s.ip };
}

// ----------------------------------------------------------------- cookies ----

/** `__Host-` needs Secure, so plain http gets a plain name. */
function cookieName(secure) {
  return secure ? COOKIE_SECURE : COOKIE_PLAIN;
}

function cookieHeader(token, { secure = false, maxAgeSec = ABSOLUTE_MS / 1000 } = {}) {
  let v = `${cookieName(secure)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeSec)}`;
  if (secure) v += "; Secure";
  return v;
}

function clearCookieHeader({ secure = false } = {}) {
  let v = `${cookieName(secure)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  if (secure) v += "; Secure";
  return v;
}

function parseCookies(headerValue) {
  const out = {};
  if (typeof headerValue !== "string") return out;
  for (const raw of headerValue.split(";")) {
    const part = raw.trim();
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  }
  return out;
}

/** Constant-time: hash both sides so length differences do not short-circuit. */
function checkCsrf(auth, headerValue) {
  if (!auth || typeof auth.csrf !== "string" || typeof headerValue !== "string" || !headerValue) return false;
  const a = crypto.createHash("sha256").update(auth.csrf).digest();
  const b = crypto.createHash("sha256").update(headerValue).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  AuthStore, COOKIE_NAME: COOKIE_SECURE, cookieName, cookieHeader, clearCookieHeader, parseCookies, checkCsrf,
  SCRYPT, MIN_PASSWORD, MAX_PASSWORD, USERNAME_RE, IDLE_MS, ABSOLUTE_MS,
};
