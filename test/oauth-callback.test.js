// `arcflare mcp login` opens a page on 127.0.0.1 for the browser to come back to. Whatever the link puts in its
// `error` parameter must appear on that page as text, never as markup that runs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-oauth-"));
const oauth = require("../lib/agent/oauth");

test("the login callback page shows an error from the link escaped", async () => {
  // Just enough of an authorization server for the flow to reach the callback page.
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) return json({ authorization_servers: [base] });
    if (req.url === "/.well-known/oauth-authorization-server") {
      return json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    }
    if (req.url === "/register") { req.resume(); return json({ client_id: "c1" }); }
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  let got = null;
  try {
    await assert.rejects(oauth.login({
      name: "evil",
      url: `http://127.0.0.1:${srv.address().port}/mcp`,
      // The browser comes back after onUrl has returned, as it does for real.
      onUrl: (authUrl) => {
        const back = new URL(new URL(authUrl).searchParams.get("redirect_uri"));
        back.searchParams.set("error", "<script>alert(1)</script>");
        got = fetch(back).then((r) => r.text());
      },
    }), /<script>alert\(1\)<\/script>/);
  } finally { srv.close(); }
  const page = await got;
  assert.ok(!page.includes("<script>"), page);
  assert.ok(page.includes("&#60;script&#62;alert(1)&#60;/script&#62;"), page);
});
