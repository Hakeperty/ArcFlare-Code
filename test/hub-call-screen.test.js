// The call screen of the phone UI (lib/hub/ui) in a real browser, against a real hub: one-tap answers, taps
// that arrive twice, and the list of past calls. Needs Playwright with Chromium to be resolvable; where it is not (CI), the tests are skipped.

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
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const PASS = "correct horse battery staple";

// What the app gives the page (android/www/native.js), reduced to a player and a notifier that keep what they were given.
const FAKE_APP = () => {
  const ok = async () => ({});
  window.__notes = [];
  window.ArcFlareNative = { notifier: () => ({ state: async () => ({ granted: true }), request: ok, notify: async (n) => { window.__notes.push([n.title, n.body, n.sound]); } }), call: () => ({
    ring: ok, stopRing: ok, start: ok, speak: ok, listen: ok, stop: ok, read: ok, clear: ok,
    writeLine: async (data, append) => { window.__line = (append ? window.__line : "") + atob(data); },
    playLine: async () => { window.__played = window.__line; },
  }) };
};

/**
 * A hub with one owner account and calls, and a signed-in phone-sized page on it.
 * before(calls) runs before the page opens; app: the page is given the app's player.
 */
async function phone(t, { before, app } = {}) {
  const { AuthStore } = require("../lib/hub/auth");
  const { Supervisor } = require("../lib/hub/supervisor");
  const { createHubServer } = require("../lib/hub/server");
  const { CallBox } = require("../lib/hub/calls");
  const L = require("../lib/hub/local");
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("owner", PASS);
  const supervisor = new Supervisor({ dir, roots: [dir], backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }), makeAgent: () => ({}) });
  const calls = new CallBox({ dir: path.join(dir, "calls"), synth: async (text, file) => { fs.writeFileSync(file, "RIFF" + text); return true; } });
  if (before) await before(calls);
  const hub = createHubServer({ auth, supervisor, config: { roots: [dir] }, local: { token: L.ensureToken(dir), questions: new L.QuestionBox(), calls, api: async () => {} } });
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
  return { page, calls };
}

const tapTwice = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll("#call-quick button")].find((x) => x.textContent === l);
  b.click(); b.click();   // in the same tick: the second arrives while the first is on its way
}, label);
const tapLater = (page) => page.evaluate(() => [...document.querySelectorAll("#call-quick button")].find((x) => x.textContent === "Later").click());
const until = async (f, what) => { for (let i = 0; i < 100; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(what); };

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

  // The call is now in the list on Tools. A browser shows what was said and has nothing to play it with.
  await page.locator("#sheet-call").waitFor({ state: "hidden", timeout: 10000 });
  await page.click("#tab-tools");
  await page.locator("#calls-list summary", { hasText: "Answered: Codex" }).click();
  await page.locator("#calls-list", { hasText: "You typed: Yes." }).waitFor();
  assert.strictEqual(await page.locator("#calls-list button").count(), 0);
});

test("past calls on Tools: newest first, what was said, and in the app the kept audio is fetched and played", { skip }, async (t) => {
  const { page } = await phone(t, {
    app: true,
    before: async (calls) => {
      const missed = calls.start({ say: "The build is done.", from: "Codex" }).id;
      await calls.line(missed, 0, 0, 1000);
      calls.end(missed);
      await new Promise((r) => setTimeout(r, 5));   // a later start time, so the order is known
      const id = calls.start({ say: "Deploy now?", from: "Claude Code" }).id;
      calls.answer(id);
      calls.reply(id, "Yes", "text");
      calls.hangUp(id, []);
      await new Promise((r) => setTimeout(r, 5));
      calls.decline(calls.start({ say: "Merge it?", from: "Aider" }).id, "Ask the user group first");
    },
  });
  await page.click("#tab-tools");
  await page.locator("#calls-card").waitFor({ state: "visible" });
  assert.deepStrictEqual(await page.locator("#calls-list summary .call-log-who").allTextContents(), ["Declined: Aider", "Answered: Claude Code", "Missed: Codex"]);
  // "the user" becomes "you" in the reason, but not inside the message the user typed.
  await page.locator("#calls-list summary", { hasText: "Declined: Aider" }).click();
  await page.locator("#calls-list p", { hasText: 'Ended: you declined, with the message "Ask the user group first"' }).waitFor();
  const row = page.locator("#calls-list details", { hasText: "Missed: Codex" });
  await row.locator("summary").click();
  await row.locator("p", { hasText: "Codex: The build is done." }).waitFor();
  await row.locator("p", { hasText: "Ended: the agent hung up before you answered" }).waitFor();
  await row.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => window.__played !== undefined);
  assert.strictEqual(await page.evaluate(() => window.__played), "RIFFThe build is done.");
});

test("a call nobody answered leaves the agent's line as a silent notification, once", { skip }, async (t) => {
  const { page, calls } = await phone(t, {
    app: true,
    before: (calls) => {
      calls.end(calls.start({ say: "The build is done.", from: "Codex" }).id);   // missed while the phone was away
      // And one missed two days ago: too old to bring up.
      const old = path.join(calls.dir, "00000000000000aa");
      fs.mkdirSync(old);
      fs.writeFileSync(path.join(old, "transcript.json"), JSON.stringify({ id: "00000000000000aa", from: "Aider", started: new Date(Date.now() - 2 * 86400000).toISOString(), status: "missed", why: "no answer", turns: [{ who: "agent", text: "Old news." }], recordings: [] }));
    },
  });
  const notes = () => page.evaluate(() => window.__notes);
  const missed = ["Missed call from Codex", "The build is done.", false];
  await until(async () => (await notes()).length === 1, "no notification for the call missed while away");
  assert.deepStrictEqual(await notes(), [missed]);

  await page.reload();
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepStrictEqual(await notes(), [], "the same missed call was brought up again");

  const { id } = calls.start({ say: "Tests are red. Look?", from: "Claude Code" });
  await page.locator("#call-ringing").waitFor({ state: "visible" });
  calls.end(id);                                                                                   // it stops ringing, unanswered
  await until(async () => (await notes()).length === 1, "no notification for the call that just stopped ringing");
  assert.deepStrictEqual(await notes(), [["Missed call from Claude Code", "Tests are red. Look?", false]]);
});

test("a scheduled call: listed with its time and taken back on Tools; when it rings the app says the line and hangs up", { skip }, async (t) => {
  const { page, calls } = await phone(t, {
    app: true,
    before: (calls) => { calls.schedule({ say: "Good morning. The nightly run passed.", from: "Codex", at: new Date(Date.now() + 3600_000).toISOString() }); },
  });
  await page.click("#tab-tools");
  const row = page.locator("#calls-list details", { hasText: "Scheduled: Codex" });
  await row.locator("summary", { hasText: /rings \d/ }).click();
  await row.locator("p", { hasText: "Codex: Good morning. The nightly run passed." }).waitFor();
  await row.getByRole("button", { name: "Cancel this call" }).click();
  await page.locator("#calls-list", { hasText: "No calls yet." }).waitFor();
  await until(() => page.locator("#calls-list img.panda").evaluate((i) => i.complete && i.naturalWidth > 0), "the empty call list shows no phone panda");
  assert.strictEqual(calls.timers.size, 0);

  calls.schedule({ say: "It is nine. Stand-up in ten minutes.", from: "Codex", at: new Date(Date.now() + 50).toISOString() });
  await page.locator("#call-status", { hasText: "A scheduled call" }).waitFor();
  await page.click("#call-answer");
  await until(() => calls.current() === null && calls.history().length === 1, "the app did not hang up after the line");
  assert.deepStrictEqual([calls.history()[0].status, calls.history()[0].why], ["ended", "a scheduled call: the phone said its line"]);
});

test("an approval sheet covered by a ringing call comes back when the call ends", { skip }, async (t) => {
  const { page, calls } = await phone(t);
  // An agent screen with an approval waiting (state and openSheet are app.js globals).
  await page.evaluate(() => { state.agent = { id: "a1", approvalId: "ap1" }; openSheet("approval", false); });
  await page.locator("#approval").waitFor({ state: "visible" });
  calls.start({ say: "Quick question.", from: "Codex" });
  await page.locator("#sheet-call").waitFor({ state: "visible" });
  assert.ok(!(await page.isVisible("#approval")), "the call sheet replaced the approval sheet");
  await page.click("#call-decline");
  await page.locator("#sheet-call").waitFor({ state: "hidden", timeout: 10000 });
  await page.locator("#approval").waitFor({ state: "visible" });
});

// Answer, then Decline before the hub has the answer: the answer stands, and the call screen stays.
test("Decline does nothing while an Answer is on its way", { skip }, async (t) => {
  const { page, calls } = await phone(t);
  calls.start({ say: "Deploy now?", from: "Codex" });
  await page.locator("#call-ringing").waitFor({ state: "visible" });
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route("**/answer", async (route) => { await gate; await route.continue(); });
  await page.click("#call-answer");
  await page.click("#call-decline");
  await new Promise((r) => setTimeout(r, 300));
  release();
  await page.locator("#call-active").waitFor({ state: "visible" });
  await until(() => calls.current() && calls.current().status === "talking", "the call was not answered");
});

// The agent hangs up while the phone's Answer is on its way: the screen says so and the phone does not go on as if
// the call were live (before, it showed the call controls and sent the typed answer to a call with no id).
test("an Answer that lands after the agent hung up does not reopen the call", { skip }, async (t) => {
  const { page, calls } = await phone(t);
  const { id } = calls.start({ say: "Deploy now?", from: "Codex" });
  await page.locator("#call-ringing").waitFor({ state: "visible" });
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route("**/answer", async (route) => { const res = await route.fetch(); await gate; await route.fulfill({ response: res }); });
  await tapLater(page);
  await until(() => calls.current() && calls.current().status === "talking", "the answer did not reach the hub");
  calls.end(id);
  await page.locator("#call-ringing").waitFor({ state: "hidden" });
  release();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!(await page.isVisible("#call-active")), "the call controls came back for a call that had ended");
  assert.ok(!urls.some((u) => /\/api\/calls\/null\//.test(u)), "the phone sent a reply to a call with no id");
});
