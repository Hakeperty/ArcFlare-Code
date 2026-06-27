// Small terminal UI helpers — colors, a progress bar, and the banner.
// No dependencies; honors NO_COLOR.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  accent: wrap("38;5;214"), // amber
  green: wrap("38;5;42"),
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("38;5;203"),
  cyan: wrap("38;5;45"),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Animate a filling progress bar in place, e.g. "Downloading weights █████░ 62%". */
async function progress(label, durationMs = 1100, width = 22) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${label}... done\n`);
    return;
  }
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const pct = Math.round((i / steps) * 100);
    const filled = Math.round((i / steps) * width);
    const bar = c.accent("█".repeat(filled)) + c.dim("░".repeat(width - filled));
    process.stdout.write(`\r  ${label} ${bar} ${String(pct).padStart(3)}%`);
    await sleep(durationMs / steps);
  }
  process.stdout.write("\n");
}

async function step(label, ms = 450) {
  process.stdout.write(`  ${c.dim(label)}\n`);
  await sleep(ms);
}

function banner() {
  const a = c.accent;
  return [
    "",
    `  ${c.bold("ArcFlare")} ${c.dim("·")} ${a("run open AI models")}`,
    `  ${c.dim("(•ᴥ•)つ✦")}`,
    "",
  ].join("\n");
}

module.exports = { c, sleep, progress, step, banner, useColor };
