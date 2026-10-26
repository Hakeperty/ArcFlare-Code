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
  const http = (method) => async (o) => {
    await window.__rec("http", method + " " + o.url + " | redirects=" + o.disableRedirects + " | ms=" + o.connectTimeout + " | headers=" + Object.keys(o.headers || {}).join(","));
    return window.__cfg.http(o.url);
  };
  const plugins = {
    CapacitorHttp: { get: http("GET"), post: http("POST") },
    App: {
      getLaunchUrl: async () => (window.__cfg.launchUrl ? { url: window.__cfg.launchUrl } : {}),
      addListener: async (name, fn) => { window.__appListeners = window.__appListeners || {}; window.__appListeners[name] = fn; return { remove: async () => {} }; },
    },
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
        deviceId: "AAAAAAAAAAAAAAAAAAAAAA", roomToken: "aftc_" + q.get("ps"), lanToken: "aftl_" + q.get("ps"), label: o.label, privateKey: key.privateKey, publicKey: q.get("hk") } };
    },
    connect: async function (device, opts) {
      await window.__rec("connect", device.relay + (opts && opts.fetch && device.relay.indexOf("http://") === 0 ? " [lan-fetch]" : " [page-fetch]"));
      var lan = device.relay.indexOf("http://") === 0;
      if (lan && opts && opts.fetch) await opts.fetch(device.relay + "/api/tunnel/room/" + device.room + "/client?ch=AAAAAAAAAAAAAAAAAAAAAA&after=0&wait=25", { headers: { Authorization: "Bearer " + device.lanToken } });   // goes through CapacitorHttp; rejects when the LAN is down
      if (cfg().connectError) { var e = new Error("x"); e.code = cfg().connectError; throw e; }
      if (!lan && cfg().relayError) { var e2 = new Error("x"); e2.code = cfg().relayError; throw e2; }
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
    const homeMode = cfg.homeMode || "down";
    await page.addInitScript(fakeBridge, Object.assign({}, cfg, {}));
    await page.addInitScript((mode) => {
      // what the native HTTP stack answers for the LAN mailbox
      window.__cfg.http = (url) => {
        if (mode === "up") return { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": "x=1" }, data: { frames: [], head: 0, online: true } };
        throw new Error("ECONNREFUSED " + url);
      };
    }, homeMode);
    await page.route("**/vendor/capacitor.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
    await page.route("**/ui/tunnel-client.js", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_TUNNEL }));
    // The WebView must never request the LAN address itself (no plain-http page path): count and refuse any such request.
    await page.route(LAN + "/**", (r) => { log.push(["direct-lan", r.request().url()]); return r.abort(); });
    page.on("pageerror", (e) => log.push(["pageerror", String(e.message)]));
    return { ctx, page, log };
  }
  const kinds = (log, k) => log.filter((e) => e[0] === k).map((e) => e[1]);
  const idb = (page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  const storedRecord = (page) => page.evaluate(() => window.ArcFlareStore.load().then((r) => r && { relay: r.relay, lan: r.lan, deviceId: r.deviceId, hasKey: !!r.privateKey, keyExtractable: r.privateKey && r.privateKey.extractable, keys: Object.keys(r).sort() }));
  const visible = async (page) => page.evaluate(() => [...document.querySelectorAll("[data-view]")].filter((v) => !v.hidden).map((v) => v.id));

  /** Put a pairing record into the page's IndexedDB (as a finished pairing would), then reload. */
  async function seed(page, lan = LAN, relay = "https://arcflare.net") {
    await page.evaluate(async ([lan, relay]) => {
      const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
      await window.ArcFlareStore.save({ v: 1, relay: "https://arcflare.net", room: A, hubKey: A, deviceId: "AAAAAAAAAAAAAAAAAAAAAA", roomToken: "aftc_" + A, lanToken: "aftl_" + A, label: "Android phone", privateKey: key.privateKey, publicKey: A }, { relay, lan });
    }, [lan, relay]);
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

  const unlock = (page) => page.waitForFunction(() => !document.getElementById("cf-pair").disabled, null, { timeout: 5000 });

  await t.test("good link -> confirmation (fingerprint + relay host) -> Cancel stores nothing -> Pair (after the 1.5 s lock) shows the code; stored only after the computer approves", async () => {
    const { ctx, page, log } = await open({ homeMode: "up" });
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
    assert.equal(await page.isDisabled("#cf-pair"), true, "Pair is locked right after the screen renders");
    assert.deepEqual(kinds(log, "pair"), [], "nothing is sent before the person presses Pair");
    await page.click("#cf-cancel");
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.equal(await storedRecord(page), null);
    // the SAME link works again after Cancel
    await page.fill("#pair-link", GOOD);
    await page.click("#pair-go");
    await page.waitForSelector("#v-confirm:not([hidden])");
    await unlock(page);
    await page.click("#cf-pair");
    await page.waitForSelector("#code-box:not([hidden])");
    assert.equal(await page.textContent("#code-digits"), "042917");
    const text = (await page.textContent("#v-code")).replace(/\s+/g, " ");
    assert.ok(/Compare this code with the one on your computer/.test(text));
    assert.ok(/confirm it on the computer/.test(text));
    // pair() got a canonical link with r = the LAN base first (the home network is tried first)
    const sent = kinds(log, "pair");
    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith("arcflare://pair?v=1&r=" + enc(LAN)), sent[0].slice(0, 80));
    assert.equal(await storedRecord(page), null, "NOT stored while the code is shown");
    await page.click("#code-done");                       // the fake computer has approved: connect works
    await page.waitForURL(/\/ui\/index\.html\?via=home$/);
    // record stored now: right fields, device key not extractable, no secret, nothing in Web Storage
    const rec = await storedRecord(page);
    assert.equal(rec.relay, "https://arcflare.net");
    assert.equal(rec.lan, LAN);
    assert.equal(rec.hasKey, true);
    assert.equal(rec.keyExtractable, false);
    assert.deepEqual(rec.keys, ["deviceId", "hubKey", "label", "lan", "lanToken", "pairedAt", "privateKey", "publicKey", "relay", "room", "roomToken", "v"]);
    const web = await page.evaluate(() => ({ ls: JSON.stringify(localStorage), ss: JSON.stringify(sessionStorage), ck: document.cookie }));
    assert.deepEqual(web, { ls: "{}", ss: "{}", ck: "" });
    assert.ok(!JSON.stringify(web).includes(A43));
    assert.deepEqual(kinds(log, "direct-lan"), []);
    assert.deepEqual(kinds(log, "pageerror"), []);
    await ctx.close();
  });

  await t.test("pairing failures show plain messages and store nothing", async () => {
    for (const [code, re] of [["TIMEOUT", /did not answer in time/], ["HANDSHAKE", /did not match this computer's key/], ["REFUSED", /expired|used already/], ["OFFLINE", /offline/]]) {
      const { ctx, page } = await open({ pairError: code });
      await page.goto(base + "/index.html");
      await page.fill("#pair-link", GOOD);
      await page.click("#pair-go");
      await unlock(page);
      await page.click("#cf-pair");
      await page.waitForSelector("#code-error:not([hidden])");
      assert.match(await page.textContent("#code-error"), re);
      assert.equal(await page.textContent("#code-title"), "Pairing failed");
      assert.equal(await storedRecord(page), null);
      await ctx.close();
    }
  });

  await t.test("deep link while the app is open goes to the confirmation screen; a second link is ignored with a notice; a bad one gives an error after Cancel", async () => {
    const { ctx, page } = await open();
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-pair:not([hidden])");
    await page.evaluate((u) => window.__fireAppUrl(u), GOOD);
    await page.waitForSelector("#v-confirm:not([hidden])");
    const fpBefore = await page.textContent("#cf-fp");
    await page.evaluate((u) => window.__fireAppUrl(u), GOOD.replace("hk=" + A43, "hk=" + Buffer.alloc(32, 9).toString("base64url")));
    await page.waitForSelector("#cf-notice:not([hidden])");
    assert.equal(await page.textContent("#cf-fp"), fpBefore, "the second link did not change the screen");
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

  await t.test("LAN-only link (internet relay off, r = l): confirm says so, pair() is handed the LAN base", async () => {
    const lanLink = `arcflare://pair?v=1&r=${enc(LAN)}&rm=${A43}&hk=${A43}&ps=${A43}&l=${enc(LAN)}`;
    const { ctx, page, log } = await open({ homeMode: "up" });
    await page.goto(base + "/index.html");
    await page.fill("#pair-link", lanLink);
    await page.click("#pair-go");
    await page.waitForSelector("#v-confirm:not([hidden])");
    assert.match(await page.textContent("#cf-relay"), /internet relay is off/);
    await unlock(page);
    await page.click("#cf-pair");
    await page.waitForSelector("#code-box:not([hidden])");
    assert.equal(kinds(log, "pair").length, 1);
    await ctx.close();
  });

  await t.test("after pairing, 'I confirmed it' is refused while the computer has not confirmed", async () => {
    const { ctx, page } = await open({ connectError: "PENDING" });
    await page.goto(base + "/index.html");
    await page.fill("#pair-link", GOOD);
    await page.click("#pair-go");
    await unlock(page);
    await page.click("#cf-pair");
    await page.waitForSelector("#code-done:not([hidden])");
    await page.click("#code-done");
    await page.waitForSelector("#code-error:not([hidden])");
    assert.match(await page.textContent("#code-error"), /has not confirmed this phone yet/);
    assert.equal(await storedRecord(page), null);
    await ctx.close();
  });

  await t.test("paired + home mailbox answers -> bundled UI over the tunnel, chip 'Home network', native LAN fetch used, relay NEVER contacted, WebView never touches the LAN address", async () => {
    const { ctx, page, log } = await open({ homeMode: "up" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(base + "/ui/index.html?via=home");
    await page.waitForFunction(() => document.getElementById("conn-text") && document.getElementById("conn-text").textContent === "Home network");
    for (let i = 0; i < 50 && !kinds(log, "req").includes("GET /api/me"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(kinds(log, "req").includes("GET /api/me"), "requests: " + JSON.stringify(kinds(log, "req")));
    const conns = kinds(log, "connect");
    assert.ok(conns.length >= 2, "the shell's check and the UI page's own session");
    assert.ok(conns.every((c) => c === LAN + " [lan-fetch]"), JSON.stringify(conns));
    const http = kinds(log, "http");
    assert.ok(http.length >= 2);
    for (const h of http) {
      assert.ok(h.startsWith("GET " + LAN + "/api/tunnel/room/"), h);
      assert.ok(h.includes("redirects=true"), h);
      assert.ok(h.endsWith("headers=Authorization"), "only Authorization is sent, no cookie: " + h);
    }
    assert.deepEqual(kinds(log, "direct-lan"), [], "the WebView never requested the LAN address");
    assert.deepEqual(kinds(log, "pageerror"), []);
    await ctx.close();
  });

  await t.test("paired + home down -> relay handshake -> bundled UI, chip 'Relay'; the page's first connect skips the home attempt", async () => {
    const { ctx, page, log } = await open({ homeMode: "down" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(base + "/ui/index.html?via=relay");
    await page.waitForFunction(() => document.getElementById("conn-text") && document.getElementById("conn-text").textContent === "Relay");
    const chip = await page.evaluate(() => ({ kind: document.getElementById("conn-chip").dataset.kind, text: document.getElementById("conn-text").textContent }));
    assert.deepEqual(chip, { kind: "relay", text: "Relay" });
    for (let i = 0; i < 50 && !kinds(log, "req").includes("GET /api/me"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(kinds(log, "req").includes("GET /api/me"));
    // One handshake attempt sends more than one request, and under load a second can already be in flight when the
    // first fails, so the number of home requests is not fixed. What matters is the ORDER: home first, then relay,
    // and no home request once the relay has started (the page did not retry home on its first connect).
    const conns = kinds(log, "connect");
    const firstRelay = conns.findIndex((c) => c.startsWith("https://arcflare.net"));
    assert.ok(firstRelay > 0, "the shell tried home before the relay: " + JSON.stringify(conns));
    assert.ok(conns.slice(0, firstRelay).every((c) => c === LAN + " [lan-fetch]"), "everything before the relay was a home request: " + JSON.stringify(conns));
    assert.ok(conns.slice(firstRelay).every((c) => c === "https://arcflare.net [page-fetch]"), "no home request after the relay started: " + JSON.stringify(conns));
    assert.equal(await page.evaluate(() => Object.isFrozen(window.ArcFlareTransport) && typeof window.ArcFlareTransport.fetch + typeof window.ArcFlareTransport.eventSource), "functionfunction");
    const order = await page.evaluate(() => [...document.scripts].map((s) => s.getAttribute("src")));
    assert.ok(order.indexOf("../transport.js") < order.indexOf("app.js") && order.indexOf("../relay-boot.js") < order.indexOf("app.js"));
    assert.match(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content), /connect-src 'self' https:/);
    assert.deepEqual(kinds(log, "pageerror"), []);
    await ctx.close();
  });

  await t.test("paired, no LAN base stored -> the LAN is not tried, relay mode", async () => {
    const { ctx, page, log } = await open({ homeMode: "up" });
    await page.goto(base + "/index.html");
    await seed(page, null);
    await page.waitForURL(base + "/ui/index.html?via=relay");
    assert.deepEqual(kinds(log, "http"), []);
    assert.ok(kinds(log, "connect").every((c) => c.startsWith("https://")));
    await ctx.close();
  });

  await t.test("paired, internet relay off (relay == LAN), home down -> unreachable screen; relay never contacted", async () => {
    const { ctx, page, log } = await open({ homeMode: "down" });
    await page.goto(base + "/index.html");
    await seed(page, LAN, LAN);
    await page.waitForSelector("#v-status:not([hidden])");
    // Only home requests, however many one attempt sent (a second can be in flight under load); never the relay.
    const conns2 = kinds(log, "connect");
    assert.ok(conns2.length >= 1 && conns2.every((c) => c === LAN + " [lan-fetch]"), "only the home address was contacted: " + JSON.stringify(conns2));
    assert.match(await page.textContent("#st-msg"), /did not answer on your home network/);
    await ctx.close();
  });

  await t.test("paired, home down and relay offline -> calm unreachable screen with Retry, Re-pair, Forget", async () => {
    const { ctx, page, log } = await open({ homeMode: "down", relayError: "OFFLINE" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    assert.equal(await page.textContent("#st-title"), "Can't reach your computer");
    for (const id of ["st-retry", "st-repair", "st-forget"]) assert.equal(await page.isVisible("#" + id), true);
    assert.equal(await page.textContent("#st-retry"), "Retry");
    assert.equal(await page.textContent("#st-repair"), "Re-pair");
    assert.equal(await page.textContent("#st-forget"), "Forget this computer");
    assert.equal(page.url(), base + "/index.html");
    const before = kinds(log, "connect").length;
    await page.click("#st-retry");
    for (let i = 0; i < 50 && kinds(log, "connect").length <= before; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(kinds(log, "connect").length > before, "Retry runs the whole decision again");
    await page.waitForSelector("#v-status:not([hidden])");
    await page.setViewportSize({ width: 320, height: 640 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    assert.deepEqual(kinds(log, "direct-lan"), []);
    await ctx.close();
  });

  await t.test("pending device (not confirmed on the computer) is explained on the unreachable screen", async () => {
    const { ctx, page } = await open({ homeMode: "up", connectError: "PENDING" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    assert.match(await page.textContent("#st-msg"), /not confirmed it yet/);
    await ctx.close();
  });

  await t.test("coming back (history Back) from the bundled UI shows settings instead of bouncing forward", async () => {
    const { ctx, page } = await open({ homeMode: "up" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForURL(base + "/ui/index.html?via=home");
    await page.goBack();
    await page.waitForSelector("#v-status:not([hidden])");
    assert.equal(await page.textContent("#st-title"), "This computer");
    assert.equal(await page.textContent("#st-retry"), "Open");
    assert.equal(page.url(), base + "/index.html");
    await ctx.close();
  });

  await t.test("N8: the native cookie jar is cleared once on the first start (flag in IndexedDB, not localStorage), not on later starts", async () => {
    const { ctx, page, log } = await open({});
    await page.goto(base + "/index.html");
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.deepEqual(kinds(log, "cookies"), ["cleared"], "cleared on the first start");
    assert.ok((await idb(page)).includes("arcflare-pairing"), "the marker is in IndexedDB");
    assert.equal(await page.evaluate(() => localStorage.length), 0, "nothing in localStorage");
    await page.reload();
    await page.waitForSelector("#v-pair:not([hidden])");
    await page.reload();
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.deepEqual(kinds(log, "cookies"), ["cleared"], "not again on later starts");
    await ctx.close();
  });

  await t.test("Forget wipes IndexedDB, Web Storage and cookies, then shows pairing", async () => {
    const { ctx, page, log } = await open({ homeMode: "down", relayError: "OFFLINE" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    await page.evaluate(() => { localStorage.setItem("stray", "1"); sessionStorage.setItem("stray", "1"); });
    assert.ok((await idb(page)).includes("arcflare-pairing"));
    await page.click("#st-forget");
    await page.waitForSelector("#v-forget:not([hidden])");
    await page.click("#fg-cancel");                                  // cancel keeps everything
    await page.waitForSelector("#v-status:not([hidden])");
    assert.ok((await storedRecord(page)) !== null);
    await page.click("#st-forget");
    const clearsBeforeForget = kinds(log, "cookies").length;
    await page.click("#fg-go");
    await page.waitForSelector("#v-pair:not([hidden])");
    assert.deepEqual(await idb(page), [], "no IndexedDB database is left");
    assert.equal(await storedRecord(page), null);
    const web = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length }));
    assert.deepEqual(web, { ls: 0, ss: 0 });
    // The first-start wipe may run more than once if the page boots twice before its marker is stored (harmless:
    // clearing again changes nothing), so do not count them. What must hold: the native cookie manager was asked to
    // clear every cookie at start, and Forget asked again afterwards.
    const clears = kinds(log, "cookies");
    assert.ok(clears.length >= 2 && clears.every((c) => c === "cleared"), "the first-start wipe and Forget each cleared the native cookies: " + JSON.stringify(clears));
    assert.ok(clears.length > clearsBeforeForget, "Forget itself cleared the native cookies again");
    await page.reload();
    await page.waitForSelector("#v-pair:not([hidden])");
    await ctx.close();
  });

  await t.test("Forget with a failing cookie manager does NOT claim success", async () => {
    const { ctx, page } = await open({ homeMode: "down", relayError: "OFFLINE" });
    await page.goto(base + "/index.html");
    await seed(page);
    await page.waitForSelector("#v-status:not([hidden])");
    await page.evaluate(() => { window.Capacitor.Plugins.CapacitorCookies.clearAllCookies = async () => { throw new Error("native failure"); }; });
    await page.click("#st-forget");
    await page.click("#fg-go");
    await page.waitForSelector("#fg-error:not([hidden])");
    assert.match(await page.textContent("#fg-error"), /cookies/);
    assert.match(await page.textContent("#fg-error"), /NOT fully forgotten/);
    assert.equal(await page.isVisible("#v-forget"), true);
    assert.equal(await page.isVisible("#v-pair"), false);
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
