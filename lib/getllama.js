// Fetch llama.cpp for people who don't have it: `arcflare get-engine`.
//
// ArcFlare drives the stock llama-server rather than bundling one, which is
// right for anyone who already has a tuned build and a dead end for anyone who
// doesn't — on a fresh Mac, `arcflare pull` used to stop at "llama-server not
// found". This downloads the official prebuilt release from
// github.com/ggml-org/llama.cpp for this OS and CPU, checks it against the
// sha256 GitHub publishes for the asset, and unpacks it under
// ~/.arcflare/llama.cpp/<tag>. The caller saves the path as `llamaServer`.
//
// Builds picked: macOS arm64 (Metal), macOS x64, Linux x64 (Vulkan if the
// release has one, else CPU), Windows x64 (Vulkan, else CPU). A CUDA or ROCm
// build is still better fetched by hand and set with `arcflare set-engine`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const EXE = process.platform === "win32" ? ".exe" : "";

function root() {
  return path.join(process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare"), "llama.cpp");
}

/**
 * Asset name patterns for this machine, best first. Releases have shipped
 * both .zip and .tar.gz, so both are accepted.
 */
function wanted(platform = process.platform, arch = process.arch) {
  const ext = "\\.(zip|tar\\.gz)$";
  if (platform === "darwin") return [new RegExp(`-bin-macos-${arch === "arm64" ? "arm64" : "x64"}${ext}`)];
  if (platform === "linux" && arch === "x64") return [new RegExp(`-bin-ubuntu-vulkan-x64${ext}`), new RegExp(`-bin-ubuntu-x64${ext}`)];
  if (platform === "win32" && arch === "x64") return [new RegExp(`-bin-win-vulkan-x64${ext}`), new RegExp(`-bin-win-cpu-x64${ext}`)];
  return [];
}

/** The asset to download from a release, or null. */
function pickAsset(release, platform, arch) {
  const assets = (release && release.assets) || [];
  for (const re of wanted(platform, arch)) {
    const a = assets.find((x) => re.test(x.name));
    if (a) return a;
  }
  return null;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "arcflare", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub refused the request (${res.status}), usually a rate limit; try again in a few minutes`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the llama.cpp release list`);
  return res.json();
}

/** Stream a URL to a file, reporting whole percentages. Returns its sha256. */
async function download(url, file, onProgress) {
  const res = await fetch(url, { headers: { "User-Agent": "arcflare" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(file);
  let got = 0;
  let last = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (onProgress && pct !== last && pct >= 0) { last = pct; onProgress(pct, got, total); }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest("hex");
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const zip = archive.endsWith(".zip");
  // macOS and Windows 10+ ship a bsdtar that reads zips too; Linux has unzip.
  const tries = zip
    ? [["unzip", ["-q", "-o", archive, "-d", dir]], ["tar", ["-xf", archive, "-C", dir]]]
    : [["tar", ["-xzf", archive, "-C", dir]]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return;
  }
  throw new Error(`could not unpack ${path.basename(archive)} — install ${zip ? "unzip" : "tar"} and try again`);
}

/** The first llama-server under dir, breadth-first. */
function findServerIn(dir) {
  const queue = [dir];
  while (queue.length) {
    const d = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    const hit = entries.find((e) => e.isFile() && e.name === "llama-server" + EXE);
    if (hit) return path.join(d, hit.name);
    for (const e of entries) if (e.isDirectory()) queue.push(path.join(d, e.name));
  }
  return null;
}

/**
 * Download and unpack the latest llama.cpp for this machine.
 * Resolves with { server, tag, asset, dir }; `log` gets one line per step.
 */
async function install({ log = () => {}, onProgress, release } = {}) {
  const want = wanted();
  if (!want.length) throw new Error(`no prebuilt llama.cpp for ${process.platform}/${process.arch}; build it and run arcflare set-engine <path>`);
  log("finding the latest llama.cpp release");
  const rel = release || await getJson(RELEASES);
  const asset = pickAsset(rel);
  if (!asset) throw new Error(`llama.cpp ${rel.tag_name} has no build for ${process.platform}/${process.arch}; see https://github.com/ggml-org/llama.cpp/releases`);

  const dir = path.join(root(), rel.tag_name);
  const existing = fs.existsSync(dir) && findServerIn(dir);
  if (existing) {
    log(`llama.cpp ${rel.tag_name} is already here`);
    return { server: existing, tag: rel.tag_name, asset: asset.name, dir, fresh: false };
  }

  fs.mkdirSync(root(), { recursive: true });
  const tmp = path.join(root(), `.${asset.name}.part`);
  log(`downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)`);
  const sum = await download(asset.browser_download_url, tmp, onProgress);
  // GitHub publishes "sha256:<hex>" per asset; older API answers may not.
  const expected = String(asset.digest || "").replace(/^sha256:/, "");
  if (expected && expected !== sum) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${asset.name} does not match the sha256 GitHub publishes for it; not installing it`);
  }
  log(expected ? "checksum ok" : "no checksum published for this asset; unpacking it unverified");

  // Extraction tools go by the extension, so the archive gets its real name back.
  const archive = path.join(root(), "." + asset.name);
  fs.renameSync(tmp, archive);
  const staging = dir + ".partial";
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    extract(archive, staging);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  const server = findServerIn(staging);
  if (!server) { fs.rmSync(staging, { recursive: true, force: true }); throw new Error(`no llama-server inside ${asset.name}`); }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  const final = findServerIn(dir);

  if (process.platform !== "win32") {
    for (const f of fs.readdirSync(path.dirname(final))) {
      const p = path.join(path.dirname(final), f);
      try { if (fs.statSync(p).isFile() && !/\.(dylib|so[.\d]*|h|txt|md|json|py)$/.test(f)) fs.chmodSync(p, 0o755); } catch { /* skip */ }
    }
  }
  if (process.platform === "darwin") spawnSync("xattr", ["-dr", "com.apple.quarantine", dir], { stdio: "ignore" });

  // Does it run? A build that can't load its libraries fails here, not at chat time.
  const probe = spawnSync(final, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (probe.status !== 0 && probe.error) throw new Error(`the downloaded llama-server won't start: ${probe.error.message}`);
  log(`installed llama.cpp ${rel.tag_name}`);
  return { server: final, tag: rel.tag_name, asset: asset.name, dir, fresh: true };
}

module.exports = { install, wanted, pickAsset, findServerIn, root, RELEASES };
