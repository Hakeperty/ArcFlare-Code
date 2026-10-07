// QR codes, with no dependencies: enough of ISO/IEC 18004 to put a /rc link on
// a phone. Byte mode, versions 1-10, error correction M (falling back to L for
// longer text), Reed-Solomon over GF(256), all eight masks scored by the
// standard penalty rules, and format/version information.
//
// The structure follows Project Nayuki's reference implementation (MIT), cut
// down to what a ~70-character link needs.

// ------------------------------------------------------------------ tables ----

// Per version: total codewords, then for each level the EC codewords per
// block and the block groups as [count, data codewords per block].
const VERSIONS = [
  null,
  { total: 26, L: [7, [[1, 19]]], M: [10, [[1, 16]]] },
  { total: 44, L: [10, [[1, 34]]], M: [16, [[1, 28]]] },
  { total: 70, L: [15, [[1, 55]]], M: [26, [[1, 44]]] },
  { total: 100, L: [20, [[1, 80]]], M: [18, [[2, 32]]] },
  { total: 134, L: [26, [[1, 108]]], M: [24, [[2, 43]]] },
  { total: 172, L: [18, [[2, 68]]], M: [16, [[4, 27]]] },
  { total: 196, L: [20, [[2, 78]]], M: [18, [[4, 31]]] },
  { total: 242, L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]] },
  { total: 292, L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]] },
  { total: 346, L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]] },
];

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// Format information encodes the level in two bits: L=01, M=00.
const LEVEL_BITS = { L: 1, M: 0 };

function dataCodewords(version, level) {
  return VERSIONS[version][level][1].reduce((n, [count, len]) => n + count * len, 0);
}

// --------------------------------------------------------------- GF(256) ----

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), leading 1 dropped. */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The EC codewords for one block of data. */
function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ---------------------------------------------------------------- encoding ----

function chooseVersion(bytes) {
  for (const level of ["M", "L"]) {
    for (let v = 1; v <= 10; v++) {
      const bits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
      if (bits <= dataCodewords(v, level) * 8) return { version: v, level };
    }
  }
  throw new Error(`too long for a QR code here (${bytes.length} bytes; the limit is ${dataCodewords(10, "L") - 2})`);
}

/** Mode, length, data, terminator and padding, as data codewords. */
function dataStream(bytes, version, level) {
  const cap = dataCodewords(version, level) * 8;
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add EC to each, and interleave. */
function codewords(data, version, level) {
  const [ec, groups] = VERSIONS[version][level];
  const blocks = [];
  let k = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ d, e: rsRemainder(d, ec) });
    }
  }
  const out = [];
  const maxLen = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ---------------------------------------------------------------- the grid ----

function formatBits(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(r, c, dark) { this.m[r][c] = dark; this.fn[r][c] = true; }

  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    this.finder(3, 3); this.finder(3, n - 4); this.finder(n - 4, 3);
    const pos = ALIGN[this.version];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        // Skip the three that would sit on a finder.
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) this.set(pos[i] + dr, pos[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
    this.drawFormat(0); // reserve the area; the real bits go in after masking
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = n - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(b, a, dark);
        this.set(a, b, dark);
      }
    }
  }

  finder(cr, cc) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = cr + dr, c = cc + dc;
        if (r < 0 || c < 0 || r >= this.size || c >= this.size) continue;
        const d = Math.max(Math.abs(dr), Math.abs(dc));
        this.set(r, c, d !== 2 && d !== 4);
      }
    }
  }

  drawFormat(mask, level = "M") {
    const n = this.size;
    const bits = formatBits(level, mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    // First copy, around the top-left finder.
    for (let i = 0; i <= 5; i++) this.set(i, 8, bit(i));
    this.set(7, 8, bit(6));
    this.set(8, 8, bit(7));
    this.set(8, 7, bit(8));
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, bit(i));
    // Second copy, split between the other two finders.
    for (let i = 0; i < 8; i++) this.set(8, n - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) this.set(n - 15 + i, 8, bit(i));
    this.set(n - 8, 8, true); // the dark module
  }

  drawCodewords(data) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? n - 1 - vert : vert;
          if (!this.fn[r][c] && i < data.length * 8) {
            this.m[r][c] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const f = MASKS[mask];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) if (!this.fn[r][c] && f(r, c)) this.m[r][c] = !this.m[r][c];
    }
  }

  penalty() {
    const n = this.size, m = this.m;
    let score = 0;
    const line = (get) => {
      // Rule 1: runs of five or more; rule 3: finder-like 1:1:3:1:1 with light margin.
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && get(i) === get(i - 1)) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      for (let i = 0; i + 11 <= n; i++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(i + k) ? 1 : 0)).join("");
        if (s === "10111010000" || s === "00001011101") score += 40;
      }
    };
    for (let r = 0; r < n; r++) line((c) => m[r][c]);
    for (let c = 0; c < n; c++) line((r) => m[r][c]);
    // Rule 2: 2x2 blocks of one colour.
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    // Rule 4: balance of dark and light.
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return score;
  }
}

/**
 * Encode text as a QR code. Returns rows of booleans (true = dark), no quiet
 * zone, plus `version`, `level` and `mask` as properties of the array.
 */
function encode(text, { mask: forceMask } = {}) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  const { version, level } = chooseVersion(bytes);
  const words = codewords(dataStream(bytes, version, level), version, level);

  const build = (mask) => {
    const g = new Grid(version);
    g.drawFunctionPatterns();
    g.drawCodewords(words);
    g.applyMask(mask);
    g.drawFormat(mask, level);
    return g;
  };
  let best = null;
  const masks = forceMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  for (const mask of masks) {
    const g = build(mask);
    const p = g.penalty();
    if (!best || p < best.p) best = { g, p, mask };
  }
  const out = best.g.m.map((row) => row.slice());
  Object.assign(out, { version, level, mask: best.mask });
  return out;
}

// --------------------------------------------------------------- rendering ----

function withQuiet(matrix, quiet) {
  const n = matrix.length + quiet * 2;
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => {
      const rr = r - quiet, cc = c - quiet;
      return rr >= 0 && cc >= 0 && rr < matrix.length && cc < matrix.length ? matrix[rr][cc] : false;
    }));
}

/**
 * Two modules per character cell using half blocks, so a version-5 code is 41
 * columns by 21 lines.
 *
 * color: paint black on white explicitly (ANSI 256-colour), which scans on any
 *        terminal theme.
 * invert: with no colour, draw the light modules instead of the dark ones, for
 *         the usual light-text-on-dark terminal. Phone cameras read inverted
 *         codes, and this way the quiet zone shows up as a bright frame.
 */
function toTerminal(matrix, { color = false, invert = true, quiet = 2, indent = "" } = {}) {
  const q = withQuiet(matrix, quiet);
  const lines = [];
  for (let r = 0; r < q.length; r += 2) {
    let s = "";
    for (let c = 0; c < q.length; c++) {
      let top = q[r][c];
      let bottom = r + 1 < q.length ? q[r + 1][c] : false;
      if (!color && invert) { top = !top; bottom = r + 1 < q.length ? !bottom : false; }
      s += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(color ? `${indent}\x1b[38;5;16;48;5;231m${s}\x1b[0m` : indent + s);
  }
  return lines.join("\n");
}

/** A crisp, scalable SVG: one path, dark modules on white. */
function toSvg(matrix, { quiet = 4, dark = "#000", light = "#fff" } = {}) {
  const n = matrix.length + quiet * 2;
  let d = "";
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) if (matrix[r][c]) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { encode, toTerminal, toSvg, rsRemainder, formatBits, versionBits, VERSIONS, ALIGN, MASKS, dataCodewords };
