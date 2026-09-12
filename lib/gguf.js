// Minimal GGUF metadata reader — pure Node, no dependencies.
//
// We only parse the header key/value block (never tensor data), and we read the
// file in windows so a 30 GB model costs a few MB of I/O. This is what lets
// ArcFlare show a model's real max context and work out how much KV cache a
// given context will need, instead of guessing.

const fs = require("fs");

const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

const FIXED_SIZE = {
  [T.UINT8]: 1, [T.INT8]: 1, [T.UINT16]: 2, [T.INT16]: 2,
  [T.UINT32]: 4, [T.INT32]: 4, [T.FLOAT32]: 4, [T.BOOL]: 1,
  [T.UINT64]: 8, [T.INT64]: 8, [T.FLOAT64]: 8,
};

// Enough for the header of essentially any model; tokenizer arrays dominate.
const MAX_HEADER = 192 * 1024 * 1024;

class Reader {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.buf = Buffer.alloc(0);
    this.base = 0; // file offset of buf[0]
    this.pos = 0;  // absolute file offset of the cursor
  }
  ensure(n) {
    const need = this.pos + n;
    if (need > this.size) throw new Error("truncated GGUF");
    if (need > MAX_HEADER) throw new Error("GGUF header too large");
    const have = this.base + this.buf.length;
    if (this.pos >= this.base && need <= have) return;
    // Re-window starting at the cursor, generous chunk to avoid thrashing.
    const chunk = Math.min(Math.max(n, 8 * 1024 * 1024), this.size - this.pos);
    const b = Buffer.alloc(chunk);
    const read = fs.readSync(this.fd, b, 0, chunk, this.pos);
    this.buf = b.subarray(0, read);
    this.base = this.pos;
    if (read < n) throw new Error("short read");
  }
  off() { return this.pos - this.base; }
  u8() { this.ensure(1); const v = this.buf.readUInt8(this.off()); this.pos += 1; return v; }
  i8() { this.ensure(1); const v = this.buf.readInt8(this.off()); this.pos += 1; return v; }
  u16() { this.ensure(2); const v = this.buf.readUInt16LE(this.off()); this.pos += 2; return v; }
  i16() { this.ensure(2); const v = this.buf.readInt16LE(this.off()); this.pos += 2; return v; }
  u32() { this.ensure(4); const v = this.buf.readUInt32LE(this.off()); this.pos += 4; return v; }
  i32() { this.ensure(4); const v = this.buf.readInt32LE(this.off()); this.pos += 4; return v; }
  f32() { this.ensure(4); const v = this.buf.readFloatLE(this.off()); this.pos += 4; return v; }
  f64() { this.ensure(8); const v = this.buf.readDoubleLE(this.off()); this.pos += 8; return v; }
  u64() {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.off());
    this.pos += 8;
    return Number(v);
  }
  i64() {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.off());
    this.pos += 8;
    return Number(v);
  }
  str() {
    const len = this.u64();
    if (len > 64 * 1024 * 1024) throw new Error("absurd string length");
    this.ensure(len);
    const s = this.buf.toString("utf8", this.off(), this.off() + len);
    this.pos += len;
    return s;
  }
  skip(n) { this.pos += n; }
}

function readValue(r, type, opts) {
  switch (type) {
    case T.UINT8: return r.u8();
    case T.INT8: return r.i8();
    case T.UINT16: return r.u16();
    case T.INT16: return r.i16();
    case T.UINT32: return r.u32();
    case T.INT32: return r.i32();
    case T.FLOAT32: return r.f32();
    case T.FLOAT64: return r.f64();
    case T.BOOL: return r.u8() !== 0;
    case T.UINT64: return r.u64();
    case T.INT64: return r.i64();
    case T.STRING: return r.str();
    case T.ARRAY: {
      const et = r.u32();
      const n = r.u64();
      // Large token/merge arrays are useless to us — skip them cheaply.
      if (!opts.keepArray) {
        if (FIXED_SIZE[et]) { r.skip(FIXED_SIZE[et] * n); return { skipped: n }; }
        if (et === T.STRING) {
          for (let i = 0; i < n; i++) { const l = r.u64(); r.skip(l); }
          return { skipped: n };
        }
        throw new Error("nested arrays unsupported");
      }
      const out = [];
      for (let i = 0; i < n; i++) out.push(readValue(r, et, { keepArray: false }));
      return out;
    }
    default:
      throw new Error("unknown GGUF value type " + type);
  }
}

// Keys whose array values we actually want to keep (small, per-layer).
const KEEP_ARRAY = /(head_count_kv|head_count|block_count|n_head_kv|layer_types|recurrent_layer)/;

/** Read the metadata KV block. Returns a flat object, or null if unreadable. */
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const r = new Reader(fd, size);
    if (r.u32() !== 0x46554747) return null; // "GGUF"
    const version = r.u32();
    if (version < 2 || version > 4) return null;
    const tensorCount = r.u64();
    const kvCount = r.u64();
    if (kvCount > 100000) return null;

    const meta = { __version: version, __tensor_count: tensorCount };
    for (let i = 0; i < kvCount; i++) {
      const key = r.str();
      const type = r.u32();
      let val;
      try {
        val = readValue(r, type, { keepArray: KEEP_ARRAY.test(key) });
      } catch (e) {
        // Ran past our window or hit something exotic; keep what we have.
        break;
      }
      meta[key] = val;
    }
    return meta;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const FILE_TYPES = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1",
  10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M",
  16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S",
  22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M",
  28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16", 36: "MXFP4",
};

/** Pull out the handful of fields ArcFlare actually uses. */
function summarize(meta) {
  if (!meta) return null;
  const arch = meta["general.architecture"] || "unknown";
  const g = (suffix) => meta[`${arch}.${suffix}`];

  const nLayer = g("block_count");
  const embd = g("embedding_length");
  const nHead = g("attention.head_count");
  let kvHeads = g("attention.head_count_kv");
  const kLen = g("attention.key_length");
  const vLen = g("attention.value_length");

  // Hybrid models publish head_count_kv as a per-layer array with 0 on the
  // linear-attention layers. That distinction is the whole reason long context
  // is cheap on these models, so keep it rather than averaging it away.
  let kvPerLayer = null;
  if (Array.isArray(kvHeads)) {
    kvPerLayer = kvHeads;
    kvHeads = Math.max(...kvHeads.filter((x) => typeof x === "number"), 0);
  }

  const headDimK = kLen || (embd && nHead ? embd / nHead : null);
  const headDimV = vLen || headDimK;

  return {
    arch,
    name: meta["general.name"] || null,
    sizeLabel: meta["general.size_label"] || null,
    quant: FILE_TYPES[meta["general.file_type"]] || null,
    trainCtx: g("context_length") || null,
    nLayer: typeof nLayer === "number" ? nLayer : null,
    embd: typeof embd === "number" ? embd : null,
    nHead: typeof nHead === "number" ? nHead : null,
    kvHeads: typeof kvHeads === "number" ? kvHeads : null,
    kvPerLayer,
    headDimK: headDimK || null,
    headDimV: headDimV || null,
    // Hybrid attention: only every Nth layer keeps a growing KV cache, the rest
    // are linear/recurrent with fixed-size state. Ignoring this overestimates
    // KV by 4x on Qwen3.5/3.6/3.8-class models.
    fullAttnInterval: g("full_attention_interval") || null,
    // Multi-token-prediction layers are counted in block_count but are not
    // ordinary attention layers.
    nextnLayers: g("nextn_predict_layers") || 0,
    // MLA (DeepSeek / GLM-lite): the cache is one compressed latent per layer,
    // not separate K and V tensors.
    kvLoraRank: g("attention.kv_lora_rank") || null,
    qkRopeHeadDim: g("rope.dimension_count") && g("attention.kv_lora_rank")
      ? g("attention.qk_rope_head_dim") || g("rope.dimension_count")
      : null,
    expertCount: g("expert_count") || null,
    expertUsed: g("expert_used_count") || null,
    splitCount: meta["split.count"] || null,
    hasVision: Boolean(meta["clip.has_vision_encoder"]),
  };
}

/** How many layers actually hold a per-token KV cache. */
function attendingLayers(sum) {
  if (!sum || !sum.nLayer) return null;
  if (sum.kvPerLayer && sum.kvPerLayer.length) {
    return sum.kvPerLayer.filter((h) => h).length;
  }
  const real = sum.nLayer - (sum.nextnLayers || 0);
  if (sum.fullAttnInterval && sum.fullAttnInterval > 1) {
    return Math.floor(real / sum.fullAttnInterval);
  }
  return real;
}

const BITS = {
  f32: 32, f16: 16, bf16: 16, q8_0: 8.5, q5_1: 6, q5_0: 5.5, q4_1: 5, q4_0: 4.5,
  iq4_nl: 4.5, q6_0: 6.5,
};

/**
 * Bytes of KV cache per token of context.
 * Returns null when the metadata is too incomplete to be honest about it.
 */
function kvBytesPerToken(sum, cacheType = "f16") {
  if (!sum || !sum.nLayer) return null;
  const bits = BITS[String(cacheType).toLowerCase()] || 16;
  const bytesPer = bits / 8;
  const layers = attendingLayers(sum);
  if (!layers) return null;

  // MLA: one compressed latent per token per layer, not K and V separately.
  if (sum.kvLoraRank) {
    const per = sum.kvLoraRank + (sum.qkRopeHeadDim || 0);
    return Math.round(layers * per * bytesPer);
  }

  if (!sum.headDimK || !sum.kvHeads) return null;

  if (sum.kvPerLayer && sum.kvPerLayer.length) {
    let total = 0;
    for (const h of sum.kvPerLayer) {
      if (!h) continue; // linear / recurrent layer: no per-token KV growth
      total += h * (sum.headDimK + sum.headDimV) * bytesPer;
    }
    return Math.round(total);
  }
  return Math.round(layers * sum.kvHeads * (sum.headDimK + sum.headDimV) * bytesPer);
}

/** Largest context that fits in `budgetBytes`, capped at the trained context. */
function maxContextFor(sum, budgetBytes, cacheType = "f16") {
  const per = kvBytesPerToken(sum, cacheType);
  if (!per || !budgetBytes) return null;
  const fits = Math.floor(budgetBytes / per);
  const cap = sum.trainCtx || fits;
  // Round down to a 1024 boundary; llama.cpp is happier with tidy sizes.
  return Math.max(4096, Math.min(cap, Math.floor(fits / 1024) * 1024));
}

module.exports = { readMeta, summarize, kvBytesPerToken, maxContextFor, attendingLayers, FILE_TYPES };
