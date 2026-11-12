// The call screen of the phone UI (lib/hub/ui) in a real browser, against a real hub: one-tap answers and taps
// that arrive twice. Needs Playwright with Chromium to be resolvable; where it is not (CI), the tests are skipped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-call-screen-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
const PASS = "correct horse battery staple";

/** A hub with one owner account and calls, and a signed-in phone-sized page on it. */
async function phone(t) {
  const { AuthStore } = require("../lib/hub/auth");
  const { Supervisor } = require("../lib/hub/supervisor");
  const { createHubServer } = require("../lib/hub/server");
  const { CallBox } = require("../lib/hub/calls");
  const L = require("../lib/hub/local");
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("owner", PASS);
  const supervisor = new Supervisor({ dir, roots: [dir], backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }), makeAgent: () => ({}) });
  const calls = new CallBox({ dir: path.join(dir, "calls") });
  const hub = createHubServer({ auth, supervisor, config: { roots: [dir] }, local: { token: L.ensureToken(dir), questions: new L.QuestionBox(), calls, api: async () => {} } });
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  const browser = await pw.chromium.launch();
  t.after(async () => { await browser.close(); await hub.close(); });
  const page = await (await browser.newContext(pw.devices["Pixel 7"])).newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill("#login-user", "owner");
  await page.fill("#login-pass", PASS);
  await page.click("#login-form button[type=submit]");
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  return { page, calls };
}

const tapTwice = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll("#call-quick button")].find((x) => x.textContent === l);
  b.click(); b.click();   // in the same tick: the second arrives while the first is on its way
}, label);
const until = async (f, what) => { for (let i = 0; i < 100; i++) { if (f()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(what); };

test("call screen: one tap answers while it rings and in the call; a second tap changes nothing", { skip }, async (t) => {
  const { page, calls } = await phone(t);
  const { id } = calls.start({ say: "The build is done. Deploy it now?", from: "Codex" });
  await page.locator("#call-quick").waitFor({ state: "visible" });
  await page.fill("#call-msg", "a note I was typing");

  await tapTwice(page, "Later");
  await until(() => calls.current().status === "waiting", "the tap did not answer the call");
  assert.deepStrictEqual([calls.current().answer, calls.current().via], ["Not now. Ask me again later.", "text"]);
  await page.locator("#call-active").waitFor({ state: "visible" });   // the second tap did not close the call screen
  assert.strictEqual(await page.inputValue("#call-msg"), "a note I was typing", "the typed message was overwritten");
  assert.ok(!(await page.isVisible("#call-error")));

  calls.say(id, { say: "Run the tests again first?" });
  await page.locator("#call-line", { hasText: "tests again" }).waitFor();
  await tapTwice(page, "Yes");
  await until(() => calls.current().status === "waiting", "the tap in the call did not answer");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(calls.current().turns.filter((x) => x.who === "user").map((x) => x.text), ["Not now. Ask me again later.", "Yes."]);
  assert.ok(!(await page.isVisible("#call-error")), "the second tap showed an error");

  await page.click("#call-hangup");
  await until(() => calls.current() === null, "hanging up did not end the call");
  await page.locator("#call-quick").waitFor({ state: "hidden" });
});
