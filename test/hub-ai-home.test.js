// Where the phone app opens (lib/hub/ui), in a real browser against a real hub: ArcFlare Agent (the build with the
// phone's files) opens on the AI that runs on the phone, the chat app on the agent list. Needs Playwright with Chromium
// to be resolvable; where it is not (CI), the tests are skipped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-ai-home-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const PASS = "correct horse battery staple";

// What the app gives the page (android/www/native.js): Local AI with one downloaded model, and, in the agent build,
// the phone's files.
const FAKE_APP = (agent) => {
  const local = {
    info: async () => ({ available: true, socModel: "SM8550", ramMb: 7600, freeDiskMb: 40000, loaded: null,
      models: [{ id: "qwen3-1.7b", name: "Qwen3 1.7B", size: 1834426016, license: "Apache-2.0", minRamMb: 7000, downloaded: true }] }),
    on: () => () => {},
  };
  const files = { folders: async () => ({ folders: [] }) };
  window.ArcFlareNative = { localAI: () => local, phoneFiles: () => (agent ? files : null) };
};

async function phone(t, { agent, signIn = true }) {
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
  await page.addInitScript(FAKE_APP, agent);
  page.asked = [];   // requests for the computer's tools
  page.on("request", (r) => { if (r.url().includes("/api/mcp-tools")) page.asked.push(r.url()); });
  const url = `http://127.0.0.1:${port}/`;
  if (signIn) {   // through the agent list, which needs it; then the app opens again, signed in
    await page.goto(url + "#/agents");
    await page.fill("#login-user", "owner");
    await page.fill("#login-pass", PASS);
    await page.click("#login-form button[type=submit]");
    await page.locator("#view-dashboard").waitFor({ state: "visible" });
  }
  await page.goto(url);
  return page;
}

// The tab labels in the order they are shown on screen.
const tabs = (page) => page.evaluate(() => [...document.querySelectorAll("#bottomnav a")].filter((a) => !a.hidden)
  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((a) => a.textContent.trim()));

test("ArcFlare Agent opens on the AI chat, its tab comes first, and the agents are one tap away", { skip }, async (t) => {
  const page = await phone(t, { agent: true });
  await page.locator("#view-local").waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "Arc Pocket" }).waitFor();
  assert.deepStrictEqual(await tabs(page), ["AI", "Agents", "Chat", "Tools", "Devices"]);
  assert.strictEqual(await page.locator("#tab-local").getAttribute("aria-current"), "page");
  await page.locator("#tab-agents").click();
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  await page.locator("#tab-local").click();
  await page.locator("#view-local").waitFor({ state: "visible" });
});

test("ArcFlare Agent's AI chat works without signing in to the computer, and asks it for nothing", { skip }, async (t) => {
  const page = await phone(t, { agent: true, signIn: false });
  await page.getByRole("heading", { name: "Arc Pocket" }).waitFor();
  await page.locator("#local-root textarea").waitFor();
  assert.ok(await page.locator("#view-login").isHidden());
  assert.deepStrictEqual(page.asked, [], "no request for the computer's tools before sign-in");
  await page.locator("#tab-agents").click();
  await page.locator("#view-login").waitFor({ state: "visible" });
});

test("the chat app still opens on the agent list, with On phone as a later tab", { skip }, async (t) => {
  const page = await phone(t, { agent: false });
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  assert.deepStrictEqual(await tabs(page), ["Agents", "Chat", "Tools", "On phone", "Devices"]);
});
