// The phone UI (lib/hub/ui) offering an app update, in a real browser against a real hub: the notice on the Agents
// screen, and installing from arcflare.net when the computer has nothing newer (always for ArcFlare Agent).
// Needs Playwright with Chromium to be resolvable; where it is not (CI), the tests are skipped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-app-update-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const PASS = "correct horse battery staple";

// The app's updater (android/www/native.js appUpdater), faked: info() says which app and version this is,
// checkOnline() answers what arcflare.net offers. Calls are recorded in window.__calls.
const FAKE_UPDATER = (o) => {
  const calls = (window.__calls = []);
  const rec = (name, v) => async () => { calls.push(name); return v; };
  window.ArcFlareNative = { appUpdater: () => ({
    info: rec("info", { agent: o.agent, versionCode: 458887, versionName: "1.0.458887", canInstall: true }),
    checkOnline: async () => { calls.push("checkOnline"); if (!o.online) throw new Error("offline"); return o.online; },
    downloadOnline: rec("downloadOnline", {}),
    begin: rec("begin", {}), write: rec("write", {}), abort: rec("abort", {}),
    commit: rec("commit", { status: "installed" }),
    openInstallSettings: rec("openInstallSettings", {}),
  }) };
};

async function phone(t, fake, appUpdates) {
  const { AuthStore } = require("../lib/hub/auth");
  const { Supervisor } = require("../lib/hub/supervisor");
  const { createHubServer } = require("../lib/hub/server");
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("owner", PASS);
  const supervisor = new Supervisor({ dir, roots: [dir], backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }), makeAgent: () => ({}) });
  const hub = createHubServer({ auth, supervisor, config: { roots: [dir] }, appUpdates });
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  const browser = await pw.chromium.launch();
  t.after(async () => { await browser.close(); await hub.close(); });
  const page = await (await browser.newContext(pw.devices["Pixel 7"])).newPage();
  if (fake) await page.addInitScript(FAKE_UPDATER, fake);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill("#login-user", "owner");
  await page.fill("#login-pass", PASS);
  await page.click("#login-form button[type=submit]");
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  return page;
}

const OFFER = { versionCode: 462234, versionName: "1.0.462234", size: 10471298 };
// The computer holding a newer chat-app file than the site; counts how often the page asks for it.
const hubFile = () => { const h = { asked: 0 }; h.info = () => { h.asked++; return { versionCode: 470000, versionName: "1.0.470000", size: 2048, sha256: "a".repeat(64), parts: 1 }; }; h.part = () => null; return h; };
// The update check has finished once arcflare.net was asked (it is asked last).
const checked = (page) => page.waitForFunction(() => window.__calls && window.__calls.includes("checkOnline"));

test("ArcFlare Agent: the Agents screen says an update is ready, and it installs from arcflare.net, never the computer's file", { skip }, async (t) => {
  const hub = hubFile();
  const page = await phone(t, { agent: true, online: OFFER }, hub);
  await page.locator("#dash-update").waitFor({ state: "visible" });
  await page.click("#dash-update");
  await page.locator("#view-devices").waitFor({ state: "visible" });
  assert.match(await page.textContent("#app-update-text"), /1\.0\.462234 is ready \(10\.0 MB, from arcflare\.net\)\. You have 1\.0\.458887/);
  await page.click("#app-update-btn");
  await page.waitForFunction(() => window.__calls.includes("commit"));
  const calls = await page.evaluate(() => window.__calls);
  assert.ok(calls.indexOf("downloadOnline") < calls.indexOf("commit"), JSON.stringify(calls));
  assert.ok(!calls.includes("begin"), "nothing is fetched from the computer for ArcFlare Agent");
  assert.strictEqual(hub.asked, 0, "ArcFlare Agent never asks the computer for its (chat app) file");
  assert.ok(!(await page.isVisible("#app-update-error")));
});

test("ArcFlare: when the computer has no newer app, arcflare.net's is offered; when it has, the computer's is", { skip }, async (t) => {
  const page = await phone(t, { agent: false, online: OFFER });
  await page.locator("#dash-update").waitFor({ state: "visible" });
  await page.click("#dash-update");
  assert.match(await page.textContent("#app-update-text"), /1\.0\.462234 is ready \(10\.0 MB, from arcflare\.net\)/);
  const hub = hubFile();
  const fromHub = await phone(t, { agent: false, online: OFFER }, hub);
  await fromHub.locator("#dash-update").waitFor({ state: "visible" });
  await fromHub.click("#dash-update");
  assert.match(await fromHub.textContent("#app-update-text"), /^Version 1\.0\.470000 is ready \(0\.0 MB\)\./);
  assert.ok(hub.asked >= 1);
});

test("nothing newer anywhere, offline, or a plain browser: no update notice", { skip }, async (t) => {
  for (const fake of [{ agent: true, online: { ...OFFER, versionCode: 458887 } }, { agent: true, online: null }, null]) {
    const page = await phone(t, fake);
    if (fake) await checked(page); else await page.waitForTimeout(300);   // a browser has no updater to wait for
    assert.ok(!(await page.isVisible("#dash-update")), JSON.stringify(fake));
  }
});
