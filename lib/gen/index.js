// Generative models that are not language models: image -> 3D mesh, for now.
//
// Everything else ArcFlare runs is a GGUF served by llama.cpp. Hunyuan3D and
// TripoSR are not: they are PyTorch pipelines with their own code repos, their
// own weight layouts and, for texturing, CUDA extensions that have to be
// compiled. There is no llama.cpp for them, so ArcFlare does here what it does
// for llama-server — find the pieces, check them honestly, run the thing as a
// child process and supervise it — with a Python worker in place of the engine.
//
// The worker speaks one JSON object per line on stdout. Everything a pipeline
// prints for itself goes to stderr, and only the tail of it is kept, because
// the useful part of a failed diffusion run is the last traceback, not the
// four hundred progress bars before it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const GEN = path.join(HOME, "gen");
const REPOS = path.join(GEN, "repos");
const WEIGHTS = path.join(GEN, "models");       // HY3DGEN_MODELS: Hunyuan's own cache layout
const HF_CACHE = path.join(GEN, "hf");          // HF_HUB_CACHE: everything else
const OUT = path.join(GEN, "out");
const VENV = path.join(GEN, "venv");
const WORKER = path.join(__dirname, "worker.py");

// ------------------------------------------------------------------ models ----
//
// `vram` is what the shape stage needs on the device; `textureVram` adds the
// paint stage on top. Both are the figures the model authors publish, rounded
// up — a number that is wrong in the optimistic direction costs an
// out-of-memory error ten minutes in.

const REPO_HY2 = { url: "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git", dir: "Hunyuan3D-2" };
const REPO_HY21 = { url: "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git", dir: "Hunyuan3D-2.1" };
const REPO_TRIPO = { url: "https://github.com/VAST-AI-Research/TripoSR.git", dir: "TripoSR" };

const MODELS = [
  {
    id: "hunyuan3d-2mini",
    label: "Hunyuan3D-2 mini",
    family: "hunyuan3d-2",
    repo: REPO_HY2,
    hf: "tencent/Hunyuan3D-2mini",
    subfolder: "hunyuan3d-dit-v2-mini",
    params: "0.6B",
    vram: 5,
    textureVram: 14,
    steps: 30,
    texture: true,
    text: true,
    note: "smallest Hunyuan shape model, the sensible default",
  },
  {
    id: "hunyuan3d-2mini-turbo",
    label: "Hunyuan3D-2 mini turbo",
    family: "hunyuan3d-2",
    repo: REPO_HY2,
    hf: "tencent/Hunyuan3D-2mini",
    subfolder: "hunyuan3d-dit-v2-mini-turbo",
    params: "0.6B",
    vram: 5,
    textureVram: 14,
    steps: 5,
    turbo: true,
    texture: true,
    text: true,
    note: "step-distilled with FlashVDM: seconds rather than a minute",
  },
  {
    // Guidance-distilled: one forward pass per step instead of two, so about
    // twice the speed of mini for nearly the same shape.
    id: "hunyuan3d-2mini-fast",
    label: "Hunyuan3D-2 mini fast",
    family: "hunyuan3d-2",
    repo: REPO_HY2,
    hf: "tencent/Hunyuan3D-2mini",
    subfolder: "hunyuan3d-dit-v2-mini-fast",
    params: "0.6B",
    vram: 5,
    textureVram: 14,
    steps: 30,
    texture: true,
    text: true,
    note: "guidance-distilled mini: about twice as fast, nearly the same shapes",
  },
  {
    id: "hunyuan3d-2",
    label: "Hunyuan3D-2",
    family: "hunyuan3d-2",
    repo: REPO_HY2,
    hf: "tencent/Hunyuan3D-2",
    subfolder: "hunyuan3d-dit-v2-0",
    params: "1.1B",
    vram: 6,
    textureVram: 16,
    steps: 30,
    texture: true,
    text: true,
    note: "full-size 2.0 shape model, with the paint model for textures",
  },
  {
    id: "hunyuan3d-2-turbo",
    label: "Hunyuan3D-2 turbo",
    family: "hunyuan3d-2",
    repo: REPO_HY2,
    hf: "tencent/Hunyuan3D-2",
    subfolder: "hunyuan3d-dit-v2-0-turbo",
    params: "1.1B",
    vram: 6,
    textureVram: 16,
    steps: 5,
    turbo: true,
    texture: true,
    text: true,
    note: "full-size 2.0, step-distilled with FlashVDM: 5 steps",
  },
  {
    id: "hunyuan3d-2.1",
    label: "Hunyuan3D-2.1",
    family: "hunyuan3d-2.1",
    repo: REPO_HY21,
    hf: "tencent/Hunyuan3D-2.1",
    subfolder: "hunyuan3d-dit-v2-1",
    params: "3.3B",
    vram: 10,
    textureVram: 29,
    steps: 30,
    texture: false,
    text: false,
    note: "highest-fidelity shapes; PBR texturing is not wired up here yet",
  },
  {
    id: "triposr",
    label: "TripoSR",
    family: "triposr",
    repo: REPO_TRIPO,
    hf: "stabilityai/TripoSR",
    params: "0.4B",
    vram: 6,
    steps: 1,
    texture: false,
    text: false,
    note: "feed-forward: under a second on a GPU, vertex colours, rougher shapes",
  },
];

const DEFAULT_MODEL = "hunyuan3d-2mini";

function byId(id) {
  if (!id) return MODELS.find((m) => m.id === DEFAULT_MODEL);
  const q = String(id).toLowerCase().replace(/[\s_]/g, "-");
  return MODELS.find((m) => m.id === q) ||
    MODELS.find((m) => m.id.replace(/[-.]/g, "") === q.replace(/[-.]/g, "")) ||
    null;
}

// ------------------------------------------------------------------ python ----

function venvPython(dir = VENV) {
  return IS_WIN ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
}

/**
 * The interpreter to run workers with, and where the answer came from.
 *
 * A configured path wins, because the likeliest reason to configure one is a
 * Python that already has a working GPU torch — on AMD under Windows that is a
 * hand-built ROCm wheel, and no `pip install` we could run would reproduce it.
 */
function findPython(cfg = {}) {
  const tries = [
    [cfg.genPython, "config (arcflare gen python)"],
    [process.env.ARCFLARE_PYTHON, "ARCFLARE_PYTHON"],
    [venvPython(), "ArcFlare venv"],
  ];
  for (const [p, source] of tries) {
    if (p && fs.existsSync(p)) return { path: p, source, managed: p === venvPython() };
  }
  return null;
}

/** A system Python new enough to build a venv from (3.10+, what the repos ask for). */
function findBasePython() {
  const candidates = IS_WIN
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys,json;print(json.dumps([sys.executable,list(sys.version_info[:3])]))"],
      { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) continue;
    try {
      const [exe, ver] = JSON.parse(r.stdout.trim());
      if (ver[0] === 3 && ver[1] >= 10) return { cmd, pre, exe, version: ver.join(".") };
    } catch { /* not this one */ }
  }
  return null;
}

/** Version and base interpreter of a Python, or null if it does not run. */
function pythonFacts(exe) {
  const r = spawnSync(exe, ["-c",
    "import sys,json;print(json.dumps([list(sys.version_info[:3]),getattr(sys,'_base_executable',sys.executable)]))"],
  { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const [ver, base] = JSON.parse(r.stdout.trim().split("\n").pop());
    return { version: ver.join("."), minor: `${ver[0]}.${ver[1]}`, base };
  } catch { return null; }
}

// --------------------------------------------------------------- locations ----

function repoDir(m) { return path.join(REPOS, m.repo.dir); }

/** What goes on PYTHONPATH so the worker can import the model's package. */
function importPaths(m) {
  const root = repoDir(m);
  if (m.family === "hunyuan3d-2.1") return [path.join(root, "hy3dshape"), path.join(root, "hy3dpaint"), root];
  return [root];
}

function hfCacheName(repo) { return "models--" + repo.replace("/", "--"); }

/**
 * Whether the weights are on disk, without loading anything.
 *
 * Hunyuan's loader keeps its own layout under HY3DGEN_MODELS (repo/subfolder)
 * rather than the Hugging Face cache, so the two families are looked for in
 * different places. Absent is not an error — the first run downloads them —
 * but it is worth saying before a run that is about to fetch several GB.
 */
function weightsPresent(m) {
  if (m.family.startsWith("hunyuan")) {
    const dir = path.join(WEIGHTS, m.hf, m.subfolder);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(safetensors|ckpt|bin)$/.test(f));
  }
  const snap = path.join(HF_CACHE, hfCacheName(m.hf), "snapshots");
  if (!fs.existsSync(snap)) return false;
  return fs.readdirSync(snap).some((rev) => fs.existsSync(path.join(snap, rev, "model.ckpt")));
}

function workerEnv(m, extra = {}) {
  const sep = IS_WIN ? ";" : ":";
  const paths = importPaths(m);
  if (process.env.PYTHONPATH) paths.push(process.env.PYTHONPATH);
  return {
    ...process.env,
    PYTHONPATH: paths.join(sep),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    HY3DGEN_MODELS: process.env.HY3DGEN_MODELS || WEIGHTS,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE || HF_CACHE,
    // Progress bars are written with carriage returns and would otherwise fill
    // the stderr tail with one line per step.
    TQDM_DISABLE: "1",
    ...extra,
  };
}

// ------------------------------------------------------------------ worker ----

/**
 * Run the worker once and collect its JSON lines.
 *
 * `onEvent` sees each `{event: ...}` object as it arrives. Resolves with the
 * final `done` event or rejects with the worker's own error message and the
 * stderr tail — a traceback is more use than "exit code 1".
 */
function runWorker(python, spec, { env, onEvent, signal, timeoutMs = 3600000, worker = WORKER } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(GEN, { recursive: true });
    const specFile = path.join(os.tmpdir(), `arcflare-gen-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(specFile, JSON.stringify(spec));

    const child = spawn(python, [worker, specFile], {
      env: env || process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errTail = [];
    let done = null;
    let failure = null;

    const timer = setTimeout(() => {
      failure = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      kill();
    }, timeoutMs);
    function kill() { try { child.kill(); } catch { /* already gone */ } }
    if (signal) signal.addEventListener("abort", () => { failure = "cancelled"; kill(); }, { once: true });

    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === "done") done = ev;
        if (ev.event === "error") failure = ev.message;
        if (onEvent) onEvent(ev);
      }
    });
    child.stderr.on("data", (d) => {
      const lines = d.toString("utf8").split(/\r?\n|\r/).filter((l) => l.trim());
      errTail = errTail.concat(lines).slice(-40);
    });
    child.on("error", (e) => { failure = failure || e.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { fs.unlinkSync(specFile); } catch { /* fine */ }
      if (done && !failure) return resolve(done);
      const err = new Error(failure || `worker exited with code ${code} and reported nothing`);
      err.stderr = errTail.join("\n");
      reject(err);
    });
  });
}

/** What the interpreter can actually do: torch, the device, the model's package. */
async function check(cfg, m) {
  const py = findPython(cfg);
  if (!py) return { ok: false, python: null, problems: ["no Python configured — run `arcflare gen setup`"] };
  try {
    const r = await runWorker(py.path, { action: "check", family: m ? m.family : null },
      { env: m ? workerEnv(m) : process.env, timeoutMs: 120000 });
    return { ok: !(r.problems || []).length, python: py, ...r };
  } catch (e) {
    return { ok: false, python: py, problems: [e.message], stderr: e.stderr };
  }
}

/** Everything `arcflare gen` prints in its table, without spawning Python. */
function status(cfg = {}) {
  const py = findPython(cfg);
  return MODELS.map((m) => ({
    ...m,
    repoPresent: fs.existsSync(repoDir(m)),
    weights: weightsPresent(m),
    python: py,
  }));
}

// ------------------------------------------------------------------- setup ----

const TORCH_INDEX = {
  cuda: "https://download.pytorch.org/whl/cu128",
  cpu: "https://download.pytorch.org/whl/cpu",
  rocm: "https://download.pytorch.org/whl/rocm6.4",
};

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: opts.quiet ? "ignore" : "inherit", windowsHide: true, ...opts });
    child.on("error", (e) => resolve({ code: -1, error: e.message }));
    child.on("close", (code) => resolve({ code }));
  });
}

/**
 * Install what a model needs: a venv, the code repo, its requirements, and —
 * only when asked — torch.
 *
 * Torch is the one thing not installed by default, deliberately. The right
 * wheel depends on the GPU vendor, the driver and the OS, a wrong guess is a
 * multi-GB download of something that then runs on the CPU, and on Windows with
 * an AMD card there is no official wheel at all. So setup says what it found and
 * which flag would install it, rather than picking.
 */
async function setup(cfg, m, { torch, torchFrom, texture, log = console.log } = {}) {
  const steps = [];
  fs.mkdirSync(REPOS, { recursive: true });

  // 1. an interpreter
  let py = findPython(cfg);
  // Borrowed torch is compiled for one Python minor version, so the venv has to
  // be built from the donor's own base interpreter — 3.13 cannot load a 3.12
  // torch, and fails at import rather than here.
  const donor = torchFrom ? pythonFacts(torchFrom) : null;
  if (torchFrom && !donor) throw new Error(`cannot run ${torchFrom}`);
  if (donor && py && py.managed) {
    const mine = pythonFacts(py.path);
    if (mine && mine.minor !== donor.minor) {
      throw new Error(`ArcFlare's venv is Python ${mine.version} but ${torchFrom} is ${donor.version}. ` +
        `Delete ${VENV} and run setup again to rebuild it to match.`);
    }
  }
  if (!py && donor) {
    log(`  creating venv with Python ${donor.version} (to match ${torchFrom}) → ${VENV}`);
    const r = await sh(donor.base, ["-m", "venv", VENV]);
    if (r.code !== 0) throw new Error("could not create the venv");
    py = findPython(cfg);
    steps.push("venv");
  }
  if (!py) {
    const base = findBasePython();
    if (!base) throw new Error("no Python 3.10+ found. Install one, or point ArcFlare at an existing environment: arcflare gen python <path>");
    log(`  creating venv with Python ${base.version} → ${VENV}`);
    const r = await sh(base.cmd, [...base.pre, "-m", "venv", VENV]);
    if (r.code !== 0) throw new Error("could not create the venv");
    py = findPython(cfg);
    steps.push("venv");
  }
  const pip = (args) => sh(py.path, ["-m", "pip", ...args]);
  if (py.managed) await pip(["install", "--upgrade", "pip", "wheel", "setuptools", "-q"]);

  // 2. the code
  const dir = repoDir(m);
  if (!fs.existsSync(dir)) {
    log(`  cloning ${m.repo.url}`);
    const r = await sh("git", ["clone", "--depth", "1", m.repo.url, dir]);
    if (r.code !== 0) throw new Error("git clone failed — is git installed and on PATH?");
    steps.push("repo");
  }

  // 3. torch, only on request. `torchFrom` borrows it from another environment
  // that already has a working GPU build — on AMD under Windows there is no
  // official wheel, and the one that works was usually hand-installed for some
  // other tool. A .pth file makes that environment's packages importable from
  // ours, read-only and *after* our own site-packages, so everything setup
  // installs here wins and nothing is ever written into theirs.
  if (torchFrom) {
    if (!py.managed) throw new Error("--torch-from needs ArcFlare's own venv; unset `arcflare gen python` first");
    const probe = spawnSync(torchFrom, ["-c",
      "import sysconfig,json,torch;print(json.dumps([sysconfig.get_paths()['purelib'],sysconfig.get_paths()['platlib'],torch.__version__]))"],
      { encoding: "utf8", timeout: 120000, windowsHide: true });
    if (probe.status !== 0) throw new Error(`${torchFrom} cannot import torch: ${(probe.stderr || "").trim().split("\n").pop()}`);
    const [pure, plat, ver] = JSON.parse(probe.stdout.trim().split("\n").pop());
    const site = spawnSync(py.path, ["-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"],
      { encoding: "utf8", windowsHide: true }).stdout.trim();
    fs.writeFileSync(path.join(site, "arcflare-torch-from.pth"), [...new Set([pure, plat])].join("\n") + "\n");
    log(`  borrowing torch ${ver} from ${torchFrom}`);
    // torchvision has to be built against the same torch; the PyPI wheel next to
    // a ROCm or custom torch fails at import ("operator torchvision::nms does
    // not exist"). So it is borrowed too, or named as missing — never installed.
    if (m.family.startsWith("hunyuan") &&
        spawnSync(torchFrom, ["-c", "import torchvision"], { windowsHide: true, timeout: 120000 }).status !== 0) {
      log(`  ! ${torchFrom} has no torchvision, and Hunyuan3D imports it. Install the torchvision ` +
        `built for torch ${ver} into that environment (from the same place its torch came from).`);
    }
    steps.push("torch-from");
  } else if (torch) {
    const index = TORCH_INDEX[torch];
    if (!index) throw new Error(`--torch must be one of ${Object.keys(TORCH_INDEX).join(", ")}`);
    if (torch === "rocm" && IS_WIN) {
      throw new Error("there is no official ROCm torch wheel for Windows. Borrow one from an environment " +
        "that already has it: arcflare gen setup <model> --torch-from <path-to-python>");
    }
    log(`  installing torch (${torch})`);
    const r = await pip(["install", "torch", "torchvision", "--index-url", index]);
    if (r.code !== 0) throw new Error("torch install failed");
    steps.push("torch");
  }

  // 4. the repo's own requirements, minus torch: a requirements file that pins
  // torch would replace a working GPU build with whatever PyPI resolves to.
  const reqFile = [path.join(dir, "requirements.txt"), path.join(dir, "hy3dshape", "requirements.txt")]
    .find((f) => fs.existsSync(f));
  if (reqFile) {
    const kept = fs.readFileSync(reqFile, "utf8").split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .filter((l) => !/^(torch|torchvision|torchaudio)\b/i.test(l.trim()))
      // Linux-only wheels that break a Windows install outright.
      .filter((l) => !(IS_WIN && /^(bpy|deepspeed|open3d|pymeshlab)\b/i.test(l.trim())));
    const filtered = path.join(GEN, `requirements-${m.repo.dir}.txt`);
    fs.writeFileSync(filtered, kept.join("\n") + "\n");
    log(`  installing ${kept.length} requirements from ${path.relative(REPOS, reqFile)}`);
    const r = await pip(["install", "-r", filtered]);
    if (r.code !== 0) throw new Error("installing requirements failed — the pip output above says which package");
    steps.push("requirements");
  }
  if (m.family.startsWith("hunyuan")) {
    // Background removal for un-matted photos; Hunyuan imports it lazily.
    await pip(["install", "rembg", "onnxruntime", "-q"]);
  }

  // 5. texture extensions, only on request: CUDA source that has to compile.
  if (texture) {
    if (!m.texture) throw new Error(`${m.label} has no texture stage wired up`);
    for (const sub of ["hy3dgen/texgen/custom_rasterizer", "hy3dgen/texgen/differentiable_renderer"]) {
      const at = path.join(dir, sub);
      if (!fs.existsSync(at)) continue;
      log(`  building ${sub} (needs the CUDA toolkit and a C++ compiler)`);
      const r = await sh(py.path, ["-m", "pip", "install", "--no-build-isolation", "."], { cwd: at });
      if (r.code !== 0) throw new Error(`building ${sub} failed — texturing needs an NVIDIA card with the CUDA toolkit`);
    }
    steps.push("texture");
  }

  return { python: py, steps, check: await check(cfg, m) };
}

// --------------------------------------------------------------------- run ----

function defaultOut(m, { image, prompt, cwd = process.cwd() }) {
  if (image) {
    const base = path.basename(image).replace(/\.[^.]+$/, "");
    return path.join(cwd, `${base}-${m.id}.glb`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const slug = String(prompt || "mesh").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "");
  return path.join(OUT, `${slug || "mesh"}-${m.id}-${Date.now().toString(36)}.glb`);
}

/**
 * Generate one mesh. Exactly one of `image` or `prompt`.
 *
 * A prompt is turned into an image first (HunyuanDiT, inside the worker), then
 * meshed like any other image — which is also why a prompt is the worse input:
 * the mesh reproduces whatever that image got wrong. A picture you chose is
 * better than one generated for you.
 */
async function generate(cfg, opts) {
  const m = byId(opts.model);
  if (!m) throw new Error(`unknown model "${opts.model}". Known: ${MODELS.map((x) => x.id).join(", ")}`);
  if (!opts.image && !opts.prompt) throw new Error("give an image, or --prompt for text-to-3D");
  if (opts.image && !fs.existsSync(opts.image)) throw new Error(`no such image: ${opts.image}`);
  if (opts.prompt && !m.text) throw new Error(`${m.label} is image-only; use a hunyuan3d-2 model for --prompt`);
  if (opts.texture && !m.texture) throw new Error(`${m.label} cannot texture here; drop --texture or use a hunyuan3d-2 model`);

  const py = findPython(cfg);
  if (!py) throw new Error("no Python environment yet — run `arcflare gen setup " + m.id + "`");
  if (!fs.existsSync(repoDir(m))) throw new Error(`${m.label} code is not installed — run \`arcflare gen setup ${m.id}\``);

  const out = path.resolve(opts.out || defaultOut(m, opts));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const spec = {
    action: "generate",
    family: m.family,
    hf: m.hf,
    subfolder: m.subfolder || null,
    turbo: !!m.turbo,
    image: opts.image ? path.resolve(opts.image) : null,
    prompt: opts.prompt || null,
    out,
    steps: Number(opts.steps) || m.steps,
    seed: opts.seed == null ? 1234 : Number(opts.seed),
    octree: Number(opts.octree) || 256,
    faces: opts.faces == null ? 40000 : Number(opts.faces),
    texture: !!opts.texture,
    removeBackground: opts.removeBackground !== false,
    device: opts.device || null,
  };
  const started = Date.now();
  const done = await runWorker(py.path, spec, {
    env: workerEnv(m), onEvent: opts.onEvent, signal: opts.signal, timeoutMs: opts.timeoutMs,
  });
  let bytes = 0;
  try { bytes = fs.statSync(done.file).size; } catch { /* reported below */ }
  if (!bytes) throw new Error(`the worker reported success but ${done.file} is missing or empty`);
  return { ...done, model: m.id, bytes, ms: Date.now() - started };
}

// -------------------------------------------------------------------- jobs ----
//
// For the MCP tool. A mesh takes seconds on a fast GPU and many minutes on a
// CPU or on a first run that downloads weights, and an MCP call has a ceiling.
// So a call waits as long as it reasonably can and otherwise hands back a job
// id — the work keeps going either way.

const jobs = new Map();
let jobSeq = 0;

function startJob(cfg, opts) {
  const id = `g${++jobSeq}`;
  const ac = new AbortController();
  const job = { id, model: opts.model || DEFAULT_MODEL, state: "running", stage: "starting",
    started: Date.now(), result: null, error: null, abort: () => ac.abort() };
  job.promise = generate(cfg, {
    ...opts,
    signal: ac.signal,
    onEvent: (ev) => { if (ev.event === "stage") job.stage = ev.stage; },
  }).then((r) => { job.state = "done"; job.result = r; return job; },
    (e) => { job.state = "failed"; job.error = e.message; job.stderr = e.stderr; return job; });
  jobs.set(id, job);
  return job;
}

async function waitJob(job, ms) {
  await Promise.race([job.promise, new Promise((r) => setTimeout(r, ms))]);
  return job;
}

module.exports = {
  MODELS, DEFAULT_MODEL, byId, findPython, findBasePython, status, check, setup, generate,
  weightsPresent, repoDir, workerEnv, runWorker, defaultOut, startJob, waitJob, jobs,
  GEN, VENV, WEIGHTS, HF_CACHE, TORCH_INDEX,
};
