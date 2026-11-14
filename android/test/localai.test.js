"use strict";
// Local AI: the per-phone settings (lib/hub/ui/localai.js profile()), and that the app's Arc Pocket matches its
// Modelfile and its model list matches ModelCatalog.java.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repo = path.join(__dirname, "..", "..");
const win = {};
win.window = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(repo, "lib", "hub", "ui", "localai.js"), "utf8"), win);
const L = win.ArcFlareLocalAI;

const MODELS = [
  { id: "qwen3-0.6b", name: "Qwen3 0.6B", size: 639446688, minRamMb: 3000 },
  { id: "qwen3-1.7b", name: "Qwen3 1.7B", size: 1834426016, minRamMb: 7000 },
];
const phone = (o) => Object.assign({ available: true, ramMb: 8000, models: MODELS }, o);

test("phones people use get their own chip's settings", () => {
  const cases = [
    // [what Android reports, chip name, threads, recommended model]
    [{ socModel: "SM8450", board: "taro", ramMb: 7600 }, "Snapdragon 8 Gen 1", 4, "qwen3-0.6b"],          // Galaxy S22
    [{ hardware: "s5e9925", ramMb: 7600 }, "Exynos 2200", 4, "qwen3-0.6b"],                               // Galaxy S22 (Exynos)
    [{ socModel: "SM8550", ramMb: 7600 }, "Snapdragon 8 Gen 2", 4, "qwen3-1.7b"],                           // Galaxy S23, OnePlus 11
    [{ socModel: "SM8650", ramMb: 11500 }, "Snapdragon 8 Gen 3", 5, "qwen3-1.7b"],                          // Galaxy S24 Ultra, OnePlus 12, Xiaomi 14
    [{ hardware: "s5e9945", ramMb: 7600 }, "Exynos 2400", 6, "qwen3-1.7b"],                               // Galaxy S24 (Exynos)
    [{ socModel: "SM8750", board: "sun", ramMb: 11500 }, "Snapdragon 8 Elite", 6, "qwen3-1.7b"],            // Galaxy S25
    [{ socModel: "SM8475", ramMb: 11500 }, "Snapdragon 8+ Gen 1", 4, "qwen3-1.7b"],                         // Nothing Phone (2)
    [{ socModel: "MT6886", ramMb: 7600 }, "MediaTek", 4, "qwen3-0.6b"],                                     // Nothing Phone (2a)
    [{ hardware: "gs201", ramMb: 7600 }, "Google Tensor G2", 4, "qwen3-0.6b"],                              // Pixel 7
    [{ board: "zuma", ramMb: 7600 }, "Google Tensor G3", 4, "qwen3-1.7b"],                                  // Pixel 8
    [{ board: "zumapro", ramMb: 11500 }, "Google Tensor G4", 4, "qwen3-1.7b"],                              // Pixel 9
    [{ socModel: "MT6989", ramMb: 11500 }, "Dimensity 9300", 6, "qwen3-1.7b"],                              // vivo X100
    [{ socModel: "SM7550", ramMb: 7600 }, "Snapdragon 7 series", 4, "qwen3-0.6b"],                          // Motorola edge
    [{ hardware: "kirin9000", ramMb: 7600 }, "Kirin 9000 series", 4, "qwen3-0.6b"],                         // Huawei P50
  ];
  for (const [info, chip, threads, rec] of cases) {
    const p = L.profile(phone(info));
    assert.equal(p.chip, chip, JSON.stringify(info));
    assert.equal(p.known, true);
    assert.equal(p.threads, threads, chip);
    assert.equal(p.recommended, rec, chip);
    assert.equal(p.problem, null);
  }
});

test("a chip we have no entry for: settings from RAM and core speeds, never the big model", () => {
  const p = L.profile(phone({ socModel: "XYZ123", ramMb: 12000, maxFreqsKHz: [2000000, 2000000, 3000000, 3000000, 3200000, 1800000] }));
  assert.equal(p.known, false);
  assert.equal(p.chip, "a chip we have no settings for");
  assert.equal(p.threads, 3, "the cores within 75 % of the fastest");
  assert.equal(p.recommended, "qwen3-0.6b");
  assert.equal(p.ctx, 2048);
  assert.equal(L.profile(phone({ ramMb: 6000 })).threads, 4, "no speeds: four threads");
});

test("only models that fit in RAM are offered; no 64-bit ARM or too little RAM says why", () => {
  assert.deepEqual(L.profile(phone({ socModel: "SM8650", ramMb: 5800 })).models.map((m) => m.id), ["qwen3-0.6b"]);
  assert.equal(L.profile(phone({ socModel: "SM8650", ramMb: 5800 })).recommended, "qwen3-0.6b");
  assert.match(L.profile(phone({ available: false })).problem, /64-bit ARM/);
  assert.match(L.profile(phone({ ramMb: 2000 })).problem, /too little memory/);
  assert.equal(L.profile(null).problem !== null, true);
});

test("Arc Pocket: the app's instructions and sampling are its Modelfile's, and its bases are ModelCatalog's", () => {
  const mf = fs.readFileSync(path.join(repo, "lib", "arcs", "arc-pocket.Modelfile"), "utf8");
  const system = /SYSTEM """\n([\s\S]*?)\n"""/.exec(mf)[1];
  assert.equal(L.SYSTEM, system);
  const cpp = fs.readFileSync(path.join(__dirname, "..", "android", "app", "src", "main", "cpp", "arcflare_llm.cpp"), "utf8");
  const param = (k) => Number(new RegExp("PARAMETER " + k + " ([\\d.]+)").exec(mf)[1]);
  const set = (k) => Number(new RegExp("sp\\." + k + " = ([\\d.]+)f?;").exec(cpp)[1]);
  assert.equal(set("temp"), param("temperature"));
  assert.equal(set("top_p"), param("top_p"));
  assert.equal(set("top_k"), param("top_k"));
  assert.equal(set("min_p"), param("min_p"));
  const java = fs.readFileSync(path.join(__dirname, "..", "android", "app", "src", "main", "java", "net", "arcflare", "app", "ModelCatalog.java"), "utf8");
  for (const [, repoName] of mf.matchAll(/^# arcflare: base \S+ (\S+?):Q8_0 /gm)) assert.ok(java.includes("https://huggingface.co/" + repoName + "/resolve/"), repoName);
  for (const m of MODELS) assert.ok(java.includes('new Model("' + m.id + '", "' + m.name + '"') && java.includes(m.size + "L"), m.id);
});
