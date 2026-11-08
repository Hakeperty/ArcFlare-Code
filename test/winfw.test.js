// Windows Firewall verdict for the LAN path (lib/hub/winfw.js). Pure, plus the query with a fake PowerShell.
const test = require("node:test");
const assert = require("node:assert");
const { firewallVerdict, queryFirewall, covers } = require("../lib/hub/winfw");

const EXE = "C:\Users\me\AppData\Local\hermes\node\node.exe";

test("profile strings cover the right networks", () => {
  assert.ok(covers("Any", "Private"));
  assert.ok(covers("Private, Public", "Private"));
  assert.ok(!covers("Public", "Private"));
  assert.ok(!covers("", "Private"));
});

test("node.exe allowed on Public only while the Wi-Fi is Private: the phone times out, say why and how to fix", () => {
  // The exact state found on a real machine: two Allow rules, both Public, home Wi-Fi Private.
  const v = firewallVerdict({ category: "Private", rules: [{ profile: "Public", action: "Allow" }, { profile: "Public", action: "Allow" }], exe: EXE, port: 7878 });
  assert.ok(v, "a verdict");
  assert.match(v.reason, /only on Public/);
  assert.match(v.reason, /Private/);
  assert.match(v.fix, /New-NetFirewallRule .*-Program "C:\Users\me\AppData\Local\hermes\node\node\.exe" -LocalPort 7878 -Profile Private/);
});

test("a Block rule on this network wins over an Allow", () => {
  const v = firewallVerdict({ category: "Private", rules: [{ profile: "Any", action: "Allow" }, { profile: "Private", action: "Block" }], exe: EXE });
  assert.match(v.reason, /BLOCKS/);
});

test("allowed on this network, no rules at all, or nothing known: no warning", () => {
  assert.strictEqual(firewallVerdict({ category: "Private", rules: [{ profile: "Private, Public", action: "Allow" }], exe: EXE }), null);
  assert.strictEqual(firewallVerdict({ category: "Public", rules: [{ profile: "Any", action: "Allow" }], exe: EXE }), null);
  assert.strictEqual(firewallVerdict({ category: "Private", rules: [], exe: EXE }), null, "Windows will ask on first use");
  assert.strictEqual(firewallVerdict({ category: null, rules: [{ profile: "Public", action: "Allow" }], exe: EXE }), null);
  assert.strictEqual(firewallVerdict({ category: "DomainAuthenticated", rules: [{ profile: "Domain", action: "Allow" }], exe: EXE }), null);
});

test("the query: parses PowerShell's answer (one rule comes back as an object), quotes the path, gives up quietly", async () => {
  let seen;
  const fake = (out, err) => (cmd, args, opts, cb) => { seen = args[args.length - 1]; cb(err || null, out); };
  let q = await queryFirewall({ address: "192.168.1.5", exe: "C:\it's\node.exe", run: fake('{"category":"Private","rules":{"profile":"Public","action":"Allow"}}') });
  assert.deepStrictEqual(q, { category: "Private", rules: [{ profile: "Public", action: "Allow" }] });
  assert.match(seen, /-Program 'C:\it''s\node\.exe'/, "single quote doubled for PowerShell");
  assert.match(seen, /-IPAddress '192\.168\.1\.5'/);
  assert.strictEqual(await queryFirewall({ address: "192.168.1.5", exe: EXE, run: fake("", new Error("no such address")) }), null);
  assert.strictEqual(await queryFirewall({ address: "192.168.1.5", exe: EXE, run: fake("garbage") }), null);
  assert.strictEqual(await queryFirewall({ address: "evil'; rm", exe: EXE, run: fake("{}") }), null, "only an IPv4 literal reaches PowerShell");
});

test("the real query on Windows answers with a network category", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { lanAddresses } = require("../lib/hub/cli");
  const a = lanAddresses()[0];
  if (!a) return;
  const q = await queryFirewall({ address: a, exe: process.execPath });
  assert.ok(q && typeof q.category === "string" && Array.isArray(q.rules), JSON.stringify(q));
});
