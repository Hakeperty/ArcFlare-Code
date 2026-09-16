// OAuth for hosted MCP servers.
//
// A local server is a process you spawn; a hosted one is a URL that answers 401
// until you prove who you are. The MCP spec says how: the 401 names a metadata
// document, the metadata names an authorization server, the authorization
// server takes a dynamically registered public client through an authorization
// code with PKCE, and the token comes back with a refresh token so it only has
// to happen once.
//
// All of it is plain HTTPS and one short-lived local listener, so it stays
// inside ArcFlare's no-dependency rule. What it cannot do without a person is
// the consent screen itself — that is the point of the consent screen — so the
// flow opens a browser and waits.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const STORE = path.join(HOME, "oauth.json");

// ------------------------------------------------------------------ http ----

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`bad url ${url}: ${e.message}`)); }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method, timeout: 30000,
      headers: {
        Accept: "application/json",
        "User-Agent": "arcflare",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`${url} timed out`)); });
    if (body) req.write(body);
    req.end();
  });
}

const form = (o) => new URLSearchParams(o).toString();

// ------------------------------------------------------------- discovery ----

/**
 * Follow the trail from a resource URL to its authorization server.
 *
 * The 401's WWW-Authenticate header names the metadata document, but a server
 * that answers the well-known path without being asked is just as valid, so
 * both are tried before giving up.
 */
async function discover(resourceUrl, wwwAuthenticate) {
  const u = new URL(resourceUrl);
  const candidates = [];
  const named = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate || "");
  if (named) candidates.push(named[1]);
  candidates.push(
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`);

  let resource = null;
  for (const c of candidates) {
    const r = await request(c).catch(() => null);
    if (r && r.status === 200 && r.json && r.json.authorization_servers) { resource = r.json; break; }
  }
  if (!resource) throw new Error(`${resourceUrl} did not advertise an authorization server`);

  const issuer = resource.authorization_servers[0];
  let meta = null;
  for (const c of [
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  ]) {
    const r = await request(c).catch(() => null);
    if (r && r.status === 200 && r.json && r.json.authorization_endpoint) { meta = r.json; break; }
  }
  if (!meta) throw new Error(`authorization server ${issuer} published no usable metadata`);

  return {
    resource: resource.resource || u.origin,
    scopes: resource.scopes_supported || [],
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint || null,
  };
}

// ------------------------------------------------------------------ pkce ----

const b64url = (buf) => buf.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ---------------------------------------------------------------- storage ----

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}

function saveStore(store) {
  fs.mkdirSync(HOME, { recursive: true });
  // These are live credentials. 0600 is respected on POSIX and harmless on
  // Windows, where the file inherits the profile's ACL.
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(STORE, 0o600); } catch {}
}

function saved(name) {
  return loadStore()[name] || null;
}

function forget(name) {
  const store = loadStore();
  if (!store[name]) return false;
  delete store[name];
  saveStore(store);
  return true;
}

// ------------------------------------------------------------------- flow ----

/**
 * Run the whole flow for one server and store the result.
 *
 * @param {object} o
 * @param {string} o.name     what to file the credentials under
 * @param {string} o.url      the MCP endpoint
 * @param {function} o.onUrl  called with the consent URL, to open it or print it
 */
async function login({ name, url, onUrl, wwwAuthenticate, scopes }) {
  const meta = await discover(url, wwwAuthenticate);
  const wanted = (scopes && scopes.length ? scopes : meta.scopes).join(" ") || "openid";
  return codeFlow({ name, url, meta, wanted, onUrl });
}

async function codeFlow({ name, url, meta, wanted, onUrl }) {
  const state = b64url(crypto.randomBytes(16));
  const { verifier, challenge } = pkce();

  // Bind the loopback listener, then register a client for exactly that URI.
  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (!u.pathname.startsWith("/callback")) { res.writeHead(404).end(); return; }
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    const ok = !!code && u.searchParams.get("state") === state;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>ArcFlare</title>
<body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<div style="font-size:28px;color:${ok ? "#ffab2e" : "#e06c75"}">${ok ? "ArcFlare is connected" : "Authorization failed"}</div>
<p style="opacity:.7">${ok ? "Close this tab and go back to the terminal." : (err || "no code returned")}</p>
</div></body>`);
    setTimeout(() => { try { server.close(); } catch {} }, 250);
    if (ok) resolveCode(code);
    else rejectCode(new Error(err || "the redirect carried no usable code"));
  });
  await new Promise((r, j) => { server.on("error", j); server.listen(0, "127.0.0.1", r); });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => {
    try { server.close(); } catch {}
    rejectCode(new Error("timed out waiting for the browser"));
  }, 300000);

  try {
    if (!meta.registrationEndpoint) {
      throw new Error(`${meta.issuer} does not support dynamic client registration; ` +
        `put a token in the server's config instead`);
    }
    const reg = await request(meta.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ArcFlare",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",   // public client; PKCE is the proof
        scope: wanted,
      }),
    });
    if (reg.status >= 400 || !reg.json || !reg.json.client_id) {
      throw new Error(`client registration failed (${reg.status}): ${reg.text.slice(0, 200)}`);
    }
    const clientId = reg.json.client_id;
    const clientSecret = reg.json.client_secret || null;

    const authUrl = new URL(meta.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: wanted,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // RFC 8707: say which resource the token is for, so it cannot be
      // replayed against a different service.
      resource: meta.resource,
    })) authUrl.searchParams.set(k, v);

    if (onUrl) await onUrl(authUrl.toString());
    const code = await codePromise;

    const tok = await request(meta.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: meta.resource,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    if (tok.status >= 400 || !tok.json || !tok.json.access_token) {
      throw new Error(`token exchange failed (${tok.status}): ${tok.text.slice(0, 200)}`);
    }

    const record = {
      resource: meta.resource,
      issuer: meta.issuer,
      tokenEndpoint: meta.tokenEndpoint,
      clientId,
      clientSecret,
      scope: tok.json.scope || wanted,
      accessToken: tok.json.access_token,
      refreshToken: tok.json.refresh_token || null,
      expiresAt: tok.json.expires_in ? Date.now() + tok.json.expires_in * 1000 : null,
      obtainedAt: Date.now(),
    };
    const store = loadStore();
    store[name] = record;
    saveStore(store);
    return record;
  } finally {
    clearTimeout(timer);
    try { server.close(); } catch {}
  }
}

/** Swap a refresh token for a fresh access token. */
async function refresh(name) {
  const rec = saved(name);
  if (!rec || !rec.refreshToken) return null;
  const tok = await request(rec.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: rec.refreshToken,
      client_id: rec.clientId,
      resource: rec.resource,
      ...(rec.clientSecret ? { client_secret: rec.clientSecret } : {}),
    }),
  });
  if (tok.status >= 400 || !tok.json || !tok.json.access_token) return null;
  const store = loadStore();
  store[name] = {
    ...rec,
    accessToken: tok.json.access_token,
    refreshToken: tok.json.refresh_token || rec.refreshToken,
    expiresAt: tok.json.expires_in ? Date.now() + tok.json.expires_in * 1000 : null,
    obtainedAt: Date.now(),
  };
  saveStore(store);
  return store[name];
}

/**
 * A usable access token for this server, or null.
 * Refreshes a minute before expiry rather than after a failure.
 */
async function accessToken(name) {
  const rec = saved(name);
  if (!rec) return null;
  if (rec.expiresAt && rec.expiresAt - Date.now() < 60000) {
    const fresh = await refresh(name).catch(() => null);
    return fresh ? fresh.accessToken : null;
  }
  return rec.accessToken;
}

module.exports = {
  discover, login, refresh, accessToken, saved, forget, loadStore, pkce, request,
  STORE,
};
