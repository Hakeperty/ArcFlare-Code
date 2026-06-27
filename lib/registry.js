// Bundled registry of real, openly-available models. This is public metadata
// only (name, author, license, sizes) — running a model pulls its weights from
// the configured backend, not from this file.

const models = [
  { slug: "qwen2.5", author: "Alibaba Qwen", category: "Chat", license: "Apache-2.0", sizes: ["0.5b", "1.5b", "7b", "14b", "32b"], description: "Multilingual LLM series with strong instruction following and 128K context." },
  { slug: "qwen2.5-coder", author: "Alibaba Qwen", category: "Code", license: "Apache-2.0", sizes: ["1.5b", "7b", "32b"], description: "Code-specialized Qwen2.5 with fill-in-the-middle support." },
  { slug: "llama3.2", author: "Meta", category: "Chat", license: "Llama 3.2 Community", sizes: ["1b", "3b"], description: "Compact, on-device-friendly Llama models." },
  { slug: "llama3.1", author: "Meta", category: "Chat", license: "Llama 3.1 Community", sizes: ["8b", "70b"], description: "Strong general-purpose model family with a 128K context." },
  { slug: "mistral", author: "Mistral AI", category: "Chat", license: "Apache-2.0", sizes: ["7b"], description: "Fast, efficient, fully open 7B model." },
  { slug: "mixtral", author: "Mistral AI", category: "Reasoning", license: "Apache-2.0", sizes: ["8x7b"], description: "Sparse mixture-of-experts model with high inference efficiency." },
  { slug: "gemma2", author: "Google", category: "Chat", license: "Gemma", sizes: ["2b", "9b", "27b"], description: "Google's open models built from Gemini research." },
  { slug: "phi4", author: "Microsoft", category: "Reasoning", license: "MIT", sizes: ["14b"], description: "14B model with outsized reasoning ability." },
  { slug: "deepseek-r1", author: "DeepSeek", category: "Reasoning", license: "MIT", sizes: ["1.5b", "7b", "8b", "14b", "32b"], description: "Open reasoning model trained with reinforcement learning." },
  { slug: "nomic-embed-text", author: "Nomic AI", category: "Embedding", license: "Apache-2.0", sizes: ["137m"], description: "High-performing open text embedding model with 8K context." },
  { slug: "mxbai-embed-large", author: "Mixedbread AI", category: "Embedding", license: "Apache-2.0", sizes: ["335m"], description: "State-of-the-art English embedding model." },
  { slug: "moondream", author: "vikhyat", category: "Vision", license: "Apache-2.0", sizes: ["1.8b"], description: "Tiny, fast vision-language model for the edge." },
  { slug: "starcoder2", author: "BigCode", category: "Code", license: "BigCode OpenRAIL-M", sizes: ["3b", "7b", "15b"], description: "Open code models across 600+ languages." },
  { slug: "whisper", author: "OpenAI", category: "Audio", license: "MIT", sizes: ["base", "large-v3"], description: "Robust multilingual speech-to-text." },
  { slug: "flux.1-schnell", author: "Black Forest Labs", category: "Image", license: "Apache-2.0", sizes: ["12b"], description: "Fast, fully open text-to-image model (1–4 steps)." },
  { slug: "flux.1-dev", author: "Black Forest Labs", category: "Image", license: "FLUX.1 [dev] Non-Commercial", sizes: ["12b"], description: "High-quality text-to-image model (non-commercial)." },
  { slug: "stable-diffusion-3.5", author: "Stability AI", category: "Image", license: "Stability AI Community", sizes: ["8b"], description: "Powerful text-to-image diffusion transformer." },
  { slug: "sdxl", author: "Stability AI", category: "Image", license: "OpenRAIL++-M", sizes: ["3.5b"], description: "Widely-used open text-to-image model." },
];

function find(name) {
  if (!name) return undefined;
  const base = String(name).split(":")[0].toLowerCase();
  return models.find((m) => m.slug.toLowerCase() === base);
}

function search(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.slug.toLowerCase().includes(q) ||
      m.author.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q),
  );
}

module.exports = { models, find, search };
