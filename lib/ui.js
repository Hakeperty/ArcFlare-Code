// Terminal UI helpers: colours, an arrow-key select menu, and a spinner.
// Zero dependencies. Honors NO_COLOR and degrades gracefully off a TTY.

const readline = require("readline");

// NO_COLOR wins; FORCE_COLOR turns colour on for a pipe (handy for capturing
// output with its colours); otherwise colour follows whether this is a TTY.
const forced = process.env.FORCE_COLOR !== undefined && !["0", "false"].includes(process.env.FORCE_COLOR);
const useColor = !process.env.NO_COLOR && (forced || !!process.stdout.isTTY);
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// The arcflare.net palette: amber for what matters, teal for ok and status,
// dim for labels. `green` stays as the name the code already uses for "ok".
const c = {
  accent: wrap("38;5;214"), // amber
  green: wrap("38;5;43"),   // teal, the site's status colour
  teal: wrap("38;5;43"),
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("38;5;203"),
  cyan: wrap("38;5;45"),
  grey: wrap("38;5;245"),
  inverse: wrap("7"),
};

// Symbols. The old Windows console (conhost with Consolas) draws check marks,
// arrows and braille as empty boxes, so there - and only on a real terminal,
// so piped output and tests stay the same everywhere - fall back to glyphs
// every console font has. Windows Terminal and VS Code set WT_SESSION /
// TERM_PROGRAM and get the real thing.
const legacyConsole = process.platform === "win32" && !!process.stdout.isTTY
  && !process.env.WT_SESSION && !process.env.TERM_PROGRAM && !process.env.ARCFLARE_UNICODE;
const sym = legacyConsole
  ? { ok: "√", fail: "x", warn: "!", dot: "·", arrow: "->", prompt: ">", bar: "-", vbar: "|", up: "^", busy: "*" }
  : { ok: "✓", fail: "✗", warn: "!", dot: "·", arrow: "→", prompt: "❯", bar: "─", vbar: "│", up: "↑", busy: "●" };

/** Printable width of a string: ANSI colour codes take no space. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const width = (s) => String(s).replace(ANSI, "").length;
const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - width(s)));
const cols = () => Math.max(40, Math.min(process.stdout.columns || 80, 100));

/** Cut to `n` printable columns, ending with an ellipsis. Colour codes kept. */
function trunc(s, n) {
  s = String(s);
  if (width(s) <= n) return s;
  let out = "", w = 0;
  for (let i = 0; i < s.length;) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m && m.index === i) { out += m[0]; i += m[0].length; continue; }
    if (w >= n - 1) break;
    out += s[i++]; w++;
  }
  return out + "…" + (useColor ? "\x1b[0m" : "");
}

/**
 * A section heading the way the website writes them:
 *   ── MODELS ────────────────────────── 6 found
 */
function section(title, right = "") {
  const w = cols() - 4;
  const left = `${c.dim(sym.bar.repeat(2))} ${c.accent(String(title).toUpperCase())} `;
  const tail = right ? ` ${c.dim(right)}` : "";
  const fill = Math.max(2, w - width(left) - width(tail));
  return `  ${left}${c.dim(sym.bar.repeat(fill))}${tail}`;
}

/** A thin rule across the usable width. */
const rule = () => `  ${c.dim(sym.bar.repeat(cols() - 4))}`;

/**
 * Rows of cells as aligned columns. Each column is padded to its widest cell;
 * the last column is left ragged. `gap` spaces between columns.
 */
function table(rows, { gap = 2, indent = 2 } = {}) {
  const widths = [];
  for (const r of rows) r.forEach((cell, i) => { if (i < r.length - 1) widths[i] = Math.max(widths[i] || 0, width(cell)); });
  // The last column takes whatever room is left and is cut to it, so a long
  // path never runs off the edge of a narrow terminal.
  return rows.map((r) => {
    const lead = " ".repeat(indent) + r.slice(0, -1).map((cell, i) => pad(cell, widths[i] + gap)).join("");
    const room = Math.max(12, cols() - width(lead));
    return lead + trunc(r[r.length - 1], room);
  }).join("\n");
}

/** "label ······ value" rows, labels dimmed and aligned. */
function kv(pairs, { indent = 2 } = {}) {
  const w = Math.max(...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => `${" ".repeat(indent)}${c.dim(pad(k, w))}  ${v}`).join("\n");
}

/** Milliseconds as "820ms", "4.2s", "1m 05s". */
function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Named so the control bytes never have to appear literally in the source.
const KEY = {
  CTRL_C: "",
  ESC: "",
  UP: "[A",
  DOWN: "[B",
  CR: "\r",
  LF: "\n",
};

function banner(right = "") {
  const v = (() => { try { return require("../package.json").version; } catch { return ""; } })();
  const left = `${c.accent("arcflare")}${c.dim("_")}  ${c.dim(`v${v}`)}`;
  const tag = c.dim("local models, any harness");
  const w = cols() - 4;
  const gapN = w - width(left) - width(tag) - (right ? width(right) + 3 : 0);
  const line = gapN >= 2
    ? `  ${left}${" ".repeat(gapN)}${tag}${right ? `${c.dim(" " + sym.dot + " ")}${right}` : ""}`
    : `  ${left}  ${tag}`;
  return ["", line, rule(), ""].join("\n");
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
 *
 * items: [{ label, hint, note, value, disabled }]
 * opts:  { subtitle, selected, stdin, stdout }
 *
 * Returns the chosen value, or null if cancelled (Esc / Ctrl-C / q).
 * Streams are injectable so the interactive path is testable without a
 * terminal — hijacking the real process.stdout swallows a test reporter's own
 * output, which is exactly the sort of thing that makes interactive UI go
 * untested.
 */
function select(title, items, opts = {}) {
  const choosable = items.filter((i) => !i.disabled);
  if (!choosable.length) return Promise.resolve(null);

  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;

  // Non-interactive: take the default without drawing anything.
  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(choosable[0].value);
  }

  return new Promise((resolve) => {
    let idx = items.findIndex((i) => !i.disabled);
    if (opts.selected != null) {
      const want = items.findIndex((i) => i.value === opts.selected && !i.disabled);
      if (want >= 0) idx = want;
    }
    let drawn = 0;
    // Long lists scroll: only a window of rows is drawn, sized to the terminal,
    // with a count of what is above and below. Drawing 56 models into a
    // 30-row terminal scrolls the frame off the top and redraws garbage.
    const page = Math.max(5, opts.pageSize || ((stdout.rows || 30) - 9 - (opts.subtitle ? 1 : 0)));
    let top = 0;

    const render = () => {
      if (drawn) readline.moveCursor(stdout, 0, -drawn);
      let out = `  ${c.bold(title)}\n`;
      if (opts.subtitle) out += `  ${c.dim(opts.subtitle)}\n`;
      out += "\n";
      const paged = items.length > page;
      if (paged) {
        if (idx < top) top = idx;
        if (idx >= top + page) top = idx - page + 1;
        out += `  ${c.dim(top > 0 ? `↑ ${top} more` : " ")}\n`;
      }
      const from = paged ? top : 0;
      const to = paged ? Math.min(items.length, top + page) : items.length;
      for (let i = from; i < to; i++) {
        const it = items[i];
        const active = i === idx;
        const cursor = active ? c.accent(sym.prompt) : " ";
        const label = it.disabled
          ? c.dim(it.label)
          : active ? c.accent(it.label) : it.label;
        // Never lean on colour alone to separate a label from its hint. With
        // NO_COLOR set (or any monochrome terminal) "ArcFlare chat built in"
        // reads as one phrase, so bracket the secondary text instead.
        let line = `  ${cursor} ${label}`;
        if (it.hint) line += useColor ? ` ${c.dim(it.hint)}` : ` (${it.hint})`;
        if (it.note) line += useColor ? ` ${c.grey(it.note)}` : `  - ${it.note}`;
        out += line + "\n";
      }
      if (paged) out += `  ${c.dim(to < items.length ? `↓ ${items.length - to} more` : " ")}\n`;
      out += "\n";
      out += `  ${c.dim("up/down move · enter select · esc cancel")}\n`;
      // Clear to end of screen first so a shorter frame cannot leave debris.
      stdout.write("\x1b[0J" + out);
      drawn = out.split("\n").length - 1;
    };

    const cleanup = () => {
      if (stdin.setRawMode) stdin.setRawMode(false);
      if (stdin.pause) stdin.pause();
      stdin.removeListener("data", onData);
      if (drawn) {
        readline.moveCursor(stdout, 0, -drawn);
        stdout.write("\x1b[0J");
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
      if (k === KEY.CTRL_C || k === KEY.ESC || k === "q") {
        cleanup();
        return resolve(null);
      }
      if (k === KEY.CR || k === KEY.LF) {
        const it = items[idx];
        if (it.disabled) return;
        cleanup();
        return resolve(it.value);
      }
      if (k === KEY.UP || k === "k") return step(-1);
      if (k === KEY.DOWN || k === "j") return step(1);
      const n = parseInt(k, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= items.length && !items[n - 1].disabled) {
        idx = n - 1;
        render();
        cleanup();
        return resolve(items[idx].value);
      }
    };

    if (stdin.setRawMode) stdin.setRawMode(true);
    if (stdin.resume) stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

const FRAMES = legacyConsole
  ? ["|", "/", "-", "\\"]
  : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinner(label, stream) {
  const stdout = stream || process.stdout;
  if (!stdout.isTTY) {
    stdout.write(`  ${label}\n`);
    return { update() {}, stop(final) { if (final) stdout.write(`  ${final}\n`); } };
  }
  let i = 0;
  let text = label;
  const tick = () => {
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
    stdout.write(`  ${c.accent(FRAMES[i++ % FRAMES.length])} ${trunc(text, cols() - 6)}`);
  };
  const t = setInterval(tick, 80);
  tick();
  return {
    update(next) { text = next; },
    stop(final) {
      clearInterval(t);
      readline.clearLine(stdout, 0);
      readline.cursorTo(stdout, 0);
      if (final) stdout.write(`  ${final}\n`);
    },
  };
}

/** Single-line free-text prompt. Returns the default if cancelled. */
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

module.exports = {
  c, useColor, sym, sleep, banner, select, spinner, ask, fmtBytes, fmtTokens, fmtMs, KEY,
  width, pad, trunc, cols, section, rule, table, kv,
};
