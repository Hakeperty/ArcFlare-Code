// `arcflare auto` — a configuration made for the computer it runs on.
//
// Three steps, each one already a command of its own: look at the parts
// (hardware.js), get the llama.cpp build for them (engine-install.js), and
// measure the fastest settings (tune.js). This file is what ties them to one
// computer: what the parts imply before anything is measured, which settings
// that step may write, and how to tell that a configuration was made for a
// different machine.
//
// What is decided from the parts alone is deliberately little - the engine
// build and the memory profile. Batch size, threads and the choice between two
// working backends are not guessed from a parts list; they are timed.

const os = require("os");
const crypto = require("crypto");

const GB = 1024 ** 3;

/**
 * A cheap identity for this computer: host, CPU, core count, memory, platform.
 *
 * Cheap on purpose - it is checked on every model load, so it must not start a
 * process. It tells one computer from another (a config folder copied or
 * synced across machines) but not a swapped graphics card; after changing
 * parts, `arcflare auto` is run again by hand.
 */
function key(sys = os) {
  const cpus = sys.cpus() || [];
  const parts = [
    sys.hostname(), sys.platform(), sys.arch(),
    cpus[0] ? String(cpus[0].model).replace(/\s+/g, " ").trim() : "",
    cpus.length, Math.round(sys.totalmem() / GB),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Is this GPU's memory the computer's own RAM?
 * true / false, or null when the name does not say (Linux often gives no name).
 */
function sharesRam(gpu) {
  if (!gpu) return null;
  if (gpu.unified || gpu.integrated) return true;
  const n = String(gpu.name || "");
  if (gpu.vendor === "nvidia") return false;
  if (gpu.vendor === "amd") {
    if (/\bRX\s?\d|Radeon Pro W|FirePro|\bW\d{4}\b/i.test(n)) return false;
    if (/Radeon(\(TM\))?\s+(\d{3,4}[A-Z]*\s+)?Graphics|Vega|\b\d{3}M\b|\b\d{4}S\b/i.test(n)) return true;
    return null;
  }
  if (gpu.vendor === "intel") {
    if (/Arc(\(TM\))?\s+(Pro\s+)?[AB]\d{3}/i.test(n)) return false;
    if (/UHD|Iris|HD Graphics|Arc(\(TM\))?\s+Graphics|Arc(\(TM\))?\s+\d{3}[VT]/i.test(n)) return true;
    return null;
  }
  if (gpu.vendor === "apple" || gpu.vendor === "qualcomm") return true;
  return null;
}

/**
 * What the parts imply, before measuring.
 * Returns { settings: { memoryProfile }, where, why }.
 *
 * The memory profile sets how much RAM llama-server keeps for old prompts.
 * That cache is only free when the model lives somewhere else - on a graphics
 * card with its own memory. Where the model sits in RAM (no GPU, an integrated
 * one, Apple's unified memory), every gigabyte of prompt cache is a gigabyte
 * the model's context cannot have, so a machine short on RAM gets the lean
 * profile. Nothing here ever picks "max": that keeps four models resident,
 * which is a choice about how the computer is used, not a fact about its parts.
 */
function plan(hw, totalRamBytes) {
  const ram = totalRamBytes / GB;
  const shares = (hw.gpus || []).map(sharesRam);
  const dedicated = shares.includes(false);
  // A GPU whose kind the name does not give away decides nothing: the lean
  // profile also unloads an idle model sooner, and that is not a price to
  // charge a machine on a guess. It keeps the ordinary profile.
  const unknown = !dedicated && shares.includes(null);
  const where = dedicated ? "gpu" : unknown ? "unknown" : "ram";
  const lean = dedicated ? ram < 12 : unknown ? false : ram < 24;
  return {
    where,
    settings: { memoryProfile: lean ? "lean" : "balanced" },
    why: dedicated
      ? `the model runs in the graphics card's own memory; ${Math.round(ram)} GB of RAM ${lean ? "is little to spare for a prompt cache" : "leaves room for a prompt cache"}`
      : unknown
        ? "could not tell whether the GPU has its own memory, so the ordinary profile stays"
        : `the model shares the computer's ${Math.round(ram)} GB of RAM${lean ? ", so the prompt cache is kept small" : ", and there is enough of it for a prompt cache"}`,
  };
}

/**
 * The engine to install, if any: null, or { kind?, why }.
 * `activeKind` is the build in use: a kind, "none", or "unknown" for a build
 * someone pointed ArcFlare at by hand - which is theirs, and is left alone.
 */
function engineStep(hw, activeKind, advice) {
  if (activeKind === "unknown") return null;
  if (activeKind === "none") return { kind: null, why: "no llama.cpp is installed" };
  const tip = (advice || []).find((t) => t.kind && !t.optional);
  return tip ? { kind: tip.kind, why: tip.text } : null;
}

/**
 * Write the plan into a config, touching only what is this command's to touch:
 * a setting that is unset, or still holds what an earlier run put there. A
 * value someone chose by hand is kept and reported.
 * Returns { cfg, changed: [names], kept: [names] }.
 */
function apply(cfg, settings, machineKey, now = Date.now()) {
  const earlier = (cfg.auto && cfg.auto.set) || {};
  const out = { ...cfg };
  const set = {};
  const changed = [];
  const kept = [];
  for (const [name, value] of Object.entries(settings)) {
    if (cfg[name] === undefined || cfg[name] === earlier[name]) {
      if (cfg[name] !== value) changed.push(name);
      out[name] = value;
      set[name] = value;
    } else {
      kept.push(name);
    }
  }
  out.auto = { machine: machineKey, at: now, set };
  return { cfg: out, changed, kept };
}

/** Was this config made by `arcflare auto` on a different computer? */
function madeElsewhere(cfg, machineKey = key()) {
  return Boolean(cfg && cfg.auto && cfg.auto.machine && cfg.auto.machine !== machineKey);
}

module.exports = { key, sharesRam, plan, engineStep, apply, madeElsewhere };
