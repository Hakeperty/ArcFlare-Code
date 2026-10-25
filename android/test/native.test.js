"use strict";
// www/native.js run for real in a vm with a fake window: what the shell can ask the bridge for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(extra = {}) {
  const assigned = [];
  const calls = [];
  const plugin = (name) => new Proxy({}, { get: (_, m) => (...a) => { calls.push(name + "." + String(m)); return Promise.resolve({ url: "arcflare://pair?x" }); } });
  const win = { location: { assign: (u) => assigned.push(u) }, Capacitor: { Plugins: { CapacitorHttp: plugin("CapacitorHttp"), App: plugin("App"), CapacitorCookies: plugin("CapacitorCookies") }, registerPlugin: (n) => plugin(n) } };
  Object.assign(win, extra);
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", "native.js"), "utf8"), win);
  return { N: win.ArcFlareNative, assigned, calls };
}

test("navigate: only the bundled UI (with the optional via hint); everything else throws and goes nowhere", () => {
  const { N, assigned } = load();
  N.navigate("ui/index.html"); N.navigate("ui/index.html?via=home"); N.navigate("ui/index.html?via=relay");
  assert.deepEqual(assigned, ["ui/index.html", "ui/index.html?via=home", "ui/index.html?via=relay"]);
  for (const bad of ["http://192.168.1.20:8765", "http://192.168.1.20:8765/", "https://localhost/ui/index.html", "https://evil.example/", "//evil.example", "/ui/index.html", "../index.html", "ui/index.html?via=lan", "ui/index.html?via=home&x=1", "ui/index.html#x", "javascript:alert(1)", "data:text/html,x", "ui/index.html\n", "", null, undefined, 5]) {
    assert.throws(() => N.navigate(bad), /refused/, String(bad));
  }
  assert.equal(assigned.length, 3);
});

test("the native bridge surface is small: no NavGuard, no setLan, no generic http, no cookie setter", () => {
  const { N } = load();
  assert.deepEqual(Object.keys(N).sort(), ["clearCookies", "getLaunchUrl", "nativeHttp", "navigate", "onAppUrl", "onForeground", "supportsX25519"]);
});

test("nativeHttp exposes get and post only (what lanfetch.js wraps), nothing else of CapacitorHttp", () => {
  const { N, calls } = load();
  const h = N.nativeHttp();
  assert.deepEqual(Object.keys(h).sort(), ["get", "post"]);
  h.get({}); h.post({});
  assert.deepEqual(calls, ["CapacitorHttp.get", "CapacitorHttp.post"]);
});

test("outside the app (no Capacitor) the wrappers fail closed", async () => {
  const { N } = load({ Capacitor: undefined });
  assert.throws(() => N.nativeHttp());
  assert.equal(await N.getLaunchUrl(), null);
});

test("only lanfetch.js (and its two callers) mention nativeHttp; nothing else in www calls CapacitorHttp", () => {
  const www = path.join(__dirname, "..", "www");
  const hits = fs.readdirSync(www).filter((f) => f.endsWith(".js")).filter((f) => /CapacitorHttp|nativeHttp/.test(fs.readFileSync(path.join(www, f), "utf8").replace(/\/\/.*$/gm, "")));
  assert.deepEqual(hits.sort(), ["native.js", "relay-boot.js", "shell.js"]);
});
