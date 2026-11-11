// Model discovery. Finds GGUF files wherever they already live — the llama.cpp
// HF cache, an explicit models dir, ArcFlare's own store, or Ollama's — and
// reads just enough metadata to describe each one.

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
    add(path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "llama.cpp"));
    // llama.cpp's cache on macOS (and where `arcflare pull` puts models there).
    if (process.platform === "darwin") add(path.join(os.homedir(), "Library", "Caches", "llama.cpp"));
  }
  // LM Studio's folder, last: models downloaded there run on either engine, and
  // ArcFlare's own imports into it (links to files found above) dedupe by id.
  for (const d of require("./lmstudio").modelDirs()) add(d);
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

// ----------------------------------------------------------------- ollama --

// Ollama keeps weights as content-addressed blobs (`blobs/sha256-<hex>`) named
// by manifests at `manifests/<host>/<namespace>/<model>/<tag>` — newer builds
// also write `manifests-v2/`. The blobs are plain GGUF, so llama-server loads
// them as they are; the manifest is only needed to know what each one is.

function ollamaRoots(extra = []) {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const r = path.resolve(p);
    if (!out.includes(r) && fs.existsSync(path.join(r, "blobs"))) out.push(r);
  };
  add(process.env.OLLAMA_MODELS);
  add(path.join(os.homedir(), ".ollama", "models"));
  // Ollama as a system service keeps its models in the service user's home: /usr/share/ollama with the
  // official installer, /var/lib/ollama with the Arch, Fedora and NixOS packages.
  if (process.platform === "linux") { add("/usr/share/ollama/.ollama/models"); add("/var/lib/ollama/.ollama/models"); add("/var/lib/ollama/models"); }
  // OLLAMA_MODELS is often set only for the Ollama service, not for us; any
  // models root that holds manifests is an Ollama store whatever it is called.
  roots(extra).forEach(add);
  return out;
}

/** "registry.ollama.ai/library/qwen3/8b" -> "qwen3:8b", as `ollama list` shows it. */
function ollamaName(host, ns, model, tag) {
  const bare = host === "registry.ollama.ai" || host === "ollama.com";
  const prefix = bare ? (ns === "library" ? "" : ns + "/") : `${host}/${ns}/`;
  return `${prefix}${model}:${tag}`.toLowerCase();
}

function isGguf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b.toString("latin1") === "GGUF";
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Every pullable model in an Ollama store, as discover() entries. */
function ollamaModels(root) {
  const blob = (digest) => path.join(root, "blobs", String(digest).replace(":", "-"));
  const out = [];
  for (const kind of ["manifests-v2", "manifests"]) {
    const base = path.join(root, kind);
    for (const h of listDirs(base)) {
      if (!h.isDirectory()) continue;
      for (const n of listDirs(path.join(base, h.name))) {
        if (!n.isDirectory()) continue;
        for (const m of listDirs(path.join(base, h.name, n.name))) {
          if (!m.isDirectory()) continue;
          for (const t of listDirs(path.join(base, h.name, n.name, m.name))) {
            if (!t.isFile()) continue;
            let man;
            try { man = JSON.parse(fs.readFileSync(path.join(base, h.name, n.name, m.name, t.name), "utf8")); }
            catch { continue; }
            if (man.format && man.format !== "gguf") continue;
            const layers = man.layers || [];
            const weights = layers.find((l) => l.mediaType === "application/vnd.ollama.image.model");
            if (!weights) continue; // cloud-only and adapter-only entries
            const file = blob(weights.digest);
            let st;
            try { st = fs.statSync(file); } catch { continue; }
            if (!isGguf(file)) continue; // safetensors-backed models need Ollama's own engine
            const entry = {
              id: ollamaName(h.name, n.name, m.name, t.name),
              file,
              dir: path.dirname(file),
              name: weights.from ? path.basename(weights.from) : path.basename(file),
              size: st.size,
              mtime: st.mtimeMs,
              meta: null,
              ollama: true,
            };
            const proj = layers.find((l) => l.mediaType === "application/vnd.ollama.image.projector");
            if (proj && fs.existsSync(blob(proj.digest))) entry.mmproj = blob(proj.digest);
            out.push(entry);
          }
        }
      }
    }
  }
  return out;
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

  // Ollama's models, under the names `ollama list` gives them. A blob that was
  // imported from a GGUF still sitting in the HF cache is the same weights
  // twice, so the copy already found by its filename wins.
  if (opts.ollama !== false) {
    const same = new Set(models.map((m) => m.name.toLowerCase() + ":" + m.size));
    for (const r of ollamaRoots(opts.roots || [])) {
      for (const m of ollamaModels(r)) {
        if (seen.has(m.id) || same.has(m.name.toLowerCase() + ":" + m.size)) continue;
        seen.add(m.id);
        models.push(m);
      }
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

module.exports = { discover, resolve, loadMeta, flushMetaCache, roots, ollamaRoots, idFor, HOME };
