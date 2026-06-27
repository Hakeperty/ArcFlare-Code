// Local backend: a tiny on-disk store of installed models at ~/.arcflare.
// Real, persistent state (install/list/edit/remove) without bundling weights.

const fs = require("fs");
const path = require("path");
const os = require("os");

const DIR = process.env.ARCFLARE_HOME || path.join(os.homedir(), ".arcflare");
const FILE = path.join(DIR, "store.json");

function ensure() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { models: {} };
  }
}

function save(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function get(slug) {
  return load().models[slug];
}

function listInstalled() {
  return Object.values(load().models).sort(
    (a, b) => (b.lastUsed || b.installedAt) - (a.lastUsed || a.installedAt),
  );
}

function install(model, tag = "latest") {
  const data = load();
  const existing = data.models[model.slug];
  data.models[model.slug] = {
    slug: model.slug,
    base: model.base || model.slug, // backend model name (custom models keep their base)
    tag,
    size: model.sizes && model.sizes[0] ? model.sizes[0] : model.size || "—",
    author: model.author,
    license: model.license,
    category: model.category,
    gguf: model.gguf || (existing ? existing.gguf : undefined),
    file: model.file || (existing ? existing.file : undefined),
    system: existing ? existing.system : "",
    params: existing ? existing.params : {},
    installedAt: existing ? existing.installedAt : Date.now(),
    lastUsed: existing ? existing.lastUsed : null,
  };
  save(data);
  return data.models[model.slug];
}

function remove(slug) {
  const data = load();
  const existed = Boolean(data.models[slug]);
  delete data.models[slug];
  save(data);
  return existed;
}

function touch(slug) {
  const data = load();
  if (data.models[slug]) {
    data.models[slug].lastUsed = Date.now();
    save(data);
  }
}

function setConfig(slug, patch) {
  const data = load();
  if (!data.models[slug]) return false;
  Object.assign(data.models[slug], patch);
  save(data);
  return true;
}

module.exports = {
  DIR,
  FILE,
  load,
  save,
  get,
  listInstalled,
  install,
  remove,
  touch,
  setConfig,
};
