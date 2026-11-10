// Tests for what makes ArcFlare faster on each machine: knowing the hardware,
// installing the build for it, measuring the fastest settings (`arcflare
// tune`), and not reloading a model that is already loaded. No GPU needed: the
// hardware is fed in as each platform's real output, and model loads run
// against test/_fake-llama-server.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "af-speed-"));
process.env.ARCFLARE_HOME = path.join(TMP, "home");
fs.mkdirSync(process.env.ARCFLARE_HOME, { recursive: true });

const hardware = require("../lib/hardware");
const ei = require("../lib/engine-install");
const backend = require("../lib/backend");
const tune = require("../lib/tune");
const serve = require("../lib/serve");
const engine = require("../lib/engine");

// --------------------------------------------------------------- hardware ----

function io({ platform, arch = "x64", files = {}, dirs = {}, run = {}, cpus = [] }) {
  return {
    platform, arch,
    readFile: (f) => (f in files ? files[f] : null),
    readdir: (d) => dirs[d] || [],
    run: (cmd, args) => {
      for (const [key, out] of Object.entries(run)) {
        if ((cmd + " " + args.join(" ")).includes(key)) return { status: 0, stdout: out };
      }
      return { status: -1, stdout: "" };
    },
    cpus: () => cpus,
  };
}
const cpuList = (n, model) => Array.from({ length: n }, () => ({ model }));

test("Linux: a hybrid Intel CPU is split into performance and efficiency cores", () => {
  // i7-13700K: 8 P cores with hyper-threading (cpus 0-15), 8 E cores (16-23).
  const files = { "/sys/devices/cpu_core/cpus": "0-15\n", "/sys/devices/cpu_atom/cpus": "16-23\n" };
  for (let i = 0; i < 24; i++) {
    const core = i < 16 ? Math.floor(i / 2) : 8 + (i - 16);
    files[`/sys/devices/system/cpu/cpu${i}/topology/core_id`] = `${core}\n`;
    files[`/sys/devices/system/cpu/cpu${i}/topology/physical_package_id`] = "0\n";
  }
  const c = hardware.cpu(io({ platform: "linux", files, cpus: cpuList(24, "13th Gen Intel(R) Core(TM) i7-13700K") }));
  assert.deepStrictEqual([c.hybrid, c.physical, c.performance, c.efficiency, c.vendor], [true, 16, 8, 8, "intel"]);
  assert.match(hardware.cpuLine(c), /8 P-cores \+ 8 E-cores/);
});

test("Linux: a CPU with one kind of core reports its physical cores", () => {
  const files = {};
  for (let i = 0; i < 16; i++) {
    files[`/sys/devices/system/cpu/cpu${i}/topology/core_id`] = `${i % 8}\n`;
    files[`/sys/devices/system/cpu/cpu${i}/topology/physical_package_id`] = "0\n";
  }
  const c = hardware.cpu(io({ platform: "linux", files, cpus: cpuList(16, "AMD Ryzen 7 7700X 8-Core Processor") }));
  assert.deepStrictEqual([c.hybrid, c.physical, c.performance, c.vendor], [false, 8, 8, "amd"]);
});

test("Windows: P cores are read from the core and logical-processor counts", () => {
  const win = (model, line) => hardware.cpu(io({ platform: "win32", run: { Win32_Processor: line + "\r\n" }, cpus: cpuList(1, model) }));
  // 8P+8E with hyper-threading: 16 cores, 24 logical.
  const hybrid = win("13th Gen Intel(R) Core(TM) i7-13700K", "16 24");
  assert.deepStrictEqual([hybrid.hybrid, hybrid.performance, hybrid.efficiency], [true, 8, 8]);
  // No E cores: every core is a performance core.
  assert.strictEqual(win("Intel(R) Core(TM) i9-10900K", "10 20").performance, 10);
  assert.strictEqual(win("AMD Ryzen 9 7950X", "16 32").hybrid, false);
  // Intel without hyper-threading cannot be told apart from here, so it is left unknown.
  const ultra = win("Intel(R) Core(TM) Ultra 7 265K", "20 20");
  assert.deepStrictEqual([ultra.hybrid, ultra.performance], [false, null]);
});

test("macOS: performance cores come from sysctl, and Apple Silicon is one unified GPU", () => {
  const mac = io({ platform: "darwin", arch: "arm64", cpus: cpuList(12, "Apple M3 Pro"),
    run: { "hw.physicalcpu": "12\n6\n6\n", "machdep.cpu.brand_string": "Apple M3 Pro\n" } });
  const hw = hardware.survey(mac);
  assert.deepStrictEqual([hw.cpu.performance, hw.cpu.efficiency, hw.appleSilicon], [6, 6, true]);
  assert.deepStrictEqual(hw.vendors, ["apple"]);
  assert.deepStrictEqual(hardware.backendsFor(hw), ["metal"]);
  assert.deepStrictEqual(hardware.advice(hw, "metal"), []);
});

test("GPUs are found per vendor on Linux and Windows", () => {
  const linux = hardware.survey(io({ platform: "linux", dirs: { "/sys/class/drm": ["card0", "card1", "card1-DP-1", "renderD128"] },
    files: { "/sys/class/drm/card0/device/vendor": "0x8086\n", "/sys/class/drm/card1/device/vendor": "0x1002\n" } }));
  assert.deepStrictEqual(linux.vendors.sort(), ["amd", "intel"]);
  assert.deepStrictEqual(hardware.backendsFor(linux), ["rocm", "sycl", "vulkan", "cpu"]);

  const win = hardware.survey(io({ platform: "win32", run: {
    Win32_VideoController: "Intel(R) Arc(TM) A770 Graphics\r\nMicrosoft Basic Display Adapter\r\nNVIDIA GeForce RTX 4070\r\n" } }));
  assert.deepStrictEqual(win.gpus.map((g) => g.vendor), ["intel", "nvidia"]);
  assert.deepStrictEqual(hardware.backendsFor(win), ["cuda", "sycl", "vulkan", "cpu"]);

  const headless = hardware.survey(io({ platform: "linux", run: { "nvidia-smi": "NVIDIA A100-SXM4-80GB\n" } }));
  assert.deepStrictEqual(headless.vendors, ["nvidia"]);
  assert.strictEqual(hardware.vendorOf("AMD Radeon(TM) 8060S Graphics"), "amd");
  assert.strictEqual(hardware.vendorOf("Qualcomm(R) Adreno(TM) X1-85 GPU"), "qualcomm");
});

test("advice names the faster build only when one is being missed", () => {
  const nvidia = { platform: "linux", gpus: [{ name: "RTX 4070", vendor: "nvidia" }], vendors: ["nvidia"] };
  assert.match(hardware.advice(nvidia, "vulkan")[0].command, /--cuda/);
  assert.deepStrictEqual(hardware.advice(nvidia, "cuda"), []);
  const arc = { platform: "win32", gpus: [{ name: "Intel(R) Arc(TM) A770 Graphics", vendor: "intel" }], vendors: ["intel"] };
  assert.match(hardware.advice(arc, "cpu")[0].command, /--vulkan/);
  assert.deepStrictEqual(hardware.advice(arc, "vulkan"), []);
  const radeon = { platform: "linux", gpus: [{ name: "Radeon RX 7900 XTX", vendor: "amd" }], vendors: ["amd"] };
  assert.match(hardware.advice(radeon, "vulkan")[0].command, /--rocm.*tune --backends/);
  assert.deepStrictEqual(hardware.advice({ platform: "linux", gpus: [], vendors: [] }, "cpu"), []);
});

// --------------------------------------------------------- engine install ----

const asset = (name) => ({ name, size: 1, browser_download_url: `https://example.invalid/${name}` });
// Real asset names from a llama.cpp release (b11533), plus spellings older releases used.
const ASSETS = [
  "cudart-llama-b11533-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "llama-b11533-bin-macos-arm64.tar.gz",
  "llama-b11533-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "llama-b11533-bin-ubuntu-rocm-10.0-x64.tar.gz",
  "llama-b11533-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b11533-bin-ubuntu-x64.tar.gz",
  "llama-b11533-bin-win-cpu-x64.zip",
  "llama-b11533-bin-win-cpu-arm64.zip",
  "llama-b11533-bin-win-cuda-12.4-x64.zip",
  "llama-b11533-bin-win-rocm-10.0-x64.zip",
  "llama-b11533-bin-win-vulkan-x64.zip",
].map(asset);
const OLD = ["llama-b6000-bin-win-sycl-x64.zip", "llama-b6000-bin-win-hip-radeon-x64.zip",
  "llama-b6000-bin-win-opencl-adreno-arm64.zip", "llama-b6000-bin-win-cpu-x64.zip"].map(asset);
const pick = (assets, o) => { const r = ei.pickAssets(assets, o); return [r.kind, r.main.name, ...r.extra.map((x) => x.name)]; };

test("engine install on Linux gives NVIDIA the CUDA build and its runtime", () => {
  assert.deepStrictEqual(pick(ASSETS, { platform: "linux", arch: "x64", gpu: { nvidia: true, cuda: "12.9", vulkan: true } }),
    ["cuda", "llama-b11533-bin-ubuntu-cuda-12.8-x64.tar.gz", "cudart-llama-b11533-bin-ubuntu-cuda-12.8-x64.tar.gz"]);
  // A driver older than the build cannot run it: Vulkan instead.
  assert.strictEqual(pick(ASSETS, { platform: "linux", arch: "x64", gpu: { nvidia: true, cuda: "12.2", vulkan: true } })[0], "vulkan");
  // No NVIDIA: nothing changes.
  assert.strictEqual(pick(ASSETS, { platform: "linux", arch: "x64", gpu: { vulkan: true } })[0], "vulkan");
  assert.strictEqual(pick(ASSETS, { platform: "linux", arch: "x64", gpu: { vulkan: false } })[1], "llama-b11533-bin-ubuntu-x64.tar.gz");
});

test("engine install finds vendor builds under every name a release has used", () => {
  assert.strictEqual(pick(ASSETS, { platform: "win32", arch: "x64", want: "rocm" })[1], "llama-b11533-bin-win-rocm-10.0-x64.zip");
  assert.strictEqual(pick(OLD, { platform: "win32", arch: "x64", want: "rocm" })[1], "llama-b6000-bin-win-hip-radeon-x64.zip");
  assert.strictEqual(pick(OLD, { platform: "win32", arch: "x64", want: "sycl" })[1], "llama-b6000-bin-win-sycl-x64.zip");
  assert.strictEqual(pick(OLD, { platform: "win32", arch: "arm64", want: "opencl" })[1], "llama-b6000-bin-win-opencl-adreno-arm64.zip");
  // Asked for by name and not published: say so, with what there is.
  assert.throws(() => ei.pickAssets(ASSETS, { platform: "win32", arch: "x64", want: "sycl" }), /no Windows x64 sycl build.*win-vulkan/);
  // The vendor builds are never picked unasked.
  assert.strictEqual(pick(ASSETS, { platform: "win32", arch: "x64", gpu: { vulkan: true } })[0], "vulkan");
});

test("an auto-picked build that will not start is set aside for the next one", async () => {
  const home = path.join(TMP, "install-home");
  const fetched = [];
  const r = await ei.install({
    home, platform: "linux", arch: "x64",
    release: { tag_name: "b11533", assets: ASSETS },
    gpu: { nvidia: true, cuda: "12.9", vulkan: true },
    fetchFile: async (url, file) => { fetched.push(path.basename(file)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x"); },
    unpack: (file, dir) => { fs.mkdirSync(path.join(dir, "build", "bin"), { recursive: true }); fs.writeFileSync(path.join(dir, "build", "bin", "llama-server"), "#!/bin/sh\n"); },
    // The CUDA build fails the way a missing runtime does.
    check: (server) => (/cuda/.test(server) ? { ok: false, text: "error while loading shared libraries: libcudart.so.12" } : { ok: true, text: "version: 11533" }),
  });
  assert.strictEqual(r.kind, "vulkan");
  assert.deepStrictEqual(r.skipped.map((s) => s.kind), ["cuda"]);
  assert.match(r.skipped[0].why, /libcudart/);
  assert.ok(fetched.includes("llama-b11533-bin-ubuntu-vulkan-x64.tar.gz"));

  // Asked for by name, the same failure is an error, not a silent swap.
  await assert.rejects(ei.install({
    home, platform: "linux", arch: "x64", want: "cuda",
    release: { tag_name: "b11533", assets: ASSETS }, gpu: { nvidia: true, cuda: "12.9" },
    fetchFile: async () => {}, unpack: () => {}, check: () => ({ ok: false, text: "libcudart.so.12 missing" }),
  }), /didn't start/);
});

test("every installed build is discovered, named for what it is", () => {
  const root = path.join(process.env.ARCFLARE_HOME, "engine");
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const [name, sub] of [["b1-linux-vulkan-x64", "build/bin"], ["b1-linux-rocm-10.0-x64", ""], ["b1-linux-cpu-x64", "llama-b1"]]) {
    const dir = path.join(root, name, sub);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "llama-server" + exe), "");
  }
  const mine = backend.discover().filter((b) => b.dir.startsWith(root));
  assert.deepStrictEqual(mine.map((b) => b.id).sort(),
    ["cpu:b1-linux-cpu-x64", "rocm:b1-linux-rocm-10.0-x64", "vulkan:b1-linux-vulkan-x64"]);
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------- tune ----

const row = (prefill, gen, extra = {}) => ({ prefill: { tokPerSec: prefill }, gen: { tokPerSec: gen }, ...extra });

test("a turn's time is the prompt read plus the reply written", () => {
  assert.strictEqual(tune.turnSeconds(row(1024, 30), tune.WORKLOADS.agent), 2 + 10);
  assert.strictEqual(tune.turnSeconds(row(1024, 30), tune.WORKLOADS.long), 8 + 10);
  assert.strictEqual(tune.turnSeconds({ error: "x" }), null);
  assert.strictEqual(tune.turnSeconds(row(null, 30)), null);
});

test("the setting in use stays unless another beats it by more than the margin", () => {
  const base = row(1000, 50, { ubatch: 2048 });
  // 2% faster: noise.
  assert.strictEqual(tune.pickBest([base, row(1100, 50, { ubatch: 512 })]).best, base);
  const fast = row(2000, 50, { ubatch: 1024 });
  const r = tune.pickBest([base, row(1100, 50, { ubatch: 512 }), fast]);
  assert.strictEqual(r.best, fast);
  assert.ok(r.gain > 0.1 && r.gain < 0.2);
  // A baseline that failed to load does not block the ones that did.
  assert.strictEqual(tune.pickBest([{ error: "did not fit", ubatch: 2048 }, fast]).best, fast);
  assert.strictEqual(tune.pickBest([{ error: "x" }]).best, null);
});

test("candidates: the batch in use first; threads only where cores differ", () => {
  assert.deepStrictEqual(tune.batchCandidates(2048).map((c) => c.ubatch), [2048, 512, 1024]);
  assert.deepStrictEqual(tune.batchCandidates(768).map((c) => c.ubatch), [768, 512, 1024, 2048]);
  const hybrid = { hybrid: true, performance: 8, efficiency: 8, physical: 16, logical: 24 };
  assert.deepStrictEqual(tune.threadCandidates(hybrid, 512).map((c) => c.threads), [8, 16]);
  assert.deepStrictEqual(tune.threadCandidates({ hybrid: false, physical: 8, performance: 8, logical: 16 }, 512), []);
  assert.deepStrictEqual(tune.threadCandidates(null, 512), []);
});

test("measured settings apply only to the model and engine they were measured on", () => {
  const file = path.join(TMP, "tune.json");
  const exe = path.join(TMP, "engine-a");
  fs.writeFileSync(exe, "a");
  const model = { id: "m:q4", size: 100 };
  tune.save(tune.record(tune.load(file), model, exe, { ubatch: 1024, threads: 8 }), file);
  assert.deepStrictEqual(tune.tunedFor(model, exe, file), { ubatch: 1024, threads: 8 });
  assert.strictEqual(tune.tunedFor({ id: "m:q4", size: 101 }, exe, file), null, "a different file under the same name");
  assert.strictEqual(tune.tunedFor(model, path.join(TMP, "engine-b"), file), null, "a different engine");
  assert.strictEqual(tune.tunedFor({ id: "other", size: 100 }, exe, file), null);
  // The same path with a new build behind it is a different engine too.
  fs.utimesSync(exe, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  assert.strictEqual(tune.tunedFor(model, exe, file), null);
});

test("measuring keeps the faster of two readings", async () => {
  const rates = [800, 1200];
  let n = 0;
  const chat = async (port, body) => (body.max_tokens === 1
    ? { timings: { prompt_n: 2000, prompt_per_second: rates[n++] } }
    : { timings: { predicted_n: 100, predicted_per_second: 40 } });
  const r = await tune.measure({ port: 1, id: "m", chat, count: async () => 2000 });
  assert.strictEqual(r.prefill.tokPerSec, 1200);
  assert.strictEqual(r.gen.tokPerSec, 40);
});

// ---------------------------------------------- loading, against a server ----

const unix = process.platform !== "win32";
const FAKE = path.join(TMP, "eng", "llama-server");
const LOG = path.join(TMP, "starts.log");
const starts = () => { try { return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

function freePort() {
  return new Promise((resolve) => {
    const s = require("net").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test("a loaded model is reused, and reloaded only when something about it changed", { skip: !unix }, async (t) => {
  fs.mkdirSync(path.dirname(FAKE), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "_fake-llama-server.js"), FAKE);
  fs.chmodSync(FAKE, 0o755);
  process.env.FAKE_LOG = LOG;
  const file = path.join(TMP, "tiny-Q4_K_M.gguf");
  fs.writeFileSync(file, "not really a model");
  const model = { id: "tiny:q4_k_m", file, size: fs.statSync(file).size, meta: { trainCtx: 32768 } };
  const cfg = { llamaServer: FAKE, port: await freePort() };
  t.after(() => engine.stop());
  const noSwap = { freeBytes: 0 };

  const first = await serve.prepareModel(cfg, model, 32768, "f16", { auto: true });
  assert.ok(!first.failed, first.error);
  assert.strictEqual(first.ubatch, serve.DEFAULT_UBATCH);
  assert.strictEqual(starts().length, 1);

  // The same model again: no restart, same address.
  const again = await serve.reuseLoaded(cfg, model, noSwap);
  assert.deepStrictEqual(again, { port: cfg.port, servedId: first.servedId, ctx: 32768, reused: true });
  const viaGui = await serve.loadModel(cfg, model, {});
  assert.strictEqual(viaGui.reused, true);
  assert.strictEqual(starts().length, 1, "nothing was reloaded");

  // Anything that would load differently is not a match.
  assert.strictEqual(await serve.reuseLoaded({ ...cfg, ubatch: 512 }, model, noSwap), null, "another batch size");
  assert.strictEqual(await serve.reuseLoaded({ ...cfg, spec: "off" }, model, noSwap), null, "speculation turned off");
  assert.strictEqual(await serve.reuseLoaded({ ...cfg, memoryProfile: "lean" }, model, noSwap), null, "another memory profile");
  assert.strictEqual(await serve.reuseLoaded(cfg, model, { ctx: 16384 }), null, "another context size");
  assert.strictEqual(await serve.reuseLoaded(cfg, { ...model, file: file + ".other" }, noSwap), null, "another model");
  assert.ok(await serve.reuseLoaded(cfg, model, { ctx: 32768 }), "the same context, asked for by size");

  // A measured setting for this model changes what a load would use, so the old load no longer matches.
  tune.save(tune.record(tune.load(), model, FAKE, { ubatch: 1024 }));
  assert.strictEqual(serve.settingsFor(cfg, model).ubatch, 1024);
  assert.strictEqual(serve.settingsFor({ ...cfg, ubatch: 512 }, model).ubatch, 512, "a batch set by hand still wins");
  assert.strictEqual(await serve.reuseLoaded(cfg, model, noSwap), null);
  const tuned = await serve.prepareModel(cfg, model, 32768, "f16", { auto: true });
  assert.strictEqual(tuned.ubatch, 1024);
  assert.strictEqual(starts().length, 2);
  assert.strictEqual(starts()[1].sections["tiny:q4_k_m"].ub, "1024");
  assert.strictEqual(starts()[1].sections["tiny:q4_k_m"].threads, undefined, "threads are llama.cpp's choice unless measured");

  // A changed file is a different model, whatever its name.
  fs.appendFileSync(file, " v2");
  assert.strictEqual(await serve.reuseLoaded(cfg, { ...model, size: fs.statSync(file).size }, noSwap), null);

  // A stopped server holds nothing.
  await serve.prepareModel(cfg, { ...model, size: fs.statSync(file).size }, 32768, "f16", { auto: true });
  assert.ok(await engine.stopAndWait());
  assert.strictEqual(await serve.reuseLoaded(cfg, { ...model, size: fs.statSync(file).size }, noSwap), null);
  tune.clear();
});

test("a load made when memory was short is not reused once a larger context would fit", { skip: !unix }, async (t) => {
  const file = path.join(TMP, "big-Q4_K_M.gguf");
  fs.writeFileSync(file, "weights");
  // 1 KiB of KV per token at f16, so 131072 tokens of context cost 128 MiB.
  const meta = { trainCtx: 131072, nLayer: 1, kvHeads: 1, headDimK: 256, headDimV: 256 };
  const model = { id: "big:q4_k_m", file, size: fs.statSync(file).size, meta };
  const per = require("../lib/gguf").kvBytesPerToken(meta, "f16");
  assert.ok(per > 0, "the test model has a KV size");
  const cfg = { llamaServer: FAKE, port: await freePort() };
  t.after(() => engine.stop());

  const r = await serve.prepareModel(cfg, model, 32768, "f16", { auto: true });
  assert.ok(!r.failed, r.error);
  // Nothing more is free: keep what is loaded.
  assert.ok(await serve.reuseLoaded(cfg, model, { freeBytes: 0 }));
  // Enough has been freed for the full context: take it.
  assert.strictEqual(await serve.reuseLoaded(cfg, model, { freeBytes: per * 131072 + 4e9 }), null);
  // A size someone chose is theirs to keep, however much is free.
  assert.ok(await serve.reuseLoaded(cfg, model, { ctx: 32768, freeBytes: per * 131072 + 4e9 }));
});

test("a load that asks for one batch size is told when it does not fit", { skip: !unix }, async (t) => {
  const file = path.join(TMP, "tiny-Q4_K_M.gguf");
  const model = { id: "tiny:q4_k_m", file, size: fs.statSync(file).size, meta: { trainCtx: 32768 } };
  const cfg = { llamaServer: FAKE, port: await freePort() };
  t.after(() => { engine.stop(); delete process.env.FAKE_MAX_UB; });
  process.env.FAKE_MAX_UB = "1024";
  // Asked for exactly 2048 (as tune does): an error, not a quiet 512 timed under 2048's name.
  const exact = await serve.prepareModel(cfg, model, 32768, "f16", { ubatch: 2048 });
  assert.strictEqual(exact.failed, true);
  assert.match(exact.error, /batch 2048/);
  // An ordinary load still gives up batch before context.
  const normal = await serve.prepareModel(cfg, model, 32768, "f16");
  assert.deepStrictEqual([normal.failed, normal.ubatch, normal.ctx], [undefined, 512, 32768]);
});

test("arcflare tune finds this machine's fastest batch and the next load uses it", { skip: !unix }, async () => {
  const home = path.join(TMP, "cli-home");
  const modelsDir = path.join(TMP, "cli-models");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, "tiny-Q4_K_M.gguf"), "not really a model");
  const port = await freePort();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ llamaServer: FAKE, port, ubatch: 2048 }));
  const log = path.join(TMP, "cli-starts.log");
  const env = { ...process.env, ARCFLARE_HOME: home, ARCFLARE_MODELS: modelsDir, HOME: path.join(TMP, "nohome"),
    XDG_CACHE_HOME: path.join(TMP, "nocache"), FAKE_LOG: log, FAKE_BEST_UB: "512", NO_COLOR: "1" };
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "arcflare.js"), ...args],
    { env, encoding: "utf8", input: "", timeout: 60000 });

  const r = cli("tune", "tiny");
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /use\s+batch 512/);
  assert.match(r.stdout, /% less time per turn/);
  const db = JSON.parse(fs.readFileSync(path.join(home, "tune.json"), "utf8"));
  assert.strictEqual(db.models["tiny:q4_k_m"].ubatch, 512);
  // The batch typed by hand is gone: it would have outranked the measurement.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).ubatch, undefined);
  assert.match(cli("tune", "--show").stdout, /tiny:q4_k_m\s+batch 512/);

  // The next run loads with it; the one after finds it loaded.
  const before = fs.readFileSync(log, "utf8").trim().split("\n").length;
  const run1 = cli("run", "tiny");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.strictEqual(lines.length, before + 1, run1.stdout + run1.stderr);
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).sections["tiny:q4_k_m"].ub, "512");
  const run2 = cli("run", "tiny");
  assert.match(run2.stdout, /already loaded/);
  assert.strictEqual(fs.readFileSync(log, "utf8").trim().split("\n").length, before + 1);

  assert.match(cli("tune", "--clear").stdout, /forgot/);
  cli("stop");
});
