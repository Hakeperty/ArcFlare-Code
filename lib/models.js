// Model discovery. Finds GGUF files wherever they already live — the llama.cpp
// HF cache, an explicit models dir, or ArcFlare's own store — and reads just
// enough metadata to describe each one.

const fs = require("fs");
const os = require("os");
const path = require("path");
const gguf = require("./gguf");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");

/** Candidate roots, in priority order. Deduped, existing dirs only. */
function roots(extra = []) {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const r = path.resolve(p);
    if (!out.includes(r) && fs.existsSync(r)) out.push(r);
  };
  extra.forEach(add);
  add(process.env.ARCFLARE_MODELS);
  add(process.env.LLAMA_CACHE);
  add(path.join(HOME, "models"));
  add(path.join(os.homedir(), "llamacpp", "models"));
  if (process.platform === "win32") {
    add(path.join(process.env.LOCALAPPDATA || "", "llama.cpp"));
  } else {
    add(path.join(os.homedir(), ".cache", "llama.cpp"));
  }
  return out;
}

function walk(dir, depth, hits) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "blobs" || e.name === ".git" || e.name === "node_modules") continue;
      walk(full, depth - 1, hits);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".gguf")) {
      hits.push(full);
    }
  }
}

// "Model-00002-of-00005.gguf" -> only the first shard represents the model.
function isLaterShard(name) {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(name);
  return Boolean(m) && m[1] !== "00001";
}

function isAuxiliary(name) {
  const n = name.toLowerCase();
  return n.startsWith("mmproj") || n.startsWith("mtp-") || n.includes("eagle3");
}

/** Short, stable, Ollama-ish id for a model file. */
function idFor(file) {
  let base = path.basename(file).replace(/\.gguf$/i, "");
  base = base.replace(/-(\d{5})-of-(\d{5})$/i, "");
  const m = /^(.*?)-((?:UD-)?(?:I?Q\d[^-]*|BF16|F16|F32|MXFP4[^-]*)(?:_[A-Z0-9]+)*)$/i.exec(base);
  if (m) return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
  return base.toLowerCase();
}

// Draft models for speculative decoding. Normally an `mtp-*.gguf` sits beside
// the weights, but the HF cache splits them across repos — the Qwen3.8-27B
// draft ships from ggml-org while the weights come from unsloth, so a
// same-directory scan finds nothing and MTP silently stays off. Index every
// draft we saw and match on model family instead.
//
// Family only, and only for drafts: an `mmproj` is repo-local and pairing one
// with a different model's weights would be a real mistake, so vision sidecars
// stay strictly same-directory.
function indexDrafts(hits) {
  const byFamily = new Map();
  for (const file of hits) {
    const name = path.basename(file);
    if (!/^mtp-.*.gguf$/i.test(name)) continue;
    const family = idFor(name.replace(/^mtp-/i, "")).split(":")[0];
    if (family && !byFamily.has(family)) byFamily.set(family, file);
  }
  return byFamily;
}

/**
 * Discover models. Metadata parsing is lazy — pass {meta:true} when you need
 * context sizes, otherwise this is just a directory walk.
 */
function discover(opts = {}) {
  const hits = [];
  for (const r of roots(opts.roots || [])) walk(r, opts.depth ?? 5, hits);

  const seen = new Set();
  const models = [];
  for (const file of hits) {
    const name = path.basename(file);
    if (isLaterShard(name) || isAuxiliary(name)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }

    const id = idFor(file);
    if (seen.has(id)) continue;
    seen.add(id);

    const entry = {
      id,
      file,
      dir: path.dirname(file),
      name,
      size: st.size,
      mtime: st.mtimeMs,
      meta: null,
    };

    // Sharded models: total the set so the reported size is honest.
    const shard = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(name);
    if (shard) {
      const total = parseInt(shard[2], 10);
      let sum = 0;
      for (let i = 1; i <= total; i++) {
        const p = path.join(entry.dir,
          name.replace(/-\d{5}-of-\d{5}\.gguf$/i,
            `-${String(i).padStart(5, "0")}-of-${shard[2]}.gguf`));
        try { sum += fs.statSync(p).size; } catch {}
      }
      if (sum) entry.size = sum;
      entry.shards = total;
    }

    // Sidecars that live next to the model.
    try {
      for (const f of fs.readdirSync(entry.dir)) {
        if (/^mmproj.*\.gguf$/i.test(f)) entry.mmproj = path.join(entry.dir, f);
        else if (/^mtp-.*\.gguf$/i.test(f)) entry.mtp = path.join(entry.dir, f);
      }
    } catch {}

    models.push(entry);
  }

  // Attach a cross-repo draft to anything that did not find one next door.
  const drafts = indexDrafts(hits);
  for (const m of models) {
    if (m.mtp) continue;
    const d = drafts.get(m.id.split(":")[0]);
    if (d) {
      m.mtp = d;
      m.mtpFromOtherRepo = true;
    }
  }

  if (opts.meta) {
    for (const m of models) loadMeta(m);
    flushMetaCache();
  }
  models.sort((a, b) => b.size - a.size);
  return models;
}

const _metaCache = new Map();
const META_CACHE_FILE = path.join(HOME, "metadata.json");
let _disk = null;
let _diskDirty = false;

function diskCache() {
  if (_disk) return _disk;
  try { _disk = JSON.parse(fs.readFileSync(META_CACHE_FILE, "utf8")); }
  catch { _disk = {}; }
  return _disk;
}

function flushMetaCache() {
  if (!_diskDirty || !_disk) return;
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(META_CACHE_FILE, JSON.stringify(_disk));
    _diskDirty = false;
  } catch { /* a cache we cannot write is not an error */ }
}

/**
 * Summarised metadata for a model, memoised in memory and on disk.
 * Parsing a header means reading megabytes off a multi-gigabyte file, so the
 * disk cache is what keeps `arcflare ls` instant on a large model collection.
 */
function loadMeta(entry) {
  if (entry.meta) return entry.meta;
  const key = entry.file + ":" + Math.round(entry.mtime) + ":" + entry.size;
  if (_metaCache.has(key)) {
    entry.meta = _metaCache.get(key);
    return entry.meta;
  }
  const d = diskCache();
  if (d[key]) {
    _metaCache.set(key, d[key]);
    entry.meta = d[key];
    return entry.meta;
  }
  const sum = gguf.summarize(gguf.readMeta(entry.file));
  _metaCache.set(key, sum);
  if (sum) { d[key] = sum; _diskDirty = true; }
  entry.meta = sum;
  return sum;
}

/** Resolve a user-typed name to a model, tolerating partial matches. */
function resolve(models, query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  return (
    models.find((m) => m.id === q) ||
    models.find((m) => m.id.split(":")[0] === q) ||
    models.find((m) => m.name.toLowerCase() === q) ||
    models.find((m) => m.id.includes(q)) ||
    models.find((m) => m.name.toLowerCase().includes(q)) ||
    null
  );
}

module.exports = { discover, resolve, loadMeta, flushMetaCache, roots, idFor, HOME };
