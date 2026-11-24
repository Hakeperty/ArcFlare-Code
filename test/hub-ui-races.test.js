// The phone UI (lib/hub/ui) in a real browser against a real hub, for the timing cases: a screen opened twice, a
// reply that lands after you moved on, a sign-out in between. Needs Playwright with Chromium to be resolvable; where
// it is not (CI), the tests are skipped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-ui-races-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const PASS = "correct horse battery staple";

/** A hub with an owner account, chats and questions, and a phone-sized page signed in as `user`. */
async function phone(t, { user = "owner", setup } = {}) {
  const { AuthStore } = require("../lib/hub/auth");
  const { Supervisor } = require("../lib/hub/supervisor");
  const { ChatManager } = require("../lib/hub/chat");
  const { createHubServer } = require("../lib/hub/server");
  const L = require("../lib/hub/local");
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("owner", PASS);
  const supervisor = new Supervisor({ dir, roots: [dir], backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }), makeAgent: () => ({}) });
  const chats = new ChatManager({ dir, backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "m" }), models: () => [{ id: "m" }] });
  const questions = new L.QuestionBox();
  const hub = createHubServer({ auth, supervisor, chats, config: { roots: [dir] }, local: { token: L.ensureToken(dir), questions, api: async () => {} } });
  const ctx = { auth, supervisor, chats, questions, dir };
  if (setup) await setup(ctx);
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  const browser = await pw.chromium.launch();
  t.after(async () => { await browser.close(); await hub.close(); });
  const page = await (await browser.newContext(pw.devices["Pixel 7"])).newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  ctx.page = page;
  ctx.signIn = async () => {
    await page.locator("#view-login").waitFor({ state: "visible" });
    await page.fill("#login-user", user);
    await page.fill("#login-pass", PASS);
    await page.click("#login-form button[type=submit]");
    await page.locator("#view-dashboard").waitFor({ state: "visible" });
  };
  await ctx.signIn();
  return ctx;
}

const until = async (f, what) => { for (let i = 0; i < 100; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(what); };

test("a chat opened twice in quick succession shows each answer once", { skip }, async (t) => {
  const { page, chats } = await phone(t);
  const { id } = chats.create({ model: "m" });
  // Two routes to the same chat in one tick: the hash change and a second hashchange before the first has loaded.
  await page.evaluate((cid) => { location.hash = "#/chat/" + cid; window.dispatchEvent(new HashChangeEvent("hashchange")); }, id);
  await page.locator("#view-chat").waitFor({ state: "visible" });
  await until(() => chats.listenerCount("event") > 0, "the chat stream never connected");
  await new Promise((r) => setTimeout(r, 500));   // a second stream, if one was opened, has connected too
  chats._emit(id, "start", { model: "m" });
  chats._emit(id, "delta", { text: "hello" });
  chats._emit(id, "done");
  await page.locator("#chat-transcript .bubble.agent", { hasText: "hello" }).first().waitFor();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(await page.locator("#chat-transcript .bubble.agent").allTextContents(), ["hello"]);
});

// Turning YOLO or team mode on for one agent, then opening another before the hub answers: the answer belongs to the
// first agent and must not switch the second one's buttons or status.
for (const mode of ["yolo", "team"]) {
  test(`turning ${mode} mode on, then opening another agent before the hub answers, leaves that agent as it was`, { skip }, async (t) => {
    let a, b;
    const { page } = await phone(t, { setup: ({ supervisor, dir }) => {
      a = supervisor.create({ name: "first", cwd: dir }).id;
      b = supervisor.create({ name: "second", cwd: dir }).id;
    } });
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route(`**/api/agents/${a}/${mode}`, async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, yolo: true, team: true, status: "working", pendingApproval: null }) });
    });
    await page.evaluate((id) => { location.hash = "#/agent/" + id; }, a);
    await page.locator("#agent-name", { hasText: "first" }).waitFor();
    await page.click(`#agent-${mode}`);
    await page.check(`#${mode}-sure`);
    await page.click(`#${mode}-ok`);
    await page.evaluate((id) => { location.hash = "#/agent/" + id; }, b);
    await page.locator("#agent-name", { hasText: "second" }).waitFor();
    const before = await page.textContent("#agent-status");
    release();
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(await page.getAttribute(`#agent-${mode}`, "aria-pressed"), "false");
    assert.strictEqual(await page.textContent("#agent-status"), before);
    assert.strictEqual(await page.evaluate((m) => !!state.agent[m], mode), false);
  });
}
