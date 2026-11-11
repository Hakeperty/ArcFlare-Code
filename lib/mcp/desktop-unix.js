// Eyes and hands on macOS and Linux: the same eleven functions as desktop.js
// has for Windows, built from what each system already ships or commonly has.
//
//   macOS  screencapture and sips for the picture, osascript for everything
//          else. Mouse events go through CoreGraphics from JavaScript for
//          Automation, since AppleScript has no way to click a point.
//   Linux  xdotool for the mouse, keyboard and windows; ImageMagick, scrot,
//          maim, gnome-screenshot or grim for the picture; xclip, xsel or
//          wl-clipboard for the clipboard. X11 only: a Wayland compositor does
//          not let one program type into another, so on Wayland these reach
//          XWayland windows and nothing else, and support() says so.
//
// Nothing here goes through a shell. Every value a caller supplies is an
// argument in an argv array or a line on stdin, never part of a script's text.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IS_MAC = process.platform === "darwin";
const TMP = path.join(os.tmpdir(), "arcflare-mcp");

function ensureTmp() {
  try { fs.mkdirSync(TMP, { recursive: true }); } catch {}
  return TMP;
}

const found = new Map();
/** Is this program on PATH? Remembered, since the answer does not change mid-session. */
function has(cmd) {
  if (found.has(cmd)) return found.get(cmd);
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  const ok = r.status === 0 && !!String(r.stdout).trim();
  found.set(cmd, ok);
  return ok;
}

/** Run a program, return its stdout; reject with the first line of stderr. */
function run(cmd, args, { input, timeoutMs = 30000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e.code === "ENOENT" ? new Error(`${cmd} is not installed`) : e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0) return reject(new Error(err.trim().split("\n")[0] || `${cmd} exited ${code}`));
      resolve(binary ? buf : buf.toString("utf8").trim());
    });
    if (input != null) child.stdin.end(input);
  });
}

/** Width and height from a PNG or JPEG header, so no image library is needed to report them. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

/** `KEY=value` lines (xdotool --shell) as an object of numbers. */
function shellVars(text) {
  const o = {};
  for (const line of String(text).split("\n")) {
    const m = /^([A-Z_]+)=(-?\d+)/.exec(line.trim());
    if (m) o[m[1].toLowerCase()] = Number(m[2]);
  }
  return o;
}

const chord = (combo) => String(combo).split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);

// =================================================================== Linux ====

const X_KEYS = {
  enter: "Return", return: "Return", tab: "Tab", esc: "Escape", escape: "Escape",
  backspace: "BackSpace", bs: "BackSpace", del: "Delete", delete: "Delete", space: "space",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
  pgup: "Prior", pgdn: "Next", insert: "Insert", capslock: "Caps_Lock", printscreen: "Print",
};
const X_MODS = { ctrl: "ctrl", control: "ctrl", alt: "alt", shift: "shift", win: "super", super: "super", cmd: "super", meta: "super" };

/** "ctrl+shift+p" as xdotool spells it. */
function toXdotool(combo) {
  const parts = chord(combo);
  const key = parts.pop();
  if (!key) throw new Error(`no key in "${combo}"`);
  const mods = parts.map((m) => {
    if (!X_MODS[m]) throw new Error(`unknown modifier "${m}" in "${combo}"`);
    return X_MODS[m];
  });
  let k = X_KEYS[key];
  if (!k) {
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) k = key.toUpperCase();
    else if (key.length === 1) k = key;
    else if (X_MODS[key]) k = X_MODS[key];
    else throw new Error(`unknown key "${key}" in "${combo}"`);
  }
  return [...mods, k].join("+");
}

const X_BUTTON = { left: "1", middle: "2", right: "3" };

/** The xdotool argument lists for one mouse action, in order. */
function xMouseCommands({ action = "click", x, y, to_x, to_y, button = "left", amount = 3 }) {
  const b = X_BUTTON[button] || "1";
  const at = x == null || y == null ? [] : [["mousemove", "--sync", String(x | 0), String(y | 0)]];
  switch (action) {
    case "move": return at;
    case "click": return [...at, ["click", b]];
    case "double": return [...at, ["click", "--repeat", "2", "--delay", "80", b]];
    case "down": return [...at, ["mousedown", b]];
    case "up": return [...at, ["mouseup", b]];
    case "drag": {
      // In steps, as on Windows: a jump between press and release reads as a click.
      const steps = [];
      for (let i = 1; i <= 20; i++) {
        steps.push(["mousemove", String(Math.round((x | 0) + ((to_x | 0) - (x | 0)) * i / 20)), String(Math.round((y | 0) + ((to_y | 0) - (y | 0)) * i / 20))]);
      }
      return [...at, ["mousedown", b], ...steps, ["mouseup", b]];
    }
    case "scroll": {
      const n = Number(amount) || 3;
      return [...at, ["click", "--repeat", String(Math.abs(n)), "--delay", "20", n > 0 ? "4" : "5"]];
    }
    default: throw new Error(`unknown mouse action "${action}"`);
  }
}

const linux = {
  support() {
    const wayland = (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
    if (!process.env.DISPLAY) {
      return { ok: false, how: wayland
        ? "Linux on Wayland with no X display: one program cannot see or type into another here. Log in to an X11 session to use desktop control"
        : "no display: this machine has no graphical session to control (DISPLAY is not set)" };
    }
    if (!has("xdotool")) return { ok: false, how: "desktop control on Linux needs xdotool (sudo apt install xdotool, or your distribution's package)" };
    return { ok: true, how: "xdotool (X11)", note: wayland ? "Wayland session: only XWayland windows respond" : null };
  },

  /** Which helper programs the screenshot and clipboard tools would use here, or null where none is installed. */
  helpers() {
    const wayland = !!process.env.WAYLAND_DISPLAY;
    return {
      screenshot: ["import", "maim", "scrot", "grim", "gnome-screenshot"].find(has) || null,
      clipboard: (wayland && has("wl-paste") ? "wl-clipboard" : null) || ["xclip", "xsel"].find(has) || null,
    };
  },

  async screenRect() {
    const [w, h] = (await run("xdotool", ["getdisplaygeometry"])).split(/\s+/).map(Number);
    return { x: 0, y: 0, width: w, height: h };
  },

  async windowRect(title) {
    const ids = (await run("xdotool", ["search", "--onlyvisible", "--name", String(title)]).catch(() => "")).split("\n").filter(Boolean);
    if (!ids.length) throw new Error(`no window matching '${title}'`);
    const g = shellVars(await run("xdotool", ["getwindowgeometry", "--shell", ids[0]]));
    return { id: ids[0], x: g.x, y: g.y, width: g.width, height: g.height };
  },

  /** Write a PNG of `rect` (or the whole screen) to `file`. */
  async grab(file, rect, full) {
    const geo = rect ? `${rect.width}x${rect.height}+${rect.x}+${rect.y}` : null;
    if (has("import")) {
      await run("import", ["-silent", "-window", "root", ...(geo && !full ? ["-crop", geo, "+repage"] : []), file], { timeoutMs: 60000 });
    } else if (has("maim")) {
      await run("maim", [...(geo && !full ? ["-g", geo] : []), file], { timeoutMs: 60000 });
    } else if (has("scrot")) {
      await run("scrot", ["-o", ...(geo && !full ? ["-a", `${rect.x},${rect.y},${rect.width},${rect.height}`] : []), file], { timeoutMs: 60000 });
    } else if (has("grim")) {
      await run("grim", [...(geo && !full ? ["-g", `${rect.x},${rect.y} ${rect.width}x${rect.height}`] : []), file], { timeoutMs: 60000 });
    } else if (has("gnome-screenshot")) {
      await run("gnome-screenshot", ["-f", file], { timeoutMs: 60000 });
      if (geo && !full && has("convert")) await run("convert", [file, "-crop", geo, "+repage", file]);
    } else {
      throw new Error("no screenshot program found: install ImageMagick, maim, scrot or gnome-screenshot");
    }
  },

  /** Shrink and/or convert in place; returns the file it ended up in. */
  async resize(file, width, jpeg) {
    if (!has("convert")) return file;   // full size PNG: still correct, only larger
    const out = jpeg ? file.replace(/\.png$/, ".jpg") : file;
    await run("convert", [file, ...(width ? ["-resize", `${width}x`] : []), out]);
    if (out !== file) { try { fs.unlinkSync(file); } catch {} }
    return out;
  },

  async mouse(a) {
    for (const cmd of xMouseCommands(a)) await run("xdotool", cmd);
    return linux.cursor();
  },

  async cursor() {
    const v = shellVars(await run("xdotool", ["getmouselocation", "--shell"]));
    return { x: v.x, y: v.y };
  },

  async typeText(text, { delay_ms = 0 } = {}) {
    // Line by line, pressing Return between: `xdotool type` sends a newline as
    // a keysym some toolkits ignore.
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await run("xdotool", ["type", "--clearmodifiers", "--delay", "6", "--", lines[i]], { timeoutMs: 120000 });
      if (i < lines.length - 1) await run("xdotool", ["key", "--clearmodifiers", "Return"]);
    }
    if (delay_ms) await new Promise((r) => setTimeout(r, delay_ms));
    return { sent: String(text).length };
  },

  async pressKeys(combos, { delay_ms = 60 } = {}) {
    const keys = [].concat(combos).map(toXdotool);
    for (const k of keys) {
      await run("xdotool", ["key", "--clearmodifiers", k]);
      await new Promise((r) => setTimeout(r, delay_ms));
    }
    return { pressed: keys };
  },

  async listWindows() {
    const ids = (await run("xdotool", ["search", "--onlyvisible", "--name", ""]).catch(() => "")).split("\n").filter(Boolean).slice(0, 80);
    const out = [];
    for (const id of ids) {
      try {
        const title = await run("xdotool", ["getwindowname", id]);
        if (!title) continue;
        const g = shellVars(await run("xdotool", ["getwindowgeometry", "--shell", id]));
        const pid = Number(await run("xdotool", ["getwindowpid", id]).catch(() => "0")) || 0;
        let name = "";
        try { name = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch {}
        out.push({ pid, name, title, x: g.x, y: g.y, width: g.width, height: g.height });
      } catch { /* a window that closed while we were asking */ }
    }
    return out;
  },

  async focusWindow(title) {
    const ids = (await run("xdotool", ["search", "--onlyvisible", "--name", String(title)]).catch(() => "")).split("\n").filter(Boolean);
    const named = [];
    for (const id of ids) {
      const t = await run("xdotool", ["getwindowname", id]).catch(() => "");
      if (t) named.push({ id, title: t });
    }
    if (!named.length) throw new Error(`no window matching '${title}'`);
    const w = named[0];
    // windowactivate asks the window manager, which is the polite way; with no
    // window manager to ask (a bare X server), focus and raise it directly.
    try { await run("xdotool", ["windowactivate", "--sync", w.id], { timeoutMs: 5000 }); }
    catch { await run("xdotool", ["windowfocus", w.id]).catch(() => {}); await run("xdotool", ["windowraise", w.id]).catch(() => {}); }
    const front = await run("xdotool", ["getwindowfocus"]).catch(() => "");
    const pid = Number(await run("xdotool", ["getwindowpid", w.id]).catch(() => "0")) || 0;
    let name = "";
    try { name = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch {}
    return { pid, title: w.title, name, focused: front === w.id, others: named.slice(1).map((x) => x.title) };
  },

  async clipboardGet() {
    if (process.env.WAYLAND_DISPLAY && has("wl-paste")) return run("wl-paste", ["--no-newline"]).catch(() => "");
    if (has("xclip")) return run("xclip", ["-selection", "clipboard", "-o"]).catch(() => "");
    if (has("xsel")) return run("xsel", ["--clipboard", "--output"]).catch(() => "");
    throw new Error("the clipboard needs xclip, xsel or wl-clipboard installed");
  },

  async clipboardSet(text) {
    const s = String(text);
    if (process.env.WAYLAND_DISPLAY && has("wl-copy")) await run("wl-copy", [], { input: s });
    else if (has("xclip")) {
      // xclip stays alive to serve the selection; do not wait for it to exit.
      await new Promise((resolve, reject) => {
        const child = spawn("xclip", ["-selection", "clipboard", "-i"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
        child.on("error", reject);
        child.stdin.end(s, () => { child.unref(); setTimeout(resolve, 80); });
      });
    } else if (has("xsel")) await run("xsel", ["--clipboard", "--input"], { input: s });
    else throw new Error("the clipboard needs xclip, xsel or wl-clipboard installed");
    return { bytes: Buffer.byteLength(s) };
  },
};

// =================================================================== macOS ====

const MAC_KEYCODES = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, bs: 51, esc: 53, escape: 53,
  del: 117, delete: 117, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119,
  pgup: 116, pgdn: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};
const MAC_MODS = {
  ctrl: "control down", control: "control down", alt: "option down", option: "option down",
  shift: "shift down", cmd: "command down", command: "command down", win: "command down", meta: "command down",
};

/** One chord as the arguments the keystroke script takes: [kind, value, modifiers]. */
function toMacKey(combo) {
  const parts = chord(combo);
  const key = parts.pop();
  if (!key) throw new Error(`no key in "${combo}"`);
  const mods = parts.map((m) => {
    if (!MAC_MODS[m]) throw new Error(`unknown modifier "${m}" in "${combo}"`);
    return MAC_MODS[m];
  });
  if (MAC_KEYCODES[key] != null) return ["code", String(MAC_KEYCODES[key]), mods.join(",")];
  if (key.length === 1) return ["char", key, mods.join(",")];
  throw new Error(`unknown key "${key}" in "${combo}"`);
}

// Takes: kind ("code" | "char"), value, comma-separated modifiers.
const MAC_KEY_SCRIPT = `on run argv
  set kind to item 1 of argv
  set v to item 2 of argv
  set mods to {}
  if (count of argv) > 2 then
    set AppleScript's text item delimiters to ","
    repeat with m in (text items of (item 3 of argv))
      if m as text is "control down" then set end of mods to control down
      if m as text is "option down" then set end of mods to option down
      if m as text is "shift down" then set end of mods to shift down
      if m as text is "command down" then set end of mods to command down
    end repeat
  end if
  tell application "System Events"
    if kind is "code" then
      key code (v as integer) using mods
    else
      keystroke v using mods
    end if
  end tell
end run`;

const MAC_TYPE_SCRIPT = `on run argv
  tell application "System Events" to keystroke (item 1 of argv)
end run`;

// Mouse through CoreGraphics. argv: action, x, y, toX, toY, button, amount.
const MAC_MOUSE_JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  var action = argv[0], x = Number(argv[1]), y = Number(argv[2]), tx = Number(argv[3]), ty = Number(argv[4]);
  var button = argv[5], amount = Number(argv[6]) || 3;
  var B = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] }[button] || [1, 2, 6, 0];
  function here() { var p = $.CGEventGetLocation($.CGEventCreate(null)); return { x: p.x, y: p.y }; }
  if (isNaN(x) || isNaN(y)) { var p = here(); x = p.x; y = p.y; }
  function post(type, px, py, clicks) {
    var e = $.CGEventCreateMouseEvent(null, type, { x: px, y: py }, B[3]);
    if (clicks) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks);
    $.CGEventPost($.kCGHIDEventTap, e);
    delay(0.02);
  }
  post(5, x, y);
  if (action === 'click') { post(B[0], x, y, 1); post(B[1], x, y, 1); }
  else if (action === 'double') { post(B[0], x, y, 1); post(B[1], x, y, 1); post(B[0], x, y, 2); post(B[1], x, y, 2); }
  else if (action === 'down') post(B[0], x, y, 1);
  else if (action === 'up') post(B[1], x, y, 1);
  else if (action === 'drag') {
    post(B[0], x, y, 1);
    for (var i = 1; i <= 20; i++) post(B[2], x + (tx - x) * i / 20, y + (ty - y) * i / 20);
    post(B[1], tx, ty, 1);
  } else if (action === 'scroll') {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent2(null, 1, 1, amount, 0, 0));
  }
  var at = here();
  return JSON.stringify({ x: Math.round(at.x), y: Math.round(at.y) });
}`;

const MAC_SCREEN_JXA = `ObjC.import('CoreGraphics');
function run() {
  var b = $.CGDisplayBounds($.CGMainDisplayID());
  return JSON.stringify({ x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height });
}`;

const MAC_WINDOWS_JXA = `function run() {
  var se = Application('System Events'), out = [];
  se.processes.whose({ backgroundOnly: false })().forEach(function (p) {
    try {
      p.windows().forEach(function (w) {
        var pos = w.position(), sz = w.size();
        out.push({ pid: p.unixId(), name: p.name(), title: w.name() || '', x: pos[0], y: pos[1], width: sz[0], height: sz[1] });
      });
    } catch (e) {}
  });
  return JSON.stringify(out);
}`;

const MAC_FOCUS_JXA = `function run(argv) {
  var want = String(argv[0]).toLowerCase(), se = Application('System Events'), hits = [];
  se.processes.whose({ backgroundOnly: false })().forEach(function (p) {
    try { p.windows().forEach(function (w) { var t = w.name() || ''; if (t.toLowerCase().indexOf(want) >= 0) hits.push({ p: p, w: w, t: t }); }); } catch (e) {}
  });
  if (!hits.length) throw new Error("no window matching '" + argv[0] + "'");
  var h = hits[0];
  h.p.frontmost = true;
  try { h.w.actions['AXRaise'].perform(); } catch (e) {}
  delay(0.25);
  return JSON.stringify({ pid: h.p.unixId(), title: h.t, name: h.p.name(), focused: h.p.frontmost(),
    others: hits.slice(1).map(function (x) { return x.t; }) });
}`;

const MAC_PERMISSION = "macOS blocked this. Allow the app running ArcFlare (Terminal, or ArcFlare itself) under " +
  "System Settings → Privacy & Security → Accessibility, and Screen Recording for screenshots, then try again";

async function osa(script, args = [], { jxa = false } = {}) {
  try {
    return await run("osascript", [...(jxa ? ["-l", "JavaScript"] : []), "-e", script, "--", ...args.map(String)]);
  } catch (e) {
    if (/not allowed|assistive|-1719|-25211|1002|not authori/i.test(e.message)) throw new Error(MAC_PERMISSION);
    throw e;
  }
}

const mac = {
  support() { return { ok: true, how: "screencapture + osascript", note: "needs Accessibility and Screen Recording permission" }; },

  async screenRect() { return JSON.parse(await osa(MAC_SCREEN_JXA, [], { jxa: true })); },

  async windowRect(title) {
    const all = await mac.listWindows();
    const w = all.find((x) => String(x.title).toLowerCase().includes(String(title).toLowerCase()));
    if (!w) throw new Error(`no window matching '${title}'`);
    return w;
  },

  async grab(file, rect, full) {
    await run("screencapture", ["-x", "-t", "png", ...(rect && !full ? ["-R", `${rect.x},${rect.y},${rect.width},${rect.height}`] : []), file], { timeoutMs: 60000 });
    if (!fs.existsSync(file)) throw new Error(MAC_PERMISSION);
  },

  async resize(file, width, jpeg) {
    if (width) await run("sips", ["--resampleWidth", String(width), file]);
    if (!jpeg) return file;
    const out = file.replace(/\.png$/, ".jpg");
    await run("sips", ["-s", "format", "jpeg", file, "--out", out]);
    try { fs.unlinkSync(file); } catch {}
    return out;
  },

  async mouse({ action = "click", x, y, to_x, to_y, button = "left", amount = 3 }) {
    if (!["move", "click", "double", "down", "up", "drag", "scroll"].includes(action)) throw new Error(`unknown mouse action "${action}"`);
    const n = (v) => (v == null ? "NaN" : String(v | 0));
    return JSON.parse(await osa(MAC_MOUSE_JXA, [action, n(x), n(y), n(to_x), n(to_y), button, String(Number(amount) || 3)], { jxa: true }));
  },

  async cursor() { return mac.mouse({ action: "move" }); },

  async typeText(text, { delay_ms = 0 } = {}) {
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await osa(MAC_TYPE_SCRIPT, [lines[i]]);
      if (i < lines.length - 1) await osa(MAC_KEY_SCRIPT, ["code", "36", ""]);
    }
    if (delay_ms) await new Promise((r) => setTimeout(r, delay_ms));
    return { sent: String(text).length };
  },

  async pressKeys(combos, { delay_ms = 60 } = {}) {
    const list = [].concat(combos);
    const keys = list.map(toMacKey);
    for (const k of keys) {
      await osa(MAC_KEY_SCRIPT, k);
      await new Promise((r) => setTimeout(r, delay_ms));
    }
    return { pressed: list.map(String) };
  },

  async listWindows() { return JSON.parse(await osa(MAC_WINDOWS_JXA, [], { jxa: true }) || "[]"); },
  async focusWindow(title) { return JSON.parse(await osa(MAC_FOCUS_JXA, [title], { jxa: true })); },
  async clipboardGet() { return run("pbpaste", []); },
  async clipboardSet(text) { await run("pbcopy", [], { input: String(text) }); return { bytes: Buffer.byteLength(String(text)) }; },
};

// ================================================================== shared ====

const impl = IS_MAC ? mac : linux;

/**
 * Capture the screen, one window, or a rectangle: the same result shape as the
 * Windows version, so the tool above does not care which it got.
 *
 * `scale` is image pixels per screen unit. On a Retina Mac the picture has
 * twice as many pixels as the screen has points, and the mouse works in
 * points, so the scale is measured from the file instead of assumed.
 */
async function screenshot({ monitor, window: title, region, max_width = 1400, format = "png" } = {}) {
  ensureTmp();
  if (monitor != null && Number(monitor) !== 0) throw new Error("only the primary monitor can be captured on this system; use region for another area");
  const jpeg = String(format).toLowerCase() === "jpeg";
  const rect = region
    ? { x: Number(region.x) | 0, y: Number(region.y) | 0, width: Number(region.width) | 0, height: Number(region.height) | 0 }
    : title ? await impl.windowRect(title) : await impl.screenRect();
  if (!(rect.width > 0 && rect.height > 0)) throw new Error("that area has no size");

  let file = path.join(TMP, `shot-${Date.now()}.png`);
  await impl.grab(file, rect, !region && !title);
  const max = Number(max_width) | 0;
  const raw = imageSize(fs.readFileSync(file));
  const shrink = max > 0 && raw.width > max;
  if (shrink || jpeg) file = await impl.resize(file, shrink ? max : 0, jpeg);

  const data = fs.readFileSync(file);
  const size = imageSize(data);
  return {
    file, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    shotWidth: size.width, shotHeight: size.height,
    scale: size.width && rect.width ? size.width / rect.width : 1,
    bytes: data.length, base64: data.toString("base64"),
    mimeType: /\.jpg$/.test(file) ? "image/jpeg" : "image/png",
  };
}

module.exports = {
  screenshot,
  mouse: (a) => impl.mouse(a),
  cursor: () => impl.cursor(),
  typeText: (t, o) => impl.typeText(t, o),
  pressKeys: (k, o) => impl.pressKeys(k, o),
  listWindows: () => impl.listWindows(),
  focusWindow: (t) => impl.focusWindow(t),
  clipboardGet: () => impl.clipboardGet(),
  clipboardSet: (t) => impl.clipboardSet(t),
  support: () => impl.support(),
  helpers: () => (impl.helpers ? impl.helpers() : null),
  // For the tests: the pure parts.
  toXdotool, xMouseCommands, toMacKey, imageSize, shellVars, linux, mac,
};
