// Adding an MCP server from the phone's Tools tab (lib/hub/ui), in a real browser against a real hub: the sheet is
// an owner's only, an added server shows off, and removing it takes a second tap. Needs Playwright with Chromium to
// be resolvable; where it is not (CI), the tests are skipped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw = null;
try { pw = require("playwright"); } catch { /* skipped below */ }
const skip = pw ? false : "playwright is not installed";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-mcp-add-ui-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const PASS = "correct horse battery staple";

function FakeRegistry() {
  this.servers = new Map();
  this.add = async (name) => { this.servers.set(name, { tools: [], stop() {} }); return { ok: true, name, tools: 0 }; };
}

async function phone(t, role) {
  const { AuthStore } = require("../lib/hub/auth");
  const { Supervisor } = require("../lib/hub/supervisor");
  const { createHubServer } = require("../lib/hub/server");
  const { McpHub, loadHomeConfig } = require("../lib/hub/mcphub");
  const store = require("../lib/store");
  const dir = fs.mkdtempSync(path.join(TMP, "hub-"));
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const auth = new AuthStore({ dir });
  auth.createAccount("boss", PASS);
  if (role === "user") auth.createAccount("guest", PASS, { role: "user" });
  const supervisor = new Supervisor({ dir, roots: [dir], backend: async () => ({ port: 1, model: "m", nCtx: 4096, modelRef: "r" }), makeAgent: () => ({}) });
  const mcp = new McpHub({
    dir, home, builtins: true, Registry: FakeRegistry,
    load: () => loadHomeConfig({ home, userHome: home }),
    catalog: async () => ({ data: store.bundled(), source: "bundled" }),
  });
  const hub = createHubServer({ auth, supervisor, mcp, config: { roots: [dir] } });
  const { port } = await hub.listen({ port: 0, host: "127.0.0.1" });
  const browser = await pw.chromium.launch();
  t.after(async () => { await browser.close(); await hub.close(); });
  const page = await (await browser.newContext(pw.devices["Pixel 7"])).newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill("#login-user", role === "user" ? "guest" : "boss");
  await page.fill("#login-pass", PASS);
  await page.click("#login-form button[type=submit]");
  await page.locator("#view-dashboard").waitFor({ state: "visible" });
  await page.click("#tab-tools");
  await page.locator("#mcp-list li", { hasText: "arcflare-web" }).waitFor();
  return { page, file: path.join(home, "mcp.json") };
}

test("Tools: an owner adds a store server, it shows off, and removing it asks for a second tap", { skip }, async (t) => {
  const { page, file } = await phone(t, "owner");
  await page.click("#mcp-add");
  const sheet = page.locator("#sheet-mcp-add");
  await sheet.waitFor({ state: "visible" });
  await page.locator("#mcp-add-warn", { hasText: "Every tool call still asks you first" }).waitFor();
  const mem = page.locator("#mcp-cat li", { hasText: "Memory" });
  await mem.locator("code", { hasText: "npx -y @modelcontextprotocol/server-memory" }).waitFor();

  // A server that needs a folder says so, and nothing is written.
  await page.locator("#mcp-cat li", { hasText: "Filesystem" }).getByRole("button", { name: "Add Filesystem" }).click();
  await page.locator("#mcp-add-error", { hasText: "needs folder" }).waitFor();
  assert.ok(!fs.existsSync(file));

  await mem.getByRole("button", { name: "Add Memory" }).click();
  await page.locator("#mcp-add-result", { hasText: "Added Memory. It is off" }).waitFor();
  await mem.locator("text=Added. Remove it from the Tools list.").waitFor();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.memory, { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] });
  await page.click("#mcp-add-done");
  await sheet.waitFor({ state: "hidden" });

  const row = page.locator("#mcp-list li", { hasText: "memory" });
  await row.waitFor();
  assert.strictEqual(await row.getByRole("switch").isChecked(), false);
  await row.locator("text=Off").waitFor();

  // Built-ins have no Remove button.
  assert.strictEqual(await page.locator("#mcp-list li", { hasText: "arcflare-web" }).getByRole("button", { name: /Remove/ }).count(), 0);

  const rm = row.getByRole("button", { name: "Remove memory" });
  await rm.click();
  await row.locator("text=Tap again to remove").waitFor();
  assert.ok("memory" in JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, "one tap removed it");
  await rm.click();
  await row.waitFor({ state: "detached" });
  assert.ok(!("memory" in JSON.parse(fs.readFileSync(file, "utf8")).mcpServers));
});

test("Tools: a non-owner account has no Add a tool server button", { skip }, async (t) => {
  const { page } = await phone(t, "user");
  await page.locator("#tools-note", { hasText: "Only an owner account" }).waitFor();
  assert.strictEqual(await page.isVisible("#mcp-add"), false);
  assert.strictEqual(await page.isVisible("#sheet-mcp-add"), false);
});
