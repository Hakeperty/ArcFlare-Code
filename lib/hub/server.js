// The hub's HTTP front door: the phone UI, a JSON API and two SSE streams, on
// nothing but node:http (https only when the host CLI hands us a tls pair).
//
// This is the part of the hub that faces a network, so every decision here
// leans toward "refuse by default".
//
// Who may talk to it. The hub binds to the LAN so a phone can reach it, which
// means anything else on the LAN (or, if someone port-forwards, the internet)
// can too. So the socket's own remote address must be loopback or private,
// unless config.allowRemote says otherwise. X-Forwarded-For is never read: it
// is a header the client writes, and trusting it would turn the gate into a
// suggestion. The Host header is checked against an allowlist (localhost, IP
// literals, *.local, config.allowedHosts) so a page on evil.example cannot
// DNS-rebind to 192.168.x.x and talk to the hub from a victim's browser.
//
// Who may change things. The cookie is SameSite=Strict and HttpOnly, but that
// is not the only layer: every state-changing request also needs the
// per-session X-CSRF-Token (kept in page memory, never in storage), an Origin
// that matches the Host when the browser sends one, a JSON content type (which
// a cross-site form cannot produce) and a body under 64 KB. No CORS headers
// are ever emitted, so no other origin can read a response either.
//
// What it serves. Static files come from an exact-name allowlist looked up
// against the raw request path, never joined onto a directory, so there is no
// traversal to get wrong. Supervisor errors are mapped by .code to fixed
// messages; stack traces, paths and error text from below never reach a client.
//
// Auth and supervisor are injected (contract in the hub design), which is also
// why the tests can run this file against small fakes.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");

const MAX_BODY = 64 * 1024;
const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;
const HEARTBEAT_MS = 10000;
const BODY_IDLE_MS = 8000;
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS_TOTAL = 64;
const MAX_SSE_BACKLOG = 1024 * 1024; // a stalled phone must not grow our memory without bound
const TIERS = new Set(["light", "standard", "hard"]);
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Exact request path -> file in uiDir and its type. Nothing else is ever read.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/assets/bitcount-single.ttf": ["assets/bitcount-single.ttf", "font/ttf"],
  "/assets/geist-latin.woff2": ["assets/geist-latin.woff2", "font/woff2"],
  "/assets/geist-mono-latin.woff2": ["assets/geist-mono-latin.woff2", "font/woff2"],
  "/assets/mascot-light.png": ["assets/mascot-light.png", "image/png"],
  "/assets/mascot-dark.png": ["assets/mascot-dark.png", "image/png"],
  "/assets/panda-search.png": ["assets/panda-search.png", "image/png"],
  "/tunnel-client.js": ["tunnel-client.js", "text/javascript; charset=utf-8"],
};

// ---- address checks --------------------------------------------------------

function parseIPv6(addr) {
  // -> array of 8 16-bit groups, or null
  let a = addr;
  const v4 = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (net.isIPv4(v4[2]) === false) return null;
    const p = v4[2].split(".").map(Number);
    a = v4[1] + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = head.concat(Array(fill).fill("0"), tail);
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isPrivateV4(a, b) {
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

// True for loopback, link-local and RFC1918 / ULA addresses, including
// IPv4-mapped IPv6 (::ffff:a.b.c.d and its hex form). Anything unparsable is false.
function isPrivateAddress(addr) {
  if (typeof addr !== "string" || !addr) return false;
  let a = addr.trim();
  const zone = a.indexOf("%");
  if (zone !== -1) a = a.slice(0, zone);
  if (net.isIPv4(a)) {
    const p = a.split(".").map(Number);
    return isPrivateV4(p[0], p[1]);
  }
  if (!net.isIPv6(a)) return false;
  const g = parseIPv6(a);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPrivateV4(g[6] >> 8, g[6] & 0xff); // IPv4-mapped
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return null;
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end === -1) return null;
    const rest = h.slice(end + 1);
    if (rest && !/^:\d+$/.test(rest)) return null;
    return h.slice(1, end);
  }
  const m = h.match(/^([^:]+)(?::\d+)?$/);
  return m ? m[1] : null;
}

function hostAllowed(hostHeader, allowedHosts) {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  if (h === "localhost" || net.isIP(h)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(h)) return true;
  return allowedHosts.includes(h);
}

// ---- cookie helpers (used only when auth supplies none) --------------------

const localHelpers = {
  cookieName: (secure) => (secure ? "__Host-arcflare" : "arcflare_sid"),
  cookieHeader: (token, { secure, maxAgeSec }) =>
    `${localHelpers.cookieName(secure)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}` + (secure ? "; Secure" : ""),
  clearCookieHeader: ({ secure }) =>
    `${localHelpers.cookieName(secure)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` + (secure ? "; Secure" : ""),
  parseCookies(v) {
    const out = {};
    if (typeof v !== "string") return out;
    for (const part of v.split(";")) {
      const i = part.indexOf("=");
      if (i < 1) continue;
      const k = part.slice(0, i).trim();
      if (!(k in out)) out[k] = part.slice(i + 1).trim();
    }
    return out;
  },
  checkCsrf(session, header) {
    if (!session || typeof session.csrf !== "string" || typeof header !== "string") return false;
    const a = crypto.createHash("sha256").update(session.csrf).digest();
    const b = crypto.createHash("sha256").update(header).digest();
    return crypto.timingSafeEqual(a, b);
  },
};

function resolveHelpers(auth, override) {
  let mod = {};
  try { mod = require("./auth"); } catch { /* auth.js not available: local fallbacks */ }
  const out = {};
  for (const k of Object.keys(localHelpers)) {
    const f = (override && override[k]) || (auth && typeof auth[k] === "function" && auth[k].bind(auth)) ||
      (typeof mod[k] === "function" && mod[k]) || localHelpers[k];
    out[k] = f;
  }
  return out;
}

// ---- small response helpers ------------------------------------------------

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SUPERVISOR_ERRORS = {
  BAD_CWD: [400, "That folder is not allowed"],
  BUSY: [409, "Agent is busy"],
  NOT_FOUND: [404, "Not found"],
  BAD_TIER: [400, "Unknown tier"],
  BAD_REQUEST: [400, "Bad request"],
  NOT_RUNNING: [409, "Agent is not running"],
  STOPPED: [409, "Agent is stopped"],
  NO_BACKEND: [503, "No model is available"],
  NO_MODEL: [503, "No local model found"],
  LIMIT: [409, "Too many agents"],
  MODEL_BUSY: [409, "Another agent is using a different model"],
};

function sendJson(res, status, body, headers) {
  if (res.headersSent) return;
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
  }, headers));
  res.end(data);
}

function readJson(req, idleMs = BODY_IDLE_MS) {
  return new Promise((resolve, reject) => {
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > MAX_BODY) {
      return reject(new HttpError(413, "Request too large"));
    }
    const chunks = [];
    let size = 0;
    // Node's requestTimeout only covers the headers. A client that promises a
    // body and never sends it would hold the socket forever, with no login, so
    // the body gets its own inactivity deadline.
    let idle = null;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        reject(new HttpError(408, "Request timed out"));
        req.socket.destroy();
      }, idleMs);
    };
    const disarm = () => clearTimeout(idle);
    arm();
    req.on("close", disarm);
    req.on("data", (c) => {
      arm();
      size += c.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        reject(new HttpError(413, "Request too large"));
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      disarm();
      if (size > MAX_BODY) return;
      if (size === 0) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolve(v);
      } catch {
        reject(new HttpError(400, "Body must be a JSON object"));
      }
    });
    req.on("error", () => reject(new HttpError(400, "Bad request")));
  });
}

function hasBody(req) {
  const cl = req.headers["content-length"];
  return (cl !== undefined && Number(cl) > 0) || req.headers["transfer-encoding"] !== undefined;
}

function str(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

// ---- server ----------------------------------------------------------------

function createHubServer(opts) {
  const { auth, supervisor, models, uiDir = path.join(__dirname, "ui"), tls } = opts || {};
  // The hub's own tunnel mailbox (lib/hub/lanrelay.js), or null when the LAN
  // path is off. Mounted under /api/tunnel/, outside the cookie/CSRF logic.
  const lanRelay = (opts && opts.lanRelay) || null;
  const config = Object.assign({ allowRemote: false, allowedHosts: [], roots: [], secure: false }, opts && opts.config);
  const secure = !!config.secure || !!tls;
  const allowedHosts = (config.allowedHosts || []).map((h) => String(h).toLowerCase());
  const heartbeatMs = config.heartbeatMs || HEARTBEAT_MS;
  const helpers = resolveHelpers(auth, opts && opts.helpers);
  const remoteAddr = (opts && opts.getRemoteAddress) || ((req) => req.socket.remoteAddress);
  const cookieName = helpers.cookieName(secure);
  const sseClients = new Set();
  // Requests that arrived through the authenticated relay tunnel (lib/hub/tunnel.js),
  // keyed by the request object itself. Only in-process code holding this
  // server's dispatchTunnel can add to it; nothing a client sends can.
  const viaTunnel = new WeakMap();

  const log = typeof config.log === "function" ? config.log : () => {};

  function baseHeaders(res, isApi) {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", isApi ? "no-store" : "no-cache");
  }

  function tokenOf(req) {
    const t = helpers.parseCookies(req.headers.cookie)[cookieName];
    return typeof t === "string" && t ? t : null;
  }

  function session(req) {
    const token = tokenOf(req);
    if (!token) return null;
    const s = auth.authenticate(token);
    return s ? { token, s } : null;
  }

  function requireSession(req) {
    const cur = session(req);
    if (!cur) throw new HttpError(401, "Not signed in");
    return cur;
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    if (origin !== `${secure ? "https" : "http"}://${req.headers.host}`) throw new HttpError(403, "Origin not allowed");
  }

  function mapError(err) {
    if (err instanceof HttpError) return err;
    const m = err && SUPERVISOR_ERRORS[err.code];
    if (m) return new HttpError(m[0], m[1]);
    log(err);
    return new HttpError(500, "Internal error");
  }

  function agentOr404(id) {
    if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
    const a = supervisor.get(id);
    if (!a) throw new HttpError(404, "Not found");
    return a;
  }

  // ---- SSE ----

  // token -> open stream count, so one session cannot hold the box open.
  const streamsByToken = new Map();
  const streamEnders = new Map(); // end() -> token, for sweeping after a revoke

  /** Close every stream whose session is gone, now rather than at the next beat. */
  function sweepStreams() {
    for (const [end, token] of [...streamEnders]) {
      let still = null;
      try { still = auth.authenticate(token); } catch { /* treat as gone */ }
      if (!still) end();
    }
  }

  function openStream(req, res, cur, { replay, after = 0, filter }) {
    const mine = streamsByToken.get(cur.token) || 0;
    if (mine >= MAX_STREAMS_PER_SESSION || sseClients.size >= MAX_STREAMS_TOTAL) {
      throw new HttpError(429, "Too many open streams");
    }
    streamsByToken.set(cur.token, mine + 1);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.write("retry: 3000\n\n");
    let lastSeq = after; // per-agent streams only: seqs are monotonic per agent
    const write = (ev) => {
      if (replay && ev.seq !== undefined) {
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;
      }
      if (res.writableLength > MAX_SSE_BACKLOG) return end();
      res.write((ev.seq !== undefined ? `id: ${ev.seq}\n` : "") + `data: ${JSON.stringify(ev)}\n\n`);
    };
    const onEvent = (ev) => { if (!filter || filter(ev)) write(ev); };
    let timer = null;
    function end() {
      if (timer) clearInterval(timer);
      timer = null;
      supervisor.removeListener("event", onEvent);
      if (sseClients.delete(res)) {
        const left = (streamsByToken.get(cur.token) || 1) - 1;
        if (left > 0) streamsByToken.set(cur.token, left); else streamsByToken.delete(cur.token);
      }
      streamEnders.delete(end);
      if (!res.writableEnded) res.end();
    }
    sseClients.add(res);
    streamEnders.set(end, cur.token);
    supervisor.on("event", onEvent);
    if (replay) for (const ev of replay()) write(ev);
    timer = setInterval(() => {
      // A revoked or expired session closes its streams at the next beat.
      let still = null;
      try { still = auth.authenticate(cur.token); } catch { /* treat as gone */ }
      if (!still) return end();
      res.write(": hb\n\n");
    }, heartbeatMs);
    req.on("close", end);
    res.on("close", end);
  }

  // ---- API ----

  async function api(req, res, pathname, query) {
    const method = req.method;
    const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    const isLogin = pathname === "/api/login";

    if (mutating) checkOrigin(req);

    let cur = null;
    if (!isLogin && !(method === "GET" && pathname === "/api/status")) {
      cur = requireSession(req);
      if (mutating && !helpers.checkCsrf(cur.s, req.headers["x-csrf-token"])) throw new HttpError(403, "Bad CSRF token");
    }

    let body = {};
    if (mutating) {
      if (hasBody(req)) {
        const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (ct !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
        body = await readJson(req, config.bodyIdleMs || BODY_IDLE_MS);
      }
    }

    let m;
    if (method === "GET" && pathname === "/api/status") {
      return sendJson(res, 200, { setup: !!auth.hasAccounts() });
    }
    if (method === "POST" && isLogin) {
      if (!str(body.username, 64) || !str(body.password, 1024)) throw new HttpError(400, "Username and password required");
      const device = typeof body.device === "string" ? body.device.slice(0, 80) : "";
      const r = await auth.login({
        username: body.username,
        password: body.password,
        // Tunnel requests all come from this process, so the lockout keys on
        // the paired device instead of one shared address.
        ip: viaTunnel.has(req) ? `relay:${viaTunnel.get(req).deviceId}` : req.socket.remoteAddress,
        userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
        device,
      });
      if (!r || !r.ok) {
        if (r && r.code === "BUSY") {
          return sendJson(res, 503, { error: "Busy. Try again in a moment.", retryAfterSec: 1 }, { "Retry-After": "1" });
        }
        if (r && r.code === "LOCKED") {
          const sec = Math.max(1, Math.ceil((r.retryAfterMs || 1000) / 1000));
          return sendJson(res, 429, { error: "Too many attempts. Try again later.", retryAfterSec: sec }, { "Retry-After": String(sec) });
        }
        return sendJson(res, 401, { error: "Wrong username or password" });
      }
      const info = auth.authenticate(r.token);
      const user = (info && info.user) || { username: body.username };
      return sendJson(res, 200, { user, csrf: r.csrf }, {
        "Set-Cookie": helpers.cookieHeader(r.token, { secure, maxAgeSec: SESSION_MAX_AGE_SEC }),
      });
    }
    if (method === "POST" && pathname === "/api/logout") {
      auth.logout(cur.token);
      sweepStreams();
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": helpers.clearCookieHeader({ secure }) });
    }
    if (method === "GET" && pathname === "/api/me") return sendJson(res, 200, { user: cur.s.user, csrf: cur.s.csrf });

    if (method === "GET" && pathname === "/api/sessions") {
      const list = auth.listSessions(cur.s.user.username).map((x) => ({
        id: x.id, device: x.device, ip: x.ip, created: x.created, lastSeen: x.lastSeen,
        current: !!(cur.s.session && x.id === cur.s.session.id),
      }));
      return sendJson(res, 200, list);
    }
    if (method === "POST" && pathname === "/api/sessions/revoke-others") {
      const revoked = auth.revokeAll(cur.s.user.username, cur.token);
      sweepStreams();
      return sendJson(res, 200, { revoked });
    }
    if (method === "DELETE" && (m = pathname.match(/^\/api\/sessions\/([^/]+)$/))) {
      if (!ID_RE.test(m[1]) || !auth.revokeSession(cur.s.user.username, m[1])) throw new HttpError(404, "Not found");
      sweepStreams();
      return sendJson(res, 200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/models") {
      return sendJson(res, 200, (await (models ? models() : [])) || []);
    }
    if (method === "GET" && pathname === "/api/agents") return sendJson(res, 200, supervisor.list());
    if (method === "POST" && pathname === "/api/agents") {
      if (!str(body.name, 100) || !str(body.cwd, 4096)) throw new HttpError(400, "name and cwd required");
      if (body.tier !== undefined && !TIERS.has(body.tier)) throw new HttpError(400, "tier must be light, standard or hard");
      if (body.task !== undefined && typeof body.task !== "string") throw new HttpError(400, "task must be text");
      const a = await supervisor.create({ name: body.name, cwd: body.cwd, tier: body.tier || "standard", task: body.task });
      return sendJson(res, 201, a);
    }
    if (method === "GET" && pathname === "/api/events") {
      const isMine = (ev) => ["status", "approval", "approval_resolved", "turn_end", "error"].includes(ev.type);
      return openStream(req, res, cur, { filter: isMine });
    }
    if ((m = pathname.match(/^\/api\/agents\/([^/]+)(?:\/([a-z]+))?$/))) {
      const id = m[1], action = m[2];
      if (!action && method === "GET") return sendJson(res, 200, agentOr404(id));
      if (!action && method === "DELETE") {
        agentOr404(id);
        await supervisor.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      if (action === "events" && method === "GET") {
        agentOr404(id);
        const n = parseInt(query.get("after") || req.headers["last-event-id"] || "0", 10);
        const after = Number.isFinite(n) && n > 0 ? n : 0;
        return openStream(req, res, cur, {
          after,
          replay: () => supervisor.history(id, after),
          filter: (ev) => ev.agentId === id,
        });
      }
      if (method === "POST" && action) {
        if (["start", "stop", "wake", "approve"].includes(action)) agentOr404(id);
        if (action === "start") {
          if (body.task !== undefined && typeof body.task !== "string") throw new HttpError(400, "task must be text");
          return sendJson(res, 200, await supervisor.start(id, { task: body.task }));
        }
        if (action === "stop") return sendJson(res, 200, await supervisor.stop(id));
        if (action === "wake") {
          if (!str(body.text, 20000)) throw new HttpError(400, "text required");
          return sendJson(res, 200, await supervisor.wake(id, body.text));
        }
        if (action === "approve") {
          if (!str(body.approvalId, 200) || typeof body.allow !== "boolean") throw new HttpError(400, "approvalId and allow required");
          const ok = await supervisor.approve(id, body.approvalId, body.allow);
          if (!ok) throw new HttpError(404, "No such pending approval");
          return sendJson(res, 200, { ok: true });
        }
      }
    }
    throw new HttpError(404, "Not found");
  }

  function serveStatic(req, res, pathname) {
    const ent = Object.prototype.hasOwnProperty.call(STATIC, pathname) ? STATIC[pathname] : null;
    if (!ent || (req.method !== "GET" && req.method !== "HEAD")) {
      return sendJson(res, 404, { error: "Not found" });
    }
    fs.readFile(path.join(uiDir, ent[0]), (err, data) => {
      if (err) return sendJson(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": ent[1], "Content-Length": data.length });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  }

  function handler(req, res) {
    const raw = req.url || "";
    const isApi = raw === "/api" || raw.startsWith("/api/") || raw.startsWith("/api?");
    baseHeaders(res, isApi);
    if (!viaTunnel.has(req) && !config.allowRemote && !isPrivateAddress(remoteAddr(req))) {
      return sendJson(res, 403, { error: "Forbidden" });
    }
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      return sendJson(res, 421, { error: "Misdirected request" });
    }
    if (!raw.startsWith("/")) return sendJson(res, 400, { error: "Bad request" });
    const q = raw.indexOf("?");
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));

    // The LAN mailbox. It sits after the private-address gate and the Host
    // allowlist (so only LAN peers reach it) and before the session logic: it
    // authenticates with bearer tokens, never cookies, so there is no cookie
    // to ride and no CSRF to check. The Origin/CSRF rules of the web API do not
    // run here and still run for everything else. It carries ciphertext only.
    // A tunneled request (already inside the tunnel) can never reach it.
    if (pathname === "/api/tunnel" || pathname.startsWith("/api/tunnel/")) {
      res.removeHeader("Cross-Origin-Resource-Policy");
      if (!lanRelay || viaTunnel.has(req)) return sendJson(res, 404, { error: "Not found" });
      // The socket's own address, never a header: see the top of this file.
      lanRelay.handle(req, res, remoteAddr(req));
      return;
    }

    if (!isApi) return serveStatic(req, res, pathname);
    api(req, res, pathname, query).catch((err) => {
      const e = mapError(err);
      if (res.headersSent) return res.destroy();
      if (e.status === 413) res.setHeader("Connection", "close");
      sendJson(res, e.status, Object.assign({ error: e.message }, e.extra));
    });
  }

  const server = tls ? require("node:https").createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;

  function listen({ port = 0, host = "0.0.0.0" } = {}) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        const addr = server.address();
        const scheme = secure ? "https" : "http";
        const urls = [];
        if (host === "0.0.0.0" || host === "::") {
          for (const list of Object.values(os.networkInterfaces())) {
            for (const i of list || []) if (i.family === "IPv4" && !i.internal) urls.push(`${scheme}://${i.address}:${addr.port}`);
          }
          urls.push(`${scheme}://localhost:${addr.port}`);
        } else {
          urls.push(`${scheme}://${host.includes(":") ? `[${host}]` : host}:${addr.port}`);
        }
        resolve({ port: addr.port, host, urls });
      });
    });
  }

  function close() {
    if (lanRelay) lanRelay.close();
    return new Promise((resolve) => {
      for (const r of sseClients) r.end();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  // Feed a request that the tunnel has already decrypted and authenticated
  // (device id established by the handshake) through the same handler as the
  // socket. Every other check — Host, session, CSRF, lockout — still runs.
  function dispatchTunnel(req, res, ctx) {
    if (!ctx || typeof ctx.deviceId !== "string" || !ctx.deviceId) throw new Error("dispatchTunnel needs a deviceId");
    viaTunnel.set(req, Object.freeze({ deviceId: ctx.deviceId }));
    handler(req, res);
  }

  return { server, listen, close, dispatchTunnel, cookieName, lanRelay };
}

module.exports = { createHubServer, isPrivateAddress, hostAllowed };
