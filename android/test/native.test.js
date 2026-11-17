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
  assert.deepEqual(Object.keys(N).sort(), ["appUpdater", "assist", "call", "clearCookies", "getLaunchUrl", "localAI", "nativeHttp", "navigate", "notifier", "onAppUrl", "onForeground", "phoneFiles", "supportsX25519"]);
});

// A build's Capacitor: a plugin record for every name (as the real registerPlugin gives), and isPluginAvailable says
// which names this build really has.
function phoneFilesBuild(has) {
  const seen = [];
  // { ...arg } copies the vm-realm object into this realm, so deepStrictEqual compares prototypes fairly.
  const plugin = new Proxy({}, { get: (_, m) => (arg) => { seen.push([String(m), arg === undefined ? undefined : { ...arg }]); return Promise.resolve({}); } });
  const cap = { registerPlugin: () => plugin, isPluginAvailable: (n) => has.includes(n) };
  const { N } = load({ Capacitor: cap });
  return { P: N.phoneFiles(), seen };
}

test("phoneFiles: null outside the app and in a build without the agent plugin", () => {
  const outside = load({ Capacitor: undefined });
  assert.equal(outside.N.phoneFiles(), null);
  assert.equal(phoneFilesBuild([]).P, null);
  assert.equal(phoneFilesBuild(["LocalAI", "Call"]).P, null);
  // An old WebView without isPluginAvailable: the wrapper fails closed too.
  assert.equal(load({ Capacitor: { registerPlugin: () => ({}) } }).N.phoneFiles(), null);
});

test("phoneFiles: exposes the six calls and nothing else", () => {
  const { P } = phoneFilesBuild(["PhoneFiles"]);
  assert.deepEqual(Object.keys(P).sort(), ["folders", "forget", "list", "pickFolder", "read", "write"]);
});

test("phoneFiles: each call passes exactly the arguments the plugin takes", () => {
  const { P, seen } = phoneFilesBuild(["PhoneFiles"]);
  P.folders(); P.pickFolder(); P.forget("content://tree/x"); P.list("content://tree/x", "a/b");
  P.read("content://tree/x", "notes.txt"); P.write("content://tree/x", "a/notes.txt", "hello");
  assert.deepEqual(seen, [
    ["folders", undefined],
    ["pickFolder", undefined],
    ["forget", { id: "content://tree/x" }],
    ["list", { id: "content://tree/x", path: "a/b" }],
    ["read", { id: "content://tree/x", path: "notes.txt" }],
    ["write", { id: "content://tree/x", path: "a/notes.txt", content: "hello" }],
  ]);
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

test("appUpdater exposes the eight update calls and nothing else, and is null outside the app", () => {
  const { N, calls } = load();
  const u = N.appUpdater();
  assert.deepEqual(Object.keys(u).sort(), ["abort", "begin", "checkOnline", "commit", "downloadOnline", "info", "openInstallSettings", "write"]);
  u.checkOnline("https://evil.example/x.json"); u.downloadOnline("https://evil.example/x.apk");
  assert.deepEqual(calls.slice(-2), ["AppUpdater.checkOnline", "AppUpdater.downloadOnline"]);
  const saved = global.window && global.window.Capacitor;
  if (global.window) {
    delete global.window.Capacitor;
    assert.equal(N.appUpdater(), null);
    global.window.Capacitor = saved;
  }
});

test("assist: null outside the app and in a build without the agent plugin; true once when the gesture started the app", async () => {
  assert.equal(load({ Capacitor: undefined }).N.assist(), null);
  assert.equal(phoneFilesBuild([]).seen.length, 0);
  const none = load({ Capacitor: { registerPlugin: () => ({}), isPluginAvailable: () => false } });
  assert.equal(none.N.assist(), null);
  const mk = (r) => load({ Capacitor: { isPluginAvailable: (n) => n === "Assist", registerPlugin: () => ({ consume: async () => r, addListener: () => Promise.resolve({ remove() {} }) }) } }).N.assist();
  assert.equal(await mk({ assist: true }).consume(), true);
  assert.equal(await mk({ assist: false }).consume(), false);
  assert.equal(await mk(undefined).consume(), false);
  assert.deepEqual(Object.keys(mk({ assist: true })).sort(), ["consume", "on"]);
});
