// Backend discovery: find every llama.cpp build on this machine, ask each one
// what devices it can actually see, and pick the best working one.
//
// A build shipping kernels for your GPU is not the same as a build that can
// *use* your GPU — a ROCm build can contain gfx1151 kernels and still enumerate
// zero devices because the installed driver will not expose them to HIP. So we
// probe rather than infer, and we report the difference honestly.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const EXE = process.platform === "win32" ? ".exe" : "";
const SERVER = "llama-server" + EXE;
const CLI = "llama-cli" + EXE;

// Preference when several backends work. Dedicated GPU APIs first; Vulkan is a
// strong default on AMD iGPUs and is usually the only thing that works there.
const PREFERENCE = ["cuda", "hip", "rocm", "vulkan", "sycl", "metal", "opencl", "cpu"];

const KIND_HINTS = [
  [/rocm|hip/i, "rocm"],
  [/cuda/i, "cuda"],
  [/vulkan/i, "vulkan"],
  [/sycl/i, "sycl"],
  [/metal/i, "metal"],
  [/opencl/i, "opencl"],
  [/cpu/i, "cpu"],
];

function kindOf(dir, files) {
  const base = path.basename(dir).toLowerCase();
  for (const [re, kind] of KIND_HINTS) if (re.test(base)) return kind;
  // Fall back to the ggml backend libraries sitting next to the binary.
  const libs = files.join(" ").toLowerCase();
  if (/ggml-hip|amdhip/.test(libs)) return "rocm";
  if (/ggml-cuda|cudart/.test(libs)) return "cuda";
  if (/ggml-vulkan/.test(libs)) return "vulkan";
  if (/ggml-sycl/.test(libs)) return "sycl";
  if (/ggml-metal/.test(libs)) return "metal";
  if (/ggml-opencl/.test(libs)) return "opencl";
  return "cpu";
}

function candidateDirs(extra = []) {
  const dirs = [];
  const add = (d) => {
    if (!d) return;
    const r = path.resolve(d);
    if (!dirs.includes(r) && fs.existsSync(r)) dirs.push(r);
  };
  extra.forEach(add);
  if (process.env.ARCFLARE_LLAMA_DIR) add(process.env.ARCFLARE_LLAMA_DIR);

  const home = os.homedir();
  const bases = [
    path.join(home, "llamacpp"),
    path.join(home, "llama.cpp"),
    path.join(home, ".arcflare", "engines"),
    "/usr/local/lib/llama.cpp",
    "/opt/llama.cpp",
  ];
  for (const b of bases) {
    add(b);
    let subs = [];
    try { subs = fs.readdirSync(b, { withFileTypes: true }); } catch {}
    for (const s of subs) if (s.isDirectory()) add(path.join(b, s.name));
  }
  add(path.join(home, "llama.cpp", "build", "bin"));
  // Anything already on PATH.
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["llama-server"], { encoding: "utf8" });
  if (r.status === 0) {
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      const t = line.trim();
      if (t && fs.existsSync(t)) add(path.dirname(t));
    }
  }
  return dirs;
}

/** All llama.cpp builds we can find. */
function discover(extra = []) {
  const out = [];
  for (const dir of candidateDirs(extra)) {
    const server = path.join(dir, SERVER);
    if (!fs.existsSync(server)) continue;
    let files = [];
    try { files = fs.readdirSync(dir); } catch {}
    let mtime = 0;
    try { mtime = fs.statSync(server).mtimeMs; } catch {}
    out.push({
      id: kindOf(dir, files) + ":" + path.basename(dir),
      kind: kindOf(dir, files),
      dir,
      server,
      cli: fs.existsSync(path.join(dir, CLI)) ? path.join(dir, CLI) : null,
      mtime,
    });
  }
  return out;
}

const DEVICE_RE = /^\s*(\S+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;

/**
 * Ask a build what devices it can see.
 * IMPORTANT: run with cwd set to the build's own directory. On Windows the DLL
 * search path includes the working directory, so probing a ROCm build from
 * inside a Vulkan build's folder silently loads the Vulkan backend and reports
 * a device that the ROCm build cannot actually use.
 */
function probe(build, timeout = 25000) {
  const exe = build.cli || build.server;
  const r = spawnSync(exe, ["--list-devices"], {
    encoding: "utf8",
    cwd: build.dir,
    timeout,
    windowsHide: true,
  });
  const text = (r.stdout || "") + "\n" + (r.stderr || "");
  const devices = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DEVICE_RE.exec(line);
    if (m) {
      devices.push({
        handle: m[1],
        name: m[2],
        totalMiB: Number(m[3]),
        freeMiB: Number(m[4]),
      });
    }
  }
  const failed = r.error || r.status !== 0;
  return {
    devices,
    ok: devices.length > 0,
    error: failed ? String((r.error && r.error.message) || `exit ${r.status}`) : null,
    // Kernels present but no device => driver/runtime problem, not a build problem.
    note: !devices.length && !failed
      ? "build loads but enumerates no device (driver or runtime)"
      : null,
    raw: text.trim().split(/\r?\n/).slice(0, 6).join("\n"),
  };
}

/** Which GPU architectures a ROCm/HIP build actually contains. */
function hipTargets(build) {
  const lib = path.join(build.dir, "ggml-hip.dll");
  const alt = path.join(build.dir, "libggml-hip.so");
  const file = fs.existsSync(lib) ? lib : fs.existsSync(alt) ? alt : null;
  if (!file) return [];
  // These libraries run to ~1 GB. Read them in windows with a small overlap so
  // a target straddling a boundary is still found, and never hold more than one
  // chunk — slurping the file exceeds Node's max string length outright.
  const CHUNK = 4 * 1024 * 1024;
  const OVERLAP = 16;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK);
    const found = new Set();
    const re = /gfx[0-9a-f]{3,4}/g;
    let pos = 0;
    let carry = "";
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      const text = carry + buf.toString("latin1", 0, n);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) found.add(m[0]);
      carry = text.slice(-OVERLAP);
      pos += n;
    }
    return [...found].sort();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** Probe every build, cheapest-to-most-useful order, with a small disk cache. */
function survey(cacheFile, opts = {}) {
  const builds = discover(opts.extra || []);
  let cache = {};
  if (cacheFile && !opts.fresh) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
  }
  const out = [];
  for (const b of builds) {
    const key = `${b.server}:${b.mtime}`;
    let res = cache[key];
    if (!res) {
      res = probe(b);
      cache[key] = res;
    }
    out.push({ ...b, ...res });
  }
  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } catch {}
  }
  out.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    const pa = PREFERENCE.indexOf(a.kind);
    const pb = PREFERENCE.indexOf(b.kind);
    if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    const fa = a.devices[0] ? a.devices[0].totalMiB : 0;
    const fb = b.devices[0] ? b.devices[0].totalMiB : 0;
    return fb - fa;
  });
  return out;
}

/** The build we should actually use, honouring an explicit preference. */
function choose(surveyed, preferred) {
  if (preferred) {
    const exact = surveyed.find((b) => b.id === preferred || b.dir === preferred);
    if (exact) return exact;
    const byKind = surveyed.find((b) => b.kind === preferred && b.ok);
    if (byKind) return byKind;
  }
  return surveyed.find((b) => b.ok) || surveyed[0] || null;
}

/**
 * Bytes of device memory currently held by *any* process.
 *
 * This matters more than it sounds. llama.cpp's `--list-devices` reports a
 * static heap budget: it printed "46522 MiB free" both while a 30 GB model was
 * resident and immediately after that process exited. Sizing a context off that
 * number works right up until something else is using the GPU, and then the
 * model fails to load with a bare ErrorOutOfDeviceMemory.
 */
function deviceUsedBytes() {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue)" +
      ".CounterSamples | Measure-Object -Property CookedValue -Sum |" +
      " Select-Object -ExpandProperty Sum"],
      { encoding: "utf8", timeout: 15000, windowsHide: true });
    const n = Number(String(r.stdout || "").trim());
    if (Number.isFinite(n) && n >= 0) return n;
    return null;
  }
  // NVIDIA
  let r = spawnSync("nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 15000 });
  if (r.status === 0) {
    const mb = Number(String(r.stdout || "").split(/\r?\n/)[0]);
    if (Number.isFinite(mb)) return mb * 1024 * 1024;
  }
  // AMD
  r = spawnSync("rocm-smi", ["--showmemuse", "--csv"], { encoding: "utf8", timeout: 15000 });
  if (r.status === 0) {
    const m = /(\d+)\s*$/m.exec(String(r.stdout || ""));
    if (m) return Number(m[1]);
  }
  return null;
}

let _memCache = null;

/**
 * Honest view of device memory: the reported budget, what is actually in use,
 * and the smaller of the two as the number to plan against.
 */
function deviceMemory(build, opts = {}) {
  if (_memCache && !opts.fresh && Date.now() - _memCache.at < 5000) return _memCache.value;
  let totalBytes = null;
  let budgetFreeBytes = null;
  if (build && build.devices && build.devices.length) {
    const d = build.devices[0];
    totalBytes = d.totalMiB * 1024 * 1024;
    budgetFreeBytes = d.freeMiB * 1024 * 1024;
  }
  const usedBytes = opts.skipUsed ? null : deviceUsedBytes();
  let freeBytes = budgetFreeBytes;
  if (totalBytes != null && usedBytes != null) {
    freeBytes = Math.max(0, Math.min(budgetFreeBytes ?? totalBytes, totalBytes - usedBytes));
  }
  const value = { totalBytes, budgetFreeBytes, usedBytes, freeBytes };
  _memCache = { at: Date.now(), value };
  return value;
}

module.exports = {
  discover, probe, survey, choose, hipTargets, deviceMemory, deviceUsedBytes, PREFERENCE,
};
