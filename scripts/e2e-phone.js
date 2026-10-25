#!/usr/bin/env node
// End-to-end test of the ArcFlare hub phone UI in an emulated Android phone.
//
//   npm run e2e:phone
//
// Not part of `npm test`. It needs Playwright and Chromium to be resolvable
// (`require('playwright')`); if they are not, it prints "skipped" and exits 0.
// Nothing is installed and no dependency is added to the repo.
//
// What runs: the REAL AuthStore, Supervisor and createHubServer, in this
// process, on 127.0.0.1 with an ephemeral port, a temp ARCFLARE_HOME and a temp
// root folder. Only the model side is faked (a scripted agent and a backend
// stub), exactly as test/hub-supervisor.test.js does. Each profile (device x
// colour scheme) gets its own hub, so every profile starts from zero accounts.
//
// Profiles: Pixel 7 and Galaxy S9+ (a 320px wide phone), each in light and dark.
// Every numbered flow runs in every profile; a flow prints PASS only if it
// passed in all of them. Selectors are ids, input types and visible text only,
// never CSS classes, so a restyle does not break it.
//
// Env: E2E_SHOTS=<dir> screenshot directory (default <tmp>/arcflare-e2e-shots),
//      E2E_SERIAL=1 run the profiles one after another instead of in parallel,
//      E2E_ONLY=<substring of profile id> run a subset.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

let pw;
try { pw = require("playwright"); } catch (e) {
  console.log("skipped: playwright not available");
  process.exit(0);
}
const { chromium, devices } = pw;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-e2e-phone-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), "arcflare-e2e-shots");
fs.mkdirSync(SHOTS, { recursive: true });

const { AuthStore } = require("../lib/hub/auth");
const { Supervisor } = require("../lib/hub/supervisor");
const { createHubServer } = require("../lib/hub/server");

const USER = "phoneuser";
const PASS = "correct horse battery staple";
const LONG_APPROVAL_MS = 10 * 60 * 1000;
// Markup, a script tag, backticks, a right-to-left override, zero-width chars.
const HOST = "<img src=x onerror=window.__x=1>\"><script>`id`\u202eevil\u200b\u200d";
const HOST_DIR = "h<img src=x onerror=window.__x=1>\"><script>`x`\u202e\u200b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the fake model --

function makeGate() {
  const g = { p: Promise.resolve(), _rel: () => {} };
  g.arm = () => { g.p = new Promise((r) => { g._rel = r; }); };
  g.release = () => g._rel();
  return g;
}

/** Scripted agent, after test/hub-supervisor.test.js. */
function fakeFactory(log, gate) {
  return (o) => {
    const a = {
      opts: o, messages: [], busy: false, loaded: null, aborted: 0,
      conversation() { return this.messages.slice(); },
      loadConversation(m) { this.loaded = m; this.messages = m.slice(); },
      abort() { this.aborted++; if (this._release) this._release(); },
      async send(text) {
        this.busy = true;
        try {
          this.messages.push({ role: "user", content: text });
          if (text.startsWith("ask:")) {
            const cmd = text.slice(4);
            const ok = await o.approve("bash", cmd);
            const out = `result: ${ok ? "ran" : "denied"} [${cmd.slice(0, 40)}]`;
            o.onEvent({ type: "content", text: out });
            this.messages.push({ role: "assistant", content: out });
            return { ok: true, content: out };
          }
          if (text === "rich:") {
            o.onEvent({ type: "reasoning", text: "The user wants a summary. I will list the files first, then check the build output." });
            o.onEvent({ type: "content", text: "I looked at `package.json` and the build log.\n\nHere is the failing command:\n\n```bash\nnpm run build -- --config ./configs/production/webpack.config.js --env target=android --progress --profile --json > /tmp/stats.json\n```\n\nIt fails on the second step, so I will check the config." });
            o.onEvent({ type: "tool", name: "bash", args: { command: "cd /home/user/project && npm run build -- --config ./configs/production/webpack.config.js 2>&1 | tail -n 40" } });
            o.onEvent({ type: "tool_result", name: "bash", out: "ERROR: exit code 1\nat step 2\nat step 3" });
            o.onEvent({ type: "content", text: "The build failed with a non-zero exit code." });
            this.messages.push({ role: "assistant", content: "rich done" });
            return { ok: true, content: "The build failed with a non-zero exit code." };
          }
          if (text === "hang") {
            await new Promise((r) => { this._release = r; });
            this.messages.push({ role: "assistant", content: "[interrupted by the user]" });
            return { ok: false, aborted: true };
          }
          if (text.startsWith("ticks:")) {
            const tag = text.slice(6);
            const tick = (i) => o.onEvent({ type: "tool", name: "tick", args: { name: `${tag}-${i}` } });
            for (let i = 1; i <= 6; i++) tick(i);
            await gate.p;
            for (let i = 7; i <= 12; i++) tick(i);
            return { ok: true, content: "ticks done" };
          }
          o.onEvent({ type: "content", text: `echo ${text}` });
          const hostile = text.includes("onerror");
          o.onEvent({ type: "tool", name: "read_file", args: { path: hostile ? text : "a.txt" } });
          o.onEvent({ type: "tool_result", name: "read_file", out: hostile ? `${text}\nsecond line` : "hello\nworld" });
          o.onEvent({ type: "content", text: "done" });
          this.messages.push({ role: "assistant", content: `echo ${text}` });
          return { ok: true, content: `echo ${text}` };
        } finally { this.busy = false; }
      },
    };
    log.push({ made: a });
    return a;
  };
}

const backend = async (tier) => ({ port: 1, model: `m-${tier}`, nCtx: 4096, modelRef: `ref-${tier}` });

// ------------------------------------------------------------------- the hub --

async function startServer(H, port) {
  const hub = createHubServer({
    auth: H.auth, supervisor: H.sup,
    config: { roots: [H.root], heartbeatMs: 2000 },
  });
  hub.server.on("connection", (s) => { H.sockets.add(s); s.on("close", () => H.sockets.delete(s)); });
  const info = await hub.listen({ port, host: "127.0.0.1" });
  H.hub = hub;
  H.port = info.port;
  H.url = `http://127.0.0.1:${info.port}`;
}

async function bootHub(id) {
  const dir = path.join(TMP, id);
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  const proj = path.join(root, "proj");
  for (const d of [proj, outside, path.join(root, HOST_DIR)]) fs.mkdirSync(d, { recursive: true });
  // A controllable clock so the lockout wait is exact instead of racing real time.
  const clock = {
    base: null, skew: 0,
    now() { return this.base != null ? this.base : Date.now() + this.skew; },
    freeze() { this.base = this.now(); },
    thaw(advanceMs) { const b = this.base; this.skew = b + advanceMs - Date.now(); this.base = null; },
  };
  const H = { id, dir, root, outside, proj, clock, sockets: new Set(), log: [], gate: makeGate() };
  H.auth = new AuthStore({ dir: path.join(dir, "hub"), now: () => clock.now() });
  H.sup = new Supervisor({
    dir: path.join(dir, "hub"), roots: [root], backend,
    makeAgent: fakeFactory(H.log, H.gate), approveTimeoutMs: LONG_APPROVAL_MS,
  });
  await startServer(H, 0);
  return H;
}

// -------------------------------------------------------------- page helpers --

const sameOrigin = (u, base) => {
  try {
    const x = new URL(u);
    return x.origin === new URL(base).origin || ["data:", "blob:", "about:"].includes(x.protocol);
  } catch { return false; }
};

async function newCtx(P) {
  const ctx = await P.browser.newContext({ ...P.device, colorScheme: P.scheme });
  ctx.setDefaultTimeout(10000);
  // The no-internet guarantee: anything that is not the hub is refused and noted.
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (sameOrigin(u, P.H.url)) return route.continue();
    P.blocked.push(u);
    return route.abort();
  });
  ctx.on("request", (r) => P.requests.push(r.url()));
  ctx.on("response", (r) => P.responses.push({ url: r.url(), status: r.status() }));
  const page = await ctx.newPage();
  page.on("dialog", (d) => { P.dialogs.push(`${d.type()}:${d.message()}`); d.accept().catch(() => {}); });
  page.on("pageerror", (e) => P.pageErrors.push(String(e && e.message || e)));
  return { ctx, page };
}

const visible = (page, sel, o) => page.locator(sel).waitFor({ state: "visible", ...o });
const hidden = (page, sel, o) => page.locator(sel).waitFor({ state: "hidden", ...o });
const textOf = (page, sel) => page.locator(sel).evaluate((n) => n.textContent);
const waitTx = (page, text, timeout) => page.waitForFunction(
  (t) => document.getElementById("transcript").textContent.includes(t), text, { timeout: timeout || 10000 });
const waitStatus = (page, re) => page.locator("#agent-status", { hasText: re }).waitFor({ state: "visible" });
const card = (page, name) => page.locator("#agent-list li", { hasText: name });
const tab = (page, label) => page.locator("#bottomnav a", { hasText: label });

/** Open the card's overflow menu (a bottom sheet) and tap one of its actions. */
async function cardMenu(page, name, action) {
  await card(page, name).getByRole("button", { name: /more actions/i }).tap();
  await visible(page, "#sheet-menu");
  await page.locator("#sheet-menu button", { hasText: new RegExp(`^\\s*${action}\\s*$`) }).tap();
  await hidden(page, "#sheet-menu");
}

/** Open the New agent sheet from the floating button. */
async function openNewSheet(page) {
  await page.locator("#fab-new").tap();
  await visible(page, "#sheet-new");
  await visible(page, "#new-name");
}

async function fillLogin(page, user, pass) {
  await page.locator("#login-user").fill(user);
  await page.locator("#login-pass").fill(pass);
}

/** Submit the sign-in form and return the error text it ends up showing. */
async function tryLogin(page, user, pass) {
  await fillLogin(page, user, pass);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/login")),
    page.locator("#login-form button[type=submit]").tap(),
  ]);
  await page.waitForFunction(() => !document.getElementById("login-error").hidden);
  return (await textOf(page, "#login-error")).trim();
}

async function login(page) {
  await fillLogin(page, USER, PASS);
  await page.locator("#login-form button[type=submit]").tap();
  await visible(page, "#view-dashboard", { timeout: 15000 });
}

const goHash = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

async function openAgentView(P, page, name) {
  await goHash(page, "#/");
  await visible(page, "#view-dashboard");
  await cardMenu(page, name, "Wake");
  await visible(page, "#view-agent");
}

async function send(page, text) {
  await page.locator("#compose-text").fill(text);
  await page.locator("#compose button[type=submit]").tap();
}

/** Layout rules, measured in the page. Returns a list of problems. */
function measureLayout(expectDark) {
  const issues = [];
  const de = document.documentElement, b = document.body;
  if (de.scrollWidth > de.clientWidth) issues.push(`page scrolls sideways (scrollWidth ${de.scrollWidth} > ${de.clientWidth})`);
  if (b.scrollWidth > b.clientWidth) issues.push(`body overflows (scrollWidth ${b.scrollWidth} > ${b.clientWidth})`);
  if (de.scrollWidth > de.clientWidth) {
    const wide = [...document.querySelectorAll("body *")].filter((n) => (n.checkVisibility ? n.checkVisibility() : true) && n.getBoundingClientRect().right > de.clientWidth + 0.5);
    for (const n of wide.slice(0, 3)) issues.push(`  wider than screen: <${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}> right=${n.getBoundingClientRect().right.toFixed(0)}`);
  }
  const y = window.scrollY;
  window.scrollTo(80, y);
  if (window.scrollX !== 0) issues.push("page can be scrolled horizontally");
  window.scrollTo(0, y);
  if (window.matchMedia("(prefers-color-scheme: dark)").matches !== expectDark) issues.push("colour scheme not applied to the page");
  const rgb = (getComputedStyle(b).backgroundColor.match(/[\d.]+/g) || [255, 255, 255]).map(Number);
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (expectDark ? lum > 0.35 : lum < 0.65) issues.push(`body background is ${getComputedStyle(b).backgroundColor}, wrong for ${expectDark ? "dark" : "light"}`);
  const vis = (n) => (n.checkVisibility ? n.checkVisibility() : n.offsetParent !== null);
  const tapLinks = new Set(["", "Open", "Agents", "Devices"]);
  for (const n of [...document.querySelectorAll("[style]")].filter((x) => x.getAttribute("style").trim()).slice(0, 3)) issues.push(`inline style attribute on <${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}>: ${n.getAttribute("style")}`);
  for (const sel of ["main", ".view", "#transcript", ".sheet", ".bottomnav", ".topbar"]) {
    for (const n of document.querySelectorAll(sel)) {
      if (!(n.checkVisibility ? n.checkVisibility() : true)) continue;
      if (n.scrollWidth > n.clientWidth + 1) issues.push(`${sel} scrolls sideways (${n.scrollWidth} > ${n.clientWidth})`);
    }
  }
  const nav = document.getElementById("bottomnav");
  if (nav && !nav.hidden) {
    for (const a of nav.querySelectorAll("a")) {
      if (a.getBoundingClientRect().height < 55.9) issues.push(`nav tab ${a.textContent.trim()} is ${a.getBoundingClientRect().height}px tall, want 56`);
    }
    if (Math.abs(nav.getBoundingClientRect().bottom - window.innerHeight) > 1) issues.push("bottom nav is not at the bottom of the screen");
  }
  for (const n of document.querySelectorAll("body *")) {
    if (!(n.checkVisibility ? n.checkVisibility() : true)) continue;
    const ff = getComputedStyle(n).fontFamily;
    if (/Bitcount/i.test(ff) && !n.closest(".wordmark, .pixel-head")) issues.push(`pixel font outside the wordmark/empty headline on <${n.tagName.toLowerCase()}>`);
  }
  for (const n of document.querySelectorAll("button, input, select, textarea, a[href]")) {
    if (n.tagName === "INPUT" && n.type === "hidden") continue;
    if (!vis(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const label = `${n.tagName.toLowerCase()}#${n.id || ""}"${(n.textContent || n.getAttribute("placeholder") || n.type || "").trim().slice(0, 24)}"`;
    if (n.tagName === "A" && !tapLinks.has((n.textContent || "").trim())) continue;
    if (r.height < 43.9 || r.width < 43.9) issues.push(`touch target too small ${label} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
    if (r.right > window.innerWidth + 0.5 || r.left < -0.5) issues.push(`${label} sticks out of the screen`);
    if (["INPUT", "TEXTAREA", "SELECT"].includes(n.tagName) && !["checkbox", "radio"].includes(n.type)) {
      const fs = parseFloat(getComputedStyle(n).fontSize);
      if (fs < 16) issues.push(`font-size ${fs}px under 16px on ${label}`);
    }
  }
  return issues;
}

/** Full-page screenshot plus the layout rules for one screen. */
async function screen(P, page, name) {
  await page.waitForTimeout(120);
  // Measure a settled layout: wait for every animation that has an end (sheet
  // slide-ins, the button entrance), but not the endless ones (cursor blink,
  // progress pulse). Capped, so a stuck animation cannot hang the run.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
      .filter((a) => { try { return a.effect.getComputedTiming().iterations !== Infinity; } catch (e) { return false; } })
      .map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, 1500)),
  ]));
  const issues = await page.evaluate(measureLayout, P.scheme === "dark");
  P.layout.push({ name, issues });
  P.screens.add(name);
  await page.screenshot({ path: path.join(SHOTS, `${P.id}-${name}.png`), fullPage: false });
}

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
  });
}

// --------------------------------------------------------------------- flows --

const flows = [];
const flow = (n, title, fn) => flows.push({ n, title, fn });

flow(1, "unauthenticated load: login; no accounts shows the setup message", async (P) => {
  const { page, H } = P;
  P.step("no accounts: load");
  await page.goto(H.url + "/");
  await visible(page, "#view-login");
  await visible(page, "#login-note");
  const note = (await textOf(page, "#login-note")).replace(/\s+/g, " ").trim();
  assert.match(note, /computer/i, `setup note should say to use the computer: ${note}`);
  assert.match(note, /arcflare phone user add/, `setup note should name the add-user command: ${note}`);
  P.notes.add(`setup message is: "${note}"`);
  await hidden(page, "#login-fields");
  await hidden(page, "#topbar");
  await hidden(page, "#bottomnav");
  await hidden(page, "#view-dashboard");
  assert.ok(await page.locator("#login-note code").isVisible(), "the setup command is shown in code style");
  await screen(P, page, "login-setup");
  P.step("api answers 401 without a session");
  const st = await page.evaluate(() => fetch("/api/agents").then((r) => r.status));
  assert.strictEqual(st, 401);

  P.step("account exists: login form");
  H.auth.createAccount(USER, PASS);
  await page.reload();
  await visible(page, "#login-fields");
  await hidden(page, "#login-note");
  await visible(page, "#login-user");
  await visible(page, "#login-pass");
  const btn = (await textOf(page, "#login-form button[type=submit]")).trim();
  assert.match(btn, /^(Log in|Sign in)$/);
  if (btn !== "Log in") P.notes.add(`login button text is "${btn}", not "Log in"`);
  await hidden(page, "#topbar");
  await goHash(page, "#/devices");
  await visible(page, "#view-login");           // a deep link does not skip sign-in
  await hidden(page, "#view-devices");
  await goHash(page, "#/");
  await screen(P, page, "login");
});

flow(2, "wrong password: generic error, then lockout with the wait time", async (P) => {
  const { page, H } = P;
  P.step("generic error");
  const a = await tryLogin(page, "nobody", "whatever-password-1");
  const b = await tryLogin(page, USER, "wrong-password-1");
  assert.strictEqual(a, b, "unknown user and wrong password must read the same");
  assert.match(b, /wrong|incorrect|invalid/i);
  assert.ok(!/exist|no such|unknown user/i.test(b), `error leaks account info: ${b}`);
  P.step("lockout");
  H.clock.freeze();                             // the wait is exact while frozen
  let msg = "";
  for (let i = 0; i < 8; i++) {
    msg = await tryLogin(page, USER, `wrong-password-${i + 2}`);
    if (/too many|try again/i.test(msg)) break;
  }
  const m = /try again in (\d+) seconds?/i.exec(msg);
  assert.ok(m, `no lockout message with a wait time, last message: "${msg}"`);
  assert.ok(Number(m[1]) >= 1);
  const again = await tryLogin(page, USER, PASS);
  assert.match(again, /too many|try again/i, "the right password must not get in during a lockout");
  await visible(page, "#login-fields");
  await screen(P, page, "login-locked");
  H.clock.thaw(30000);
});

flow(3, "login lands on dashboard; session survives reload; nothing secret in JS reach", async (P) => {
  const { page, ctx } = P;
  P.step("login");
  await login(page);
  await visible(page, "#topbar");
  await visible(page, "#dash-empty");
  await screen(P, page, "dashboard-empty");
  assert.strictEqual(await textOf(page, "#login-pass").catch(() => ""), "");
  P.step("storage and cookies");
  const me = await page.evaluate(() => fetch("/api/me").then((r) => r.json()));
  assert.ok(me.csrf && me.csrf.length >= 16, "csrf token present");
  const dump = async () => page.evaluate(() => ({
    cookie: document.cookie,
    ls: JSON.stringify(Object.entries(localStorage)),
    ss: JSON.stringify(Object.entries(sessionStorage)),
    html: document.documentElement.outerHTML,
    pass: document.getElementById("login-pass").value,
  }));
  let d = await dump();
  assert.strictEqual(d.cookie, "", "document.cookie must be empty (HttpOnly)");
  for (const k of ["ls", "ss", "cookie", "html"]) {
    assert.ok(!d[k].includes(PASS), `password found in ${k}`);
    assert.ok(!d[k].includes(me.csrf), `csrf token found in ${k}`);
  }
  assert.strictEqual(d.pass, "");
  const cookies = await ctx.cookies();
  const sid = cookies.find((c) => /arcflare/.test(c.name));
  assert.ok(sid, "session cookie set");
  assert.ok(sid.httpOnly, "session cookie is HttpOnly");
  assert.strictEqual(sid.sameSite, "Strict");
  for (const k of ["ls", "ss"]) assert.ok(!d[k].includes(sid.value), `session token found in ${k}`);
  const noCsrf = await page.evaluate(() => fetch("/api/agents", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.status));
  assert.strictEqual(noCsrf, 403, "a write without the CSRF token is refused");
  P.step("reload");
  await page.reload();
  await visible(page, "#view-dashboard");
  await hidden(page, "#view-login");
  d = await dump();
  assert.strictEqual(d.cookie, "");
});

flow(4, "create agent: valid folder, folder outside roots rejected, tiers", async (P) => {
  const { page, H } = P;
  await visible(page, "#view-dashboard");
  P.step("open the New agent sheet from the + button");
  await hidden(page, "#sheet-new");
  await openNewSheet(page);
  assert.strictEqual(await page.evaluate(() => document.getElementById("sheet-new").contains(document.activeElement)), true, "focus moves into the sheet");
  assert.strictEqual(await page.evaluate(() => document.getElementById("app").hasAttribute("inert")), true, "the app behind the sheet is inert");
  assert.match(await textOf(page, "#sheet-new"), /Hard is reserved for the toughest tasks/);
  const tiers = await page.locator("#new-form input[name=tier]").evaluateAll((o) => o.map((x) => x.value));
  assert.deepStrictEqual(tiers, ["light", "standard", "hard"]);
  assert.strictEqual(await page.locator("#new-form input[name=tier]:checked").getAttribute("value"), "standard");
  await screen(P, page, "new-sheet");
  P.step("Esc closes the sheet, the + button reopens it");
  await page.keyboard.press("Escape");
  await hidden(page, "#sheet-new");
  await openNewSheet(page);
  P.step("rejected folders");
  const before = await page.locator("#agent-list li").count();
  const bad = [H.outside, path.join(H.root, "..", "outside"), path.join(H.root, "nope"), "relative/dir"];
  for (const cwd of bad) {
    await page.locator("#new-name").fill("bad");
    await page.locator("#new-cwd").fill(cwd);
    await page.locator("#new-submit").tap();
    await visible(page, "#new-error");
    assert.match(await textOf(page, "#new-error"), /folder/i, `error for ${cwd}`);
    assert.ok(!(await textOf(page, "#new-error")).includes(H.dir), "error must not leak server paths");
  }
  await visible(page, "#sheet-new");
  assert.strictEqual(await page.locator("#agent-list li").count(), before, "nothing was created");
  P.step("valid folder");
  await page.locator("#new-name").fill("alpha");
  await page.locator("#new-cwd").fill(H.proj);
  await page.locator("#new-form label.seg", { hasText: /^Light$/ }).tap();
  assert.strictEqual(await page.locator("#new-form input[name=tier]:checked").getAttribute("value"), "light");
  await page.locator("#new-submit").tap();
  await hidden(page, "#sheet-new");
  await visible(page, "#agent-list li");
  const c = card(page, "alpha");
  await c.waitFor();
  const t = await c.textContent();
  assert.ok(t.includes(fs.realpathSync(H.proj)), "card shows the folder");
  assert.match(t, /light/);
  assert.match(t, /Stopped/);
  await hidden(page, "#new-error");
  await screen(P, page, "dashboard");
});

flow(5, "Start, Wake, streamed text, tool line and tool result", async (P) => {
  const { page } = P;
  P.step("start");
  await card(page, "alpha").locator("button", { hasText: /^Start$/ }).tap();
  await card(page, "alpha").filter({ hasText: "Ready" }).waitFor();
  P.step("wake");
  assert.strictEqual(await card(page, "alpha").locator("a", { hasText: /^Open$/ }).count(), 1, "a running agent's primary action is Open");
  assert.strictEqual(await card(page, "alpha").locator("button", { hasText: /^Start$/ }).count(), 0);
  await cardMenu(page, "alpha", "Wake");
  await visible(page, "#view-agent");
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), "compose-text", "Wake focuses the message box");
  assert.strictEqual(await page.locator("#compose-send").isDisabled(), true, "send is disabled while the box is empty");
  assert.strictEqual((await textOf(page, "#agent-name")).trim(), "alpha");
  await send(page, "hello");
  await waitTx(page, "done");
  const tx = await textOf(page, "#transcript");
  const iTool = tx.indexOf("read_file a.txt");
  const order = [tx.indexOf("echo hello"), iTool, tx.indexOf("hello", iTool + 15), tx.lastIndexOf("done")];
  assert.ok(iTool >= 0 && order.every((i) => i >= 0), `transcript is missing a part: ${JSON.stringify(tx)}`);
  assert.deepStrictEqual(order, [...order].sort((x, y) => x - y), "transcript parts are in order");
  P.step("tool chip expands to its result");
  const chip = page.locator("#transcript details.tool").first();
  assert.strictEqual(await chip.evaluate((d) => d.open), false, "tool chips start collapsed");
  await chip.locator("summary").tap();
  assert.strictEqual(await chip.evaluate((d) => d.open), true);
  assert.match(await chip.textContent(), /hello/);
  P.step("rich message: thinking chip, code block, error chip");
  await send(page, "rich:");
  await waitTx(page, "non-zero exit code");
  await waitStatus(page, /^Ready$/);
  const rich = await page.evaluate(() => {
    const tx = document.getElementById("transcript");
    const pre = [...tx.querySelectorAll("pre")].pop();
    const think = tx.querySelector("details:not([class*=tool])") || tx.querySelectorAll("details")[1];
    const codes = [...tx.querySelectorAll("p code")].map((c) => c.textContent);
    return {
      preScrolls: pre.scrollWidth > pre.clientWidth, preText: pre.textContent,
      thinkOpen: think && think.open, thinkText: think && think.querySelector("summary").textContent.trim(),
      codes, errChip: !![...tx.querySelectorAll("details")].find((d) => d.open && /exit code 1/.test(d.textContent)),
      innerHTMLish: tx.querySelectorAll("script, img, [onerror]").length,
    };
  });
  const atBottom = await page.evaluate(() => { const t = document.getElementById("transcript"); return t.scrollHeight - t.scrollTop - t.clientHeight; });
  assert.ok(atBottom < 4, `the conversation follows new output to the bottom (${atBottom}px short)`);
  assert.ok(rich.preScrolls, "a long code line scrolls horizontally inside its block");
  assert.match(rich.preText, /webpack\.config\.js/);
  assert.strictEqual(rich.thinkText, "Thinking");
  assert.strictEqual(rich.thinkOpen, false, "reasoning is collapsed under a Thinking chip");
  assert.ok(rich.codes.includes("package.json"), "inline code renders as code");
  assert.ok(rich.errChip, "a failed tool call opens its result");
  await screen(P, page, "agent-rich");
  const side = await page.evaluate(() => {
    const u = [...document.querySelectorAll("#transcript .bubble.user")].pop().getBoundingClientRect();
    const a = [...document.querySelectorAll("#transcript .bubble.agent")].pop().getBoundingClientRect();
    return { userRight: window.innerWidth - u.right, userLeft: u.left, agentLeft: a.left, agentRight: window.innerWidth - a.right };
  });
  assert.ok(side.userRight < side.userLeft, "user bubbles sit on the right");
  assert.ok(side.agentLeft < side.agentRight, "agent bubbles sit on the left");
  await waitStatus(page, /^Ready$/);
  await screen(P, page, "agent");
});

flow(6, "approvals: full command, Deny, Allow, timeout", async (P) => {
  const { page, H } = P;
  const cmd = "rm -rf ./build && echo \"done\" | tee log.txt # 'x'";
  await send(page, "ask:" + cmd);
  await visible(page, "#approval");
  assert.strictEqual(await textOf(page, "#approval-detail"), cmd, "the full command is shown");
  assert.match(await textOf(page, "#approval-kind"), /bash/);
  assert.match(await textOf(page, "#approval-title"), /Allow this command\?/);
  P.step("modal: focus inside, app inert, Esc and the backdrop do not answer");
  assert.strictEqual(await page.evaluate(() => document.getElementById("approval").querySelector(".sheet").contains(document.activeElement)), true, "focus is inside the approval sheet");
  assert.strictEqual(await page.evaluate(() => document.getElementById("app").hasAttribute("inert")), true, "the app behind is inert");
  const order = await page.evaluate(() => {
    const d = document.getElementById("approve-deny").getBoundingClientRect();
    const a = document.getElementById("approve-allow").getBoundingClientRect();
    return d.left < a.left && Math.abs(d.top - a.top) < 2 && d.height >= 55.9 && a.height >= 55.9;
  });
  assert.ok(order, "Deny sits left of Allow, both 56px tall, side by side");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await page.waitForTimeout(350);
  assert.strictEqual(await page.locator("#approval").isVisible(), true, "Esc or a tap outside must not dismiss (or approve) the sheet");
  assert.strictEqual(await page.evaluate(() => fetch("/api/agents").then((r) => r.status)), 200);
  assert.ok(!(await textOf(page, "#transcript")).includes("Allowed"), "nothing was approved");
  P.step("deny");
  const st = (await textOf(page, "#agent-status")).trim();
  assert.match(st, /needs approval/i, "status shows that an approval is needed");
  // The two answers are the most important buttons on screen: each label must
  // sit on one line (not "ALLO / W") and inside the viewport, even at 320px.
  const fit = await page.evaluate(() => ["approve-deny", "approve-allow"].map((id) => {
    const b = document.getElementById(id);
    const r = document.createRange();
    r.selectNodeContents(b);
    const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top / 3)));
    const box = b.getBoundingClientRect();
    return { id, lines: tops.size, inside: box.left >= 0 && box.right <= window.innerWidth, clipped: b.scrollWidth > b.clientWidth + 1 };
  }));
  for (const f of fit) {
    assert.strictEqual(f.lines, 1, `${f.id} label wraps onto ${f.lines} lines`);
    assert.ok(f.inside && !f.clipped, `${f.id} is clipped or off screen`);
  }
  await screen(P, page, "agent-approval");
  await page.locator("#approve-deny").tap();
  await hidden(page, "#approval");
  await waitTx(page, "Denied");
  await waitTx(page, "result: denied [rm -rf");
  await waitStatus(page, /^Ready$/);
  P.step("allow");
  await send(page, "ask:ls -la");
  await visible(page, "#approval");
  assert.strictEqual(await textOf(page, "#approval-detail"), "ls -la");
  await page.locator("#approve-allow").tap();
  await hidden(page, "#approval");
  await waitTx(page, "Allowed");
  await waitTx(page, "result: ran [ls -la]");
  await waitStatus(page, /^Ready$/);
  P.step("timeout");
  H.sup.approveTimeoutMs = 2500;
  try {
    await send(page, "ask:sleep 99");
    await visible(page, "#approval");
    await hidden(page, "#approval", { timeout: 8000 });
    await waitTx(page, "timed out");
    await waitTx(page, "result: denied [sleep 99]");
    await waitStatus(page, /^Ready$/);
  } finally { H.sup.approveTimeoutMs = LONG_APPROVAL_MS; }
  const asked = H.log.filter((l) => l.made).pop().made;
  assert.ok(asked, "agent exists");
});

flow(7, "Stop, status change, Start resumes", async (P) => {
  const { page, H } = P;
  P.step("stop from the agent screen");
  await send(page, "hang");
  await waitStatus(page, /^Working$/);
  await page.locator("#agent-stop").tap();
  await waitStatus(page, /^Stopped$/);
  P.step("dashboard shows it stopped");
  await page.locator("#agent-back").tap();
  await visible(page, "#view-dashboard");
  await card(page, "alpha").filter({ hasText: "Stopped" }).waitFor();
  await card(page, "alpha").locator("button", { hasText: /^Start$/ }).tap();
  await card(page, "alpha").filter({ hasText: "Ready" }).waitFor();
  P.step("stop from the dashboard, start again");
  await cardMenu(page, "alpha", "Stop");
  await card(page, "alpha").filter({ hasText: "Stopped" }).waitFor();
  await card(page, "alpha").locator("button", { hasText: /^Start$/ }).tap();
  await card(page, "alpha").filter({ hasText: "Ready" }).waitFor();
  P.step("resumed conversation");
  await cardMenu(page, "alpha", "Wake");
  await visible(page, "#view-agent");
  await waitTx(page, "echo hello");               // the history survived the stop
  await send(page, "resumed");
  await waitTx(page, "echo resumed");
  const a = H.log.filter((l) => l.made).pop().made;
  assert.ok(a.loaded && a.loaded.some((m) => m.content === "hello"), "agent reloaded its saved conversation");
  await waitStatus(page, /^Ready$/);
});

flow(8, "devices: list, second device, Revoke, sign out others, Log out", async (P) => {
  const { page, H } = P;
  const nav = async (label) => tab(page, label).tap();
  const refreshDevices = async () => { await nav("Agents"); await visible(page, "#view-dashboard"); await nav("Devices"); await visible(page, "#view-devices"); };
  P.step("this device");
  await nav("Devices");
  await visible(page, "#view-devices");
  await page.locator("#session-list li").first().waitFor();
  assert.strictEqual(await page.locator("#session-list li").count(), 1);
  const row = await page.locator("#session-list li").first().textContent();
  assert.match(row, /This device/);
  assert.match(row, /Android|Pixel|Mobile/i);
  P.step("second device appears");
  const second = await newCtx(P);
  await second.page.goto(H.url + "/");
  await login(second.page);
  await refreshDevices();
  await page.locator("#session-list li").nth(1).waitFor();
  assert.strictEqual(await page.locator("#session-list li").count(), 2);
  assert.strictEqual(await page.locator("#session-list li", { hasText: "This device" }).count(), 1);
  await screen(P, page, "devices");
  P.step("revoke kicks the second device");
  const t0 = Date.now();
  await page.locator("#session-list li", { hasText: "Revoke" }).locator("button", { hasText: "Revoke" }).tap();
  await visible(second.page, "#view-login", { timeout: 2500 });
  const took = Date.now() - t0;
  assert.ok(took < 2500, `second device took ${took}ms to be signed out`);
  assert.match(await textOf(second.page, "#login-error"), /session ended|sign in/i);
  await page.locator("#session-list li").nth(1).waitFor({ state: "detached" });
  assert.strictEqual(await page.locator("#session-list li").count(), 1);
  P.step("sign out other devices");
  await login(second.page);
  await refreshDevices();
  await page.locator("#session-list li").nth(1).waitFor();
  const dialogsBefore = P.dialogs.length;
  await page.locator("#revoke-others").tap();
  await visible(page, "#sheet-confirm");
  await page.locator("#confirm-cancel").tap();
  await hidden(page, "#sheet-confirm");
  assert.strictEqual(await page.locator("#session-list li").count(), 2, "cancel keeps the other device signed in");
  await screen(P, page, "devices-confirm-prep");
  await page.locator("#revoke-others").tap();
  await visible(page, "#sheet-confirm");
  await screen(P, page, "devices-confirm");
  await page.locator("#confirm-ok").tap();
  await visible(second.page, "#view-login", { timeout: 2500 });
  assert.deepStrictEqual(P.dialogs.slice(dialogsBefore), [], "the confirmation is an in-page sheet, not a browser dialog");
  await page.locator("#session-list li").nth(1).waitFor({ state: "detached" });
  assert.strictEqual(await page.locator("#session-list li").count(), 1);
  await second.ctx.close();
  P.step("log out");
  const sid = (await P.ctx.cookies()).find((c) => /arcflare/.test(c.name));
  await page.locator("#logout").tap();
  await visible(page, "#view-login");
  const bye = await textOf(page, "#login-error");
  assert.match(bye, /signed out|session ended/i);
  if (!/signed out/i.test(bye)) P.notes.add(`after Log out the message is sometimes "${bye}" instead of "Signed out." (the closing stream races the logout handler)`);
  assert.strictEqual(await page.evaluate(() => fetch("/api/me").then((r) => r.status)), 401, "API answers 401 after logout");
  assert.strictEqual(await rawRequest(H.url + "/api/me", { Cookie: `${sid.name}=${sid.value}` }), 401, "the old cookie is dead on the server");
  assert.ok(!(await P.ctx.cookies()).some((c) => c.name === sid.name && c.value), "cookie cleared");
  P.step("sign back in");
  await goHash(page, "#/");
  await login(page);
});

flow(9, "stream reconnect: dropped sockets and a server restart lose and repeat nothing", async (P) => {
  const { page, H } = P;
  const ticks = async (tag) => {
    const tx = await textOf(page, "#transcript");
    return [...tx.matchAll(new RegExp(`tick (${tag}-\\d+)`, "g"))].map((m) => m[1]);
  };
  const want = (tag) => Array.from({ length: 12 }, (_, i) => `${tag}-${i + 1}`);
  await openAgentView(P, page, "alpha");
  await waitStatus(page, /^Ready$/);

  P.step("A: connections destroyed");
  H.gate.arm();
  await send(page, "ticks:A");
  await waitTx(page, "A-6");
  const mark = P.requests.length;
  for (const s of [...H.sockets]) s.destroy();
  H.gate.release();                               // the rest is emitted while the phone is cut off
  await waitTx(page, "A-12", 25000);
  await waitStatus(page, /^Ready$/);
  assert.deepStrictEqual(await ticks("A"), want("A"), "A ticks: each exactly once, in order");
  assert.ok(P.requests.slice(mark).some((u) => /\/events\?after=[1-9]\d*/.test(u)), "the stream resumed from the last seq");

  P.step("B: server restarted");
  H.gate.arm();
  await send(page, "ticks:B");
  await waitTx(page, "B-6");
  const port = H.port;
  await H.hub.close();
  H.gate.release();
  await sleep(1500);
  await startServer(H, port);
  await waitTx(page, "B-12", 30000);
  await waitStatus(page, /^Ready$/);
  assert.deepStrictEqual(await ticks("B"), want("B"), "B ticks: each exactly once, in order");
  assert.deepStrictEqual(await ticks("A"), want("A"), "A ticks still intact");
  assert.strictEqual(await page.locator("#view-login").isVisible(), false, "still signed in after the restart");
});

flow(10, "hostile text renders as inert text", async (P) => {
  const { page, H } = P;
  const dialogsBefore = P.dialogs.length;
  const reqBefore = P.requests.length;
  await goHash(page, "#/");
  await visible(page, "#view-dashboard");
  P.step("create with hostile name, folder and task");
  await openNewSheet(page);
  await page.locator("#new-name").fill(HOST);
  await page.locator("#new-cwd").fill(path.join(H.root, HOST_DIR));
  await page.locator("#new-task").fill(HOST);
  await page.locator("#new-submit").tap();
  await visible(page, "#view-agent");
  await page.waitForFunction((h) => document.getElementById("agent-name").textContent === h, HOST);
  await page.locator("#agent-back").tap();
  await visible(page, "#view-dashboard");
  await page.waitForFunction(() => document.querySelectorAll("#agent-list li").length >= 2);
  const c = page.locator("#agent-list li").last();
  await c.waitFor();
  const ct = await c.textContent();
  assert.ok(ct.includes(HOST), "card shows the hostile name as text");
  assert.ok(ct.includes(HOST_DIR), "card shows the hostile folder as text");
  P.step("run it: task, tool and tool output");
  await c.locator("button", { hasText: /^Start$/ }).tap();
  await c.filter({ hasText: "Ready" }).waitFor();
  await c.getByRole("button", { name: /more actions/i }).tap();
  await visible(page, "#sheet-menu");
  await page.locator("#sheet-menu button", { hasText: /^\s*Wake\s*$/ }).tap();
  await visible(page, "#view-agent");
  await page.locator("#transcript details.tool:not(.pending)").first().waitFor({ state: "attached" });
  const tx = await textOf(page, "#transcript");
  // markdown-lite turns `id` into inline code, so its backticks are consumed
  assert.ok(tx.includes("echo " + HOST.replace(/`/g, "")), "task echoed as text (backticks become inline code)");
  assert.ok(tx.includes("read_file " + HOST), "tool chip shows hostile detail as text");
  assert.ok(tx.includes(HOST), "tool result shows hostile output as text");
  P.step("hostile approval and message");
  await send(page, "ask:" + HOST);
  await visible(page, "#approval");
  assert.strictEqual(await textOf(page, "#approval-detail"), HOST);
  await screen(P, page, "hostile-approval");
  await page.locator("#approve-deny").tap();
  await hidden(page, "#approval");
  await waitStatus(page, /^Ready$/);
  await send(page, HOST);
  await waitTx(page, "result: denied");
  await waitStatus(page, /^Ready$/);
  await screen(P, page, "hostile-agent");
  await goHash(page, "#/");
  await visible(page, "#view-dashboard");
  await screen(P, page, "hostile-dashboard");
  P.step("nothing ran");
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => ({
    x: window.__x, injected: document.querySelectorAll("main img:not(.panda), main script, [onerror]").length,
  }));
  assert.strictEqual(probe.x, undefined, "window.__x must stay undefined");
  assert.strictEqual(probe.injected, 0, "no injected elements");
  assert.deepStrictEqual(P.dialogs.slice(dialogsBefore), [], "no dialogs");
  assert.ok(!P.requests.slice(reqBefore).some((u) => new URL(u).pathname === "/x"), "the <img src=x> was never fetched");
  await goHash(page, "#/");
});

flow(11, "offline guarantee: only same-origin requests; nothing external needed", async (P) => {
  const { page, ctx, H } = P;
  P.step("every request");
  assert.ok(P.requests.length > 20, "requests were recorded");
  const foreign = P.requests.filter((u) => !sameOrigin(u, H.url));
  assert.deepStrictEqual(foreign, [], "requests to other origins");
  assert.deepStrictEqual(P.blocked, [], "the page tried to reach an external host");
  const badStatic = P.responses.filter((r) => !/\/api\//.test(r.url) && !/\/favicon\.ico$/.test(r.url) && r.status >= 400);
  assert.deepStrictEqual(badStatic, [], "same-origin static files that failed to load (broken asset links)");
  assert.deepStrictEqual(P.pageErrors, [], "uncaught page errors");
  P.step("page markup and fonts");
  await page.goto(H.url + "/");
  await visible(page, "#view-dashboard");
  const dom = await page.evaluate(() => ({
    ext: [...document.querySelectorAll("[src], [href]")].map((n) => n.getAttribute("src") || n.getAttribute("href")).filter((u) => /^(https?:)?\/\//i.test(u)),
    fonts: document.fonts.size,
    res: performance.getEntriesByType("resource").map((e) => e.name),
  }));
  assert.deepStrictEqual(dom.ext, [], "external urls in the markup");
  assert.ok(dom.res.every((u) => sameOrigin(u, H.url)), "all loaded resources are same-origin");
  P.step("offline after load");
  // Chromium's offline switch also cuts loopback, so the hub itself becomes
  // unreachable too. What can be proven here: an already-loaded page does not
  // fall over, and tells the person the hub cannot be reached.
  await ctx.setOffline(true);
  try {
    await tab(page, "Devices").tap();
    await visible(page, "#view-devices");
    await visible(page, "#dev-error");
    assert.match(await textOf(page, "#dev-error"), /cannot reach|connection/i);
    assert.strictEqual(await page.evaluate(() => fetch("https://example.com/").then(() => "reached", () => "blocked")), "blocked");
    await tab(page, "Agents").tap();
    await visible(page, "#view-dashboard");
  } finally { await ctx.setOffline(false); }
  await tab(page, "Devices").tap();
  await page.locator("#session-list li").first().waitFor({ timeout: 15000 });
  await hidden(page, "#dev-error");
  await goHash(page, "#/");
});

flow(12, "layout: no sideways scroll, 44px targets, 16px inputs, both themes, screenshots", async (P) => {
  const { page } = P;
  P.step("reduced motion: no sheet animation");
  await goHash(page, "#/");
  await visible(page, "#view-dashboard");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#fab-new").tap();
  await visible(page, "#sheet-new");
  const anim = await page.evaluate(() => [".sheet", ".scrim"].map((q) => getComputedStyle(document.querySelector("#sheet-new " + q)).animationName));
  assert.deepStrictEqual(anim, ["none", "none"], "sheets do not animate under prefers-reduced-motion");
  await page.keyboard.press("Escape");
  await hidden(page, "#sheet-new", { timeout: 500 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const need = ["login-setup", "login", "login-locked", "dashboard-empty", "dashboard", "agent", "agent-approval", "devices", "hostile-agent", "hostile-dashboard", "new-sheet", "devices-confirm", "hostile-approval", "agent-rich"];
  const missing = need.filter((s) => !P.screens.has(s));
  const bad = P.layout.filter((l) => l.issues.length).map((l) => `${l.name}: ${l.issues.join("; ")}`);
  const shots = need.filter((s) => !fs.existsSync(path.join(SHOTS, `${P.id}-${s}.png`)));
  const problems = [];
  if (missing.length) problems.push(`screens not reached: ${missing.join(", ")}`);
  if (shots.length) problems.push(`screenshots missing: ${shots.join(", ")}`);
  problems.push(...bad);
  assert.strictEqual(problems.length, 0, problems.join(" | "));
});

flow(13, "transport seam: all API traffic uses window.ArcFlareTransport, read once; chip follows relay", async (P) => {
  const { H } = P;
  const second = await newCtx(P);
  const page = second.page;
  const seen = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) seen.push(u.pathname + u.search); });
  try {
    P.step("wrapper installed before the app loads");
    await second.ctx.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      const RealES = window.EventSource;
      const calls = { fetch: [], es: [], swapped: 0 };
      window.__calls = calls;
      window.ArcFlareTransport = {
        fetch: (p, i) => { calls.fetch.push(String(p)); return realFetch(p, i); },
        eventSource: (p) => { calls.es.push(String(p)); return new RealES(p); },
      };
    });
    await page.goto(H.url + "/");
    await visible(page, "#view-login");
    P.step("login and open an agent");
    await login(page);
    await openAgentView(P, page, "alpha");
    await page.locator("#agent-status", { hasText: /Ready|Working|Stopped/ }).waitFor({ state: "visible" });
    const calls = await page.evaluate(() => window.__calls);
    assert.ok(calls.fetch.length > 0, "the wrapper saw fetch calls");
    assert.ok(calls.es.some((p) => p === "/api/events"), "dashboard stream opened through the wrapper");
    assert.ok(calls.es.some((p) => /^\/api\/agents\/[^/]+\/events\?after=\d+$/.test(p)), "agent stream opened through the wrapper");
    P.step("every request the browser made came from the wrapper");
    const wrapped = new Set([...calls.fetch, ...calls.es]);
    assert.ok(seen.length > 0, "the browser made API requests");
    const stray = seen.filter((u) => !wrapped.has(u));
    assert.deepStrictEqual(stray, [], "API requests the wrapper never saw (the page used fetch/EventSource directly)");
    P.step("replacing the transport after load has no effect");
    await page.evaluate(() => {
      window.ArcFlareTransport = {
        fetch: () => { window.__calls.swapped++; return Promise.reject(new Error("swapped")); },
        eventSource: () => { window.__calls.swapped++; throw new Error("swapped"); },
      };
    });
    await tab(page, "Devices").tap();
    await visible(page, "#view-devices");
    await page.locator("#session-list li").first().waitFor();
    await hidden(page, "#dev-error");
    const after = await page.evaluate(() => window.__calls);
    assert.strictEqual(after.swapped, 0, "the replacement transport was never called");
    assert.ok(after.fetch.includes("/api/sessions"), "the original wrapper served /api/sessions");
    P.step("connection chip");
    await tab(page, "Agents").tap();
    await visible(page, "#view-dashboard");
    assert.strictEqual((await textOf(page, "#conn-text")).trim(), "Home network");
    await page.evaluate(() => window.arcflareSetConnection("relay"));
    assert.strictEqual((await textOf(page, "#conn-text")).trim(), "Relay");
    await tab(page, "Devices").tap();
    await tab(page, "Agents").tap();
    assert.strictEqual((await textOf(page, "#conn-text")).trim(), "Relay", "the chip keeps Relay across screens");
    await page.evaluate(() => window.arcflareSetConnection("home"));
    assert.strictEqual((await textOf(page, "#conn-text")).trim(), "Home network");
  } finally { await second.ctx.close().catch(() => {}); }
});

// -------------------------------------------------------------------- runner --

const PROFILES = [
  { id: "pixel7-light", dev: "Pixel 7", scheme: "light" },
  { id: "pixel7-dark", dev: "Pixel 7", scheme: "dark" },
  { id: "s9plus-light", dev: "Galaxy S9+", scheme: "light" },
  { id: "s9plus-dark", dev: "Galaxy S9+", scheme: "dark" },
];

async function runProfile(browser, prof) {
  const res = {};
  const P = {
    id: prof.id, scheme: prof.scheme, browser, device: devices[prof.dev],
    requests: [], responses: [], blocked: [], dialogs: [], pageErrors: [], layout: [], screens: new Set(), notes: new Set(),
    stepName: "", step(s) { this.stepName = s; },
  };
  P.H = await bootHub(prof.id);
  const first = await newCtx(P);
  Object.assign(P, first);
  try {
    for (const f of flows) {
      P.step("");
      try { await f.fn(P); res[f.n] = { ok: true }; }
      catch (e) {
        const msg = String(e && e.message || e).split("\n").slice(0, 3).join(" ").slice(0, 400);
        res[f.n] = { ok: false, msg: `[${P.stepName}] ${msg}` };
        try { await P.page.screenshot({ path: path.join(SHOTS, `${P.id}-FAIL-flow${f.n}.png`), fullPage: true }); } catch { /* ignore */ }
        // A failed flow can leave the page anywhere; get back to a known place.
        try { await P.page.evaluate(() => { location.hash = "#/"; }); } catch { /* page gone */ }
      }
    }
  } finally {
    try { await P.H.sup.stopAll(); } catch { /* best effort */ }
    try { await P.H.hub.close(); } catch { /* best effort */ }
    try { await P.ctx.close(); } catch { /* best effort */ }
  }
  return { prof, res, notes: [...P.notes] };
}

(async () => {
  const t0 = Date.now();
  for (const d of ["Pixel 7", "Galaxy S9+"]) {
    if (!devices[d]) { console.error(`FAIL: playwright has no "${d}" device descriptor`); process.exit(1); }
  }
  let browser;
  try { browser = await chromium.launch(); } catch (e) {
    console.log("skipped: playwright not available (" + String(e.message).split("\n")[0] + ")");
    process.exit(0);
  }
  const profs = PROFILES.filter((p) => !process.env.E2E_ONLY || p.id.includes(process.env.E2E_ONLY));
  let results;
  try {
    if (process.env.E2E_SERIAL) { results = []; for (const p of profs) results.push(await runProfile(browser, p)); }
    else results = await Promise.all(profs.map((p) => runProfile(browser, p)));
  } finally { await browser.close().catch(() => {}); }

  let failed = 0;
  console.log(`ArcFlare phone e2e: ${profs.map((p) => p.id).join(", ")}`);
  for (const f of flows) {
    const bad = results.filter((r) => !r.res[f.n] || !r.res[f.n].ok);
    if (!bad.length) { console.log(`PASS ${String(f.n).padStart(2)}  ${f.title}`); continue; }
    failed++;
    console.log(`FAIL ${String(f.n).padStart(2)}  ${f.title}`);
    for (const r of bad) console.log(`        ${r.prof.id}: ${r.res[f.n] ? r.res[f.n].msg : "did not run"}`);
  }
  const notes = new Set(results.flatMap((r) => r.notes));
  for (const n of notes) console.log(`note: ${n}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${flows.length - failed}/${flows.length} flows passed in ${secs}s. Screenshots: ${SHOTS}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
