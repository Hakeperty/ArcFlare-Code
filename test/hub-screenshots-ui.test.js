// The "Allow screenshots" switch on the phone's Tools tab (lib/hub/ui), in a real browser against a real hub: shown
// only when the app's bridge has it, starts from what the app says, and sends the app true or false. Needs Playwright
// with Chromium to be resolvable; where it is not (CI), the tests are skipped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-screenshots-ui-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const PASS = "correct horse battery staple";

// What the app gives the page (android/www/native.js): a notifier whose screenshots() keeps every argument.
const FAKE_APP = () => {
  let allow = true;
  window.__shots = [];
  const ok = async () => ({});
  window.ArcFlareNative = { notifier: () => ({ state: async () => ({ granted: true }), request: ok, notify: ok,
    screenshots: async (a) => { window.__shots.push(a); if (typeof a === "boolean") allow = a; return { allow }; } }) };
};

async function tools(t, app) {
  const { AuthStore } = require("../lib/hub/auth");
  const { Supervisor } = require("../lib/hub/supervisor");
  const { createHubServer } = require("../lib/hub/server");
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("owner", PASS);
  const supervisor = new Supervisor({ dir, roots: [dir], backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }), makeAgent: () => ({}) });
  const hub = createHubServer({ auth, supervisor, config: { roots: [dir] } });
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  const browser = await pw.chromium.launch();
  t.after(async () => { await browser.close(); await hub.close(); });
  const page = await (await browser.newContext(pw.devices["Pixel 7"])).newPage();
  if (app) await page.addInitScript(FAKE_APP);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill("#login-user", "owner");
  await page.fill("#login-pass", PASS);
  await page.click("#login-form button[type=submit]");
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  await page.click("#tab-tools");
  await page.locator("#view-tools").waitFor({ state: "visible" });
  return page;
}

test("Allow screenshots: on by default in the app, and the switch sends the app false, then true", { skip }, async (t) => {
  const page = await tools(t, true);
  await page.locator("#screen-card").waitFor({ state: "visible" });
  assert.strictEqual(await page.isChecked("#screen-allow"), true);
  await page.click("#screen-card .switch");
  await page.waitForFunction(() => window.__shots.length === 2);
  assert.strictEqual(await page.isChecked("#screen-allow"), false);
  await page.click("#screen-card .switch");
  await page.waitForFunction(() => window.__shots.length === 3);
  assert.deepStrictEqual(await page.evaluate(() => window.__shots), [undefined, false, true]);
  assert.strictEqual(await page.isChecked("#screen-allow"), true);
});

test("Allow screenshots: hidden in a normal browser, where nothing can block captures", { skip }, async (t) => {
  const page = await tools(t, false);
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator("#screen-card").isHidden(), true);
});
