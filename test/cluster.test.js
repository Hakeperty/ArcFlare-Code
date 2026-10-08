// Tests for `arcflare cluster`. What matters most is the gate: ggml-rpc-server
// runs whatever a client sends it, so a connection from an address that is not
// allowed must never reach it. Then that the node list round-trips through the
// config, that the workers end up in the preset llama-server loads, and that
// llama.cpp's device listing is read correctly.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-cluster-"));
const cluster = require("../lib/cluster");
const { gate } = require("../lib/cluster-worker");

test("parseNode reads hosts, ports and IPv6", () => {
  assert.deepStrictEqual(cluster.parseNode("10.0.0.5"), { host: "10.0.0.5", port: 50052 });
  assert.deepStrictEqual(cluster.parseNode("box2:6000"), { host: "box2", port: 6000 });
  assert.deepStrictEqual(cluster.parseNode("[fd00::5]:7000"), { host: "fd00::5", port: 7000 });
  assert.deepStrictEqual(cluster.parseNode("fd00::5"), { host: "fd00::5", port: 50052 });
  assert.strictEqual(cluster.endpoint({ host: "fd00::5", port: 7000 }), "[fd00::5]:7000");
  assert.throws(() => cluster.parseNode("box2:70000"), /bad port/);
  assert.throws(() => cluster.parseNode("a,b"), /not a host/);
  assert.throws(() => cluster.parseNode(""), /not a host/);
});

test("nodes are added once, removed, and switched off without being forgotten", () => {
  let cfg = { port: 11434 };
  assert.strictEqual(cluster.enabled(cfg), false);
  cfg = cluster.addNode(cfg, "10.0.0.5");
  cfg = cluster.addNode(cfg, "10.0.0.5:50052");
  cfg = cluster.addNode(cfg, "10.0.0.6");
  assert.deepStrictEqual(cluster.nodes(cfg).map(cluster.endpoint), ["10.0.0.5:50052", "10.0.0.6:50052"]);
  assert.strictEqual(cfg.port, 11434);
  assert.strictEqual(cluster.enabled(cfg), true);
  assert.strictEqual(cluster.enabled(cluster.setEnabled(cfg, false)), false);
  assert.strictEqual(cluster.nodes(cluster.setEnabled(cfg, false)).length, 2);
  cfg = cluster.removeNode(cfg, "10.0.0.5");
  assert.deepStrictEqual(cluster.nodes(cfg).map(cluster.endpoint), ["10.0.0.6:50052"]);
  assert.strictEqual(cluster.nodes(cluster.removeNode(cfg, "all")).length, 0);
});

test("only private and VPN addresses count as private", () => {
  for (const ip of ["10.1.2.3", "192.168.1.9", "172.16.0.1", "172.31.255.1", "127.0.0.1",
    "100.64.0.1", "100.127.1.1", "169.254.3.4", "::1", "fd12::1", "fe80::1", "::ffff:192.168.1.2"]) {
    assert.ok(cluster.isPrivate(ip), ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", ""]) {
    assert.ok(!cluster.isPrivate(ip), ip);
  }
});

test("remote devices are read from llama.cpp's listing, local ones skipped", () => {
  const text = [
    "Available devices:",
    "  Vulkan0: AMD Radeon(TM) 8060S Graphics (49152 MiB, 46522 MiB free)",
    "  RPC0[192.168.1.11:50052]: AMD Radeon(TM) 8060S Graphics (49152 MiB, 47000 MiB free)",
    "  RPC1[[fd00::5]:50052]: CPU (16000 MiB, 15000 MiB free)",
  ].join("\n");
  const d = cluster.parseRemoteDevices(text);
  assert.strictEqual(d.length, 2);
  // Current llama.cpp: plain RPC<n>, with the endpoint as the description.
  const plain = cluster.parseRemoteDevices("  RPC0: 127.0.0.1:50061 (16094 MiB, 16094 MiB free)");
  assert.strictEqual(plain[0].endpoint, "127.0.0.1:50061");
  assert.strictEqual(plain[0].freeMiB, 16094);
  assert.deepStrictEqual(d[0], {
    handle: "RPC0[192.168.1.11:50052]", name: "AMD Radeon(TM) 8060S Graphics",
    endpoint: "192.168.1.11:50052", totalMiB: 49152, freeMiB: 47000,
  });
});

test("workers go into the preset ahead of everything else, and only when given", () => {
  const serve = require("../lib/serve");
  const model = { id: "big:q4_k_m", file: "/m/big-Q4_K_M.gguf" };
  serve.writePresetFor(model, 32768, "f16", 2048, { rpc: "10.0.0.5:50052,10.0.0.6:50052" });
  const ini = fs.readFileSync(serve.PRESET, "utf8");
  const section = ini.slice(ini.indexOf("[big:q4_k_m]")).split("\n");
  assert.strictEqual(section[1], "rpc = 10.0.0.5:50052,10.0.0.6:50052");
  serve.writePresetFor(model, 32768, "f16", 2048);
  assert.ok(!fs.readFileSync(serve.PRESET, "utf8").includes("rpc"));
});

test("remote memory counts only while the cluster is on and the figure is fresh", () => {
  const cfg = cluster.addNode({}, "10.0.0.5");
  fs.writeFileSync(cluster.STATE_FILE, JSON.stringify({ at: Date.now(), freeBytes: 40e9 }));
  assert.strictEqual(cluster.cachedRemoteFreeBytes(cfg), 40e9);
  assert.strictEqual(cluster.cachedRemoteFreeBytes(cluster.setEnabled(cfg, false)), 0);
  fs.writeFileSync(cluster.STATE_FILE, JSON.stringify({ at: Date.now() - 3600e3, freeBytes: 40e9 }));
  assert.strictEqual(cluster.cachedRemoteFreeBytes(cfg), 0);
});

/** A stand-in for ggml-rpc-server: echoes, and records that anyone got through. */
function fakeRpc() {
  const seen = [];
  const srv = net.createServer((s) => { seen.push(true); s.pipe(s); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, port: srv.address().port })));
}

function gateOn(allow, innerPort) {
  const srv = net.createServer(gate(new Set(allow), innerPort));
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

/** Connect, send, and collect what comes back until the far end closes or 500 ms pass. */
function exchange(port, payload) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let got = "";
    s.on("data", (d) => { got += d; if (got.length >= payload.length) s.end(); });
    s.on("connect", () => s.write(payload));
    s.on("close", () => resolve(got));
    s.on("error", () => {});
    setTimeout(() => s.destroy(), 500);
  });
}

test("the gate passes allowed hosts through, byte for byte", async () => {
  const rpc = await fakeRpc();
  const g = await gateOn(["127.0.0.1"], rpc.port);
  const payload = "x".repeat(200000);
  assert.strictEqual(await exchange(g.port, payload), payload);
  g.srv.close(); rpc.srv.close();
});

test("the gate drops everyone else before they reach ggml-rpc-server", async () => {
  const rpc = await fakeRpc();
  const g = await gateOn(["10.9.9.9"], rpc.port);
  assert.strictEqual(await exchange(g.port, "hello"), "");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(rpc.seen.length, 0);
  g.srv.close(); rpc.srv.close();
});

test("reach and scan find a listening port and nothing else", async () => {
  const rpc = await fakeRpc();
  assert.strictEqual((await cluster.reach({ host: "127.0.0.1", port: rpc.port })).ok, true);
  rpc.srv.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual((await cluster.reach({ host: "127.0.0.1", port: rpc.port }, 500)).ok, false);
  const other = await fakeRpc();
  const found = await cluster.scan({ hosts: ["127.0.0.1", "127.0.0.2"], port: other.port });
  other.srv.close();
  assert.deepStrictEqual(found.map((n) => n.host).filter((h) => h === "127.0.0.1"), ["127.0.0.1"]);
});

test("a worker refuses to start without an allow list", async () => {
  await assert.rejects(cluster.startWorker({ rpcServer: "/bin/true", bind: "127.0.0.1", allow: [] }), /--allow/);
});
