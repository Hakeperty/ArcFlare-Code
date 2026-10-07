// Remote control: drive a running chat or agent session from a browser.
//
// `/rc` in a session prints a secret key and a link. The session then holds a
// long-poll open to a relay (the ArcFlare website's /api/rc routes), and anyone
// with the key can open /remote on that site — from a phone, another machine,
// anywhere the relay is reachable — read the session as it happens and type
// into it.
//
// Three decisions shape this file.
//
// Outbound only. The machine never listens on a port: it polls the relay, the
// way a browser would. That is what lets it work from behind NAT, a corporate
// firewall or a hotel Wi-Fi without anyone opening anything.
//
// The key is the only credential, so it is treated like one. 24 random bytes,
// stored in ~/.arcflare/rc.json with owner-only permissions, never logged by
// the relay (which stores a SHA-256 of it), and carried in the link's fragment
// so it is not sent to the server when the page loads. Remote control is off
// until someone types `/rc` in a session they are sitting at, and ends with it.
//
// Approval still means approval. A turn that came from the browser asks the
// browser before running a tool, because the person who asked is the one
// watching; a turn typed at the terminal asks the terminal. Auto mode is auto
// mode in both.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const STORE = path.join(HOME, "rc.json");
const DEFAULT_RELAY = "https://arcflare.net";
const KEY_RE = /^afrc_[A-Za-z0-9_-]{32}$/;

// --------------------------------------------------------------------- key ----

function newKey() {
  return "afrc_" + crypto.randomBytes(24).toString("base64url");
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}

function saveStore(s) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(STORE, 0o600); } catch { /* Windows: ACLs, not modes */ }
}

/**
 * The key for this machine, made on first use and kept.
 *
 * Stable on purpose: the website remembers it, so a phone that was paired once
 * reconnects to every later session without anyone retyping 37 characters.
 * `rotate` is the way to cut every device off at once.
 */
function getKey({ rotate = false } = {}) {
  const s = loadStore();
  if (!rotate && KEY_RE.test(s.key || "")) return s.key;
  const key = newKey();
  saveStore({ ...s, key, created: new Date().toISOString() });
  return key;
}

function relayUrl(cfg = {}) {
  const s = loadStore();
  const raw = process.env.ARCFLARE_RELAY || s.relay || cfg.relay || DEFAULT_RELAY;
  return String(raw).replace(/\/+$/, "");
}

function setRelay(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("the relay must be http:// or https://");
  const clean = u.toString().replace(/\/+$/, "");
  saveStore({ ...loadStore(), relay: clean });
  return clean;
}

/** The link to open. The key rides in the fragment, which browsers never send. */
function linkFor(relay, key) {
  return `${relay}/remote#k=${key}`;
}

/** First and last few characters, for logs and status lines. */
function redact(key) {
  return key ? `${key.slice(0, 9)}…${key.slice(-4)}` : "";
}

// ------------------------------------------------------------------ session ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RemoteSession {
  /**
   * @param {object} o
   * @param {string} o.relay       base URL of the site hosting /api/rc
   * @param {string} o.key         the secret
   * @param {object} o.info        what the browser shows: host, model, kind, cwd
   * @param {function} [o.onStatus] (text) => void, for connection changes
   * @param {function} [o.fetch]   injected for tests
   */
  constructor(o) {
    this.relay = o.relay;
    this.key = o.key;
    this.info = o.info || {};
    this.onStatus = o.onStatus || (() => {});
    this.fetch = o.fetch || globalThis.fetch;
    this.active = false;
    this.connected = false;
    this.after = 0;
    this.outbox = [];
    this.flushTimer = null;
    this.flushing = null;
    this.inbox = [];
    this._next = null;
    this._nextRes = null;
    this.approvals = new Map();
    this.approvalSeq = 0;
    this.clients = 0;
  }

  _headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` };
  }

  async _post(body) {
    const res = await this.fetch(`${this.relay}/api/rc/host`, {
      method: "POST", headers: this._headers(), body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const e = new Error(`relay answered ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  /** Register with the relay. Throws if the relay cannot be reached at all. */
  async open() {
    if (typeof this.fetch !== "function") throw new Error("remote control needs Node 18 or newer (global fetch)");
    await this._post({ type: "open", info: this.info });
    this.active = true;
    this.connected = true;
    this._loop = this._pollLoop();
    return this;
  }

  async close() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.flushTimer);
    // Anything waiting on the browser is answered no: nobody is there to say yes.
    for (const [, p] of this.approvals) p.resolve(false);
    this.approvals.clear();
    try {
      await this._flush();
      await this._post({ type: "close" });
    } catch { /* the relay may already be gone; closing is best effort */ }
  }

  // --------------------------------------------------------------- outbound ----

  /**
   * Queue an event for the browser. Deltas are coalesced and sent in batches —
   * one POST per token would be a few hundred requests a second.
   */
  emit(ev) {
    if (!this.active) return;
    const last = this.outbox[this.outbox.length - 1];
    if (ev.type === "delta" && last && last.type === "delta" && last.kind === ev.kind) {
      last.text += ev.text;
    } else {
      this.outbox.push({ ...ev });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this._flush().catch(() => {}); }, 120);
    }
  }

  async _flush() {
    // Serialised, so batches arrive in the order they were made.
    if (this.flushing) await this.flushing.catch(() => {});
    if (!this.outbox.length) return;
    const batch = this.outbox.splice(0, this.outbox.length);
    this.flushing = this._post({ type: "events", events: batch }).catch((e) => {
      // Put it back for the next attempt rather than dropping a chunk of reply.
      this.outbox.unshift(...batch);
      if (this.active && !this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = null; this._flush().catch(() => {}); }, 2000);
      }
      throw e;
    });
    return this.flushing;
  }

  // ---------------------------------------------------------------- inbound ----

  async _pollLoop() {
    let backoff = 1000;
    while (this.active) {
      try {
        const res = await this.fetch(`${this.relay}/api/rc/host?after=${this.after}`, {
          headers: this._headers(), signal: AbortSignal.timeout(40000),
        });
        // The relay forgot us — restarted, or expired an idle session. Open again
        // rather than polling a session that no longer exists.
        if (res.status === 404 || res.status === 410) {
          await this._post({ type: "open", info: this.info });
          this.after = 0;
          continue;
        }
        if (!res.ok) throw new Error(`relay answered ${res.status}`);
        const j = await res.json();
        if (!this.connected) { this.connected = true; this.onStatus("reconnected to the relay"); }
        backoff = 1000;
        if (typeof j.clients === "number" && j.clients !== this.clients) {
          const before = this.clients;
          this.clients = j.clients;
          if (j.clients > before) this.onStatus(`a browser connected (${j.clients} watching)`);
        }
        for (const ev of j.events || []) {
          this.after = Math.max(this.after, ev.seq || 0);
          this._receive(ev);
        }
      } catch (e) {
        if (!this.active) break;
        if (this.connected) { this.connected = false; this.onStatus(`lost the relay (${e.message}) — retrying`); }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  _receive(ev) {
    if (ev.type === "approve") {
      const p = this.approvals.get(String(ev.id));
      if (p) { this.approvals.delete(String(ev.id)); p.resolve(!!ev.allow); }
      return;
    }
    if (ev.type === "message" && typeof ev.text === "string" && ev.text.trim()) {
      const msg = { from: "remote", text: ev.text.slice(0, 20000) };
      if (this._nextRes) { const r = this._nextRes; this._nextRes = null; r(msg); } else this.inbox.push(msg);
    }
  }

  /**
   * The next message typed in a browser.
   *
   * Memoised until consumed: a REPL races this against the terminal, and a
   * fresh promise per race would let a message resolve one nobody is waiting
   * on any more — and vanish. See InputMux.
   */
  nextMessage() {
    if (!this._next) {
      this._next = this.inbox.length
        ? Promise.resolve(this.inbox.shift())
        : new Promise((r) => { this._nextRes = r; });
    }
    return this._next;
  }

  consumed() { this._next = null; }

  /**
   * Ask the browser whether a tool may run. No answer within the window is a
   * no — a command should not run because someone put their phone down.
   */
  askApproval(kind, detail, timeoutMs = 300000) {
    const id = String(++this.approvalSeq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.approvals.delete(id)) {
          this.emit({ type: "approval_resolved", id, allow: false, reason: "timed out" });
          resolve(false);
        }
      }, timeoutMs);
      this.approvals.set(id, {
        resolve: (allow) => {
          clearTimeout(timer);
          this.emit({ type: "approval_resolved", id, allow });
          resolve(allow);
        },
      });
      this.emit({ type: "approval", id, kind, detail: String(detail).slice(0, 2000) });
    });
  }
}

// ------------------------------------------------------------------- input ----

/**
 * One prompt fed by two sources: the terminal and the browser.
 *
 * Both sides are memoised until consumed, for the same reason as nextMessage:
 * Promise.race does not cancel the loser, so a terminal line typed while a
 * remote turn runs must still be there on the next call, not answered into a
 * promise that lost a race a minute ago.
 */
class InputMux {
  constructor(rl, prompt) {
    this.rl = rl;
    this.prompt = prompt;
    this.pending = null;
    this.closed = false;
    this._res = null;
    rl.on("close", () => {
      this.closed = true;
      if (this._res) { const r = this._res; this._res = null; r({ from: "terminal", text: null }); }
    });
  }

  _line() {
    if (this.closed) return Promise.resolve({ from: "terminal", text: null });
    if (!this.pending) {
      this.pending = new Promise((resolve) => {
        this._res = resolve;
        this.rl.question(this.prompt, (answer) => { this._res = null; resolve({ from: "terminal", text: answer }); });
      });
    }
    return this.pending;
  }

  /** `{from, text}`; text is null when the terminal has closed. */
  async next(remote) {
    const sources = [this._line()];
    if (remote && remote.active) sources.push(remote.nextMessage());
    const got = await Promise.race(sources);
    if (got.from === "remote") remote.consumed(); else this.pending = null;
    return got;
  }
}

/**
 * An agent event as the browser sees it, or null for ones it does not need.
 * Tool results are cut to their first line, as the terminal shows them: a
 * 900-line build log is not something to push through a relay to a phone.
 */
function toRemote(ev) {
  switch (ev.type) {
    case "reasoning":
    case "content":
      return ev.text ? { type: "delta", kind: ev.type, text: ev.text } : null;
    case "tool": {
      const a = ev.args || {};
      let detail = a.path || a.pattern || a.command || a.name || a.query || a.tool || "";
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      return { type: "tool", name: ev.name, detail: String(detail).slice(0, 300) };
    }
    case "tool_result": {
      const out = String(ev.out || "");
      const lines = out.split("\n");
      return { type: "tool_result", name: ev.name, line: lines[0].slice(0, 200),
        lines: lines.length, error: out.startsWith("ERROR") };
    }
    case "error":
      return { type: "error", text: String(ev.text || "") };
    case "compact":
      return { type: "note", text: `context compacted: ${(ev.actions || []).length} change(s)` };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the /rc ----

/**
 * Handle `/rc`, `/rc off`, `/rc new` inside a REPL. Returns the session to use
 * from now on (or null). `ctx.info` describes the session to the browser.
 */
async function command(line, current, ctx) {
  const { c } = require("./ui");
  const arg = line.trim().split(/\s+/)[1] || "";
  const print = ctx.log || console.log;

  if (arg === "off" || arg === "stop") {
    if (!current) { print(`  ${c.dim("remote control is not on")}`); return null; }
    await current.close();
    print(`  ${c.green("✓")} remote control off`);
    return null;
  }
  if (arg && !["new", "rotate", "on", "status"].includes(arg)) {
    print(`  ${c.dim("/rc · /rc off · /rc new (new key, unpairs every device)")}`);
    return current;
  }

  const rotate = arg === "new" || arg === "rotate";
  if (current && !rotate) {
    showKey(print, current.relay, current.key, current);
    return current;
  }
  if (current) await current.close();

  const relay = relayUrl(ctx.cfg);
  const key = getKey({ rotate });
  const session = new RemoteSession({
    relay, key, info: ctx.info,
    onStatus: (t) => print(`\n  ${c.dim("⇄ " + t)}`),
  });
  try {
    await session.open();
  } catch (e) {
    print(`  ${c.red("✗")} could not reach the relay at ${relay}: ${e.message}`);
    print(`  ${c.dim("point ArcFlare at your site with:")} arcflare rc relay https://your-site`);
    return null;
  }
  if (rotate) print(`  ${c.green("✓")} new key — devices paired with the old one are cut off`);
  showKey(print, relay, key, session);
  return session;
}

function showKey(print, relay, key, session) {
  const { c } = require("./ui");
  print("");
  print(`  ${c.bold("Remote control on")} ${c.dim(session && session.connected ? "· relay connected" : "")}`);
  print(`  ${c.dim("key")}   ${c.accent(key)}`);
  print(`  ${c.dim("open")}  ${linkFor(relay, key)}`);
  print(`  ${c.dim("or paste the key at " + relay + "/remote · /rc off to stop")}`);
  print(`  ${c.dim("anyone with this key can use this session — treat it like a password")}`);
  print("");
}

module.exports = {
  RemoteSession, InputMux, command, toRemote, getKey, newKey, relayUrl, setRelay, linkFor, redact,
  loadStore, KEY_RE, DEFAULT_RELAY, STORE,
};
