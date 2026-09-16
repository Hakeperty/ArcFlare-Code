// Is the thing we just started actually answering?
//
// "It built and the process is still alive" is a weak claim about a web app —
// a server that crashed on its first request is also still alive for a second.
// So testing built software means asking it something and reading the reply,
// which is all this file does: one HTTP request, one TCP connect, and a retry
// loop for the seconds a dev server spends warming up.

const http = require("http");
const https = require("https");
const net = require("net");
const { URL } = require("url");

const BODY_LIMIT = 8000;

/** One HTTP request. Resolves with a result object; never rejects. */
function httpOnce(url, { method = "GET", headers, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: `bad url: ${e.message}` }); }
    const mod = u.protocol === "https:" ? https : http;
    const started = Date.now();

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      timeout: timeoutMs,
      headers: {
        "User-Agent": "arcflare-mcp",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        ...(headers || {}),
      },
      // A self-signed certificate on a local dev server is the normal case,
      // not an attack; refusing it would just make the tool useless there.
      rejectUnauthorized: false,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (text.length < BODY_LIMIT) text += d; });
      res.on("end", () => resolve({
        ok: res.statusCode < 400,
        status: res.statusCode,
        statusText: res.statusMessage || "",
        contentType: res.headers["content-type"] || "",
        bytes: Number(res.headers["content-length"]) || text.length,
        ms: Date.now() - started,
        body: text.slice(0, BODY_LIMIT),
        headers: res.headers,
      }));
    });

    req.on("error", (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout", ms: Date.now() - started }); });
    if (body) req.write(body);
    req.end();
  });
}

/** Is something listening on host:port? */
function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: host || "127.0.0.1", port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

/** Poll `fn` until it returns truthy or the deadline passes. */
async function waitUntil(fn, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return { ok: true, result: last, waitedMs: timeoutMs - (deadline - Date.now()) };
    if (Date.now() >= deadline) return { ok: false, result: last, waitedMs: timeoutMs };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Request a URL, retrying while it is not up yet.
 *
 * Connection refused during the first few seconds is a server still booting,
 * not a failure; an HTTP error code is a real answer and comes straight back.
 */
async function httpProbe(url, opts = {}) {
  const waitMs = Number(opts.wait_ms ?? opts.waitMs ?? 0);
  const once = () => httpOnce(url, {
    method: opts.method, headers: opts.headers, body: opts.body,
    timeoutMs: opts.timeout_ms || opts.timeoutMs || 10000,
  });
  if (!waitMs) return once();

  const deadline = Date.now() + waitMs;
  let last = await once();
  while (!last.status && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    last = await once();
  }
  return last;
}

/** A one-line summary of an HTTP result, for a model that wants the verdict first. */
function describe(res) {
  if (!res) return "no response";
  if (res.error) return `no answer (${res.error})`;
  return `HTTP ${res.status} ${res.statusText} · ${res.contentType.split(";")[0] || "?"} · ${res.ms}ms`;
}

module.exports = { httpOnce, httpProbe, portOpen, waitUntil, describe, BODY_LIMIT };
