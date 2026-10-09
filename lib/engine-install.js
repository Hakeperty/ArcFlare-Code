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

/**
 * Choose the archive(s) for a machine. Pure: give it the release's asset list.
 *   platform: win32 | darwin | linux,  arch: x64 | arm64
 *   gpu: { nvidia, cuda, vulkan },  want: optional "cpu" | "vulkan" | "cuda" | "rocm" | "metal"
 * Returns { variant, main, extra: [] } or throws with what is available.
 */
function pickAssets(assets, { platform, arch, gpu = {}, want } = {}) {
  const names = assets.map((a) => a.name);
  const find = (re) => assets.find((a) => re.test(a.name));
  const a = arch === "arm64" ? "arm64" : "x64";

  if (platform === "darwin") {
    const main = find(new RegExp(`^llama-.*-bin-macos-${a}\\.(tar\\.gz|zip)$`));
    if (!main) throw new Error(`no macOS ${a} build in this release`);
    return { variant: `macos-${a}`, main, extra: [] };
  }

  if (platform === "linux") {
    const order = want ? [want] : (gpu.vulkan ? ["vulkan", "cpu"] : ["cpu"]);
    for (const v of order) {
      let re;
      if (v === "vulkan") re = new RegExp(`^llama-.*-bin-ubuntu-vulkan-${a}\\.tar\\.gz$`);
      else if (v === "cpu") re = new RegExp(`^llama-.*-bin-ubuntu-${a}\\.tar\\.gz$`);
      else if (v === "rocm") re = new RegExp(`^llama-.*-bin-ubuntu-rocm-[\\d.]+-${a}\\.tar\\.gz$`);
      else if (v === "cuda") re = new RegExp(`^llama-.*-bin-ubuntu-cuda-[\\d.]+-${a}\\.tar\\.gz$`);
      const main = re && find(re);
      if (main) return { variant: `linux-${v}-${a}`, main, extra: [] };
    }
    throw new Error(`no Linux ${a} ${order.join("/")} build in this release (it has: ${names.filter((n) => /ubuntu/.test(n)).join(", ")})`);
  }

  if (platform === "win32") {
    const order = want ? [want] : (gpu.nvidia && gpu.cuda ? ["cuda", "vulkan", "cpu"] : gpu.vulkan === false ? ["cpu"] : ["vulkan", "cpu"]);
    for (const v of order) {
      if (v === "cuda") {
        // The newest CUDA build this driver can run: build version <= driver's.
        const builds = assets
          .map((x) => ({ x, m: new RegExp(`^llama-.*-bin-win-cuda-([\\d.]+)-${a}\\.zip$`).exec(x.name) }))
          .filter((o) => o.m && (!gpu.cuda || cmpVer(o.m[1], gpu.cuda) <= 0))
          .sort((p, q) => cmpVer(q.m[1], p.m[1]));
        if (!builds.length) continue;
        const cv = builds[0].m[1];
        const rt = find(new RegExp(`^cudart-llama-.*bin-win-cuda-${cv.replace(/\./g, "\\.")}-${a}\\.zip$`));
        return { variant: `win-cuda-${cv}-${a}`, main: builds[0].x, extra: rt ? [rt] : [] };
      }
      const re = v === "vulkan" ? new RegExp(`^llama-.*-bin-win-vulkan-${a}\\.zip$`)
        : v === "cpu" ? new RegExp(`^llama-.*-bin-win-cpu-${a}\\.zip$`)
        : v === "rocm" ? new RegExp(`^llama-.*-bin-win-rocm-[\\d.]+-${a}\\.zip$`) : null;
      const main = re && find(re);
      if (main) return { variant: `win-${v}-${a}`, main, extra: [] };
    }
    throw new Error(`no Windows ${a} ${order.join("/")} build in this release`);
  }
  throw new Error(`no prebuilt llama.cpp for ${platform}; build it from source: https://github.com/${REPO}`);
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

/**
 * Install. Returns { server, dir, tag, variant, version }.
 *   home: ArcFlare home (default ~/.arcflare); want: force a variant
 *   onStep(text), onProgress({done,total,rate})
 */
async function install({ home, want, onStep = () => {}, onProgress, platform = process.platform, arch = process.arch } = {}) {
  const root = path.join(home || process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "engine");
  onStep("finding the latest llama.cpp build");
  const rel = await resolveRelease();
  const gpu = detectGpu({ platform });
  const pick = pickAssets(rel.assets, { platform, arch, gpu, want });
  const dir = path.join(root, `${rel.tag_name}-${pick.variant}`);

  const existing = findFile(dir, "llama-server" + EXE);
  if (!existing) {
    const tmp = path.join(root, ".download");
    for (const asset of [pick.main, ...pick.extra]) {
      onStep(`downloading ${asset.name}`);
      const file = path.join(tmp, asset.name);
      await download(asset.browser_download_url, file, { size: asset.size, onProgress });
      onStep(`unpacking ${asset.name}`);
      extract(file, dir);
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
  const v = spawnSync(server, ["--version"], { encoding: "utf8", timeout: 30000 });
  const text = `${v.stdout || ""}${v.stderr || ""}`;
  if (v.status !== 0 && !/version/i.test(text)) {
    throw new Error(`llama-server didn't start: ${(text || String(v.error || "")).trim().split("\n").slice(-3).join(" ")}`);
  }
  const m = /version:\s*(\d+)/i.exec(text);
  return { server, dir, tag: rel.tag_name, variant: pick.variant, version: m ? m[1] : rel.tag_name, gpu };
}

module.exports = { detectGpu, pickAssets, resolveRelease, install, extract, cmpVer };
