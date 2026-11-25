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

// Questions answered on the computer while the phone was signed out are gone after signing in again; only the ones
// still open come back.
test("questions resolved while signed out do not come back after signing in", { skip }, async (t) => {
  const { page, questions, signIn } = await phone(t);
  const q1 = questions.ask({ question: "First question?" }).id;
  const q2 = questions.ask({ question: "Second question?" }).id;
  await page.locator("#question-text", { hasText: "First question?" }).waitFor();
  await page.evaluate(() => logout());
  await page.locator("#view-login").waitFor({ state: "visible" });
  questions.answer(q1, "done on the computer");
  questions.cancel(q2);
  questions.ask({ question: "Still open?" });
  await signIn();
  await page.locator("#sheet-question").waitFor({ state: "visible" });
  assert.strictEqual(await page.textContent("#question-text"), "Still open?");
});

// Removing an agent erases its conversation, and the hub allows it only for an owner account: a second account's
// menu has no Delete to tap.
for (const [user, shown] of [["owner", true], ["helper", false]]) {
  test(`the agent menu ${shown ? "offers" : "hides"} Delete for ${user === "owner" ? "an owner" : "a user"} account`, { skip }, async (t) => {
    const { page } = await phone(t, { user, setup: ({ auth, supervisor, dir }) => {
      auth.createAccount("helper", PASS, { role: "user" });
      supervisor.create({ name: "first", cwd: dir });
    } });
    await page.getByRole("button", { name: "More actions for first" }).click();
    await page.locator("#sheet-menu").waitFor({ state: "visible" });
    assert.strictEqual(await page.isVisible("#menu-delete"), shown);
    assert.strictEqual(await page.isVisible("#menu-wake"), true);
  });
}

// Agents' questions are for owner accounts only: a second account gets a 403 for the list and no question events,
// and its phone shows no question and no error.
test("a user account that is not an owner is shown no agent questions and no error", { skip }, async (t) => {
  const { page, questions } = await phone(t, { user: "helper", setup: ({ auth, questions: q }) => {
    auth.createAccount("helper", PASS, { role: "user" });
    q.ask({ question: "Asked before sign-in?" });
  } });
  questions.ask({ question: "Asked after sign-in?" });
  await page.evaluate(() => loadQuestions());   // throws here if a 403 is not taken as "no questions"
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!(await page.isVisible("#sheet-question")), "a question was shown to an account that cannot answer it");
  assert.strictEqual(await page.evaluate(() => questionState.queue.length + (questionState.current ? 1 : 0)), 0);
});

// The hub tells the phone a question is resolved before the answer's own reply arrives; the next question shown
// meanwhile must stay (before, the late reply closed it and it was lost until a reload).
test("the next question stays when the answer's reply lands after the question was resolved", { skip }, async (t) => {
  const { page, questions } = await phone(t);
  questions.ask({ question: "First question?" });
  questions.ask({ question: "Second question?" });
  await page.locator("#question-text", { hasText: "First question?" }).waitFor();
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route("**/api/questions/*/answer", async (route) => { const res = await route.fetch(); await gate; await route.fulfill({ response: res }); });
  await page.fill("#question-answer", "yes");
  await page.click("#question-send");
  await page.locator("#question-text", { hasText: "Second question?" }).waitFor();
  release();
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(await page.isVisible("#sheet-question"), "the late reply closed the next question");
  assert.strictEqual(await page.textContent("#question-text"), "Second question?");
});

// Two loads of the agent list in flight: the older answer coming back last must not replace the newer list.
test("an older agent list that comes back last does not replace the newer one", { skip }, async (t) => {
  const { page, supervisor, dir } = await phone(t, { setup: ({ supervisor, dir }) => { supervisor.create({ name: "first", cwd: dir }); } });
  await page.locator(".agent-name", { hasText: "first" }).waitFor();
  let release, held = false;
  const gate = new Promise((r) => { release = r; });
  await page.route("**/api/agents", async (route) => {
    if (held) return route.continue();
    held = true;
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  const old = page.evaluate(() => loadAgents());
  await until(() => held, "the first load did not start");
  await new Promise((r) => setTimeout(r, 200));
  supervisor.create({ name: "second", cwd: dir });   // its event also loads the list, 250 ms later
  await page.locator(".agent-name", { hasText: "second" }).waitFor();
  await new Promise((r) => setTimeout(r, 300));
  release();
  await old;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(await page.locator(".agent-name").allTextContents(), ["first", "second"]);
});

// Changing the model, removing a queued message or sending, then opening another agent before the hub answers: the
// reply belongs to the first agent and must not change the second one's status, queue, transcript or composer.
for (const what of ["model", "unqueue", "wake"]) {
  test(`a ${what} reply that lands after opening another agent leaves that agent as it was`, { skip }, async (t) => {
    let a, b;
    const { page } = await phone(t, { setup: ({ supervisor, dir }) => {
      a = supervisor.create({ name: "first", cwd: dir }).id;
      b = supervisor.create({ name: "second", cwd: dir }).id;
    } });
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route(`**/api/agents/${a}/${what}`, async (route) => {
      await gate;
      if (what === "wake") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "it failed" }) });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "running", queue: ["first's message"], pendingApproval: null }) });
    });
    await page.evaluate((id) => { location.hash = "#/agent/" + id; }, a);
    await page.locator("#agent-name", { hasText: "first" }).waitFor();
    await page.waitForFunction(() => state.agent && state.agent.cwd !== undefined);
    if (what === "model") await page.evaluate(() => $("agent-model").dispatchEvent(new Event("change")));
    else if (what === "unqueue") await page.evaluate(() => { unqueue(0); });
    else { await page.fill("#compose-text", "for the first agent"); await page.click("#compose-send"); }
    await page.evaluate((id) => { location.hash = "#/agent/" + id; }, b);
    await page.locator("#agent-name", { hasText: "second" }).waitFor();
    await page.waitForFunction(() => state.agent && state.agent.cwd !== undefined);
    const before = await page.textContent("#agent-status");
    release();
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(await page.textContent("#agent-status"), before);
    assert.ok(!(await page.isVisible("#queue")), "the first agent's queue is shown on the second");
    assert.ok(!(await page.isVisible("#agent-error")), "the first agent's error is shown on the second");
    assert.strictEqual(await page.inputValue("#compose-text"), "", "the first agent's message was put in the second's composer");
    assert.strictEqual(await page.locator("#transcript .notice", { hasText: "Model set" }).count(), 0);
  });
}

// A send that fails after you left the agent and came back to it: the message is put back in its composer.
test("a send that fails after leaving and reopening the same agent puts the message back", { skip }, async (t) => {
  let a, b;
  const { page } = await phone(t, { setup: ({ supervisor, dir }) => {
    a = supervisor.create({ name: "first", cwd: dir }).id;
    b = supervisor.create({ name: "second", cwd: dir }).id;
  } });
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(`**/api/agents/${a}/wake`, async (route) => { await gate; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "it failed" }) }); });
  for (const id of [a, b, a]) {
    await page.evaluate((x) => { location.hash = "#/agent/" + x; }, id);
    await page.waitForFunction((x) => state.agent && state.agent.id === x && state.agent.cwd !== undefined, id);
    if (id === a && !(await page.evaluate(() => window.__sent))) {
      await page.fill("#compose-text", "for the first agent");
      await page.click("#compose-send");
      await page.evaluate(() => { window.__sent = true; });
    }
  }
  release();
  await page.locator("#agent-error", { hasText: "it failed" }).waitFor();
  assert.strictEqual(await page.inputValue("#compose-text"), "for the first agent");
});

// A chat message that fails after you opened another chat: the other chat's composer and error line stay as they were.
test("a chat send that fails after opening another chat leaves that chat as it was", { skip }, async (t) => {
  const { page, chats } = await phone(t);
  const a = chats.create({ model: "m" }).id;
  const b = chats.create({ model: "m" }).id;
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(`**/api/chats/${a}/send`, async (route) => { await gate; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "it failed" }) }); });
  await page.evaluate((id) => { location.hash = "#/chat/" + id; }, a);
  await page.locator("#view-chat").waitFor({ state: "visible" });
  await page.waitForFunction((id) => chatView.id === id, a);
  await page.fill("#chat-text", "for the first chat");
  await page.evaluate(() => $("chat-compose").requestSubmit());
  await page.evaluate((id) => { location.hash = "#/chat/" + id; }, b);
  await page.waitForFunction((id) => chatView.id === id, b);
  await new Promise((r) => setTimeout(r, 300));
  release();
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(await page.inputValue("#chat-text"), "", "the first chat's message was put in the second's composer");
  assert.ok(!(await page.isVisible("#chat-error")), "the first chat's error is shown on the second");
});

// A delete that fails (the hub unreachable for a moment) can be tried again without leaving the screen.
test("Delete on a chat works again after a failed delete", { skip }, async (t) => {
  const { page, chats } = await phone(t);
  const { id } = chats.create({ model: "m" });
  let fail = true;
  await page.route(`**/api/chats/${id}`, (route) => (route.request().method() === "DELETE" && fail
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "it failed" }) }) : route.continue()));
  await page.evaluate(() => { location.hash = "#/chats"; });
  const del = page.locator("#chat-list button", { hasText: "Delete" });
  await del.click();
  await page.locator("#chat-list button", { hasText: "Tap again to delete" }).click();
  await page.locator("#chats-error", { hasText: "it failed" }).waitFor();
  fail = false;
  await del.click();
  await page.locator("#chat-list button", { hasText: "Tap again to delete" }).click();
  await until(() => chats.list().length === 0, "the second delete did not go through");
});
