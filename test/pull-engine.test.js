// Tests for getting started without llama.cpp: the native Hugging Face pull
// (file picking, resumable checksummed downloads) and `arcflare engine install`
// (choosing the right prebuilt archive for each machine).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

process.env.ARCFLARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-pull-"));

const hf = require("../lib/hf");
const ei = require("../lib/engine-install");
const dl = require("../lib/download");

// ------------------------------------------------------------ engine pick ----

// Real asset names from a llama.cpp release (b11533).
const ASSETS = [
  "cudart-llama-b11533-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.4-arm64.zip",
  "llama-b11533-bin-macos-arm64.tar.gz",
  "llama-b11533-bin-macos-x64.tar.gz",
  "llama-b11533-bin-ubuntu-arm64.tar.gz",
  "llama-b11533-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "llama-b11533-bin-ubuntu-rocm-10.0-x64.tar.gz",
  "llama-b11533-bin-ubuntu-vulkan-arm64.tar.gz",
  "llama-b11533-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b11533-bin-ubuntu-x64.tar.gz",
  "llama-b11533-bin-win-cpu-x64.zip",
  "llama-b11533-bin-win-cuda-12.4-x64.zip",
  "llama-b11533-bin-win-cuda-13.4-x64.zip",
  "llama-b11533-bin-win-rocm-10.0-x64.zip",
  "llama-b11533-bin-win-vulkan-x64.zip",
  "llama-b11533-ui.tar.gz",
].map((name) => ({ name, size: 1, browser_download_url: `https://example.invalid/${name}` }));

const pick = (o) => {
  const r = ei.pickAssets(ASSETS, o);
  return [r.variant, r.main.name, ...r.extra.map((x) => x.name)];
};

test("engine install picks the macOS build for the CPU", () => {
  assert.deepStrictEqual(pick({ platform: "darwin", arch: "arm64" }).slice(0, 2), ["macos-arm64", "llama-b11533-bin-macos-arm64.tar.gz"]);
  assert.deepStrictEqual(pick({ platform: "darwin", arch: "x64" })[1], "llama-b11533-bin-macos-x64.tar.gz");
});

test("engine install on Linux: Vulkan when the loader is there, CPU otherwise", () => {
  assert.strictEqual(pick({ platform: "linux", arch: "x64", gpu: { vulkan: true } })[1], "llama-b11533-bin-ubuntu-vulkan-x64.tar.gz");
  assert.strictEqual(pick({ platform: "linux", arch: "x64", gpu: { vulkan: false } })[1], "llama-b11533-bin-ubuntu-x64.tar.gz");
  assert.strictEqual(pick({ platform: "linux", arch: "arm64", gpu: { vulkan: true } })[1], "llama-b11533-bin-ubuntu-vulkan-arm64.tar.gz");
  assert.strictEqual(pick({ platform: "linux", arch: "x64", want: "rocm" })[1], "llama-b11533-bin-ubuntu-rocm-10.0-x64.tar.gz");
});

test("engine install on Windows: the newest CUDA the driver supports, with its runtime", () => {
  assert.deepStrictEqual(pick({ platform: "win32", arch: "x64", gpu: { nvidia: true, cuda: "12.6", vulkan: true } }),
    ["win-cuda-12.4-x64", "llama-b11533-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]);
  assert.deepStrictEqual(pick({ platform: "win32", arch: "x64", gpu: { nvidia: true, cuda: "13.5", vulkan: true } }).slice(1),
    ["llama-b11533-bin-win-cuda-13.4-x64.zip", "cudart-llama-bin-win-cuda-13.4-x64.zip"]);
  // A driver too old for any CUDA build falls back to Vulkan.
  assert.strictEqual(pick({ platform: "win32", arch: "x64", gpu: { nvidia: true, cuda: "11.8", vulkan: true } })[1], "llama-b11533-bin-win-vulkan-x64.zip");
});

test("engine install on Windows without NVIDIA: Vulkan, or CPU on request", () => {
  assert.strictEqual(pick({ platform: "win32", arch: "x64", gpu: { vulkan: true } })[1], "llama-b11533-bin-win-vulkan-x64.zip");
  assert.strictEqual(pick({ platform: "win32", arch: "x64", gpu: { vulkan: false } })[1], "llama-b11533-bin-win-cpu-x64.zip");
  assert.strictEqual(pick({ platform: "win32", arch: "x64", gpu: { vulkan: true }, want: "cpu" })[1], "llama-b11533-bin-win-cpu-x64.zip");
});

test("engine install refuses a platform with no prebuilt build", () => {
  assert.throws(() => ei.pickAssets(ASSETS, { platform: "freebsd", arch: "x64" }), /build it from source/);
});

// --------------------------------------------------------------- hf pick ----

const sib = (rfilename, size = 100) => ({ rfilename, size, lfs: { size, sha256: "x" } });
const REPO = [
  sib(".gitattributes"), sib("README.md"),
  sib("BF16/Model-BF16-00002-of-00002.gguf"), sib("BF16/Model-BF16-00001-of-00002.gguf"),
  sib("Model-UD-IQ4_NL.gguf"), sib("Model-UD-IQ4_NL_XL.gguf"),
  sib("Model-UD-Q4_K_M.gguf"), sib("Model-UD-Q5_K_XL.gguf"), sib("Model-Q8_0.gguf"),
  sib("mmproj-F32.gguf"), sib("mmproj-BF16.gguf"), sib("mmproj-F16.gguf"),
];
const names = (r) => r.files.map((f) => f.rfilename);

test("pull parses refs like llama.cpp's -hf", () => {
  assert.deepStrictEqual(hf.parseRef("unsloth/Qwen3-GGUF:Q5_K_M"), { repo: "unsloth/Qwen3-GGUF", tag: "Q5_K_M" });
  assert.deepStrictEqual(hf.parseRef("hf.co/a/b"), { repo: "a/b", tag: "" });
  assert.throws(() => hf.parseRef("not-a-repo"), /user\/repo/);
});

test("pull picks the file for a quant tag as a whole token, plus the projector", () => {
  const r = hf.pickFiles(REPO, "Q5_K_XL");
  assert.deepStrictEqual(names(r), ["Model-UD-Q5_K_XL.gguf"]);
  assert.strictEqual(r.mmproj.rfilename, "mmproj-BF16.gguf");
  assert.deepStrictEqual(names(hf.pickFiles(REPO, "IQ4_NL")), ["Model-UD-IQ4_NL.gguf"]);
  assert.deepStrictEqual(names(hf.pickFiles(REPO, "q8_0")), ["Model-Q8_0.gguf"]);
});

test("pull takes every shard of a split model, in order", () => {
  assert.deepStrictEqual(names(hf.pickFiles(REPO, "BF16")),
    ["BF16/Model-BF16-00001-of-00002.gguf", "BF16/Model-BF16-00002-of-00002.gguf"]);
});

test("pull defaults to Q4_K_M and names what exists when a tag is missing", () => {
  assert.deepStrictEqual(names(hf.pickFiles(REPO, "")), ["Model-UD-Q4_K_M.gguf"]);
  assert.throws(() => hf.pickFiles(REPO, "Q3_K_S"), /no "Q3_K_S" file.*UD-Q5_K_XL/);
  assert.throws(() => hf.pickFiles([sib("README.md")], ""), /no GGUF/);
});

// --------------------------------------------------------------- download ----

const BODY = crypto.randomBytes(256 * 1024);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");

function server({ honourRange = true } = {}) {
  const hits = [];
  const s = http.createServer((req, res) => {
    hits.push(req.headers.range || "");
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/file" }); return res.end(); }
    const m = /bytes=(\d+)-/.exec(req.headers.range || "");
    if (m && honourRange) {
      const from = Number(m[1]);
      res.writeHead(206, { "Content-Length": BODY.length - from, "Content-Range": `bytes ${from}-${BODY.length - 1}/${BODY.length}` });
      return res.end(BODY.subarray(from));
    }
    res.writeHead(200, { "Content-Length": BODY.length });
    res.end(BODY);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ s, hits, url: `http://127.0.0.1:${s.address().port}` })));
}

const tmpFile = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-dl-")), n);

test("download follows a redirect and verifies size and SHA-256", async () => {
  const { s, url } = await server();
  try {
    const dest = tmpFile("m.gguf");
    await dl.download(`${url}/redirect`, dest, { size: BODY.length, sha256: SHA });
    assert.ok(fs.readFileSync(dest).equals(BODY));
    assert.ok(!fs.existsSync(dest + ".part"));
  } finally { s.close(); }
});

test("download resumes a partial file with a Range request", async () => {
  const { s, url, hits } = await server();
  try {
    const dest = tmpFile("m.gguf");
    fs.writeFileSync(dest + ".part", BODY.subarray(0, 100000));
    await dl.download(`${url}/file`, dest, { size: BODY.length, sha256: SHA });
    assert.strictEqual(hits[0], "bytes=100000-");
    assert.ok(fs.readFileSync(dest).equals(BODY));
  } finally { s.close(); }
});

test("download starts over when the server ignores Range", async () => {
  const { s, url } = await server({ honourRange: false });
  try {
    const dest = tmpFile("m.gguf");
    fs.writeFileSync(dest + ".part", Buffer.alloc(5000, 7)); // junk that must not survive
    await dl.download(`${url}/file`, dest, { size: BODY.length, sha256: SHA });
    assert.ok(fs.readFileSync(dest).equals(BODY));
  } finally { s.close(); }
});

test("download rejects a corrupted file and leaves no partial behind", async () => {
  const { s, url } = await server();
  try {
    const dest = tmpFile("m.gguf");
    await assert.rejects(dl.download(`${url}/file`, dest, { size: BODY.length, sha256: "0".repeat(64) }), /checksum mismatch/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + ".part"));
  } finally { s.close(); }
});

test("pull writes llama.cpp's cache layout and skips files already there", async () => {
  const { s, url } = await server();
  const prev = process.env.HF_ENDPOINT;
  try {
    // hf.js reads HF_ENDPOINT at load; use a fresh copy pointed at the test server.
    process.env.HF_ENDPOINT = url;
    delete require.cache[require.resolve("../lib/hf")];
    const hf2 = require("../lib/hf");
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "af-cache-"));
    const info = { sha: "abc123", siblings: [{ rfilename: "tiny-Q8_0.gguf", size: BODY.length, lfs: { size: BODY.length, sha256: SHA } }] };
    // The resolve URL is <endpoint>/<repo>/resolve/<sha>/<file>; the test server answers every path.
    const r = await hf2.pull("me/tiny:Q8_0", { cache, info });
    const want = path.join(cache, "models--me--tiny", "snapshots", "abc123", "tiny-Q8_0.gguf");
    assert.deepStrictEqual(r.files, [want]);
    assert.ok(fs.readFileSync(want).equals(BODY));
    assert.strictEqual(fs.readFileSync(path.join(cache, "models--me--tiny", "refs", "main"), "utf8"), "abc123");
    const again = await hf2.pull("me/tiny:Q8_0", { cache, info });
    assert.strictEqual(again.skipped, 1);
  } finally {
    s.close();
    if (prev === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = prev;
    delete require.cache[require.resolve("../lib/hf")];
  }
});

test("progress text shows a bar, percentage and rate", () => {
  const t = dl.progressText({ done: 50, total: 100, rate: 10 }, (n) => `${n}B`, 10);
  assert.strictEqual(t, "[#####-----]  50%  50B/100B  10B/s");
});

// ------------------------------------------------------------- install.sh ----

test("the website's install.sh is valid POSIX sh", { skip: (() => {
  const p = path.join(__dirname, "..", "..", "ArcFlare", "public", "install.sh");
  return !fs.existsSync(p) || spawnSync("sh", ["-c", "true"]).status !== 0 ? "website repo or sh not available" : false;
})() }, () => {
  const p = path.join(__dirname, "..", "..", "ArcFlare", "public", "install.sh");
  const r = spawnSync("sh", ["-n", p], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
});
