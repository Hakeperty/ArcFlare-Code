// Writes the notification sounds in android/app/src/main/res/raw: short sine chimes made here, so they are ours
// (no third-party audio, nothing to license). Run once after changing a tune: node scripts/make-sounds.js
const fs = require("fs");
const path = require("path");

const RATE = 22050;
const NOTE = { C5: 523.25, E5: 659.25, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568 };
const TUNES = {
  af_commit: ["C6", "E6"],        // two notes up: something was saved
  af_push: ["C6", "E6", "G6"],    // three notes up: it left the computer
  af_done: ["A5"],                // one chime
  af_failed: ["E5", "C5"],        // two notes down
};

function wav(notes) {
  const step = 0.14, tail = 0.45;
  const n = Math.round((step * (notes.length - 1) + tail) * RATE);
  const pcm = new Float32Array(n);
  notes.forEach((name, i) => {
    const f = NOTE[name], start = Math.round(i * step * RATE);
    for (let j = 0; start + j < n; j++) {
      const t = j / RATE;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 7);
      pcm[start + j] += 0.35 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
    }
  });
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return buf;
}

const out = path.join(__dirname, "..", "android", "app", "src", "main", "res", "raw");
fs.mkdirSync(out, { recursive: true });
for (const [name, notes] of Object.entries(TUNES)) fs.writeFileSync(path.join(out, name + ".wav"), wav(notes));
