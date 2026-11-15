"use strict";
// BEHAVIOUR test of ModelCatalog.java (pure Java): compiles the real source with javac and runs it. Which models
// exist, and which addresses a model download may follow. Skipped (loudly) when no JDK is installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "android", "app", "src", "main", "java", "net", "arcflare", "app", "ModelCatalog.java");
const jdk = spawnSync("javac", ["-version"], { encoding: "utf8" });
const opts = { skip: !jdk.error && jdk.status === 0 ? false : "no JDK (javac) installed: ModelCatalog.java was NOT executed" };

let out;
function run(lines) {
  if (!out) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelcatalog-"));
    const pkg = path.join(dir, "src", "net", "arcflare", "app");
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(SRC, path.join(pkg, "ModelCatalog.java"));
    fs.writeFileSync(path.join(pkg, "Probe.java"), `package net.arcflare.app;
import java.io.*; import java.util.Base64;
public class Probe { public static void main(String[] a) throws Exception {
  for (ModelCatalog.Model m : ModelCatalog.MODELS) System.out.println("M " + m.id + " " + m.size + " " + m.sha256 + " " + m.url + " " + m.minRamMb + " " + (ModelCatalog.find(m.id) == m));
  System.out.println("F " + (ModelCatalog.find("nope") == null) + " " + (ModelCatalog.find(null) == null));
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in, "UTF-8")); String l;
  while ((l = r.readLine()) != null) System.out.println(ModelCatalog.allowedHost(new String(Base64.getDecoder().decode(l), "UTF-8")) ? "1" : "0"); } }
`);
    out = path.join(dir, "out");
    const c = spawnSync("javac", ["-d", out, path.join(pkg, "ModelCatalog.java"), path.join(pkg, "Probe.java")], { encoding: "utf8" });
    assert.equal(c.status, 0, "javac failed: " + c.stderr);
  }
  const r = spawnSync("java", ["-cp", out, "net.arcflare.app.Probe"], { input: lines.map((l) => Buffer.from(l).toString("base64") + "\n").join(""), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
}

test("ModelCatalog.java: two Qwen3 files from Qwen's own repos at pinned commits, with size and SHA-256", opts, () => {
  const lines = run([]);
  const models = lines.filter((l) => l.startsWith("M ")).map((l) => l.split(" "));
  assert.deepEqual(models.map((m) => m[1]), ["qwen3-0.6b", "qwen3-1.7b"]);
  for (const m of models) {
    assert.match(m[3], /^[0-9a-f]{64}$/);
    assert.match(m[4], /^https:\/\/huggingface\.co\/Qwen\/Qwen3-[0-9.]+B-GGUF\/resolve\/[0-9a-f]{40}\/Qwen3-[0-9.]+B-Q8_0\.gguf$/, "the maker's repo, pinned to a commit");
    assert.equal(m[6], "true");
  }
  assert.ok(lines.includes("F true true"));
});

test("ModelCatalog.java: downloads follow only https to huggingface.co or a *.hf.co CDN host", opts, () => {
  const ok = ["https://huggingface.co/Qwen/x", "https://us.aws.cdn.hf.co/xet-bridge-us/abc", "https://cas-bridge.xethub.hf.co/x?y=1", "https://cdn-lfs.hf.co/x#z", "https://HUGGINGFACE.CO/x"];
  const bad = ["http://huggingface.co/x", "https://huggingface.co.evil.example/x", "https://evilhuggingface.co/x", "https://hf.co.evil.example/x",
    "https://.hf.co/x", "https://hf.co/x", "https://user@huggingface.co/x", "https://huggingface.co:444/x", "https://evil.example/huggingface.co",
    "https://evil.example?huggingface.co", "https://evil.example\\.hf.co/x", "ftp://huggingface.co/x", "", "https://", "https://evil.example/x.hf.co"];
  const got = run(ok.concat(bad)).slice(-(ok.length + bad.length));
  assert.deepEqual(got, ok.map(() => "1").concat(bad.map(() => "0")));
});
