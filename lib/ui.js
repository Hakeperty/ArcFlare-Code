// Terminal UI helpers: colours, an arrow-key select menu, and a spinner.
// Zero dependencies. Honors NO_COLOR and degrades gracefully off a TTY.

const readline = require("readline");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  accent: wrap("38;5;214"), // amber
  green: wrap("38;5;42"),
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("38;5;203"),
  cyan: wrap("38;5;45"),
  grey: wrap("38;5;245"),
  inverse: wrap("7"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner() {
  return [
    "",
    `  ${c.bold("ArcFlare")} ${c.dim("·")} ${c.accent("local models, any harness")}`,
    "",
  ].join("\n");
}

function fmtBytes(n) {
  if (!n && n !== 0) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

function fmtTokens(n) {
  if (!n) return "?";
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

/**
 * Arrow-key select menu.
 * items: [{ label, hint, value, disabled, note }]
 * Returns the chosen item's value, or null if cancelled (Esc / Ctrl-C / q).
 */
function select(title, items, opts = {}) {
  const choosable = items.filter((i) => !i.disabled);
  if (!choosable.length) return Promise.resolve(null);

  // Non-interactive: take the default without drawing anything.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve(choosable[0].value);
  }

  return new Promise((resolve) => {
    let idx = items.findIndex((i) => !i.disabled);
    if (opts.selected != null) {
      const want = items.findIndex((i) => i.value === opts.selected && !i.disabled);
      if (want >= 0) idx = want;
    }
    let drawn = 0;

    const render = () => {
      if (drawn) readline.moveCursor(process.stdout, 0, -drawn);
      let out = "";
      out += `  ${c.bold(title)}\n`;
      if (opts.subtitle) out += `  ${c.dim(opts.subtitle)}\n`;
      out += "\n";
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const active = i === idx;
        const cursor = active ? c.accent("❯") : " ";
        let label = it.disabled ? c.dim(it.label) : active ? c.accent(it.label) : it.label;
        let line = `  ${cursor} ${label}`;
        if (it.hint) line += ` ${c.dim(it.hint)}`;
        if (it.note) line += ` ${c.grey(it.note)}`;
        readline.clearLine(process.stdout, 0);
        out += line + "\n";
      }
      out += "\n";
      out += `  ${c.dim("↑/↓ move · enter select · esc cancel")}\n`;
      // Clear each line as we go to avoid leftovers from longer previous frames.
      process.stdout.write("\x1b[0J" + out);
      drawn = out.split("\n").length - 1;
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      if (drawn) {
        readline.moveCursor(process.stdout, 0, -drawn);
        process.stdout.write("\x1b[0J");
      }
    };

    const step = (dir) => {
      for (let n = 0; n < items.length; n++) {
        idx = (idx + dir + items.length) % items.length;
        if (!items[idx].disabled) break;
      }
      render();
    };

    const onData = (buf) => {
      const k = buf.toString();
      if (k === "" || k === "" || k === "q") { cleanup(); return resolve(null); }
      if (k === "\r" || k === "\n") {
        const it = items[idx];
        if (it.disabled) return;
        cleanup();
        return resolve(it.value);
      }
      if (k === "[A" || k === "k") return step(-1);
      if (k === "[B" || k === "j") return step(1);
      // number shortcuts 1-9
      const n = parseInt(k, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= items.length && !items[n - 1].disabled) {
        idx = n - 1;
        const it = items[idx];
        render();
        cleanup();
        return resolve(it.value);
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinner(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${label}\n`);
    return { update() {}, stop() {} };
  }
  let i = 0;
  let text = label;
  const tick = () => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`  ${c.accent(FRAMES[i++ % FRAMES.length])} ${text}`);
  };
  const t = setInterval(tick, 80);
  tick();
  return {
    update(next) { text = next; },
    stop(final) {
      clearInterval(t);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      if (final) process.stdout.write(`  ${final}\n`);
    },
  };
}

/** Single-line free-text prompt. Returns "" if cancelled. */
function ask(question, def = "") {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? c.dim(` (${def})`) : "";
  return new Promise((resolve) => {
    rl.question(`  ${c.bold(question)}${suffix}: `, (a) => {
      rl.close();
      resolve((a || "").trim() || def);
    });
  });
}

module.exports = { c, useColor, sleep, banner, select, spinner, ask, fmtBytes, fmtTokens };
