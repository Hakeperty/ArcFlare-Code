// The MCP client against small misbehaving stdio servers.

const test = require("node:test");
const assert = require("node:assert");
const { McpServer } = require("../lib/agent/mcp");

/** A stdio server whose answer to each request is `reply(msg)` (null: no answer). */
function fake(name, body) {
  const src = `const rl = require("readline").createInterface({ input: process.stdin });
    const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    rl.on("line", (l) => { const msg = JSON.parse(l); ${body} });`;
  return new McpServer(name, { command: process.execPath, args: ["-e", src] });
}
const INIT = `if (msg.method === "initialize") return say({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });`;

test("a stdio server that stops reading fails the call instead of crashing the agent", async () => {
  const s = fake("deaf", `${INIT}
    if (msg.method === "tools/list") {
      say({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t" }] } });
      rl.close(); require("fs").closeSync(0); setTimeout(() => {}, 20000);
    }`);
  try {
    await s.start(10000);
    // The write lands on a pipe nobody reads: EPIPE, which used to be uncaught.
    await assert.rejects(s.call("t", {}, 10000), /EPIPE|exited/);
  } finally { s.stop(); }
});

test("a request from the server is not taken as the answer to ours", async () => {
  const s = fake("asks", `${INIT}
    if (msg.method === "tools/list") {
      // Same id as our request, but it is the server asking, not answering.
      say({ jsonrpc: "2.0", id: msg.id, method: "roots/list" });
      say({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "real" }] } });
    }`);
  try {
    await s.start(10000);
    assert.deepStrictEqual(s.tools.map((t) => t.name), ["real"]);
  } finally { s.stop(); }
});
