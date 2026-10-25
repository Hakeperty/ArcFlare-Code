// `arcflare phone lan` and `arcflare phone pair` with the relay OFF, and the real hub process
// with and without --local. Spawned processes, throwaway ARCFLARE_HOME.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "arcflare.js");
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "lancli-"));
const run = (home, args, input) => spawnSync(process.execPath, [BIN, ...args], {
  env: { ...process.env, ARCFLARE_HOME: home, NO_COLOR: "1" }, input, encoding: "utf8", timeout: 20000,
});
const linkOf = (out) => new URL(/arcflare:\/\/pair\?\S+/.exec(out)[0].replace("arcflare://", "http://x/"));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

test("lan on|off|status persist; pair puts the LAN base in r, rm and l with the relay OFF", () => {
  const home = mkHome();
  try {
    assert.match(run(home, ["phone", "lan", "status"]).stdout, /default/);
    assert.match(run(home, ["phone", "lan", "off"]).stdout, /lan tunnel: off/);
    assert.match(run(home, ["phone", "lan", "status"]).stdout, /lan tunnel: off/);
    let p = run(home, ["phone", "pair", "--no-wait", "--no-qr", "--lan-url", "http://192.168.1.9:7878"]);
    assert.strictEqual(p.status, 1, "nothing to pair over: refused");
    assert.match(p.stdout + p.stderr, /no way for a phone/);
    assert.match(run(home, ["phone", "lan", "on"]).stdout, /lan tunnel: on/);
    p = run(home, ["phone", "pair", "--no-wait", "--no-qr", "--lan-url", "http://192.168.1.9:7878"]);
    const q = linkOf(p.stdout).searchParams;
    assert.strictEqual(q.get("v"), "1");
    assert.strictEqual(q.get("r"), "http://192.168.1.9:7878", "r is the LAN base while the relay is off");
    assert.strictEqual(q.get("l"), "http://192.168.1.9:7878");
    assert.match(q.get("rm"), /^[A-Za-z0-9_-]{43}$/, "rm present");
    assert.match(q.get("hk"), /^[A-Za-z0-9_-]{43}$/);
    assert.match(p.stdout, /relay: off/);
    // a non-LAN address is refused
    p = run(home, ["phone", "pair", "--no-wait", "--no-qr", "--lan-url", "http://8.8.8.8:7878"]);
    assert.match(p.stdout + p.stderr, /private IPv4|\.local/);
    // relay on: r is the internet relay, l still the LAN base
    run(home, ["phone", "relay", "on", "https://arcflare.net"]);
    const q2 = linkOf(run(home, ["phone", "pair", "--no-wait", "--no-qr", "--lan-url", "http://192.168.1.9:7878"]).stdout).searchParams;
    assert.strictEqual(q2.get("r"), "https://arcflare.net");
    assert.strictEqual(q2.get("l"), "http://192.168.1.9:7878");
    // relay on, lan off: no l
    run(home, ["phone", "lan", "off"]);
    const q3 = linkOf(run(home, ["phone", "pair", "--no-wait", "--no-qr"]).stdout).searchParams;
    assert.strictEqual(q3.get("r"), "https://arcflare.net");
    assert.strictEqual(q3.get("l"), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

async function hubProcess(home, extra) {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "phone", "--port", String(port), "--no-qr", ...extra], {
    env: { ...process.env, ARCFLARE_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const end = Date.now() + 15000;
  while (!/ctrl\+c stops/.test(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return { port, child, out: () => out, async stop() { child.kill("SIGINT"); await new Promise((r) => child.once("exit", r)); } };
}

test("the hub process: LAN mailbox on by default, off with --local", async () => {
  const home = mkHome();
  try {
    assert.strictEqual(run(home, ["phone", "user", "add", "alice", "--password-stdin"], "correct-horse-battery\n").status, 0);
    let h = await hubProcess(home, []);
    try {
      assert.match(h.out(), /lan tunnel: on/);
      assert.match(h.out(), /relay: off/);
      const r = await fetch(`http://127.0.0.1:${h.port}/api/tunnel/`);
      assert.strictEqual(r.status, 401, "mailbox answers (and wants a token)");
      assert.strictEqual((await fetch(`http://127.0.0.1:${h.port}/api/me`)).status, 401);
    } finally { await h.stop(); }
    h = await hubProcess(home, ["--local"]);
    try {
      assert.match(h.out(), /lan tunnel: off/);
      assert.strictEqual((await fetch(`http://127.0.0.1:${h.port}/api/tunnel/`)).status, 404, "no mailbox with --local");
    } finally { await h.stop(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
