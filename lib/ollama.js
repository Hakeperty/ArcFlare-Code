// Minimal client for a local Ollama-compatible server (default 127.0.0.1:11434).
// Zero dependencies — uses Node's http with NDJSON streaming. ArcFlare uses
// this as its inference backend, the same engine Ollama exposes.

const http = require("http");
const { URL } = require("url");

const HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");

function request(method, path, body, onLine, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(HOST + path);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method,
        headers: data
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line && onLine) {
              try { onLine(JSON.parse(line)); } catch {}
            }
          }
        });
        res.on("end", () => {
          if (buf.trim() && onLine) {
            try { onLine(JSON.parse(buf)); } catch {}
          }
          resolve(res.statusCode);
        });
      },
    );
    req.on("error", reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    }
    if (data) req.write(data);
    req.end();
  });
}

/** Is an Ollama server reachable? */
async function isUp(timeoutMs = 900) {
  try {
    let ok = false;
    await request("GET", "/api/version", null, () => { ok = true; }, timeoutMs);
    return ok;
  } catch {
    return false;
  }
}

/** Names of locally-available models, e.g. ["qwen2.5:latest", "llama3.2:1b"]. */
async function tags() {
  const out = [];
  try {
    await request("GET", "/api/tags", null, (j) => {
      if (Array.isArray(j.models)) for (const m of j.models) out.push(m.name);
    });
  } catch {}
  return out;
}

/** True if `name` (or `name:*`) is already pulled. */
async function has(name) {
  const list = await tags();
  return list.some((t) => t === name || t.split(":")[0] === name.split(":")[0]);
}

/** Pull a model, streaming {status, completed, total} progress lines. */
function pull(name, onProgress) {
  return request("POST", "/api/pull", { name, stream: true }, onProgress);
}

/** Stream a chat completion. messages: [{role, content}]. onToken(text) per chunk. */
async function chat(model, messages, onToken) {
  let full = "";
  await request("POST", "/api/chat", { model, messages, stream: true }, (j) => {
    if (j.message && j.message.content) {
      full += j.message.content;
      if (onToken) onToken(j.message.content);
    }
  });
  return full;
}

module.exports = { HOST, isUp, tags, has, pull, chat };
