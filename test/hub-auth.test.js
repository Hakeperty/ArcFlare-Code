// Tests for hub accounts and sessions. What matters here is what fails quietly:
// a cookie that works after it should not, a login that tells an attacker which
// usernames exist, a token that sits readable on disk, a lockout that never
// lifts or never starts.
//
// Time is injected (`now`), so lockouts and 30-day expiries take microseconds.
// scrypt itself runs for real: that is the part worth proving, and it is about
// 100 ms a hash.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-hubauth-"));
const auth = require("../lib/hub/auth");
const { AuthStore } = auth;

const PW = "correct horse battery";
const DAY = 24 * 60 * 60 * 1000;

function mk(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(process.env.ARCFLARE_HOME, "hub-"));
  const clock = { t: 1_700_000_000_000 };
  const store = new AuthStore({ dir, now: () => clock.t, ...opts.store });
  return { dir, clock, store, file: path.join(dir, "auth.json") };
}

async function loginOk(store, extra = {}) {
  const r = await store.login({ username: "alice", password: PW, ip: "10.0.0.2", device: "phone", ...extra });
  assert.strictEqual(r.ok, true);
  return r;
}

// --------------------------------------------------------------- passwords ----

test("a password round-trips: right one logs in, wrong one does not", async () => {
  const { store } = mk();
  assert.strictEqual(store.hasAccounts(), false);
  assert.deepStrictEqual(store.createAccount("Alice", PW), { username: "alice", role: "owner" });
  assert.strictEqual(store.hasAccounts(), true);
  assert.strictEqual((await store.login({ username: "alice", password: PW, ip: "1.1.1.1" })).ok, true);
  assert.strictEqual((await store.login({ username: "ALICE", password: PW, ip: "1.1.1.1" })).ok, true);
  assert.strictEqual((await store.login({ username: "alice", password: PW + "x", ip: "1.1.1.1" })).ok, false);
});

test("the stored hash is scrypt with its parameters and a per-user salt", () => {
  const { store, file } = mk();
  store.createAccount("alice", PW);
  store.createAccount("bob", PW);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const a = d.users.alice.hash, b = d.users.bob.hash;
  assert.strictEqual(a.alg, "scrypt");
  assert.deepStrictEqual([a.N, a.r, a.p, a.keylen], [32768, 8, 1, 64]);
  assert.strictEqual(Buffer.from(a.salt, "base64").length, 16);
  assert.strictEqual(Buffer.from(a.key, "base64").length, 64);
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.key, b.key, "same password, different salt, different hash");
  assert.ok(!JSON.stringify(d).includes(PW));
});

test("weak passwords and bad usernames are rejected with a code", () => {
  const { store } = mk();
  assert.throws(() => store.createAccount("alice", "short"), { code: "WEAK_PASSWORD" });
  assert.throws(() => store.createAccount("alice", "123456789"), { code: "WEAK_PASSWORD" });
  assert.throws(() => store.createAccount("alice", "x".repeat(257)), { code: "WEAK_PASSWORD" });
  assert.throws(() => store.createAccount("alice", undefined), { code: "WEAK_PASSWORD" });
  assert.doesNotThrow(() => store.createAccount("alice", "x".repeat(10)));
  for (const bad of ["a", "has space", "../etc", "x".repeat(33), "", "bob/../x", "naïve"]) {
    assert.throws(() => store.createAccount(bad, PW), { code: "BAD_USERNAME" }, bad);
  }
  assert.throws(() => store.createAccount("ALICE", PW), { code: "EXISTS" });
  assert.strictEqual(store.listAccounts().length, 1);
});

test("unknown user and wrong password give the same result", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  const unknown = await store.login({ username: "nobody", password: "whatever-long-enough", ip: "1.1.1.1" });
  const wrong = await store.login({ username: "alice", password: "whatever-long-enough", ip: "2.2.2.2" });
  assert.deepStrictEqual(unknown, wrong);
  assert.deepStrictEqual(unknown, { ok: false, code: "BAD_CREDENTIALS" });
  // Malformed input is not special either.
  const odd = await store.login({ username: "../../x", password: 12345, ip: "3.3.3.3" });
  assert.deepStrictEqual(odd, unknown);
});

test("an unknown user still costs a scrypt", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  const t0 = process.hrtime.bigint();
  await store.login({ username: "nobody", password: "whatever-long-enough", ip: "1.1.1.1" });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms > 10, `unknown-user login took ${ms} ms; expected a real hash`);
});

test("setPassword changes the password and revokes that user's sessions", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  store.createAccount("bob", PW);
  const a = await loginOk(store);
  const b = await store.login({ username: "bob", password: PW, ip: "1.1.1.1" });
  store.setPassword("alice", "a brand new passphrase");
  assert.strictEqual(store.authenticate(a.token), null);
  assert.ok(store.authenticate(b.token), "other users keep their sessions");
  assert.strictEqual((await store.login({ username: "alice", password: PW, ip: "1.1.1.1" })).ok, false);
  assert.strictEqual((await store.login({ username: "alice", password: "a brand new passphrase", ip: "1.1.1.1" })).ok, true);
  assert.throws(() => store.setPassword("alice", "short"), { code: "WEAK_PASSWORD" });
});

test("deleteAccount removes the user and their sessions", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  const a = await loginOk(store);
  store.deleteAccount("alice");
  assert.strictEqual(store.authenticate(a.token), null);
  assert.strictEqual(store.hasAccounts(), false);
});

// --------------------------------------------------------------- lockout ----

test("five failures lock the username out, with a growing retryAfterMs", async () => {
  const { store, clock } = mk();
  store.createAccount("alice", PW);
  for (let i = 0; i < 5; i++) {
    // A different IP each time, so only the username counter is in play.
    const r = await store.login({ username: "alice", password: "wrong password!", ip: `9.9.9.${i}` });
    assert.strictEqual(r.code, "BAD_CREDENTIALS");
  }
  const locked = await store.login({ username: "alice", password: PW, ip: "8.8.8.8" });
  assert.strictEqual(locked.ok, false);
  assert.strictEqual(locked.code, "LOCKED");
  assert.strictEqual(locked.retryAfterMs, 1000);

  // Even the right password is refused while locked.
  clock.t += 400;
  const still = await store.login({ username: "alice", password: PW, ip: "8.8.8.8" });
  assert.strictEqual(still.code, "LOCKED");
  assert.strictEqual(still.retryAfterMs, 600);

  // After the window, one more failure doubles it.
  clock.t += 600;
  assert.strictEqual((await store.login({ username: "alice", password: "wrong password!", ip: "8.8.8.8" })).code, "BAD_CREDENTIALS");
  const second = await store.login({ username: "alice", password: PW, ip: "8.8.8.8" });
  assert.strictEqual(second.retryAfterMs, 2000);

  // And it lifts.
  clock.t += 2000;
  assert.strictEqual((await store.login({ username: "alice", password: PW, ip: "8.8.8.8" })).ok, true);
});

test("lockout is capped at 15 minutes", async () => {
  const { store, clock } = mk();
  store.createAccount("alice", PW);
  let last;
  for (let i = 0; i < 30; i++) {
    last = await store.login({ username: "alice", password: "wrong password!", ip: "7.7.7.7" });
    if (last.code === "LOCKED") clock.t += last.retryAfterMs;
  }
  const r = await store.login({ username: "alice", password: "wrong password!", ip: "7.7.7.7" });
  assert.strictEqual(r.code, "BAD_CREDENTIALS");
  const l = await store.login({ username: "alice", password: PW, ip: "7.7.7.7" });
  assert.strictEqual(l.code, "LOCKED");
  assert.strictEqual(l.retryAfterMs, 15 * 60 * 1000);
});

test("failures are also counted per IP across usernames", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  for (let i = 0; i < 5; i++) {
    await store.login({ username: `ghost${i}`, password: "wrong password!", ip: "6.6.6.6" });
  }
  const r = await store.login({ username: "alice", password: PW, ip: "6.6.6.6" });
  assert.strictEqual(r.code, "LOCKED");
  // A different address is unaffected.
  assert.strictEqual((await store.login({ username: "alice", password: PW, ip: "6.6.6.7" })).ok, true);
});

test("a successful login clears the username counter", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  for (let i = 0; i < 4; i++) await store.login({ username: "alice", password: "wrong password!", ip: `5.5.5.${i}` });
  assert.strictEqual((await store.login({ username: "alice", password: PW, ip: "4.4.4.4" })).ok, true);
  // Four more failures would have been the 8th overall; the count restarted.
  for (let i = 0; i < 4; i++) {
    assert.strictEqual((await store.login({ username: "alice", password: "wrong password!", ip: `3.3.3.${i}` })).code, "BAD_CREDENTIALS");
  }
});

// --------------------------------------------------------------- sessions ----

test("the token is never stored in plaintext, only its hash", async () => {
  const { store, file } = mk();
  store.createAccount("alice", PW);
  const r = await loginOk(store);
  assert.ok(Buffer.from(r.token, "base64url").length === 32);
  assert.notStrictEqual(r.token, r.csrf);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(r.token), "token must not be on disk");
  assert.ok(!raw.includes(PW), "password must not be on disk");
  const crypto = require("crypto");
  const h = crypto.createHash("sha256").update(r.token).digest("hex");
  assert.ok(JSON.parse(raw).sessions[h], "sessions are keyed by sha256(token)");
  // The result handed to callers carries no secret either.
  assert.ok(!JSON.stringify(r.session).includes(r.token));
  assert.ok(!JSON.stringify(store.listSessions("alice")).includes(h));
});

test("authenticate returns the user, session and csrf; junk returns null", async () => {
  const { store } = mk();
  store.createAccount("alice", PW, { role: "owner" });
  const r = await loginOk(store, { device: "Pixel 8" });
  const a = store.authenticate(r.token);
  assert.deepStrictEqual(a.user, { username: "alice", role: "owner" });
  assert.strictEqual(a.csrf, r.csrf);
  assert.strictEqual(a.session.device, "Pixel 8");
  assert.strictEqual(a.session.ip, "10.0.0.2");
  for (const bad of [undefined, null, "", "x", "a".repeat(43), 5, {}]) assert.strictEqual(store.authenticate(bad), null);
});

test("idle timeout: unused for 7 days ends the session, use slides it", async () => {
  const { store, clock } = mk();
  store.createAccount("alice", PW);
  const r = await loginOk(store);
  clock.t += 6 * DAY;
  assert.ok(store.authenticate(r.token), "still valid at 6 days idle");
  clock.t += 6 * DAY;
  assert.ok(store.authenticate(r.token), "slid: 6 days since last use");
  clock.t += 7 * DAY + 1;
  assert.strictEqual(store.authenticate(r.token), null, "7 idle days");
  clock.t -= 1; // the dead session stays dead
  assert.strictEqual(store.authenticate(r.token), null);
});

test("absolute lifetime: 30 days ends it however active", async () => {
  const { store, clock } = mk();
  store.createAccount("alice", PW);
  const r = await loginOk(store);
  for (let d = 0; d < 29; d++) {
    clock.t += DAY;
    assert.ok(store.authenticate(r.token), `day ${d + 1}`);
  }
  clock.t += DAY + 1;
  assert.strictEqual(store.authenticate(r.token), null);
});

test("sessions survive a new AuthStore on the same dir; expired ones are pruned on load", async () => {
  const { store, clock, dir, file } = mk();
  store.createAccount("alice", PW);
  const keep = await loginOk(store);
  clock.t += 8 * DAY;
  const keep2 = await loginOk(store); // prunes the idle first one during login
  assert.strictEqual(store.authenticate(keep.token), null);

  const again = new AuthStore({ dir, now: () => clock.t });
  assert.ok(again.authenticate(keep2.token));
  assert.strictEqual(again.hasAccounts(), true);
  assert.strictEqual((await again.login({ username: "alice", password: PW, ip: "1.1.1.1" })).ok, true);

  clock.t += 31 * DAY;
  const later = new AuthStore({ dir, now: () => clock.t });
  assert.strictEqual(later.authenticate(keep2.token), null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).sessions, {});
});

test("an account added by another process is seen without a restart", () => {
  const { store, dir } = mk();
  assert.strictEqual(store.hasAccounts(), false);
  new AuthStore({ dir }).createAccount("alice", PW);
  assert.strictEqual(store.hasAccounts(), true);
});

test("logout ends one session only", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  const a = await loginOk(store);
  const b = await loginOk(store);
  store.logout(a.token);
  assert.strictEqual(store.authenticate(a.token), null);
  assert.ok(store.authenticate(b.token));
  assert.doesNotThrow(() => store.logout("never-existed"));
});

test("listSessions shows device, ip and times, newest use first, no secrets", async () => {
  const { store, clock } = mk();
  store.createAccount("alice", PW);
  store.createAccount("bob", PW);
  await loginOk(store, { device: "old" });
  clock.t += 1000;
  await loginOk(store, { device: "new" });
  await store.login({ username: "bob", password: PW, ip: "1.1.1.1" });
  const l = store.listSessions("alice");
  assert.deepStrictEqual(l.map((s) => s.device), ["new", "old"]);
  for (const s of l) {
    assert.deepStrictEqual(Object.keys(s).sort(), ["created", "current", "device", "id", "ip", "lastSeen"]);
    assert.strictEqual(s.current, false);
  }
});

test("revokeSession works only for the user's own sessions", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  store.createAccount("bob", PW);
  const a = await loginOk(store);
  const b = await store.login({ username: "bob", password: PW, ip: "1.1.1.1" });
  const aId = store.listSessions("alice")[0].id;
  assert.strictEqual(store.revokeSession("bob", aId), false, "bob cannot revoke alice's");
  assert.ok(store.authenticate(a.token));
  assert.strictEqual(store.revokeSession("alice", "nonexistent"), false);
  assert.strictEqual(store.revokeSession("alice", aId), true);
  assert.strictEqual(store.authenticate(a.token), null);
  assert.ok(store.authenticate(b.token));
});

test("revokeAll ends every session except the one named", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  store.createAccount("bob", PW);
  const a1 = await loginOk(store);
  const a2 = await loginOk(store);
  const a3 = await loginOk(store);
  const b = await store.login({ username: "bob", password: PW, ip: "1.1.1.1" });
  assert.strictEqual(store.revokeAll("alice", a2.token), 2);
  assert.strictEqual(store.authenticate(a1.token), null);
  assert.ok(store.authenticate(a2.token));
  assert.strictEqual(store.authenticate(a3.token), null);
  assert.ok(store.authenticate(b.token));
  assert.strictEqual(store.revokeAll("alice"), 1);
});

test("auth.json is mode 0600", { skip: process.platform === "win32" }, async () => {
  const { store, file } = mk();
  store.createAccount("alice", PW);
  await loginOk(store);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  store.setPassword("alice", "another long passphrase");
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ["auth.json"], "no temp files left behind");
});

// ----------------------------------------------------------- csrf, cookies ----

test("checkCsrf compares in constant time and rejects anything but the exact value", async () => {
  const { store } = mk();
  store.createAccount("alice", PW);
  const r = await loginOk(store);
  const a = store.authenticate(r.token);
  assert.strictEqual(auth.checkCsrf(a, r.csrf), true);
  assert.strictEqual(auth.checkCsrf(a, r.csrf + "x"), false);
  assert.strictEqual(auth.checkCsrf(a, r.csrf.slice(0, -1)), false);
  assert.strictEqual(auth.checkCsrf(a, ""), false);
  assert.strictEqual(auth.checkCsrf(a, undefined), false);
  assert.strictEqual(auth.checkCsrf(a, [r.csrf]), false);
  assert.strictEqual(auth.checkCsrf(null, r.csrf), false);
  assert.strictEqual(auth.checkCsrf({}, ""), false);

  // It goes through timingSafeEqual, not ===.
  const crypto = require("crypto");
  const orig = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...x) => { calls++; return orig(...x); };
  try { auth.checkCsrf(a, "short"); auth.checkCsrf(a, r.csrf); } finally { crypto.timingSafeEqual = orig; }
  assert.strictEqual(calls, 2, "also for values of a different length");
});

test("cookie names: __Host- over https, a plain name over http", () => {
  assert.strictEqual(auth.COOKIE_NAME, "__Host-arcflare");
  assert.strictEqual(auth.cookieName(true), "__Host-arcflare");
  assert.strictEqual(auth.cookieName(false), "arcflare_sid");
});

test("cookie header carries HttpOnly, SameSite=Strict, Path=/, Max-Age and Secure only on https", () => {
  const s = auth.cookieHeader("tok", { secure: true, maxAgeSec: 1234 });
  assert.match(s, /^__Host-arcflare=tok;/);
  for (const f of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=1234", "Secure"]) {
    assert.ok(s.split("; ").includes(f), `${f} in ${s}`);
  }
  assert.ok(!/Domain=/i.test(s), "__Host- forbids Domain");
  const p = auth.cookieHeader("tok", { secure: false, maxAgeSec: 60 });
  assert.match(p, /^arcflare_sid=tok;/);
  assert.ok(!p.split("; ").includes("Secure"));
  for (const f of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=60"]) assert.ok(p.split("; ").includes(f), f);

  const c = auth.clearCookieHeader({ secure: true });
  assert.match(c, /^__Host-arcflare=;/);
  assert.ok(c.includes("Max-Age=0") && c.includes("HttpOnly") && c.includes("Secure") && c.includes("Path=/"));
  assert.ok(!auth.clearCookieHeader({ secure: false }).includes("Secure"));
});

test("parseCookies handles spacing, quotes, junk and duplicates", () => {
  assert.deepStrictEqual(auth.parseCookies("a=1; b=2;c=3"), { a: "1", b: "2", c: "3" });
  assert.deepStrictEqual(auth.parseCookies('arcflare_sid="x.y-z"'), { arcflare_sid: "x.y-z" });
  assert.deepStrictEqual(auth.parseCookies("a=1; a=2"), { a: "1" }, "first one wins");
  assert.deepStrictEqual(auth.parseCookies("novalue; =x; k=v=w"), { k: "v=w" });
  assert.deepStrictEqual(auth.parseCookies(undefined), {});
  assert.deepStrictEqual(auth.parseCookies(""), {});
  assert.strictEqual(auth.parseCookies("__proto__=x").__proto__, Object.prototype);
});
