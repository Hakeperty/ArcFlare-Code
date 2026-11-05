// A small in-process proxy between Codex and llama-server.
//
// Codex sends its base prompt as `instructions` and then, as the first input
// item, a `developer` message (skills, sandbox and approval rules). llama-server
// renders both as system messages, and many chat templates - Qwen's among them -
// raise "System message must be at the beginning" on a second one. The server
// answers 500, which Codex reports as "We're currently experiencing high demand".
//
// The rewrite, for POST .../responses only:
//   * developer/system messages before the first other input item are folded
//     into `instructions`, so the system prompt stays one message and stays
//     byte-identical from turn to turn (the prompt cache depends on that);
//   * a developer/system message later in the conversation becomes a user
//     message wrapped in <developer_message>, so it keeps its place in the
//     history instead of rewriting the prefix.
// Everything else, streams included, passes through untouched.

const http = require("http");

function text(msg) {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((p) => (p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

const isSys = (m) => m && m.type === "message" && (m.role === "developer" || m.role === "system");

/** Rewrite one Responses API request body. Returns the same object, changed in place. */
function rewrite(body) {
  if (!body || !Array.isArray(body.input)) return body;
  const lead = [];
  let i = 0;
  while (i < body.input.length && isSys(body.input[i])) lead.push(text(body.input[i++]));
  const rest = body.input.slice(i).map((m) => (isSys(m)
    ? { type: "message", role: "user", content: [{ type: "input_text", text: `<developer_message>\n${text(m)}\n</developer_message>` }] }
    : m));
  const parts = [typeof body.instructions === "string" ? body.instructions : "", ...lead].filter(Boolean);
  if (parts.length) body.instructions = parts.join("\n\n");
  body.input = rest;
  return body;
}

/**
 * Start the shim on an ephemeral port in front of 127.0.0.1:<upstreamPort>.
 * Resolves to the http.Server; its address().port is where to point Codex.
 */
function start(upstreamPort) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let payload = Buffer.concat(chunks);
      if (req.method === "POST" && /\/responses\/?(\?|$)/.test(req.url)) {
        try {
          payload = Buffer.from(JSON.stringify(rewrite(JSON.parse(payload.toString("utf8")))));
        } catch { /* not JSON: pass it through and let the server answer */ }
      }
      const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}`, "content-length": String(payload.length) };
      delete headers["transfer-encoding"];
      const up = http.request({ host: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `ArcFlare could not reach the model server: ${e.message}` } }));
      });
      res.on("close", () => up.destroy());
      up.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}

module.exports = { rewrite, start };
