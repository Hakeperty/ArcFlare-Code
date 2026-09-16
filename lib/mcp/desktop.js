// Eyes and hands: screenshots, mouse, keyboard, windows, clipboard.
//
// ArcFlare has no dependencies and this file does not change that. Windows
// already ships everything needed — GDI+ for the screen grab, user32 for
// synthetic input, WinForms for SendKeys — so the work here is driving them
// through PowerShell rather than binding a native module. A script goes to a
// temp .ps1 and runs with -File, which sidesteps the quoting minefield of
// passing a program through -Command.
//
// The cost is process startup, a few hundred milliseconds per call. That is
// cheap next to a model deciding what to click, and it is the difference
// between an install that is `git clone` and one that needs a compiler.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const TMP = path.join(os.tmpdir(), "arcflare-mcp");

// P/Invoke surface, prepended to every script. SetProcessDPIAware matters more
// than it looks: without it a scaled display reports virtual coordinates, so a
// screenshot comes back at the wrong size and every click lands in the wrong
// place — consistently, which is the worst way to be wrong.
const PRELUDE = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AF {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[AF]::SetProcessDPIAware() | Out-Null
`;

function ensureTmp() {
  try { fs.mkdirSync(TMP, { recursive: true }); } catch {}
  return TMP;
}

/** Run a PowerShell script and return its stdout. Rejects with stderr on failure. */
function ps(script, { timeoutMs = 30000 } = {}) {
  if (!IS_WIN) return Promise.reject(new Error("this tool needs Windows"));
  ensureTmp();
  const file = path.join(TMP, `af-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  // BOM: PowerShell 5.1 reads a .ps1 as the ANSI codepage otherwise, which
  // turns any non-ASCII character in the script into mojibake.
  fs.writeFileSync(file, "﻿" + PRELUDE + script, "utf8");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("powershell timed out")); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { fs.unlinkSync(file); } catch {}
      if (code !== 0) return reject(new Error(err.trim().split("\n")[0] || `powershell exited ${code}`));
      resolve(out.trim());
    });
  });
}

async function psJson(script, opts) {
  const out = await ps(script + "\n", opts);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return out; }
}

// ------------------------------------------------------------- screenshot ----

/**
 * Capture the screen, one monitor, one window, or a rectangle.
 *
 * Scaled down on the way out, because the point is for a model to look at it:
 * a 4K grab is 8 MB of PNG and the answer to "where is the button" does not
 * need it. The returned scale factor is how a caller converts a coordinate in
 * the image back to a coordinate to click.
 */
async function screenshot({ monitor, window: title, region, max_width = 1400, format = "png" } = {}) {
  ensureTmp();
  const outFile = path.join(TMP, `shot-${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`);
  const q = (s) => String(s).replace(/'/g, "''");

  const pick = region
    ? `$rect = New-Object Drawing.Rectangle(${Number(region.x) | 0}, ${Number(region.y) | 0}, ${Number(region.width) | 0}, ${Number(region.height) | 0})`
    : title
      ? `
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${q(title)}*' } | Select-Object -First 1
if (-not $p) { throw "no window matching '${q(title)}'" }
$r = New-Object AF+RECT
[AF]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$rect = New-Object Drawing.Rectangle($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))`
      : monitor != null
        ? `
$screens = [Windows.Forms.Screen]::AllScreens
if (${Number(monitor) | 0} -ge $screens.Count) { throw "no monitor ${Number(monitor) | 0}" }
$rect = $screens[${Number(monitor) | 0}].Bounds`
        : `$rect = [Windows.Forms.SystemInformation]::VirtualScreen`;

  const meta = await psJson(`
${pick}
if ($rect.Width -le 0 -or $rect.Height -le 0) { throw "that area has no size" }
$bmp = New-Object Drawing.Bitmap $rect.Width, $rect.Height
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.X, $rect.Y, 0, 0, $bmp.Size)
$g.Dispose()

$scale = 1.0
$max = ${Number(max_width) | 0}
if ($max -gt 0 -and $bmp.Width -gt $max) {
  $scale = $max / $bmp.Width
  $w = [int]($bmp.Width * $scale); $h = [int]($bmp.Height * $scale)
  $small = New-Object Drawing.Bitmap $w, $h
  $sg = [Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = "HighQualityBicubic"
  $sg.DrawImage($bmp, 0, 0, $w, $h)
  $sg.Dispose(); $bmp.Dispose(); $bmp = $small
}
$fmt = if ("${format}" -eq "jpeg") { [Drawing.Imaging.ImageFormat]::Jpeg } else { [Drawing.Imaging.ImageFormat]::Png }
$bmp.Save('${q(outFile)}', $fmt)
@{ file = '${q(outFile)}'; x = $rect.X; y = $rect.Y
   width = $rect.Width; height = $rect.Height
   shotWidth = $bmp.Width; shotHeight = $bmp.Height; scale = $scale } | ConvertTo-Json -Compress
`, { timeoutMs: 60000 });

  const data = fs.readFileSync(meta.file);
  return {
    ...meta,
    bytes: data.length,
    base64: data.toString("base64"),
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}

// ------------------------------------------------------------------ mouse ----

const BUTTONS = {
  left: { down: "0x0002", up: "0x0004" },
  right: { down: "0x0008", up: "0x0010" },
  middle: { down: "0x0020", up: "0x0040" },
};

async function mouse({ action = "click", x, y, to_x, to_y, button = "left", amount = 3, delay_ms = 40 }) {
  const b = BUTTONS[button] || BUTTONS.left;
  const at = (px, py) => (px == null || py == null ? "" : `[AF]::SetCursorPos(${px | 0}, ${py | 0}) | Out-Null\nStart-Sleep -Milliseconds ${delay_ms | 0}\n`);
  const press = `[AF]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)`;
  const release = `[AF]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)`;

  let body;
  switch (action) {
    case "move": body = at(x, y); break;
    case "click": body = at(x, y) + `${press}\nStart-Sleep -Milliseconds 30\n${release}\n`; break;
    case "double":
      body = at(x, y) + `${press}\n${release}\nStart-Sleep -Milliseconds 80\n${press}\n${release}\n`;
      break;
    case "down": body = at(x, y) + press + "\n"; break;
    case "up": body = at(x, y) + release + "\n"; break;
    case "drag":
      // Moved in steps: a single jump between press and release reads as a
      // click to most applications, which do not see the intermediate motion.
      body = at(x, y) + press + "\n" +
        `$steps = 20
for ($i = 1; $i -le $steps; $i++) {
  $nx = ${x | 0} + (${(to_x | 0) - (x | 0)} * $i / $steps)
  $ny = ${y | 0} + (${(to_y | 0) - (y | 0)} * $i / $steps)
  [AF]::SetCursorPos([int]$nx, [int]$ny) | Out-Null
  Start-Sleep -Milliseconds 12
}
` + release + "\n";
      break;
    case "scroll":
      body = at(x, y) + `[AF]::mouse_event(0x0800, 0, 0, ${(Number(amount) || 3) * 120}, [IntPtr]::Zero)\n`;
      break;
    default:
      throw new Error(`unknown mouse action "${action}"`);
  }

  await ps(body + `
$p = [Windows.Forms.Cursor]::Position
@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress
`);
  return cursor();
}

async function cursor() {
  return psJson(`$p = [Windows.Forms.Cursor]::Position
@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress`);
}

// --------------------------------------------------------------- keyboard ----

// SendKeys treats these as syntax, so literal text has to brace them.
const SENDKEYS_SPECIAL = /[+^%~(){}[\]]/g;

function escapeText(text) {
  return String(text).replace(SENDKEYS_SPECIAL, (ch) => `{${ch}}`);
}

const KEY_NAMES = {
  enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
  backspace: "{BACKSPACE}", bs: "{BACKSPACE}", del: "{DELETE}", delete: "{DELETE}",
  space: " ", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  home: "{HOME}", end: "{END}", pgup: "{PGUP}", pgdn: "{PGDN}", insert: "{INSERT}",
  capslock: "{CAPSLOCK}", printscreen: "{PRTSC}",
};
const MODIFIERS = { ctrl: "^", control: "^", alt: "%", shift: "+", win: "^{ESC}" };

/** Turn "ctrl+shift+p" or "enter" into a SendKeys string. */
function toSendKeys(combo) {
  const parts = String(combo).split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop();
  let prefix = "";
  for (const m of parts) {
    if (!MODIFIERS[m]) throw new Error(`unknown modifier "${m}" in "${combo}"`);
    prefix += MODIFIERS[m];
  }
  let body = KEY_NAMES[key];
  if (!body) {
    if (/^f([1-9]|1[0-6])$/.test(key)) body = `{${key.toUpperCase()}}`;
    else if (key.length === 1) body = escapeText(key);
    else throw new Error(`unknown key "${key}" in "${combo}"`);
  }
  return prefix + body;
}

async function typeText(text, { delay_ms = 0 } = {}) {
  const chunks = String(text).split(/(\r?\n)/).filter((s) => s !== "");
  const lines = chunks.map((ch) =>
    /^\r?\n$/.test(ch) ? "{ENTER}" : escapeText(ch));
  const b64 = Buffer.from(lines.join(""), "utf8").toString("base64");
  await ps(`
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
[Windows.Forms.SendKeys]::SendWait($keys)
Start-Sleep -Milliseconds ${Number(delay_ms) | 0}
`);
  return { sent: String(text).length };
}

async function pressKeys(combos, { delay_ms = 60 } = {}) {
  const list = Array.isArray(combos) ? combos : [combos];
  const keys = list.map(toSendKeys);
  const b64 = Buffer.from(JSON.stringify(keys), "utf8").toString("base64");
  await ps(`
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json
foreach ($k in @($keys)) {
  [Windows.Forms.SendKeys]::SendWait($k)
  Start-Sleep -Milliseconds ${Number(delay_ms) | 0}
}
`);
  return { pressed: keys };
}

// ---------------------------------------------------------------- windows ----

async function listWindows() {
  const out = await psJson(`
$out = @()
foreach ($p in Get-Process | Where-Object { $_.MainWindowTitle }) {
  $r = New-Object AF+RECT
  [AF]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  $out += @{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle
             x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}
ConvertTo-Json -Compress -InputObject @($out)
`);
  return Array.isArray(out) ? out : out ? [out] : [];
}

/**
 * Bring a window to the front.
 *
 * Several windows can match one substring — two Notepads, three browser
 * profiles — and focusing the wrong one then typing into it is the most
 * expensive mistake this file can make, because the text lands somewhere real.
 * So the match is reported with everything else it could have been.
 */
async function focusWindow(title) {
  const q = String(title).replace(/'/g, "''");
  return psJson(`
$all = @(Get-Process | Where-Object { $_.MainWindowTitle -like '*${q}*' })
if ($all.Count -eq 0) { throw "no window matching '${q}'" }
$p = $all[0]
[AF]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE, in case it is minimised
[AF]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 250
$fg = [AF]::GetForegroundWindow()
@{ pid = $p.Id; title = $p.MainWindowTitle; name = $p.ProcessName
   focused = ($fg -eq $p.MainWindowHandle)
   others = @($all | Select-Object -Skip 1 | ForEach-Object { $_.MainWindowTitle })
 } | ConvertTo-Json -Compress
`);
}

// -------------------------------------------------------------- clipboard ----

async function clipboardGet() {
  return ps(`$t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }`);
}

async function clipboardSet(text) {
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  await ps(`
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
Set-Clipboard -Value $t
`);
  return { bytes: Buffer.byteLength(String(text)) };
}

// ------------------------------------------------------------ other OSes ----

/** What this platform can do, so the tools can say so instead of failing oddly. */
function support() {
  if (IS_WIN) return { ok: true, how: "powershell + user32" };
  if (IS_MAC) return { ok: false, how: "macOS: screencapture and osascript are not wired up yet" };
  return { ok: false, how: "linux: x11 tooling is not wired up yet" };
}

module.exports = {
  ps, psJson, screenshot, mouse, cursor, typeText, pressKeys, toSendKeys, escapeText,
  listWindows, focusWindow, clipboardGet, clipboardSet, support, TMP, IS_WIN,
};
