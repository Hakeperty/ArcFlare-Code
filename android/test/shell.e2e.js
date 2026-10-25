"use strict";
// Browser check of the app shell with a FAKE Capacitor bridge and a FAKE ArcFlareTunnel.
// Run: npm run test:e2e   (skips cleanly when Playwright / Chromium is not installed)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { /* skipped below */ }

const WWW = path.join(__dirname, "..", "www");
const A43 = Buffer.alloc(32, 7).toString("base64url");
const LAN = "http://192.168.1.20:8765";
const enc = encodeURIComponent;
const GOOD = `arcflare://pair?v=1&r=${enc("https://arcflare.net")}&rm=${A43}&hk=${A43}&ps=${A43}&l=${enc(LAN)}`;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      let p = path.normalize(decodeURIComponent(u.pathname));
      if (p.endsWith("/")) p += "index.html";
      const f = path.join(WWW, p);
      if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("no"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ---- the fakes (run inside the page) --------------------------------------------------------

/** Installed before any page script: fake Capacitor bridge. cfg comes from the test. */
function fakeBridge(cfg) {
  window.__cfg = cfg;
  const plugins = {
    CapacitorHttp: { get: async (o) => { await window.__rec("http", o.url + " | redirects=" + o.disableRedirects + " | ms=" + o.connectTimeout); return window.__cfg.http(o.url); } },
    App: {
      getLaunchUrl: async () => (window.__cfg.launchUrl ? { url: window.__cfg.launchUrl } : {}),
      addListener: async (name, fn) => { window.__appListeners = window.__appListeners || {}; window.__appListeners[name] = fn; return { remove: async () => {} }; },
    },
    NavGuard: { setLan: async (o) => { await window.__rec("navguard", o.url); } },
    CapacitorCookies: { clearAllCookies: async () => { await window.__rec("cookies", "cleared"); } },
  };
  window.__fireAppUrl = (url) => window.__appListeners.appUrlOpen({ url });
  window.Capacitor = { Plugins: plugins, registerPlugin: (n) => plugins[n], isNativePlatform: () => true };
}

/** Served in place of ui/tunnel-client.js: a fake ArcFlareTunnel. */
const FAKE_TUNNEL = `
(function () {
  var cfg = function () { return window.__cfg || {}; };
  window.ArcFlareTunnel = {
    pair: async function (o) {
      await window.__rec("pair", o.link);
      if (cfg().pairError) { var e = new Error("x"); e.code = cfg().pairError; throw e; }
      var q = new URL(o.link).searchParams;
      var key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      return { sas: "042917", device: { v: 1, relay: q.get("r"), room: q.get("rm"), hubKey: q.get("hk"), lan: q.get("l"),
        deviceId: "AAAAAAAAAAAAAAAAAAAAAA", roomToken: "aftc_" + q.get("ps"), label: o.label, privateKey: key.privateKey, publicKey: q.get("hk") } };
    },
    connect: async function (device) {
      await window.__rec("connect", device.relay);
      if (cfg().connectError) { var e = new Error("x"); e.code = cfg().connectError; throw e; }
      var t = {
        onclose: null, close: function () {},
        request: async function (method, path) {
          await window.__rec("req", method + " " + path);
          var body = new TextEncoder().encode(JSON.stringify({ error: "Not signed in" }));
          return { status: 401, headers: { "content-type": "application/json" }, body: body, text: function () { return new TextDecoder().decode(body); }, json: function () { return { error: "Not signed in" }; } };
        },
        eventSource: function () { return { readyState: 1, close: function () {} }; },
      };
      return t;
    },
  };
})();`;

const HUB_STUB = "<!doctype html><title>the hub</title><p>hub</p>";

test("shell e2e", { skip: chromium ? false : "playwright is not installed" }, async (t) => {
  let srv, browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip("no Chromium: " + String(e.message).split("\n")[0]); return; }
  srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(async () => { await browser.close(); srv.close(); });

  /** A fresh context + page with the fakes. log collects everything the fakes were asked. */
  async function open(cfg = {}, viewport = { width: 390, height: 780 }) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const log = [];
    await page.exposeFunction("__rec", (kind, data) => { log.push([kind, data]); });
    cfg = Object.assign({ http: null, launchUrl: null }, cfg);
    const httpMode = cfg.httpMode || "down";
    await page.addInitScript(fakeBridge, Object.assign({}, cfg, {}));
    await page.addInitScript((mode) => {
      window.__cfg.http = (url) => {
        if (mode === "hub") return { status: 200, data: { setup: true } };
        if (mode === "router") return { status: 200, data: "<html>router login</html>" };
        throw new Error("ECONNREFUSED " + url);
      };
    }, httpMode);
    await page.route("**/vendor/capacitor.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
    await page.route("**/ui/tunnel-client.js", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_TUNNEL }));
    await page.route(LAN + "/**", (r) => r.fulfill({ contentType: "text/html", body: HUB_STUB }));
    page.on("pageerror", (e) => log.push(["pageerror", String(e.message)]));
    return { ctx, page, log };
  }
  const kinds = (log, k) => log.filter((e) => e[0] === k).map((e) => e[1]);
  const idb = (page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  const storedRecord = (page) => page.evaluate(() => window.ArcFlareStore.load().then((r) => r && { relay: r.relay, lan: r.lan, deviceId: r.deviceId, hasKey: !!r.privateKey, keyExtractable: r.privateKey && r.privateKey.extractable, keys: Object.keys(r).sort() }));
  const visible = async (page) => page.evaluate(() => [...document.querySelectorAll("[data-view]")].filter((v) => !v.hidden).map((v) => v.id));

  /** Put a pairing record into the page's IndexedDB (as a finished pairing would), then reload. */
  async function seed(page, lan = LAN) {
    await page.evaluate(async (lan) => {
      const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
      await window.ArcFlareStore.save({ v: 1, relay: "https://arcflare.net", room: A, hubKey: A, deviceId: "AAAAAAAAAAAAAAAAAAAAAA", roomToken: "aftc_" + A, label: "Android phone", privateKey: key.privateKey, publicKey: A }, lan);
    }, lan);
    await page.reload();
  }

  await t.test("unpaired: shows the pairing screen; layout works at 320px; 16px input; 44px targets", async () => {
    const { ctx, page, log } = await open({}, { width: 320, height: 640 });
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.deepEqual(await visible(page), ["v-pair"]);
    const m = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return {
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        inputFont: getComputedStyle(document.getElementById("pair-link")).fontSize,
        btnH: r("pair-go").height, btnR: r("pair-go").right, inputR: r("pair-link").right,
      };
    });
    assert.ok(m.sw <= m.cw, "no horizontal scroll at 320px");
    assert.equal(m.inputFont, "16px");
    assert.ok(m.btnH >= 44);
    assert.ok(m.btnR <= 320 && m.inputR <= 320);
    assert.deepEqual(kinds(log, "http"), [], "nothing is probed when unpaired");
    assert.deepEqual(kinds(log, "pageerror"), []);
    await ctx.close();
  });

  await t.test("unpaired -> bad links give an error and store nothing", async () => {
    const { ctx, page, log } = await open();
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-pair:not([hidden])");
    const bads = [
      "hello", "https://arcflare.net", GOOD.replace("v=1", "v=2"), GOOD.replace(enc("https://arcflare.net"), enc("http://arcflare.net")),
      GOOD + "&x=1", GOOD.replace(enc(LAN), enc("http://8.8.8.8:8765")), "arcflare://pair?v=1&r=" + enc("https://10.0.0.1") + `&rm=${A43}&hk=${A43}&ps=${A43}`,
    ];
    for (const b of bads) {
      await page.fill("#pair-link", b);
      await page.click("#pair-go");
      await page.waitForSelector("#pair-error:not([hidden])");
      const msg = await page.textContent("#pair-error");
      assert.ok(msg.length > 10, "a plain message is shown");
      assert.ok(!msg.includes(A43), "the error never echoes the secret");
      assert.deepEqual(await visible(page), ["v-pair"], "stays on the pairing screen");
      assert.equal(await page.inputValue("#pair-link"), "", "the pasted text is cleared");
    }
    assert.equal(await storedRecord(page), null, "nothing stored");
    assert.deepEqual(kinds(log, "pair"), [], "pair() was never called");
    assert.deepEqual(kinds(log, "connect"), []);
    await ctx.close();
  });

  await t.test("good link -> confirmation (fingerprint + relay host) -> Cancel stores nothing -> Pair shows the code", async () => {
    const { ctx, page, log } = await open();
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-pair:not([hidden])");
    await page.fill("#pair-link", GOOD);
    await page.click("#pair-go");
    await page.waitForSelector("#v-confirm:not([hidden])");
    const crypto = require("node:crypto");
    const fp = crypto.createHash("sha256").update(Buffer.alloc(32, 7)).digest("hex").slice(0, 20).match(/.{4}/g).join(" ");
    assert.equal(await page.textContent("#cf-fp"), fp);
    assert.equal(await page.textContent("#cf-relay"), "arcflare.net");
    assert.equal(await page.textContent("#cf-lan"), LAN);
    const lead = (await page.textContent("#v-confirm .lead")).replace(/\s+/g, " ");
    assert.ok(lead.includes("Pair with the computer showing fingerprint " + fp.split(" ")[0] + "…?"));
    assert.ok(lead.includes("Only continue if you just scanned this on your own computer."));
    assert.deepEqual(kinds(log, "pair"), [], "nothing is sent before the person presses Pair");
    // Cancel
    await page.click("#cf-cancel");
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.equal(await storedRecord(page), null);
    // again, then Pair
    await page.fill("#pair-link", GOOD);
    await page.click("#pair-go");
    await page.waitForSelector("#v-confirm:not([hidden])");
    await page.click("#cf-pair");
    await page.waitForSelector("#code-box:not([hidden])");
    assert.equal(await page.textContent("#code-digits"), "042917");
    const text = (await page.textContent("#v-code")).replace(/\s+/g, " ");
    assert.ok(/Compare this code with the one on your computer/.test(text));
    assert.ok(/confirm it on the computer/.test(text));
    // what pair() received is the validated, canonical link
    const sent = kinds(log, "pair");
    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith("arcflare://pair?v=1&r="));
    // record stored: right fields, device key not extractable, no secret, nothing in Web Storage
    const rec = await storedRecord(page);
    assert.equal(rec.relay, "https://arcflare.net");
    assert.equal(rec.lan, LAN);
    assert.equal(rec.hasKey, true);
    assert.equal(rec.keyExtractable, false);
    assert.deepEqual(rec.keys, ["deviceId", "hubKey", "label", "lan", "pairedAt", "privateKey", "publicKey", "relay", "room", "roomToken", "v"]);
    const web = await page.evaluate(() => ({ ls: JSON.stringify(localStorage), ss: JSON.stringify(sessionStorage), ck: document.cookie, url: location.href }));
    assert.deepEqual(web, { ls: "{}", ss: "{}", ck: "", url: base + "/index.html" });
    assert.ok(!JSON.stringify(web).includes(A43));
    assert.deepEqual(kinds(log, "pageerror"), []);
    await ctx.close();
  });

  await t.test("pairing failures show plain messages and store nothing", async () => {
    for (const [code, re] of [["TIMEOUT", /did not answer in time/], ["HANDSHAKE", /did not match this computer's key/], ["REFUSED", /expired|used already/], ["OFFLINE", /offline/]]) {
      const { ctx, page } = await open({ pairError: code });
      await page.goto(base + "/index.html");
      await page.fill("#pair-link", GOOD);
      await page.click("#pair-go");
      await page.click("#cf-pair");
      await page.waitForSelector("#code-error:not([hidden])");
      assert.match(await page.textContent("#code-error"), re);
      assert.equal(await page.textContent("#code-title"), "Pairing failed");
      assert.equal(await storedRecord(page), null);
      await ctx.close();
    }
  });

  await t.test("deep link while the app is open goes to the confirmation screen; a bad one to an error", async () => {
    const { ctx, page } = await open();
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-pair:not([hidden])");
    await page.evaluate((u) => window.__fireAppUrl(u), GOOD);
    await page.waitForSelector("#v-confirm:not([hidden])");
    await page.click("#cf-cancel");
    await page.evaluate(() => window.__fireAppUrl("arcflare://pair?v=1&evil=1"));
    await page.waitForSelector("#pair-error:not([hidden])");
    assert.equal(await storedRecord(page), null);
    await ctx.close();
  });

  await t.test("cold start from the QR (launch URL) opens the confirmation screen", async () => {
    const { ctx, page } = await open({ launchUrl: GOOD });
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-confirm:not([hidden])");
    assert.equal(await page.textContent("#cf-relay"), "arcflare.net");
    await ctx.close();
  });

  await t.test("after pairing, 'I confirmed it' is refused while the computer has not confirmed", async () => {
    const { ctx, page } = await open({ connectError: "PENDING" });
    await page.goto(base + "/index.html");
    await page.fill("#pair-link", GOOD);
    await page.click("#pair-go");
    await page.click("#cf-pair");
    await page.waitForSelector("#code-done:not([hidden])");
    await page.click("#code-done");
    await page.waitForSelector("#code-error:not([hidden])");
    assert.match(await page.textContent("#code-error"), /has not confirmed this phone yet/);
    await ctx.close();
  });

  await t.test("paired + LAN answers like a hub -> navigates to exactly the LAN URL; relay never touched", async () => {
    const { ctx, page, log } = await open({ httpMode: "hub" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(LAN + "/");
    assert.equal(await page.title(), "the hub");
    const http = kinds(log, "http");
    assert.deepEqual(http, [LAN + "/api/status | redirects=true | ms=2000"]);
    assert.deepEqual(kinds(log, "connect"), [], "the relay is not used when the LAN answers");
    assert.deepEqual(kinds(log, "req"), []);
    assert.equal(kinds(log, "navguard").pop(), LAN, "native navigation pin was set to the exact LAN origin first");
    await ctx.close();
  });

  await t.test("paired + something else answers on the LAN address (router page) -> not trusted, relay is used", async () => {
    const { ctx, page, log } = await open({ httpMode: "router" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(base + "/ui/index.html");
    assert.ok(kinds(log, "connect").length >= 1);
    assert.equal(kinds(log, "navguard").pop(), "", "LAN pin cleared in relay mode");
    await ctx.close();
  });

  await t.test("paired + LAN down -> bundled UI in relay mode, transport used, chip says Relay", async () => {
    const { ctx, page, log } = await open({ httpMode: "down" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(base + "/ui/index.html");
    await page.waitForFunction(() => document.getElementById("conn-text") && document.getElementById("conn-text").textContent === "Relay");
    const chip = await page.evaluate(() => ({ kind: document.getElementById("conn-chip").dataset.kind, text: document.getElementById("conn-text").textContent }));
    assert.deepEqual(chip, { kind: "relay", text: "Relay" });
    // app.js really used window.ArcFlareTransport: its first call went through the (fake) tunnel
    for (let i = 0; i < 50 && !kinds(log, "req").includes("GET /api/me"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(kinds(log, "req").includes("GET /api/me"), "requests: " + JSON.stringify(kinds(log, "req")));
    assert.equal(await page.evaluate(() => Object.isFrozen(window.ArcFlareTransport) && typeof window.ArcFlareTransport.fetch + typeof window.ArcFlareTransport.eventSource), "functionfunction");
    // transport was in place before app.js ran: scripts are in this order in the served page
    const order = await page.evaluate(() => [...document.scripts].map((s) => s.getAttribute("src")));
    assert.ok(order.indexOf("../transport.js") < order.indexOf("app.js") && order.indexOf("../relay-boot.js") < order.indexOf("app.js"));
    // CSP is on the page
    assert.match(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content), /connect-src 'self' https:/);
    assert.deepEqual(kinds(log, "pageerror"), []);
    await ctx.close();
  });

  await t.test("paired, no LAN URL stored -> LAN is not probed, relay mode", async () => {
    const { ctx, page, log } = await open({ httpMode: "hub" });
    await page.goto(base + "/index.html");
    await seed(page, null);
    await page.waitForURL(base + "/ui/index.html");
    assert.deepEqual(kinds(log, "http"), []);
    await ctx.close();
  });

  await t.test("paired, LAN down and relay refused/offline -> calm unreachable screen with Retry, Re-pair, Forget", async () => {
    const { ctx, page, log } = await open({ httpMode: "down", connectError: "OFFLINE" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    assert.equal(await page.textContent("#st-title"), "Can't reach your computer");
    for (const id of ["st-retry", "st-repair", "st-forget"]) assert.equal(await page.isVisible("#" + id), true);
    assert.equal(await page.textContent("#st-retry"), "Retry");
    assert.equal(await page.textContent("#st-repair"), "Re-pair");
    assert.equal(await page.textContent("#st-forget"), "Forget this computer");
    assert.equal(page.url(), base + "/index.html");
    // Retry: runs the whole decision again (LAN probe + relay check)
    const before = kinds(log, "http").length;
    await page.click("#st-retry");
    await page.waitForSelector("#v-status:not([hidden])");
    assert.ok(kinds(log, "http").length > before);
    // 320px layout of this screen
    await page.setViewportSize({ width: 320, height: 640 });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.ok(fits);
    await ctx.close();
  });

  await t.test("pending device (not confirmed on the computer) is explained on the unreachable screen", async () => {
    const { ctx, page } = await open({ httpMode: "down", connectError: "PENDING" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    assert.match(await page.textContent("#st-msg"), /not confirmed it yet/);
    await ctx.close();
  });

  await t.test("coming back (history Back) from the hub shows settings instead of bouncing forward", async () => {
    const { ctx, page } = await open({ httpMode: "hub" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(LAN + "/");
    await page.goBack();
    await page.waitForSelector("#v-status:not([hidden])");
    assert.equal(await page.textContent("#st-title"), "This computer");
    assert.equal(await page.textContent("#st-retry"), "Open");
    assert.equal(page.url(), base + "/index.html");
    await ctx.close();
  });

  await t.test("Forget wipes IndexedDB, Web Storage, cookies and the navigation pin, then shows pairing", async () => {
    const { ctx, page, log } = await open({ httpMode: "down", connectError: "OFFLINE" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    await page.evaluate(() => { localStorage.setItem("stray", "1"); sessionStorage.setItem("stray", "1"); document.cookie = "stray=1; path=/"; });
    assert.ok((await idb(page)).includes("arcflare-pairing"));
    await page.click("#st-forget");
    await page.waitForSelector("#v-forget:not([hidden])");
    await page.click("#fg-cancel");                                  // cancel keeps everything
    await page.waitForSelector("#v-status:not([hidden])");
    assert.ok((await storedRecord(page)) !== null);
    await page.click("#st-forget");
    await page.click("#fg-go");
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.deepEqual(await idb(page), [], "no IndexedDB database is left");   // (before anything re-opens the store)
    assert.equal(await storedRecord(page), null);
    const web = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length }));
    assert.deepEqual(web, { ls: 0, ss: 0 });
    assert.deepEqual(kinds(log, "cookies"), ["cleared"], "native cookie manager was asked to clear every cookie");
    assert.equal(kinds(log, "navguard").pop(), "");
    // and a restart now starts at the pairing screen
    await page.reload();
    await page.waitForSelector("#v-pair:not([hidden])");
    await ctx.close();
  });

  await t.test("dark and light schemes both render with the phone UI's tokens", async () => {
    for (const scheme of ["dark", "light"]) {
      const { ctx, page } = await open();
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(base + "/index.html");
      await page.waitForSelector("#v-pair:not([hidden])");
      const c = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily }));
      assert.equal(c.bg, scheme === "dark" ? "rgb(11, 11, 10)" : "rgb(246, 245, 241)");
      assert.match(c.font, /Geist/);
      await ctx.close();
    }
  });
});
