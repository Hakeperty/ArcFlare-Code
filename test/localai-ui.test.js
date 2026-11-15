// Local AI's screens (lib/hub/ui/localai.js with the real style.css) in a real browser at phone size, with the app's
// LocalAI plugin faked. Needs Playwright with Chromium to be resolvable; where it is not (CI), the tests are skipped.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";
const UI = path.join(__dirname, "..", "lib", "hub", "ui");

// The fake plugin: an 8 GB Snapdragon 8 Gen 2 phone; records calls in window.__calls.
const FAKE = () => {
  const models = [
    { id: "qwen3-0.6b", name: "Qwen3 0.6B", size: 639446688, license: "Apache-2.0", minRamMb: 3000, downloaded: false },
    { id: "qwen3-1.7b", name: "Qwen3 1.7B", size: 1834426016, license: "Apache-2.0", minRamMb: 7000, downloaded: false },
  ];
  const ls = { progress: [], token: [] };
  const calls = (window.__calls = []);
  window.__chatResults = [];
  window.__native = {
    info: async () => ({ available: true, socModel: "SM8550", ramMb: 7600, freeDiskMb: 40000, metered: window.__metered || false, loaded: window.__loaded || null, models: models.map((m) => ({ ...m, partial: m.id === window.__partial })) }),
    download: async (id) => {
      calls.push(["download", id]);
      const m = models.find((x) => x.id === id);
      for (const f of [0.25, 0.5, 1]) { ls.progress.forEach((fn) => fn({ id, done: Math.round(m.size * f), total: m.size })); await new Promise((r) => setTimeout(r, 20)); }
      m.downloaded = true;
    },
    cancelDownload: async () => calls.push(["cancel"]),
    remove: async (id) => { calls.push(["remove", id]); models.find((x) => x.id === id).downloaded = false; if (window.__partial === id) window.__partial = null; },
    load: async (o) => { calls.push(["load", o.id, o.threads, o.ctx]); window.__loaded = o.id; },
    chat: async (o) => {
      calls.push(["chat", o.messages.map((m) => m.role).join(","), o.maxTokens]);
      const r = window.__chatResults.shift();
      if (r) return r;
      for (const t of ["Paris", " is the", " capital."]) { ls.token.forEach((fn) => fn({ text: t })); await new Promise((res) => setTimeout(res, 10)); }
      return { tokens: 3, ms: 30 };
    },
    stop: async () => calls.push(["stop"]),
    unload: async () => { calls.push(["unload"]); window.__loaded = null; },
    on: (ev, fn) => { ls[ev].push(fn); return () => { ls[ev] = ls[ev].filter((x) => x !== fn); }; },
  };
};

async function open(t, { scheme = "light", metered = false } = {}) {
  const browser = await pw.chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ ...pw.devices["Pixel 7"], colorScheme: scheme })).newPage();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><main class="page"><section class="view"><div id="root" class="local-root" data-assets="assets/"></div></section></main></body></html>');
  await page.addStyleTag({ path: path.join(UI, "style.css") });
  await page.evaluate((m) => { window.__metered = m; }, metered);
  await page.evaluate(FAKE);
  await page.addScriptTag({ path: path.join(UI, "localai.js") });
  await page.evaluate(() => { window.__view = window.ArcFlareLocalAI.mount(document.getElementById("root"), window.__native); });
  await page.getByText("Before you download").waitFor();
  return page;
}
const calls = (page) => page.evaluate(() => window.__calls);

test("Local AI: the notice says what it costs, and nothing downloads until the box is ticked", { skip }, async (t) => {
  const page = await open(t, { metered: true });
  const text = await page.locator("#root").innerText();
  for (const s of ["Size:", "Heat and battery:", "Speed:", "Memory:", "Mistakes:", "metered connection", "goes when you uninstall ArcFlare",
    "Snapdragon 8 Gen 2", "Arc Pocket on Qwen3 1.7B (1.8 GB), suggested for this phone"]) assert.ok(text.includes(s), s);
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByText("Tick the box first").waitFor();
  assert.deepStrictEqual(await calls(page), []);
  await page.getByLabel("Arc Pocket on Qwen3 0.6B").check();
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: "Download Qwen3 0.6B (0.64 GB)" }).click();
  await page.getByPlaceholder("Message").waitFor();
  assert.deepStrictEqual(await calls(page), [["download", "qwen3-0.6b"]]);
});

test("Local AI: chat loads the model with the phone's settings, streams the answer, and keeps the conversation", { skip }, async (t) => {
  const page = await open(t);
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByPlaceholder("Message").fill("Capital of France?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  await page.getByPlaceholder("Message").fill("And Spain?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant").nth(1).filter({ hasText: "Paris" }).waitFor();
  const c = await calls(page);
  assert.deepStrictEqual(c.filter((x) => x[0] === "load"), [["load", "qwen3-1.7b", 4, 4096]], "loaded once, Snapdragon 8 Gen 2 settings");
  assert.deepStrictEqual(c.filter((x) => x[0] === "chat").map((x) => x[1]), ["system,user", "system,user,assistant,user"]);
});

test("Local AI: a conversation too long for the model drops its oldest turns and asks again", { skip }, async (t) => {
  const page = await open(t);
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  for (const q of ["one", "two"]) {
    await page.getByPlaceholder("Message").fill(q);
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Send" }).waitFor();
  }
  await page.evaluate(() => window.__chatResults.push({ error: "TOO_LONG" }));
  await page.getByPlaceholder("Message").fill("three");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant").nth(2).filter({ hasText: "Paris" }).waitFor();
  const chats = (await calls(page)).filter((x) => x[0] === "chat").map((x) => x[1]);
  assert.deepStrictEqual(chats.slice(-2), ["system,user,assistant,user,assistant,user", "system,user,assistant,user"]);
});

test("Local AI: Models and storage deletes one model, or everything at once", { skip }, async (t) => {
  const page = await open(t);
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByRole("button", { name: "Models and storage" }).click();
  await page.getByText("Qwen3 1.7B, 1.8 GB on this phone").waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByText("Qwen3 1.7B, 1.8 GB, not downloaded").waitFor();   // stays on the list: you see it is gone
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByText("Before you download").waitFor();
  assert.deepStrictEqual((await calls(page)).at(-1), ["remove", "qwen3-1.7b"]);
  await page.getByLabel(/I understand/).check();   // a blank test page cannot store it; the app remembers it
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByPlaceholder("Message").waitFor();
  await page.getByRole("button", { name: "Models and storage" }).click();
  await page.getByRole("button", { name: "Delete all Local AI data" }).click();
  await page.getByText("Qwen3 0.6B, 0.64 GB, not downloaded").waitFor();
  assert.strictEqual(await page.getByRole("button", { name: "Delete all Local AI data" }).count(), 0);
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByText("Before you download").waitFor();
  const c = await calls(page);
  assert.deepStrictEqual(c.slice(-3), [["unload"], ["remove", "qwen3-0.6b"], ["remove", "qwen3-1.7b"]], "every model, downloaded or not");
  assert.strictEqual(await page.getByLabel(/I understand/).isChecked(), false, "the notice must be accepted again");
});

test("Local AI: a download that died half-way is listed and removed by Delete all", { skip }, async (t) => {
  const page = await open(t);
  await page.evaluate(() => { window.__partial = "qwen3-1.7b"; });
  await page.getByRole("button", { name: "Models and storage" }).click();
  await page.getByText("Qwen3 1.7B, 1.8 GB, part of a stopped download").waitFor();
  await page.getByRole("button", { name: "Delete all Local AI data" }).click();
  await page.getByText("Qwen3 1.7B, 1.8 GB, not downloaded").waitFor();
  assert.deepStrictEqual((await calls(page)).map((c) => c.join(" ")), ["unload", "remove qwen3-0.6b", "remove qwen3-1.7b"]);
});

test("Local AI: a failed answer gives the message back and leaves no question without an answer", { skip }, async (t) => {
  const page = await open(t);
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.evaluate(() => window.__chatResults.push({ error: "the phone ran out of memory part-way through the answer" }));
  await page.getByPlaceholder("Message").fill("What is 2+2?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("the phone ran out of memory part-way through the answer").waitFor();
  assert.strictEqual(await page.locator(".local-msg").count(), 0, "both the question and the empty answer are removed");
  assert.strictEqual(await page.getByPlaceholder("Message").inputValue(), "What is 2+2?", "the question is back in the box");
  await page.getByRole("button", { name: "Send" }).click();   // no typing: the draft is still in the box
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  const chats = (await calls(page)).filter((x) => x[0] === "chat").map((x) => x[1]);
  assert.strictEqual(chats.at(-1), "system,user");
});

test("Local AI: the chat says when older messages are forgotten, and does not ask the model for them again", { skip }, async (t) => {
  const page = await open(t);
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByPlaceholder("Message").fill("one");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  await page.evaluate(() => window.__chatResults.push({ error: "TOO_LONG" }));
  await page.getByPlaceholder("Message").fill("two");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant").nth(1).filter({ hasText: "Paris" }).waitFor();
  await page.getByText("Older messages no longer fit in the model's memory, so Arc Pocket has forgotten them. Start a new chat to begin again.").waitFor();
  let chats = (await calls(page)).filter((x) => x[0] === "chat").map((x) => x[1]);
  assert.deepStrictEqual(chats.slice(1), ["system,user,assistant,user", "system,user"], "the first exchange was dropped after TOO_LONG");
  await page.getByPlaceholder("Message").fill("three");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant").nth(2).filter({ hasText: "Paris" }).waitFor();
  chats = (await calls(page)).filter((x) => x[0] === "chat").map((x) => x[1]);
  assert.strictEqual(chats.at(-1), "system,user,assistant,user", "starts from the second exchange, not the first");
  await page.getByRole("button", { name: "Send" }).waitFor();   // the answer is done: the button reads Send again
  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByText("Older messages no longer fit").waitFor({ state: "detached" });
  assert.strictEqual(await page.getByText("Older messages no longer fit").count(), 0);
});
