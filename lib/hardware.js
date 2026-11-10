// What this machine is made of, as far as running a model goes: which GPUs,
// from which vendors, and how the CPU's cores are split.
//
// backend.js answers "which llama.cpp builds here can see a device" by asking
// the builds. This answers the question that comes before it - which build
// this machine *should* have - from the operating system, so it works with no
// llama.cpp installed at all. It says what is there. It does not predict how
// fast anything is: that is measured, by `arcflare tune`.
//
// Everything that touches the system goes through `io`, so each platform's
// parsing is tested with that platform's real output on any machine.

const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const VENDORS = { "0x10de": "nvidia", "0x1002": "amd", "0x1022": "amd", "0x8086": "intel", "0x106b": "apple" };

function vendorOf(name) {
  const n = String(name || "");
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/i.test(n)) return "nvidia";
  if (/\bamd\b|radeon|\bati\b|firepro/i.test(n)) return "amd";
  if (/intel|\barc\b|\biris\b|uhd graphics/i.test(n)) return "intel";
  if (/apple/i.test(n)) return "apple";
  if (/qualcomm|adreno|snapdragon/i.test(n)) return "qualcomm";
  return "other";
}

const defaultIo = {
  platform: process.platform,
  arch: process.arch,
  readFile: (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } },
  readdir: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
  run: (cmd, args, timeout = 8000) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
    return { status: r.error ? -1 : r.status, stdout: r.stdout || "" };
  },
  cpus: () => os.cpus(),
};

/** "0-7,16-19" -> 12. The kernel's CPU list format. */
function countCpuList(text) {
  let n = 0;
  for (const part of String(text || "").trim().split(",")) {
    if (!part) continue;
    const [a, b] = part.split("-").map(Number);
    if (!Number.isFinite(a)) continue;
    n += Number.isFinite(b) ? b - a + 1 : 1;
  }
  return n;
}

// -------------------------------------------------------------------- cpu ----

/**
 * { name, vendor, logical, physical, performance, efficiency, hybrid }
 *
 * `performance` is the number of full-speed physical cores, or null when the
 * system does not say. On a hybrid Intel chip a matrix multiply split evenly
 * over P and E cores waits for the slowest one, so this count - not the total -
 * is the thread count worth measuring against the default.
 */
function cpu(io = defaultIo) {
  const list = io.cpus() || [];
  const name = (list[0] && list[0].model ? list[0].model : "").replace(/\s+/g, " ").trim();
  const out = {
    name, logical: list.length || null, physical: null, performance: null, efficiency: null, hybrid: false,
    vendor: /intel/i.test(name) ? "intel" : /amd|ryzen|epyc/i.test(name) ? "amd" : /apple/i.test(name) ? "apple" : "other",
  };

  if (io.platform === "linux") {
    // Hybrid Intel exposes two PMUs, each listing its logical CPUs.
    const pList = io.readFile("/sys/devices/cpu_core/cpus");
    const eList = io.readFile("/sys/devices/cpu_atom/cpus");
    const cores = new Set();
    const pCores = new Set();
    const pCpus = new Set();
    if (pList) {
      for (const part of pList.trim().split(",")) {
        const [a, b] = part.split("-").map(Number);
        for (let i = a; i <= (Number.isFinite(b) ? b : a); i++) pCpus.add(i);
      }
    }
    for (let i = 0; i < (out.logical || 0); i++) {
      const base = `/sys/devices/system/cpu/cpu${i}/topology/`;
      const core = io.readFile(base + "core_id");
      const pkg = io.readFile(base + "physical_package_id");
      if (core == null) continue;
      const key = `${(pkg || "0").trim()}:${core.trim()}`;
      cores.add(key);
      if (pCpus.has(i)) pCores.add(key);
    }
    if (cores.size) out.physical = cores.size;
    if (pList && eList && countCpuList(eList) > 0) {
      out.hybrid = true;
      out.performance = pCores.size || null;
      out.efficiency = out.physical && out.performance ? out.physical - out.performance : countCpuList(eList);
    } else if (out.physical) {
      out.performance = out.physical;
    }
  } else if (io.platform === "darwin") {
    const r = io.run("sysctl", ["-n", "hw.physicalcpu", "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu"]);
    const nums = r.stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (nums[0]) out.physical = nums[0];
    if (nums[1]) out.performance = nums[1];
    if (nums[2]) { out.efficiency = nums[2]; out.hybrid = true; }
    if (!out.performance && out.physical) out.performance = out.physical;
    if (io.arch === "arm64") out.vendor = "apple";
  } else if (io.platform === "win32") {
    const r = io.run("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Processor | ForEach-Object { \"$($_.NumberOfCores) $($_.NumberOfLogicalProcessors)\" }"], 15000);
    let physical = 0, logical = 0;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^(\d+)\s+(\d+)\s*$/.exec(line.trim());
      if (m) { physical += Number(m[1]); logical += Number(m[2]); }
    }
    if (physical) {
      out.physical = physical;
      // Hyper-threaded P cores count twice among the logical processors and E
      // cores once, so logical - physical is the P count. It only identifies a
      // hybrid when it lands strictly between: equal means no hyper-threading
      // (and then the split cannot be read this way), double means no E cores.
      const p = logical - physical;
      if (out.vendor === "intel" && p > 0 && p < physical) {
        out.hybrid = true; out.performance = p; out.efficiency = physical - p;
      } else if (p === physical || out.vendor !== "intel") {
        out.performance = physical;
      }
      // Intel with logical == physical is left unknown: an older chip without
      // hyper-threading and a Core Ultra with E cores look the same from here.
    }
  }
  return out;
}

// -------------------------------------------------------------------- gpu ----

/** [{ name, vendor, integrated? }] - every display adapter the OS lists. */
function gpus(io = defaultIo) {
  const out = [];
  const add = (name, vendor, extra = {}) => {
    const v = vendor || vendorOf(name);
    if (!out.some((g) => g.name === name && g.vendor === v)) out.push({ name: name || v, vendor: v, ...extra });
  };

  if (io.platform === "darwin") {
    if (io.arch === "arm64") {
      const r = io.run("sysctl", ["-n", "machdep.cpu.brand_string"]);
      add((r.stdout.trim() || "Apple Silicon") + " GPU", "apple", { integrated: true, unified: true });
    } else {
      const r = io.run("system_profiler", ["SPDisplaysDataType"], 15000);
      for (const m of r.stdout.matchAll(/Chipset Model:\s*(.+)/g)) add(m[1].trim());
    }
  } else if (io.platform === "linux") {
    for (const card of io.readdir("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      const dev = `/sys/class/drm/${card}/device/`;
      const id = (io.readFile(dev + "vendor") || "").trim().toLowerCase();
      const vendor = VENDORS[id];
      if (!vendor) continue;
      const model = (io.readFile(dev + "product_name") || io.readFile(dev + "label") || "").trim();
      add(model || `${vendor} GPU (${card})`, vendor);
    }
    if (!out.some((g) => g.vendor === "nvidia")) {
      // The proprietary driver without a DRM card (headless servers, WSL).
      const r = io.run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
      if (r.status === 0) for (const l of r.stdout.split(/\r?\n/)) if (l.trim()) add(l.trim(), "nvidia");
    }
  } else if (io.platform === "win32") {
    const r = io.run("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }"], 15000);
    for (const l of r.stdout.split(/\r?\n/)) {
      const n = l.trim();
      // Remote-desktop and virtual display drivers are adapters, not GPUs.
      if (n && !/basic (display|render)|remote|virtual|mirror|parsec|citrix/i.test(n)) add(n);
    }
  }
  return out;
}

// ----------------------------------------------------------------- survey ----

let _cached = null;

/** { platform, arch, cpu, gpus, vendors: Set-like array, appleSilicon }. Cached for the process. */
function survey(io) {
  if (!io && _cached) return _cached;
  const use = io || defaultIo;
  const g = gpus(use);
  const hw = {
    platform: use.platform,
    arch: use.arch,
    cpu: cpu(use),
    gpus: g,
    vendors: [...new Set(g.map((x) => x.vendor))],
    appleSilicon: use.platform === "darwin" && use.arch === "arm64",
  };
  if (!io) _cached = hw;
  return hw;
}

const has = (hw, vendor) => Boolean(hw && hw.vendors && hw.vendors.includes(vendor));

/**
 * The llama.cpp build kinds worth having on this machine, best guess first.
 *
 * A guess about which *exists* for the hardware, in the order they have
 * generally run fastest - the vendor's own API ahead of Vulkan. Nothing here is
 * a promise: a ROCm build can ship the right kernels and still see no device,
 * which is why builds are probed after install and compared by `arcflare tune`.
 */
function backendsFor(hw) {
  if (!hw) return ["cpu"];
  if (hw.platform === "darwin") return ["metal"];
  const out = [];
  if (has(hw, "nvidia")) out.push("cuda");
  if (has(hw, "amd")) out.push("rocm");
  if (has(hw, "intel")) out.push("sycl");
  if (has(hw, "qualcomm")) out.push("opencl");
  if (hw.gpus.length) out.push("vulkan");
  out.push("cpu");
  return out;
}

/**
 * What to tell someone whose active backend leaves speed on the table.
 * Returns [{ text, command? }], empty when there is nothing to say.
 */
function advice(hw, activeKind) {
  const tips = [];
  if (!hw || hw.platform === "darwin") return tips;
  const kind = activeKind || "none";
  if (has(hw, "nvidia") && kind !== "cuda") {
    tips.push({
      text: `an NVIDIA GPU is here but the ${kind === "none" ? "engine is missing" : kind + " build is active"}; the CUDA build is usually the fastest on it`,
      command: "arcflare engine install --cuda",
    });
  } else if (hw.gpus.length && (kind === "cpu" || kind === "none")) {
    tips.push({
      text: `${hw.gpus[0].name} is here but ${kind === "none" ? "no engine is installed" : "the CPU build is active"}; the Vulkan build runs on it`,
      command: "arcflare engine install --vulkan",
    });
  }
  if (has(hw, "amd") && !has(hw, "nvidia") && kind === "vulkan") {
    tips.push({
      text: "on Radeon the ROCm build can read prompts faster than Vulkan when the driver exposes the GPU to it; install it beside this one and measure",
      command: "arcflare engine install --rocm && arcflare tune --backends",
    });
  }
  return tips;
}

/** One line for doctor: "Intel Core i7-13700K · 8 P-cores + 8 E-cores". */
function cpuLine(c) {
  if (!c) return "unknown";
  const parts = [c.name || "unknown CPU"];
  if (c.hybrid && c.performance && c.efficiency) parts.push(`${c.performance} P-cores + ${c.efficiency} E-cores`);
  else if (c.physical) parts.push(`${c.physical} cores`);
  return parts.join(" · ");
}

module.exports = { survey, cpu, gpus, vendorOf, backendsFor, advice, cpuLine, countCpuList, has };
