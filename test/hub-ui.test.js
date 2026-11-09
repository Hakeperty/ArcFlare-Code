// The phone UI's own logic (lib/hub/ui/app.js), run in Node against a small stand-in for the DOM and a
// scripted transport. No browser: these cover state bugs (what the screen says after a race, what a second tap
// does), not layout. scripts/e2e-phone.js covers the real thing in Chromium.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "lib", "hub", "ui", "app.js"), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class Node_ {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.kids = []; this.parentElement = null; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.hidden = false; this.disabled = false; this.checked = false; this.value = ""; this.className = ""; this.text = "";
    this.subs = new Map(); this.isConnected = true;
    const self = this;
    this.classList = {
      add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + " " + c).trim(); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => { if (on === undefined ? !self.classList.contains(c) : on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  set textContent(v) { this.kids = []; this.text = String(v); }
  get children() { return this.kids.filter((k) => typeof k !== "string"); }
  get childNodes() { return this.kids; }
  get lastChild() { return this.kids[this.kids.length - 1] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get scrollHeight() { return 0; } get clientHeight() { return 0; }
  append(...n) { for (const k of n) { if (typeof k !== "string") k.parentElement = this; this.kids.push(k); } }
  prepend(...n) { this.kids.unshift(...n); }
  replaceChildren(...n) { this.kids = []; this.text = ""; this.append(...n); }
  remove() { if (this.parentElement) this.parentElement.kids = this.parentElement.kids.filter((k) => k !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  async fire(t, ev) {
    const e = Object.assign({ type: t, target: this, currentTarget: this, preventDefault() {} }, ev);
    await Promise.all((this.listeners[t] || []).map((fn) => fn(e)));
  }
  querySelector(sel) { if (!this.subs.has(sel)) this.subs.set(sel, new Node_("div")); return this.subs.get(sel); }
  querySelectorAll() { return []; }
  closest() { return null; }
  getClientRects() { return [1]; }
  focus() {} select() {} reset() {} requestSubmit() { return this.fire("submit"); }
}

/** Load app.js into a fresh page. `routes` answers fetches: (method, path, body) -> [status, json]. */
async function page(routes) {
  const byId = new Map();
  const calls = [];
  const streams = [];
  const document = {
    hidden: false, activeElement: null, body: new Node_("body"),
    getElementById(id) { if (!byId.has(id)) { const n = new Node_("div"); n.id = id; n.hidden = /^sheet-|^approval$/.test(id); byId.set(id, n); } return byId.get(id); },
    createElement: (t) => new Node_(t), createElementNS: (ns, t) => new Node_(t), createTextNode: (t) => String(t),
    addEventListener() {},
  };
  const winListeners = {};
  const window = {
    matchMedia: () => ({ matches: true }), // reduced motion: sheets close at once
    addEventListener: (t, fn) => { winListeners[t] = fn; },
    ArcFlareTransport: {
      fetch: async (p, init) => {
        const method = (init && init.method) || "GET";
        calls.push(method + " " + p);
        const [status, json] = (await routes(method, p, init && init.body ? JSON.parse(init.body) : null)) || [404, { error: "Not found" }];
        return { ok: status < 400, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
      },
      eventSource: (p) => { const es = { path: p, closed: false, close() { this.closed = true; } }; streams.push(es); return es; },
    },
  };
  const location = { hash: "" };
  const ctx = vm.createContext({
    window, document, location, navigator: { userAgent: "test" }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0), console, URLSearchParams, Date, Promise,
  });
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  await tick(5); // boot(): /api/me, then the first route
  return { $: (id) => document.getElementById(id), calls, streams, location, go: (hash) => { location.hash = hash; return winListeners.hashchange(); } };
}

const ME = [200, { user: { username: "sam", role: "owner" }, csrf: "c" }];
function signedIn(extra) {
  let out = false;
  return async (method, p, body) => {
    const r = extra && await extra(method, p, body, () => { out = true; });
    if (r) return r;
    if (p === "/api/me") return out ? [401, { error: "Not signed in" }] : ME;
    if (p === "/api/logout") { out = true; return [200, { ok: true }]; }
    if (p === "/api/agents" || p === "/api/questions" || p === "/api/models") return [200, []];
    return [404, { error: "Not found" }];
  };
}

test("log out: a stream that drops because of the log out does not replace 'Signed out.'", async () => {
  const ui = await page(signedIn());
  assert.strictEqual(ui.$("view-dashboard").hidden, false, "signed in, on the agent list");
  const dash = ui.streams.find((s) => s.path === "/api/events");
  assert.ok(dash, "the dashboard stream is open");
  // The hub ends the session's streams as part of the log out: the stream's error handler asks /api/me, which
  // answers 401 only after the log out itself has finished.
  const logout = ui.$("logout").fire("click");
  dash.onerror();
  await logout;
  await tick(5);
  assert.strictEqual(ui.$("view-login").hidden, false);
  assert.strictEqual(ui.$("login-error").textContent, "Signed out.");
});

test("sign in: a second tap while the first is still on its way sends nothing", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let logins = 0;
  const ui = await page(async (method, p) => {
    if (p === "/api/login") { logins++; await gate; return [401, { error: "Wrong username or password" }]; }
    if (p === "/api/status") return [200, { setup: true }];
    return [401, { error: "Not signed in" }];
  });
  const form = ui.$("login-form");
  const a = form.fire("submit");
  const b = form.fire("submit");
  await tick(5);
  assert.strictEqual(logins, 1, "one request for two taps");
  release();
  await Promise.all([a, b]);
  assert.strictEqual(ui.$("login-error").textContent, "Wrong username or password");
  assert.strictEqual(form.querySelector("button[type=submit]").disabled, false, "the button works again after the answer");
  await form.fire("submit");
  assert.strictEqual(logins, 2);
});

test("a link with a broken escape in the agent id opens the agent list instead of throwing", async () => {
  const ui = await page(signedIn());
  await ui.go("#/devices");
  assert.strictEqual(ui.$("view-devices").hidden, false);
  assert.doesNotThrow(() => ui.go("#/agent/%E0%A4%A"));
  assert.strictEqual(ui.$("view-dashboard").hidden, false, "the agent list, not a stale screen");
  await ui.go("#/agent/a%20b");
  assert.strictEqual(ui.$("view-agent").hidden, false, "a good escape still opens the agent");
  assert.ok(ui.streams.some((s) => s.path.startsWith("/api/agents/a%20b/events")));
});

test("a question that arrives while another sheet is open shows when that sheet closes", async () => {
  const ui = await page(signedIn());
  await ui.go("#/devices");
  await ui.$("revoke-others").fire("click");
  assert.strictEqual(ui.$("sheet-confirm").hidden, false);
  const dash = ui.streams.find((s) => s.path === "/api/events");
  dash.onmessage({ data: JSON.stringify({ type: "question", id: "00000000000000q1", from: "desk", question: "Mock the database?" }) });
  assert.strictEqual(ui.$("sheet-question").hidden, true, "not over the open sheet");
  await ui.$("confirm-cancel").fire("click");
  assert.strictEqual(ui.$("sheet-confirm").hidden, true);
  await tick(400);
  assert.strictEqual(ui.$("sheet-question").hidden, false, "the question is on screen");
  assert.strictEqual(ui.$("question-text").textContent, "Mock the database?");
});
