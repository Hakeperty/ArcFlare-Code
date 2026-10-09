// Pull GGUF models from Hugging Face without llama.cpp.
//
// `arcflare pull user/repo[:QUANT]` used to hand the download to llama.cpp,
// which meant you could not get a model before you had an engine. This does it
// natively, into the same place and layout llama.cpp uses for `-hf`:
//
//   <cache>/models--<user>--<repo>/snapshots/<commit>/<file>.gguf
//
// so `arcflare ls`, llama-server and llama.cpp's own cache all find it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getJson, download } = require("./download");

const HF = process.env.HF_ENDPOINT || "https://huggingface.co";

/** "user/repo:Q5_K_M" -> { repo, tag } (tag may be ""). */
function parseRef(ref) {
  const s = String(ref || "").trim().replace(/^hf\.co\//, "").replace(/^https?:\/\/huggingface\.co\//, "");
  const i = s.indexOf(":");
  const repo = i >= 0 ? s.slice(0, i) : s;
  const tag = i >= 0 ? s.slice(i + 1) : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not a Hugging Face repo: "${ref}" (expected user/repo[:QUANT])`);
  return { repo, tag };
}

/** llama.cpp's default cache folder for this platform. */
function defaultCache() {
  if (process.env.LLAMA_CACHE) return process.env.LLAMA_CACHE;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "llama.cpp");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "llama.cpp");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "llama.cpp");
}

const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pick the files to download from a repo listing (HF `siblings`).
 * Returns { files: [sibling...], mmproj: sibling|null, quant }.
 * The quant tag must match a whole token: "IQ4_NL" does not pick "IQ4_NL_XL".
 * With no tag, Q4_K_M is the default (llama.cpp's), else the first GGUF.
 */
function pickFiles(siblings, tag) {
  const ggufs = siblings.filter((s) => /\.gguf$/i.test(s.rfilename));
  const main = ggufs.filter((s) => !/(^|\/)mmproj/i.test(s.rfilename));
  if (!main.length) throw new Error("this repo has no GGUF files");

  const byTag = (t) => {
    const re = new RegExp(`(^|[-_./])${esc(t)}(-\\d{5}-of-\\d{5})?\\.gguf$`, "i");
    return main.filter((s) => re.test(s.rfilename));
  };
  let quant = tag;
  let hits = tag ? byTag(tag) : byTag("Q4_K_M");
  if (!hits.length && !tag) { hits = [main[0]]; quant = ""; }
  if (!hits.length) {
    const have = [...new Set(main.map((s) => {
      const base = path.basename(s.rfilename).replace(SHARD, ".gguf").replace(/\.gguf$/i, "");
      const m = /[-_.]((?:UD-)?(?:I?Q\d[\w]*|BF16|F16|F32|MXFP4[\w]*))$/i.exec(base);
      return m ? m[1] : null;
    }).filter(Boolean))];
    throw new Error(`no "${tag}" file in this repo` + (have.length ? `; it has: ${have.join(", ")}` : ""));
  }

  // A sharded model: take every shard of the first match, in order.
  let files = hits;
  const first = hits[0];
  if (SHARD.test(first.rfilename)) {
    const stem = first.rfilename.replace(SHARD, "");
    files = main.filter((s) => s.rfilename.replace(SHARD, "") === stem && SHARD.test(s.rfilename))
      .sort((a, b) => a.rfilename.localeCompare(b.rfilename));
  } else {
    files = [first];
  }

  // Vision models ship a projector; llama.cpp fetches it with -hf, so do we.
  const projs = ggufs.filter((s) => /(^|\/)mmproj/i.test(s.rfilename));
  const mmproj = projs.find((s) => /BF16/i.test(s.rfilename)) || projs.find((s) => /F16/i.test(s.rfilename)) || projs[0] || null;
  return { files, mmproj, quant };
}

/** Repo info with file sizes and SHA-256 (HF's `?blobs=true`). */
async function repoInfo(repo, { token } = {}) {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    return await getJson(`${HF}/api/models/${repo}/revision/main?blobs=true`, { auth });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      throw new Error(`${repo} needs a Hugging Face login: accept its terms on huggingface.co and set HF_TOKEN`);
    }
    if (e.status === 404) throw new Error(`no such Hugging Face repo: ${repo}`);
    throw e;
  }
}

/**
 * Download a model. Returns { dir, files: [paths], skipped } where `dir` is
 * the snapshot folder. Files already present with the right size are skipped.
 */
async function pull(ref, { cache = defaultCache(), token = process.env.HF_TOKEN, onFile, onProgress, signal, info } = {}) {
  const { repo, tag } = parseRef(ref);
  const meta = info || await repoInfo(repo, { token });
  const sha = meta.sha || "main";
  const pick = pickFiles(meta.siblings || [], tag);
  const want = [...pick.files, ...(pick.mmproj ? [pick.mmproj] : [])];

  const repoDir = path.join(cache, `models--${repo.replace("/", "--")}`);
  const dir = path.join(repoDir, "snapshots", sha);
  // refs/main, as the HF cache layout has it, so other tools agree on the commit.
  fs.mkdirSync(path.join(repoDir, "refs"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "refs", "main"), sha);

  const auth = token ? { Authorization: `Bearer ${token}` } : undefined;
  const out = [];
  let skipped = 0;
  for (const s of want) {
    const dest = path.join(dir, ...s.rfilename.split("/"));
    const size = (s.lfs && s.lfs.size) || s.size;
    const digest = s.lfs && s.lfs.sha256;
    try {
      if (size && fs.statSync(dest).size === size) { out.push(dest); skipped++; continue; }
    } catch { /* not there yet */ }
    if (onFile) onFile({ name: s.rfilename, size, index: out.length, count: want.length });
    const url = `${HF}/${repo}/resolve/${sha}/${s.rfilename.split("/").map(encodeURIComponent).join("/")}`;
    await download(url, dest, { size, sha256: digest, auth, onProgress, signal });
    out.push(dest);
  }
  return { repo, quant: pick.quant, dir, files: out, skipped };
}

module.exports = { parseRef, pickFiles, defaultCache, repoInfo, pull };
