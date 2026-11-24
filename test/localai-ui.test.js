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
    info: async () => ({ available: true, socModel: "SM8550", ramMb: 7600, freeDiskMb: 40000, loaded: window.__loaded || null, models: models.map((m) => ({ ...m, partial: m.id === window.__partial })) }),
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
      calls.push(["chat", o.messages.map((m) => m.role).join(","), o.maxTokens, o.messages[0].content, o.messages.at(-1).content]);
      const r = window.__chatResults.shift();
      if (r && r.say === undefined) return r;
      // r.say: the text to stream, in four pieces; otherwise the fixed answer.
      const n = r ? Math.ceil(r.say.length / 4) : 0;
      const pieces = r ? Array.from({ length: 4 }, (_, i) => r.say.slice(i * n, (i + 1) * n)).filter(Boolean) : ["Paris", " is the", " capital."];
      for (const t of pieces) { ls.token.forEach((fn) => fn({ text: t })); await new Promise((res) => setTimeout(res, 10)); }
      return { tokens: 3, ms: 30 };
    },
    stop: async () => calls.push(["stop"]),
    unload: async () => { calls.push(["unload"]); window.__loaded = null; },
    on: (ev, fn) => { ls[ev].push(fn); return () => { ls[ev] = ls[ev].filter((x) => x !== fn); }; },
  };
};

// The agent build's files (ArcFlareNative.phoneFiles()): records every call in window.__calls.
const FILES = () => {
  const calls = window.__calls;
  window.__files = {
    folders: async () => ({ folders: window.__folders }),
    pickFolder: async () => { calls.push(["pickFolder"]); const f = { id: "tree-1", name: "Notes" }; window.__folders.push(f); return f; },
    forget: async (id) => { calls.push(["forget", id]); window.__folders = window.__folders.filter((f) => f.id !== id); },
    list: async (id, p) => { calls.push(["list", id, p]); return { entries: [{ name: "todo.txt", dir: false, size: 12 }], truncated: false }; },
    read: async (id, p) => { calls.push(["read", id, p]); return { text: "buy milk", bytes: 8, truncated: false }; },
    write: async (id, p, content) => { calls.push(["write", id, p, content]); return { created: true, name: p, bytes: content.length }; },
  };
};

async function open(t, { scheme = "light", files = false, folders = [] } = {}) {
  const browser = await pw.chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ ...pw.devices["Pixel 7"], colorScheme: scheme })).newPage();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><main class="page"><section class="view"><div id="root" class="local-root" data-assets="assets/"></div></section></main></body></html>');
  await page.addStyleTag({ path: path.join(UI, "style.css") });
  await page.evaluate(FAKE);
  if (files) {
    await page.addScriptTag({ path: path.join(UI, "phoneagent.js") });
    await page.evaluate((f) => { window.__folders = f; }, folders);
    await page.evaluate(FILES);
  }
  await page.addScriptTag({ path: path.join(UI, "localai.js") });
  await page.evaluate(() => { window.__view = window.ArcFlareLocalAI.mount(document.getElementById("root"), window.__native, window.__files || null); });
  await page.getByText("Before you download").waitFor();
  return page;
}
const calls = (page) => page.evaluate(() => window.__calls);
// Ticks the box, downloads the small model and waits for the chat.
async function reachChat(page) {
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByPlaceholder("Message").waitFor();
}
// A model answer that asks for one tool call (the format phoneagent.js reads).
const toolCall = (name, args) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
const APPROVE = (page) => page.getByRole("group", { name: "Arc Pocket asks to use a tool" });

test("Local AI: the notice says what it costs, and nothing downloads until the box is ticked", { skip }, async (t) => {
  const page = await open(t);
  const text = await page.locator("#root").innerText();
  for (const s of ["Size:", "Heat and battery:", "Speed:", "Memory:", "Mistakes:", "Use Wi-Fi if you pay for mobile data", "goes when you uninstall ArcFlare",
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

test("Local AI: a Delete that fails shows the error and keeps the list current", { skip }, async (t) => {
  const page = await open(t);
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 1\.7B/ }).click();
  await page.getByRole("button", { name: "Models and storage" }).click();
  await page.evaluate(() => { window.__native.remove = async () => { throw new Error("The file is in use."); }; });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "The file is in use." }).waitFor();
  await page.getByText("Qwen3 1.7B, 1.8 GB on this phone").waitFor();
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

test("Local AI: without the agent build there is no Files button", { skip }, async (t) => {
  const page = await open(t);
  await reachChat(page);
  assert.strictEqual(await page.getByRole("button", { name: /^Files/ }).count(), 0);
});

test("Local AI: sharing a folder needs the tick box, and Stop sharing forgets it", { skip }, async (t) => {
  const page = await open(t, { files: true });
  await reachChat(page);
  await page.getByRole("button", { name: "Files: share a folder" }).click();
  await page.getByText("Files Arc Pocket may use").waitFor();
  await page.getByText("It can list and read every file").waitFor();
  await page.getByText("A replaced file cannot be brought back").waitFor();
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await page.getByText("Tick the box first.").waitFor();
  assert.ok(!(await calls(page)).some((c) => c[0] === "pickFolder"), "no folder is picked before the tick");
  await page.getByLabel(/I understand what Arc Pocket can do/).check();
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await page.locator(".local-row", { hasText: "Notes" }).getByRole("button", { name: "Stop sharing" }).waitFor();
  assert.ok((await calls(page)).some((c) => c[0] === "pickFolder"), "pickFolder was called");
  await page.getByRole("button", { name: "Back to the chat" }).click();
  await page.getByRole("button", { name: "Files: 1 shared" }).waitFor();
  await page.getByRole("button", { name: "Files: 1 shared" }).click();
  await page.getByRole("button", { name: "Stop sharing" }).click();
  await page.getByText("No folder is shared.").waitFor();
  assert.deepStrictEqual((await calls(page)).filter((c) => c[0] === "forget"), [["forget", "tree-1"]]);
});

test("Local AI: a file is read only after Allow, and the model gets its text", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await reachChat(page);
  await page.evaluate((items) => window.__chatResults.push(...items), [
    { say: 'I will look.\n<tool_call>\n{"name": "read_file", "arguments": {"folder": "Notes", "path": "todo.txt"}}\n</tool_call>' },
  ]);
  await page.getByPlaceholder("Message").fill("What is on my list?");
  await page.getByRole("button", { name: "Send" }).click();
  await APPROVE(page).getByText("Read todo.txt in Notes").waitFor();
  assert.ok(!(await page.locator("#root").innerText()).includes("tool_call"), "the tool call is not shown");
  assert.ok(!(await calls(page)).some((c) => c[0] === "read"), "nothing is read before Allow");
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  assert.deepStrictEqual((await calls(page)).filter((c) => c[0] === "read"), [["read", "tree-1", "todo.txt"]]);
  await page.locator(".local-msg.tool", { hasText: "Read todo.txt in Notes" }).waitFor();
  const chats = (await calls(page)).filter((c) => c[0] === "chat");
  const last = chats.at(-1);
  assert.strictEqual(last[1], "system,user,assistant,user");
  assert.ok(last[4].includes("<tool_response>") && last[4].includes("buy milk"), "the model gets the file text");
  assert.ok(chats[0][3].includes("# Tools") && chats[0][3].includes("Shared folders: Notes."), "the model is told about the folder");
});

test("Local AI: Do not allow means the file is not touched, and the model is told", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await reachChat(page);
  await page.evaluate((items) => window.__chatResults.push(...items), [
    { say: toolCall("write_file", { folder: "Notes", path: "notes.txt", content: "hello" }) },
  ]);
  await page.getByPlaceholder("Message").fill("Save a note");
  await page.getByRole("button", { name: "Send" }).click();
  await APPROVE(page).getByText("Write notes.txt in Notes").waitFor();
  await APPROVE(page).getByText(/If the file exists it is replaced/).waitFor();
  await APPROVE(page).locator("pre", { hasText: "hello" }).waitFor();
  await page.getByRole("button", { name: "Do not allow" }).click();
  await page.locator(".local-msg.tool", { hasText: "Not allowed: Write notes.txt in Notes" }).waitFor();
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  assert.ok(!(await calls(page)).some((c) => c[0] === "write"), "nothing is written");
  const last = (await calls(page)).filter((c) => c[0] === "chat").at(-1);
  assert.ok(last[4].includes("The person did not allow this."), "the model is told");
});

test("Local AI: a model that keeps calling tools is stopped after the round limit", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await reachChat(page);
  const listing = toolCall("list_files", { folder: "Notes" });
  await page.evaluate((items) => window.__chatResults.push(...items), Array.from({ length: 5 }, () => ({ say: listing })));
  await page.getByPlaceholder("Message").fill("list everything");
  await page.getByRole("button", { name: "Send" }).click();
  for (let i = 0; i < 6; i++) {
    try { await APPROVE(page).waitFor({ timeout: 2000 }); } catch { break; }
    await page.getByRole("button", { name: "Allow", exact: true }).click();
  }
  const lists = (await calls(page)).filter((c) => c[0] === "list");
  const max = await page.evaluate(() => window.ArcFlarePhoneAgent.MAX_STEPS);
  assert.ok(lists.length <= max, `at most ${max} list calls, got ${lists.length}`);
  await page.getByText("I stopped here: too many steps for one question.").waitFor();
});

test("Local AI: a failed answer during a tool question removes the whole question", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await reachChat(page);
  await page.evaluate((items) => window.__chatResults.push(...items), [
    { say: toolCall("read_file", { folder: "Notes", path: "todo.txt" }) },
    { error: "the phone ran out of memory part-way through the answer" },
  ]);
  await page.getByPlaceholder("Message").fill("q");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await page.getByText("the phone ran out of memory part-way through the answer").waitFor();
  assert.strictEqual(await page.locator(".local-msg").count(), 0, "the question, the tool steps and the answers are all removed");
  assert.strictEqual(await page.getByPlaceholder("Message").inputValue(), "q", "the question is back in the box");
});

test("Local AI: with only the small model, a shared folder is not used and the chat says why", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await page.getByLabel(/Qwen3 0\.6B/).check();   // picking a model redraws the notice, so the box is ticked after it
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: /^Download Qwen3 0\.6B/ }).click();
  await page.getByPlaceholder("Message").waitFor();
  await page.getByText("Arc Pocket can only use files with Qwen3 1.7B").waitFor();
  await page.getByPlaceholder("Message").fill("What is on my list?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  const chat = (await calls(page)).filter((c) => c[0] === "chat").at(-1);
  assert.ok(!chat[3].includes("# Tools"), "the small model is not given the tools");
  assert.strictEqual((await calls(page)).filter((c) => c[0] === "read" || c[0] === "list" || c[0] === "write").length, 0);
});

// Stop during a tool question ends the whole answer: the call the model was writing is not run, and the model is not
// asked again (before, Stop ended one generation and the tool rounds went on).
test("Local AI: Stop during a tool question ends it, with no tool run and no new answer", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await reachChat(page);
  await page.evaluate((items) => {
    window.__chatResults.push(...items);
    const orig = window.__native.chat;
    window.__native.chat = async (o) => { await new Promise((r) => { window.__go = r; }); return orig(o); };
  }, [{ say: "I will look.\n" + toolCall("read_file", { folder: "Notes", path: "todo.txt" }) }]);
  await page.getByPlaceholder("Message").fill("What is on my list?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => !!window.__go);
  await page.getByRole("button", { name: "Stop" }).click();
  await page.evaluate(() => window.__go());
  await page.locator(".local-msg.assistant", { hasText: "I will look." }).waitFor();
  await page.getByRole("button", { name: "Send" }).waitFor();
  assert.strictEqual(await APPROVE(page).count(), 0, "a tool call was offered after Stop");
  assert.strictEqual((await calls(page)).filter((c) => c[0] === "chat").length, 1, "the model was asked again after Stop");
});

// An answer with more calls than are taken: the ones not run still get a result, so the model is not left with calls
// that never came back.
test("Local AI: calls beyond the limit are not run, and the model is told", { skip }, async (t) => {
  const page = await open(t, { files: true, folders: [{ id: "tree-1", name: "Notes" }] });
  await reachChat(page);
  const max = await page.evaluate(() => window.ArcFlarePhoneAgent.MAX_CALLS);
  const many = Array.from({ length: max + 1 }, () => toolCall("list_files", { folder: "Notes" })).join("\n");
  await page.evaluate((items) => window.__chatResults.push(...items), [{ say: many }]);
  await page.getByPlaceholder("Message").fill("list it");
  await page.getByRole("button", { name: "Send" }).click();
  for (let i = 0; i < max; i++) {
    await APPROVE(page).waitFor();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
  }
  await page.locator(".local-msg.assistant", { hasText: "Paris is the capital." }).waitFor();
  assert.strictEqual((await calls(page)).filter((c) => c[0] === "list").length, max);
  const last = (await calls(page)).filter((c) => c[0] === "chat").at(-1);
  assert.strictEqual(last[1], "system,user,assistant," + Array(max + 1).fill("user").join(","), "one result per call");
  assert.ok(last[4].includes("Error: not run"), "the model is told the extra call was not run");
});
