"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateLink, validateLanUrl } = require("../www/link.js");
const { hubLink, b64u, A43 } = require("./helpers.js");

const enc = encodeURIComponent;
const mk = (o = {}) => {
  const p = Object.assign({ v: "1", r: enc("https://arcflare.net"), rm: A43, hk: A43, ps: A43, l: enc("http://192.168.1.20:8765") }, o);
  return "arcflare://pair?" + Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("&");
};

test("a link built by the hub CLI code is accepted, with LAN", () => {
  const r = validateLink(hubLink());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.relay, "https://arcflare.net");
  assert.equal(r.value.relayHost, "arcflare.net");
  assert.equal(r.value.lan, "http://192.168.1.20:8765");
  assert.equal(r.value.hubKey.length, 43);
});

test("accepted without LAN, with surrounding whitespace, .local LAN, 10.x and 172.16 LAN, relay path", () => {
  assert.equal(validateLink(hubLink({ lan: null })).value.lan, null);
  assert.equal(validateLink("  " + hubLink() + "\n").ok, true);
  assert.equal(validateLink(mk({ l: enc("http://studio.local:9000") })).value.lan, "http://studio.local:9000");
  assert.equal(validateLink(mk({ l: enc("http://10.0.0.5:80") })).ok, true);
  assert.equal(validateLink(mk({ l: enc("https://172.31.255.1:443") })).ok, true);
  assert.equal(validateLink(mk({ r: enc("https://relay.example.org/base/") })).value.relay, "https://relay.example.org/base");
});

test("canonical link round-trips through the validator", () => {
  const r = validateLink(hubLink());
  const again = validateLink(r.canonical);
  assert.equal(again.ok, true);
  assert.deepEqual(again.value, r.value);
});

const bad = {
  "wrong scheme": "https://pair?v=1",
  "javascript scheme": "javascript:alert(1)",
  "javascript in relay": mk({ r: enc("javascript:alert(1)") }),
  "empty": "",
  "no query": "arcflare://pair?",
  "wrong host": mk().replace("arcflare://pair", "arcflare://evil"),
  "uppercase scheme": mk().replace("arcflare://", "ARCFLARE://"),
  "v=2": mk({ v: "2" }),
  "v=0": mk({ v: "0" }),
  "v=01": mk({ v: "01" }),
  "v=1.0": mk({ v: "1.0" }),
  "v missing": mk({ v: undefined }),
  "http relay": mk({ r: enc("http://arcflare.net") }),
  "http relay on loopback in production": mk({ r: enc("http://localhost:3000") }),
  "ftp relay": mk({ r: enc("ftp://arcflare.net") }),
  "private IP relay 192.168": mk({ r: enc("https://192.168.1.1") }),
  "private IP relay 10.x": mk({ r: enc("https://10.0.0.1") }),
  "loopback IP relay": mk({ r: enc("https://127.0.0.1") }),
  "hex IP relay (normalised to loopback)": mk({ r: enc("https://0x7f.1") }),
  "decimal IP relay": mk({ r: enc("https://2130706433") }),
  "IPv6 loopback relay": mk({ r: enc("https://[::1]") }),
  "public IP relay": mk({ r: enc("https://8.8.8.8") }),
  "localhost relay": mk({ r: enc("https://localhost") }),
  ".local relay": mk({ r: enc("https://relay.local") }),
  "single-label relay": mk({ r: enc("https://relay") }),
  "relay userinfo": mk({ r: enc("https://user:pw@arcflare.net") }),
  "relay user only": mk({ r: enc("https://user@arcflare.net") }),
  "relay lookalike userinfo": mk({ r: enc("https://arcflare.net@evil.example") }),
  "relay query": mk({ r: enc("https://arcflare.net/?x=1") }),
  "relay fragment": mk({ r: enc("https://arcflare.net/#x") }),
  "relay with space": mk({ r: enc("https://arcflare.net /x") }),
  "relay backslash": mk({ r: enc("https://arcflare.net\\@evil.example") }),
  "relay bad percent": mk({ r: "https%3A%2F%2Farcflare.net%zz" }),
  "relay missing": mk({ r: undefined }),
  "extra param": mk() + "&x=1",
  "extra param token": mk() + "&token=abc",
  "duplicate ps": mk() + "&ps=" + A43,
  "duplicate v": mk() + "&v=1",
  "duplicate l": mk() + "&l=" + enc("http://192.168.1.20:8765"),
  "empty param": mk() + "&",
  "param without value": mk() + "&flag",
  "prototype key": mk() + "&__proto__=1",
  "fragment": mk() + "#frag",
  "rm too short": mk({ rm: A43.slice(1) }),
  "rm too long": mk({ rm: A43 + "A" }),
  "hk bad alphabet +": mk({ hk: A43.slice(0, 42) + "+" }),
  "hk standard base64 slash": mk({ hk: "/" + A43.slice(1) }),
  "ps padded": mk({ ps: A43.slice(0, 42) + "=" }),
  "ps non-canonical last char": mk({ ps: A43.slice(0, 42) + "B" }),
  "ps percent encoded": mk({ ps: "%41" + A43.slice(1) }),
  "hk missing": mk({ hk: undefined }),
  "ps missing": mk({ ps: undefined }),
  "rm missing": mk({ rm: undefined }),
  "l public IP": mk({ l: enc("http://8.8.8.8:8765") }),
  "l 172.32 (not private)": mk({ l: enc("http://172.32.0.1:8765") }),
  "l 169.254 link-local": mk({ l: enc("http://169.254.1.1:8765") }),
  "l loopback": mk({ l: enc("http://127.0.0.1:8765") }),
  "l hostname not .local": mk({ l: enc("http://hub.example.com:8765") }),
  "l localhost": mk({ l: enc("http://localhost:8765") }),
  "l lookalike .local.evil.com": mk({ l: enc("http://hub.local.evil.com:8765") }),
  "l javascript scheme": mk({ l: enc("javascript:alert(1)") }),
  "l file scheme": mk({ l: enc("file:///etc/passwd") }),
  "l no port": mk({ l: enc("http://192.168.1.20") }),
  "l port 0": mk({ l: enc("http://192.168.1.20:0") }),
  "l port 65536": mk({ l: enc("http://192.168.1.20:65536") }),
  "l port leading zero": mk({ l: enc("http://192.168.1.20:080") }),
  "l userinfo": mk({ l: enc("http://user:pw@192.168.1.20:8765") }),
  "l userinfo trick": mk({ l: enc("http://192.168.1.20:8765@8.8.8.8:80") }),
  "l path": mk({ l: enc("http://192.168.1.20:8765/login") }),
  "l trailing slash": mk({ l: enc("http://192.168.1.20:8765/") }),
  "l query": mk({ l: enc("http://192.168.1.20:8765?x=1") }),
  "l fragment": mk({ l: enc("http://192.168.1.20:8765%23x") }),
  "l leading-zero octet": mk({ l: enc("http://192.168.001.20:8765") }),
  "l short IPv4": mk({ l: enc("http://192.168.1:8765") }),
  "l hex IPv4": mk({ l: enc("http://0xc0.0xa8.1.1:8765") }),
  "l IPv6": mk({ l: enc("http://[fd00::1]:8765") }),
  "l empty": mk({ l: "" }),
  "l 999 octet": mk({ l: enc("http://192.168.1.999:8765") }),
  "huge input": "arcflare://pair?" + "a".repeat(1_000_000),
  "just over 1 KB": mk({ l: enc("http://192.168.1.20:8765") }) + "&" + "x".repeat(1100),
  "huge relay": mk({ r: enc("https://" + "a".repeat(2000) + ".com") }),
  "control chars": mk() + "\u0000",
  "inner newline": mk().replace("&rm", "\n&rm"),
  "inner space": mk().replace("&rm", " &rm"),
  "bidi override": mk().replace("v=1", "v=1\u202e"),
  "zero width": mk({ r: enc("https://arc\u200bflare.net") }),
  "null": null,
  "number": 12345,
  "object": { toString: () => hubLink() },
};

for (const [name, input] of Object.entries(bad)) {
  test(`rejects: ${name}`, () => {
    const r = validateLink(input);
    assert.equal(r.ok, false, "must be rejected");
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 5 && r.error.length < 200);
    assert.equal(r.value, undefined, "no value is returned for a bad link");
    // The error text never echoes the secret-bearing parts of the input.
    assert.ok(!r.error.includes(A43));
  });
}

test("at least 25 malformed cases are covered", () => assert.ok(Object.keys(bad).length >= 25));

test("exactly 1 KB is the limit", () => {
  const ok = mk();
  assert.ok(ok.length < 1024);
  const pad = "&" + "x".repeat(1024 - ok.length);
  assert.equal(validateLink(ok + pad).ok, false);       // fails for the unknown param, not the size
  assert.equal(validateLink(ok + "&" + "x".repeat(2000)).code, "TOO_BIG");
});

test("a dev build accepts an http loopback relay; a production build does not", () => {
  const l = mk({ r: enc("http://localhost:3000") });
  assert.equal(validateLink(l, { dev: true }).ok, true);
  assert.equal(validateLink(l, { dev: false }).ok, false);
  assert.equal(validateLink(mk({ r: enc("http://127.0.0.1:3000") }), { dev: true }).ok, true);
  assert.equal(validateLink(mk({ r: enc("http://192.168.1.5:3000") }), { dev: true }).ok, false, "dev does not open private ranges");
  assert.equal(validateLink(mk({ r: enc("http://arcflare.net") }), { dev: true }).ok, false, "dev does not open plain http");
});

test("validateLanUrl re-checks a stored value", () => {
  assert.equal(validateLanUrl("http://192.168.1.20:8765"), true);
  assert.equal(validateLanUrl("http://evil.example:8765"), false);
  assert.equal(validateLanUrl(null), false);
});

test("fuzz: random garbage never throws and never validates", () => {
  for (let i = 0; i < 500; i++) {
    const s = "arcflare://pair?" + crypto.randomBytes(1 + (i % 120)).toString("latin1");
    assert.equal(validateLink(s).ok, false);
  }
});
