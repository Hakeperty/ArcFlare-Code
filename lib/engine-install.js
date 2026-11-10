// `arcflare engine install`: fetch a prebuilt llama.cpp for this machine.
//
// llama.cpp publishes builds as GitHub releases named bNNNNN; the "latest"
// release is a pointer whose nightly-tag.txt names the current build. We
// follow that, fall back to the newest release with binaries, pick the archive
// for this OS / CPU / GPU by pattern (never a hard-coded build number), unpack
// it into ~/.arcflare/engine/<build>-<variant>, and check llama-server runs.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { get, getJson, download } = require("./download");

const REPO = "ggml-org/llama.cpp";
const API = `https://api.github.com/repos/${REPO}`;
const EXE = process.platform === "win32" ? ".exe" : "";

/** What the GPU side of this machine looks like, as far as picking a build goes. */
function detectGpu({ platform = process.platform } = {}) {
  const out = { nvidia: false, cuda: null, vulkan: false };
  const smi = spawnSync("nvidia-smi", [], { encoding: "utf8", timeout: 8000 });
  if (smi.status === 0) {
    out.nvidia = true;
    const m = /CUDA Version:\s*([\d.]+)/i.exec(smi.stdout || "");
    if (m) out.cuda = m[1];
  }
  if (platform === "win32") {
    out.vulkan = fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll"));
  } else if (platform === "linux") {
    const libs = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib/x86_64-linux-gnu"];
    out.vulkan = libs.some((d) => fs.existsSync(path.join(d, "libvulkan.so.1"))) ||
      spawnSync("vulkaninfo", ["--summary"], { timeout: 8000 }).status === 0;
  }
  return out;
}

const ver = (v) => String(v || "0").split(".").map(Number);
const cmpVer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

// Names a build kind goes by in release assets. llama.cpp has shipped the AMD
// build as both "rocm-<version>" and "hip-radeon", and the Qualcomm one as
// "opencl-adreno", so a kind is matched by any of its spellings.
const SPELLINGS = {
  cuda: ["cuda"],
  rocm: ["rocm", "hip-radeon", "hip"],
  sycl: ["sycl"],
  opencl: ["opencl-adreno", "opencl"],
  openvino: ["openvino"],
  vulkan: ["vulkan"],
};
const KINDS = ["cuda", "rocm", "sycl", "opencl", "openvino", "vulkan", "cpu", "metal"];

/**
 * Choose the archive(s) for a machine. Pure: give it the release's asset list.
 *   platform: win32 | darwin | linux,  arch: x64 | arm64
 *   gpu: { nvidia, cuda, vulkan },  want: optional kind (see KINDS)
 *   exclude: kinds not to pick (an auto-picked build that turned out not to run)
 * Returns { variant, kind, main, extra: [] } or throws with what is available.
 */
function pickAssets(assets, { platform, arch, gpu = {}, want, exclude = [] } = {}) {
  const find = (re) => assets.find((a) => re.test(a.name));
  const a = arch === "arm64" ? "arm64" : "x64";

  if (platform === "darwin") {
    const main = find(new RegExp(`^llama-.*-bin-macos-${a}\\.(tar\\.gz|zip)$`));
    if (!main) throw new Error(`no macOS ${a} build in this release`);
    return { variant: `macos-${a}`, kind: "metal", main, extra: [] };
  }

  const osName = platform === "linux" ? "ubuntu" : platform === "win32" ? "win" : null;
  if (!osName) throw new Error(`no prebuilt llama.cpp for ${platform}; build it from source: https://github.com/${REPO}`);
  const short = platform === "linux" ? "linux" : "win";
  const ext = "(?:zip|tar\\.gz)";

  /** The build of `kind`, newest version first; for CUDA, no newer than the driver's. */
  const build = (kind) => {
    if (kind === "cpu") {
      const main = find(new RegExp(`^llama-.*-bin-${osName}-(?:cpu-)?${a}\\.${ext}$`));
      return main ? { variant: `${short}-cpu-${a}`, kind, main, extra: [] } : null;
    }
    const names = (SPELLINGS[kind] || []).join("|");
    if (!names) return null;
    const re = new RegExp(`^llama-.*-bin-${osName}-(${names})(?:-([\\d.]+))?-${a}\\.${ext}$`);
    const hits = assets
      .map((x) => ({ x, m: re.exec(x.name) }))
      .filter((o) => o.m && !(kind === "cuda" && gpu.cuda && o.m[2] && cmpVer(o.m[2], gpu.cuda) > 0))
      .sort((p, q) => cmpVer(q.m[2], p.m[2]));
    if (!hits.length) return null;
    const { x: main, m } = hits[0];
    const v = m[2];
    const extra = [];
    if (kind === "cuda" && v) {
      // The CUDA runtime libraries ship as a separate archive for the same version.
      const rt = find(new RegExp(`^cudart-llama-.*bin-${osName}-cuda-${v.replace(/\./g, "\\.")}-${a}\\.${ext}$`));
      if (rt) extra.push(rt);
    }
    return { variant: `${short}-${kind}${v ? "-" + v : ""}-${a}`, kind, main, extra };
  };

  // With nothing asked for: NVIDIA gets CUDA when the driver reports a version
  // (its own API is faster than Vulkan on it), any other GPU gets Vulkan, and
  // the CPU build is what always runs. AMD's and Intel's own builds are never
  // picked unasked - they need a matching vendor runtime, and one that is
  // missing shows up only as a build that sees no device.
  const order = want ? [want]
    : [...(gpu.nvidia && gpu.cuda ? ["cuda"] : []), ...(gpu.vulkan === false ? [] : ["vulkan"]), "cpu"];
  for (const kind of order) {
    if (exclude.includes(kind)) continue;
    const hit = build(kind);
    if (hit) return hit;
  }
  const label = platform === "linux" ? "Linux" : "Windows";
  const have = assets.map((x) => x.name).filter((n) => new RegExp(`-bin-${osName}-`).test(n) && !/^cudart/.test(n));
  throw new Error(`no ${label} ${a} ${order.filter((k) => !exclude.includes(k)).join("/")} build in this release` +
    (have.length ? ` (it has: ${have.join(", ")})` : ""));
}

const hasBinaries = (rel) => (rel.assets || []).some((x) => /-bin-/.test(x.name));

/** The release to install: the one "latest" points at, else the newest with binaries. */
async function resolveRelease() {
  const latest = await getJson(`${API}/releases/latest`);
  if (hasBinaries(latest)) return latest;
  const ptr = (latest.assets || []).find((x) => x.name === "nightly-tag.txt");
  if (ptr) {
    try {
      const res = await get(ptr.browser_download_url);
      let tag = "";
      for await (const ch of res) tag += ch;
      tag = tag.trim();
      if (/^[\w.-]+$/.test(tag)) {
        const rel = await getJson(`${API}/releases/tags/${tag}`);
        if (hasBinaries(rel)) return rel;
      }
    } catch { /* fall back to the list */ }
  }
  const list = await getJson(`${API}/releases?per_page=10`);
  const rel = list.find(hasBinaries);
  if (!rel) throw new Error("couldn't find a llama.cpp release with prebuilt binaries");
  return rel;
}

function findFile(dir, name, depth = 4) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
  for (const e of entries) {
    if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), name, depth - 1); if (f) return f; }
  }
  return null;
}

/** Unpack a .zip or .tar.gz with the system tar (bsdtar reads zip on Windows 10+ and macOS). */
function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const isZip = /\.zip$/i.test(archive);
  let tar = "tar";
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) tar = sys; // bsdtar; Git's GNU tar can't read zip
  }
  let r = spawnSync(tar, ["-xf", archive, "-C", dir], { encoding: "utf8" });
  if (r.status !== 0 && isZip && process.platform !== "win32") {
    r = spawnSync("unzip", ["-oq", archive, "-d", dir], { encoding: "utf8" });
  }
  if (r.status !== 0) throw new Error(`couldn't unpack ${path.basename(archive)}: ${(r.stderr || r.error || "").toString().trim()}`);
}

/** Does this llama-server start at all? Returns { ok, text }. */
function runCheck(server) {
  const v = spawnSync(server, ["--version"], { encoding: "utf8", timeout: 30000 });
  const text = `${v.stdout || ""}${v.stderr || ""}`;
  return { ok: v.status === 0 || /version/i.test(text), text: (text || String(v.error || "")).trim() };
}

/**
 * Install. Returns { server, dir, tag, variant, kind, version, gpu, skipped }.
 *   home: ArcFlare home (default ~/.arcflare); want: force a variant
 *   onStep(text), onProgress({done,total,rate})
 *
 * A build chosen for the machine (not asked for by name) that then fails to
 * start - a CUDA build whose runtime will not load, say - is set aside and the
 * next choice is installed, so guessing higher never leaves someone with less
 * than the Vulkan or CPU build they would have had. `skipped` lists those.
 */
async function install({ home, want, onStep = () => {}, onProgress, platform = process.platform, arch = process.arch,
  release, gpu: gpuIn, fetchFile = download, unpack = extract, check = runCheck } = {}) {
  const root = path.join(home || process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "engine");
  onStep("finding the latest llama.cpp build");
  const rel = release || await resolveRelease();
  const gpu = gpuIn || detectGpu({ platform });
  const exclude = [];
  const skipped = [];

  for (;;) {
    const pick = pickAssets(rel.assets, { platform, arch, gpu, want, exclude });
    const dir = path.join(root, `${rel.tag_name}-${pick.variant}`);

    if (!findFile(dir, "llama-server" + EXE)) {
      const tmp = path.join(root, ".download");
      for (const asset of [pick.main, ...pick.extra]) {
        onStep(`downloading ${asset.name}`);
        const file = path.join(tmp, asset.name);
        await fetchFile(asset.browser_download_url, file, { size: asset.size, onProgress });
        onStep(`unpacking ${asset.name}`);
        unpack(file, dir);
        fs.rmSync(file, { force: true });
      }
    }
    const server = findFile(dir, "llama-server" + EXE);
    if (!server) throw new Error(`the archive had no llama-server${EXE} (looked in ${dir})`);
    if (platform !== "win32") {
      for (const f of fs.readdirSync(path.dirname(server))) {
        const p = path.join(path.dirname(server), f);
        try { if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755); } catch { /* best effort */ }
      }
    }
    onStep("checking it runs");
    const v = check(server);
    if (!v.ok) {
      const why = v.text.split("\n").slice(-3).join(" ");
      if (want || pick.kind === "cpu") throw new Error(`llama-server didn't start: ${why}`);
      skipped.push({ variant: pick.variant, kind: pick.kind, why });
      exclude.push(pick.kind);
      onStep(`the ${pick.kind} build did not start here; trying the next one`);
      continue;
    }
    const m = /version:\s*(\d+)/i.exec(v.text);
    return { server, dir, tag: rel.tag_name, variant: pick.variant, kind: pick.kind, version: m ? m[1] : rel.tag_name, gpu, skipped };
  }
}

module.exports = { detectGpu, pickAssets, resolveRelease, install, extract, cmpVer, KINDS };
