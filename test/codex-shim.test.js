const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const shim = require("../lib/codex-shim");

const msg = (role, t) => ({ type: "message", role, content: [{ type: "input_text", text: t }] });

test("codex shim: leading developer messages fold into instructions", () => {
  const b = shim.rewrite({ instructions: "BASE", input: [msg("developer", "D1"), msg("developer", "D2"), msg("user", "hi")] });
  assert.strictEqual(b.instructions, "BASE\n\nD1\n\nD2");
  assert.deepStrictEqual(b.input, [msg("user", "hi")]);
});

test("codex shim: a later developer message becomes a tagged user message, prefix unchanged", () => {
  const first = shim.rewrite({ instructions: "BASE", input: [msg("developer", "D"), msg("user", "a")] });
  const later = shim.rewrite({ instructions: "BASE", input: [msg("developer", "D"), msg("user", "a"), msg("developer", "NEW"), msg("user", "b")] });
  assert.strictEqual(later.instructions, first.instructions);
  assert.strictEqual(later.input.length, 3);
  assert.strictEqual(later.input[1].role, "user");
  assert.match(later.input[1].content[0].text, /<developer_message>\nNEW\n<\/developer_message>/);
});

test("codex shim: bodies without input, and string content, are handled", () => {
  assert.deepStrictEqual(shim.rewrite({ model: "x" }), { model: "x" });
  const b = shim.rewrite({ input: [{ type: "message", role: "system", content: "S" }, msg("user", "u")] });
  assert.strictEqual(b.instructions, "S");
  assert.strictEqual(b.input.length, 1);
});

test("codex shim: proxies /responses rewritten and other paths untouched", async (t) => {
  const seen = [];
  const up = http.createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { seen.push({ url: req.url, body: d }); res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: 1\n\n"); res.end("data: 2\n\n"); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const s = await shim.start(up.address().port);
  t.after(() => { s.close(); up.close(); });
  const base = `http://127.0.0.1:${s.address().port}`;

  const r = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: "B", input: [msg("developer", "D"), msg("user", "u")] }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), "data: 1\n\ndata: 2\n\n");
  const sent = JSON.parse(seen[0].body);
  assert.strictEqual(sent.instructions, "B\n\nD");
  assert.strictEqual(sent.input.length, 1);

  await fetch(`${base}/v1/models`);
  assert.strictEqual(seen[1].url, "/v1/models");
});
