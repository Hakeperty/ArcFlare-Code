// Tests for the QR encoder. A code that looks right and doesn't scan is the
// failure that matters, so besides known answers from the spec's worked
// examples, every code here is read back by a small independent decoder:
// format bits by nearest BCH codeword, unmask, walk the zigzag, de-interleave,
// check every block's Reed-Solomon syndromes are zero, then parse byte mode.
// (During development the same matrices were also read by zxing-cpp.)

const test = require("node:test");
const assert = require("node:assert");
const qr = require("../lib/qr");

// ---------------------------------------------------------------- decoder ----

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}

function syndromesZero(block, ec) {
  // Evaluate the codeword polynomial at a^0..a^(ec-1): all zero for a valid one.
  let a = 1;
  for (let i = 0; i < ec; i++) {
    let s = 0;
    for (const b of block) s = gfMul(s, a) ^ b;
    if (s !== 0) return false;
    a = gfMul(a, 2);
  }
  return true;
}

function functionMap(size, version) {
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [r0, c0] of [[0, 0], [0, size - 8], [size - 8, 0]]) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) mark(r0 + r, c0 + c);
  }
  const pos = qr.ALIGN[version];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(pos[i] + dr, pos[j] + dc);
    }
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
  }
  return fn;
}

function decode(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1, "size is 4v+17");

  // Format: read the first copy, pick the nearest valid codeword.
  let raw = 0;
  const bitAt = (r, c) => (m[r][c] ? 1 : 0);
  const fmtCells = [];
  for (let i = 0; i <= 5; i++) fmtCells.push([i, 8]);
  fmtCells.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) fmtCells.push([8, 14 - i]);
  fmtCells.forEach(([r, c], i) => { raw |= bitAt(r, c) << i; });
  let best = null;
  for (const level of ["L", "M"]) {
    for (let mask = 0; mask < 8; mask++) {
      let d = qr.formatBits(level, mask) ^ raw, n = 0;
      while (d) { n += d & 1; d >>>= 1; }
      if (!best || n < best.n) best = { level, mask, n };
    }
  }
  assert.strictEqual(best.n, 0, "format bits are an exact BCH codeword");

  const fn = functionMap(size, version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const r = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        bits.push(m[r][c] !== qr.MASKS[best.mask](r, c) ? 1 : 0);
      }
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const { total } = qr.VERSIONS[version];
  assert.strictEqual(words.length, total, "codeword count matches the version");

  // De-interleave.
  const [ec, groups] = qr.VERSIONS[version][best.level];
  const lens = groups.flatMap(([count, len]) => new Array(count).fill(len));
  const blocks = lens.map(() => ({ d: [], e: [] }));
  let k = 0;
  const maxLen = Math.max(...lens);
  for (let i = 0; i < maxLen; i++) blocks.forEach((b, bi) => { if (i < lens[bi]) b.d.push(words[k++]); });
  for (let i = 0; i < ec; i++) blocks.forEach((b) => b.e.push(words[k++]));
  for (const b of blocks) assert.ok(syndromesZero([...b.d, ...b.e], ec), "Reed-Solomon syndromes are zero");

  // Byte mode.
  const data = blocks.flatMap((b) => b.d);
  const dbits = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >>> i) & 1));
  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++]; return v; };
  assert.strictEqual(take(4), 0b0100, "byte mode");
  const len = take(version <= 9 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return { text: Buffer.from(out).toString("utf8"), version, level: best.level, mask: best.mask };
}

// ------------------------------------------------------------------ tests ----

test("Reed-Solomon matches the spec's worked example (HELLO WORLD, 1-M)", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepStrictEqual(qr.rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format and version information match the spec's tables", () => {
  assert.strictEqual(qr.formatBits("M", 0), 0b101010000010010);
  assert.strictEqual(qr.formatBits("L", 4), 0b110011000101111);
  assert.strictEqual(qr.versionBits(7), 0b000111110010010100);
});

test("an /rc link fits a small code that a terminal can show", () => {
  const link = "https://arcflare.net/remote#k=afrc_" + "x".repeat(32);
  const m = qr.encode(link);
  assert.ok(m.version <= 5, `version ${m.version}`);
  const lines = qr.toTerminal(m).split("\n");
  assert.ok(lines.every((l) => [...l].length <= 45), "at most 45 columns");
  assert.strictEqual(lines.length, Math.ceil((m.length + 4) / 2), "two module rows per line");
  assert.strictEqual(decode(m).text, link);
});

test("finder and timing patterns are where a scanner looks for them", () => {
  const m = qr.encode("arcflare");
  const n = m.length;
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const d = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        assert.strictEqual(m[r0 + r][c0 + c], d !== 2, `finder at ${r0},${c0}`);
      }
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    assert.strictEqual(m[6][i], i % 2 === 0);
    assert.strictEqual(m[i][6], i % 2 === 0);
  }
  assert.strictEqual(m[n - 8][8], true, "the dark module");
});

test("every version 1-10 and every mask decodes back to the input", () => {
  const seen = new Set();
  for (const n of [1, 12, 20, 30, 40, 50, 70, 90, 110, 140, 170, 200, 230, 260, 270]) {
    const s = Array.from({ length: n }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789:/#._-"[(i * 7 + n) % 42]).join("");
    for (let mask = 0; mask < 8; mask++) {
      const m = qr.encode(s, { mask });
      const d = decode(m);
      assert.strictEqual(d.text, s);
      assert.strictEqual(d.mask, mask);
      seen.add(m.version);
    }
  }
  for (let v = 1; v <= 10; v++) assert.ok(seen.has(v), `covered version ${v}`);
});

test("UTF-8 survives, and text that is too long says so", () => {
  assert.strictEqual(decode(qr.encode("ünïcödé ✓")).text, "ünïcödé ✓");
  assert.throws(() => qr.encode("x".repeat(400)), /too long/);
});

test("the penalty picks a mask, and the chosen mask is the one in the format bits", () => {
  const m = qr.encode("https://arcflare.net/remote");
  assert.ok(m.mask >= 0 && m.mask < 8);
  assert.strictEqual(decode(m).mask, m.mask);
});

test("terminal rendering: inverted for dark terminals, explicit colours otherwise", () => {
  const m = qr.encode("hi");
  const plain = qr.toTerminal(m, { color: false, invert: true });
  assert.ok(!plain.includes("\x1b["), "no escapes without colour");
  // The quiet zone is light, so inverted it is drawn: the first line is solid.
  assert.match(plain.split("\n")[0], /^█+$/);
  const colored = qr.toTerminal(m, { color: true });
  assert.ok(colored.split("\n").every((l) => l.startsWith("\x1b[38;5;16;48;5;231m") && l.endsWith("\x1b[0m")));
});

test("SVG has one path and a white background", () => {
  const svg = qr.toSvg(qr.encode("hi"));
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.strictEqual((svg.match(/<path /g) || []).length, 1);
  assert.match(svg, /<rect [^>]*fill="#fff"/);
});
