// `arcflare get-engine`: picking the right llama.cpp build, refusing a download
// that doesn't match GitHub's digest, and unpacking to a working llama-server.
// A local HTTP server stands in for GitHub; the "llama-server" is a shell script.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-getllama-"));
const getllama = require("../lib/getllama");

const NAMES = [
  "llama-b7000-bin-macos-arm64.zip", "llama-b7000-bin-macos-x64.zip",
  "llama-b7000-bin-ubuntu-x64.zip", "llama-b7000-bin-ubuntu-vulkan-x64.zip",
  "llama-b7000-bin-win-cpu-x64.zip", "llama-b7000-bin-win-vulkan-x64.zip", "llama-b7000-xcframework.zip",
];

test("each machine gets its own build", () => {
  const rel = { assets: NAMES.map((name) => ({ name })) };
  assert.strictEqual(getllama.pickAsset(rel, "darwin", "arm64").name, "llama-b7000-bin-macos-arm64.zip");
  assert.strictEqual(getllama.pickAsset(rel, "darwin", "x64").name, "llama-b7000-bin-macos-x64.zip");
  assert.strictEqual(getllama.pickAsset(rel, "linux", "x64").name, "llama-b7000-bin-ubuntu-vulkan-x64.zip");
  assert.strictEqual(getllama.pickAsset(rel, "win32", "x64").name, "llama-b7000-bin-win-vulkan-x64.zip");
  assert.strictEqual(getllama.pickAsset(rel, "linux", "arm64"), null);
  // tar.gz is accepted too, and a CPU build when there is no Vulkan one.
  assert.strictEqual(getllama.pickAsset({ assets: [{ name: "llama-b1-bin-ubuntu-x64.tar.gz" }] }, "linux", "x64").name,
    "llama-b1-bin-ubuntu-x64.tar.gz");
});

function serve(files) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = files[req.url];
      if (!body) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Length": body.length });
      res.end(body);
    }).listen(0, () => resolve(srv));
  });
}

function fakeArchive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-llsrc-"));
  fs.mkdirSync(path.join(dir, "build", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build", "bin", "llama-server"), "#!/bin/sh\necho version: 7000\n");
  fs.writeFileSync(path.join(dir, "build", "bin", "libggml.so"), "lib");
  const out = path.join(dir, "a.tar.gz");
  assert.strictEqual(spawnSync("tar", ["-czf", out, "-C", dir, "build"]).status, 0);
  return fs.readFileSync(out);
}

/** This machine's asset name for a release tag. */
function assetFor(tag) {
  const os_ = process.platform === "darwin" ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}` : "ubuntu-x64";
  return `llama-${tag}-bin-${os_}.tar.gz`;
}

const unix = process.platform !== "win32" && getllama.wanted().length > 0;

test("a matching download is unpacked to a llama-server that runs", { skip: !unix }, async () => {
  const body = fakeArchive();
  const name = assetFor("b7000");
  const srv = await serve({ ["/" + name]: body });
  const url = `http://localhost:${srv.address().port}/${name}`;
  const digest = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
  const lines = [];
  try {
    const r = await getllama.install({ log: (l) => lines.push(l),
      release: { tag_name: "b7000", assets: [{ name, size: body.length, browser_download_url: url, digest }] } });
    assert.strictEqual(r.tag, "b7000");
    assert.ok(r.server.endsWith(path.join("build", "bin", "llama-server")));
    assert.strictEqual(spawnSync(r.server, ["--version"], { encoding: "utf8" }).stdout.trim(), "version: 7000");
    assert.ok(lines.includes("checksum ok"));
    // A second run finds it rather than downloading again.
    const again = await getllama.install({ release: { tag_name: "b7000", assets: [{ name, size: 1, browser_download_url: url }] } });
    assert.strictEqual(again.fresh, false);
    // And the engine finds it with no setting at all.
    delete require.cache[require.resolve("../lib/engine")];
    const found = require("../lib/engine").findServer(undefined);
    assert.ok(found, "engine finds a llama-server");
  } finally { srv.close(); }
});

test("a download that doesn't match GitHub's digest is refused", { skip: !unix }, async () => {
  const body = fakeArchive();
  const name = assetFor("b7001");
  const srv = await serve({ ["/" + name]: body });
  try {
    await assert.rejects(getllama.install({
      release: { tag_name: "b7001", assets: [{ name, size: body.length, browser_download_url: `http://localhost:${srv.address().port}/${name}`, digest: "sha256:" + "0".repeat(64) }] },
    }), /does not match/);
    assert.ok(!fs.existsSync(path.join(getllama.root(), "b7001")), "nothing installed");
  } finally { srv.close(); }
});
