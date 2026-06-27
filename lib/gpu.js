// Detects the platform + GPU and picks the best llama.cpp backend.
//   macOS            -> metal   (works out of the box)
//   NVIDIA           -> cuda
//   AMD / Intel      -> vulkan
//   anything else    -> cpu

const os = require("os");
const { spawnSync } = require("child_process");

function hasCmd(cmd) {
  const which = os.platform() === "win32" ? "where" : "which";
  return spawnSync(which, [cmd], { stdio: "ignore" }).status === 0;
}

function gpuName() {
  try {
    if (os.platform() === "win32") {
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"],
        { encoding: "utf8" },
      );
      return (r.stdout || "").toLowerCase();
    }
    const r = spawnSync("sh", ["-c", "lspci 2>/dev/null | grep -i 'vga\\|3d\\|display'"], {
      encoding: "utf8",
    });
    return (r.stdout || "").toLowerCase();
  } catch {
    return "";
  }
}

const NOTES = {
  metal: "Metal works out of the box on Apple Silicon — no extra install needed.",
  cuda: "Install the CUDA Toolkit (https://developer.nvidia.com/cuda-downloads), then run `arcflare gpu`.",
  vulkan: "Install the Vulkan SDK (https://vulkan.lunarg.com/sdk/home), then run `arcflare gpu`.",
  cpu: "No supported GPU detected — ArcFlare will run on CPU.",
};

function detect() {
  const platform = os.platform();

  if (platform === "darwin") {
    const apple = os.arch() === "arm64";
    return {
      platform,
      vendor: apple ? "Apple Silicon" : "Mac (Intel)",
      backend: apple ? "metal" : "cpu",
      note: apple ? NOTES.metal : NOTES.cpu,
    };
  }

  let vendor = "unknown";
  if (hasCmd("nvidia-smi")) vendor = "NVIDIA";
  else {
    const name = gpuName();
    if (name.includes("nvidia")) vendor = "NVIDIA";
    else if (name.includes("amd") || name.includes("radeon")) vendor = "AMD";
    else if (name.includes("intel")) vendor = "Intel";
  }

  const backend =
    vendor === "NVIDIA" ? "cuda" : vendor === "AMD" || vendor === "Intel" ? "vulkan" : "cpu";

  return { platform, vendor, backend, note: NOTES[backend] };
}

module.exports = { detect };
