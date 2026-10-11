// Engines downloaded by `arcflare engine install` must be found again by looking
// in ~/.arcflare/engine, whatever the settings file says; archives are checked
// against GitHub's published SHA-256; and the Hugging Face helpers the desktop
// shop uses (search, per-quant sizes) behave.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-managed-"));
process.env.ARCFLARE_HOME = HOME;

const engine = require("../lib/engine");
const backend = require("../lib/backend");
const ei = require("../lib/engine-install");

const EXE = process.platform === "win32" ? ".exe" : "";
const touch = (...p) => {
  const f = path.join(HOME, ...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "");
  return f;
};

test("managedServers finds engines nested the way each archive unpacks, newest first", () => {
  assert.deepStrictEqual(engine.managedServers(), []);
  // Windows zips are flat; Linux/macOS tarballs carry a llama-bNNNN folder.
  const flat = touch("engine", "b100-win-vulkan-x64", "llama-server" + EXE);
  const nested = touch("engine", "b200-linux-vulkan-x64", "llama-b200", "llama-server" + EXE);
  touch("engine", ".download", "llama-server" + EXE); // a half-finished download is not an engine
  fs.utimesSync(flat, new Date(2024, 0, 1), new Date(2024, 0, 1));
  fs.utimesSync(nested, new Date(2025, 0, 1), new Date(2025, 0, 1));
  assert.deepStrictEqual(engine.managedServers(), [nested, flat]);
});

test("backend discovery lists an installed engine's folder", () => {
  const dirs = backend.discover().map((b) => b.dir);
  assert.ok(dirs.includes(path.join(HOME, "engine", "b200-linux-vulkan-x64", "llama-b200")), dirs.join("\n"));
});

test("ensure() reuses an engine that is there instead of downloading another", async () => {
  const r = await ei.ensure({ configured: engine.managedServers()[0] });
  assert.strictEqual(r.already, true);
  assert.ok(r.server.endsWith("llama-server" + EXE));
});

test("only a well-formed GitHub digest is used to verify an archive", () => {
  const hex = "a".repeat(64);
  assert.strictEqual(ei.digestOf({ digest: `sha256:${hex}` }), hex);
  assert.strictEqual(ei.digestOf({ digest: `SHA256:${hex.toUpperCase()}` }), hex.toUpperCase());
  assert.strictEqual(ei.digestOf({ digest: "sha256:short" }), undefined);
  assert.strictEqual(ei.digestOf({ digest: "md5:" + "a".repeat(32) }), undefined);
  assert.strictEqual(ei.digestOf({}), undefined);
});

// ------------------------------------------------------------------ hf ----

const hf = require("../lib/hf");
const sib = (rfilename, size) => ({ rfilename, size, lfs: { size, sha256: "x" } });

test("quants lists each quant once with its real size, shards summed", () => {
  const { quants, projectorBytes } = hf.quants([
    sib("README.md", 5),
    sib("M-Q8_0.gguf", 800), sib("M-Q4_K_M.gguf", 400), sib("M-UD-Q4_K_M.gguf", 420),
    sib("M-BF16-00001-of-00002.gguf", 700), sib("M-BF16-00002-of-00002.gguf", 650),
    sib("mmproj-F16.gguf", 90), sib("mmproj-BF16.gguf", 91),
  ]);
  assert.deepStrictEqual(quants.map((q) => [q.tag, q.bytes, q.shards]),
    [["Q4_K_M", 400, 1], ["UD-Q4_K_M", 420, 1], ["Q8_0", 800, 1], ["BF16", 1350, 2]]);
  assert.strictEqual(projectorBytes, 91);
});

test("a plain Q4_K_M is not mistaken for the UD-Q4_K_M that ends the same way", () => {
  const files = [sib("M-UD-Q4_K_M.gguf", 420), sib("M-Q4_K_M.gguf", 400)];
  assert.deepStrictEqual(hf.pickFiles(files, "Q4_K_M").files.map((f) => f.rfilename), ["M-Q4_K_M.gguf"]);
  assert.deepStrictEqual(hf.pickFiles(files, "UD-Q4_K_M").files.map((f) => f.rfilename), ["M-UD-Q4_K_M.gguf"]);
});

test("search asks Hugging Face for GGUF repos, most downloaded first, and tidies the answer", async () => {
  let seen = null;
  const s = http.createServer((req, res) => {
    seen = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([
      { id: "bartowski/Llama-3.2-3B-Instruct-GGUF", downloads: 12345, likes: 77, pipeline_tag: "text-generation", tags: ["gguf", "llama"], lastModified: "2026-01-01T00:00:00Z" },
      { modelId: "old/shape", downloads: 1 },
      { id: "secret/one", private: true },
      { nope: true },
    ]));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const prev = process.env.HF_ENDPOINT;
  try {
    process.env.HF_ENDPOINT = `http://127.0.0.1:${s.address().port}`;
    delete require.cache[require.resolve("../lib/hf")];
    const hf2 = require("../lib/hf");
    const r = await hf2.search("  llama 3  ", { limit: 500, sort: "bogus" });
    assert.strictEqual(seen.pathname, "/api/models");
    assert.strictEqual(seen.searchParams.get("filter"), "gguf");
    assert.strictEqual(seen.searchParams.get("search"), "llama 3");
    assert.strictEqual(seen.searchParams.get("sort"), "downloads"); // an unknown sort falls back
    assert.strictEqual(seen.searchParams.get("limit"), "100");      // and the page size is capped
    assert.deepStrictEqual(r.map((m) => m.repo), ["bartowski/Llama-3.2-3B-Instruct-GGUF", "old/shape"]);
    assert.deepStrictEqual([r[0].author, r[0].downloads, r[0].likes, r[0].task], ["bartowski", 12345, 77, "text-generation"]);
    await hf2.search("", { sort: "trendingScore" });
    assert.strictEqual(seen.searchParams.get("search"), null);
    assert.strictEqual(seen.searchParams.get("sort"), "trendingScore");
  } finally {
    s.close();
    if (prev === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = prev;
    delete require.cache[require.resolve("../lib/hf")];
  }
});

// ------------------------------------------------------ progress lines ----

test("with ARCFLARE_PROGRESS=1 and no terminal, pull reports 'progress <pct> <text>' lines", async () => {
  const { spawn } = require("child_process");
  const crypto = require("crypto");
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const s = http.createServer((req, res) => {
    if (req.url.startsWith("/api/models/me/tiny/revision/main")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ sha: "abc", siblings: [{ rfilename: "tiny-Q8_0.gguf", size: body.length, lfs: { size: body.length, sha256: sha } }] }));
    }
    // Trickle the file so more than one progress line is due.
    res.writeHead(200, { "Content-Length": body.length });
    let i = 0;
    const step = () => {
      if (i >= body.length) return res.end();
      res.write(body.subarray(i, i += 256 * 1024));
      setTimeout(step, 150);
    };
    step();
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "af-cache-"));
    const child = spawn(process.execPath, [path.join(__dirname, "..", "bin", "arcflare.js"), "pull", "me/tiny:Q8_0"], {
      env: { ...process.env, ARCFLARE_PROGRESS: "1", HF_ENDPOINT: `http://127.0.0.1:${s.address().port}`, LLAMA_CACHE: cache, ARCFLARE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "af-home-")), NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("close", r));
    assert.strictEqual(code, 0, out);
    const lines = out.split("\n").filter((l) => l.startsWith("progress "));
    assert.ok(lines.length >= 3, out);
    assert.match(lines[0], /^progress - tiny-Q8_0\.gguf$/);
    const pcts = lines.map((l) => /^progress (\d+|-) /.exec(l)[1]).filter((p) => p !== "-").map(Number);
    assert.ok(pcts.length >= 2 && pcts.at(-1) === 100, lines.join("\n"));
    assert.deepStrictEqual(pcts, [...pcts].sort((a, b) => a - b));
  } finally { s.close(); }
});
