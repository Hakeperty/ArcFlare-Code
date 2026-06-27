// ArcFlare's own local inference engine. Embeds llama.cpp (via node-llama-cpp)
// so models run in-process — no external app or server required. Inspired by
// Ollama, but self-contained.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const MODELS_DIR = path.join(HOME, "models");

let _llama = null;
async function llama() {
  if (_llama) return _llama;
  const m = await import("node-llama-cpp");
  // Auto-selects the best available backend (Metal/CUDA/Vulkan) and falls back
  // to CPU if no GPU build is present. logLevel "error" keeps the fallback
  // notice out of the CLI output.
  _llama = await m.getLlama({ logLevel: "error" });
  return _llama;
}

/** The active backend: "metal" | "cuda" | "vulkan" | false (CPU). */
async function activeBackend() {
  const l = await llama();
  return l.gpu;
}

/** Build/enable a specific GPU backend (needs the matching SDK installed). */
async function buildBackend(backend) {
  const m = await import("node-llama-cpp");
  const l = await m.getLlama({ gpu: backend });
  _llama = l; // adopt the GPU-enabled instance
  return l.gpu;
}

// Loaded models are cached so repeated runs/requests don't re-read the GGUF.
const _models = new Map();
async function loadModel(modelPath) {
  if (_models.has(modelPath)) return _models.get(modelPath);
  const l = await llama();
  const model = await l.loadModel({ modelPath });
  _models.set(modelPath, model);
  return model;
}

function fileNameFromUrl(url) {
  return url.split("/").pop().split("?")[0];
}

function localPathFor(url) {
  return path.join(MODELS_DIR, fileNameFromUrl(url));
}

function isDownloaded(url) {
  return fs.existsSync(localPathFor(url));
}

/** Download a GGUF to the models dir. onProgress(downloadedBytes, totalBytes). */
async function download(url, onProgress) {
  const m = await import("node-llama-cpp");
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const downloader = await m.createModelDownloader({
    modelUri: url,
    dirPath: MODELS_DIR,
    onProgress: (s) => onProgress && onProgress(s.downloadedSize, s.totalSize),
  });
  return await downloader.download();
}

/** A persistent chat session (keeps history) for interactive use. */
async function createSession(modelPath, systemPrompt, contextSize = 2048) {
  const m = await import("node-llama-cpp");
  const model = await loadModel(modelPath);
  const context = await model.createContext({ contextSize });
  const session = new m.LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: systemPrompt || undefined,
  });
  return {
    async prompt(text, onToken) {
      return session.prompt(text, { onTextChunk: (t) => onToken && onToken(t) });
    },
    async dispose() {
      try { await context.dispose(); } catch {}
    },
  };
}

/** One-shot completion from a messages array (system + last user message). */
async function chatOnce(modelPath, messages, onToken, contextSize = 2048) {
  const system = messages.find((x) => x.role === "system");
  const lastUser = [...messages].reverse().find((x) => x.role === "user");
  const s = await createSession(modelPath, system && system.content, contextSize);
  try {
    return await s.prompt(lastUser ? lastUser.content : "", onToken);
  } finally {
    await s.dispose();
  }
}

module.exports = {
  MODELS_DIR,
  llama,
  activeBackend,
  buildBackend,
  download,
  isDownloaded,
  localPathFor,
  fileNameFromUrl,
  createSession,
  chatOnce,
};
