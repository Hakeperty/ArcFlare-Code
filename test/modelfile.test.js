// Modelfiles: the text an Arc is written in. Ollama's format, plus ArcFlare's
// additions carried in comments, so one file works in both.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const modelfile = require("../lib/modelfile");
const arcs = require("../lib/arcs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "af-mf-"));

test("FROM, PARAMETER and SYSTEM are read the way Ollama writes them", () => {
  const m = modelfile.parse(`# a comment
FROM unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
parameter temperature 0.3
PARAMETER top_k 40
PARAMETER stop "</s>"
PARAMETER stop "USER:"
SYSTEM """
You are Pirate.
Say "arr".
"""
MESSAGE user Ahoy
MESSAGE assistant "Arr."
LICENSE """Apache-2.0"""
`);
  assert.deepStrictEqual(m.errors, []);
  assert.strictEqual(m.from, "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M");
  assert.deepStrictEqual(m.parameters, { temperature: 0.3, top_k: 40, stop: ["</s>", "USER:"] });
  assert.strictEqual(m.system, 'You are Pirate.\nSay "arr".');
  assert.deepStrictEqual(m.messages, [{ role: "user", content: "Ahoy" }, { role: "assistant", content: "Arr." }]);
  assert.deepStrictEqual(m.license, ["Apache-2.0"]);
  assert.deepStrictEqual(modelfile.sampling(m.parameters), { temperature: 0.3, top_k: 40, stop: ["</s>", "USER:"] });
  // One-line forms.
  assert.strictEqual(modelfile.parse('FROM m\nSYSTEM You are brief.').system, "You are brief.");
  assert.strictEqual(modelfile.parse('FROM m\nSYSTEM "Quoted \\"x\\""').system, 'Quoted "x"');
});

test("what is wrong with a Modelfile is said by line; what is only unused is a warning", () => {
  const bad = modelfile.parse("PARAMETER temperature hot\nPARAMETER top_k 1.5\nBOGUS x\nSYSTEM \"\"\"never closed");
  assert.match(bad.errors.join("\n"), /line 1: PARAMETER temperature must be a number/);
  assert.match(bad.errors.join("\n"), /line 2: PARAMETER top_k must be a whole number/);
  assert.match(bad.errors.join("\n"), /line 3: unknown instruction BOGUS/);
  assert.match(bad.errors.join("\n"), /SYSTEM """ is never closed/);
  assert.match(bad.errors.join("\n"), /no FROM line/);
  assert.match(modelfile.parse("FROM a\nFROM b").errors.join(), /only one FROM/);
  const soft = modelfile.parse('FROM m\nPARAMETER mirostat 2\nTEMPLATE """{{ .Prompt }}"""\nADAPTER ./lora.gguf');
  assert.deepStrictEqual(soft.errors, []);
  assert.strictEqual(soft.warnings.length, 3);
  assert.match(soft.warnings.join("\n"), /TEMPLATE is not supported \(the chat template comes from the model file\)/);
});

test("ArcFlare's additions ride in comments, and a file survives being written and read back", () => {
  const src = {
    meta: { name: "Arc Test", focus: "Testing", description: "For tests.", side: "standard", group: "task", needs: ["web"] },
    bases: [{ slug: "small", ref: "o/Small-GGUF:Q4_K_M", gb: 4, license: "MIT" }, { slug: "big", ref: "o/Big-GGUF:Q4_K_M", gb: 20, license: "Apache-2.0" }],
    from: "o/Big-GGUF:Q4_K_M", parameters: { temperature: 0.4, top_p: 0.9 },
    system: 'You are Arc Test.\n\nSecond paragraph with "quotes".', license: ["MIT"],
  };
  const text = modelfile.render(src);
  // Every ArcFlare line is a comment to anything else that reads the file.
  for (const line of text.split("\n")) if (/arcflare:/.test(line)) assert.ok(line.startsWith("#"), line);
  const back = modelfile.parse(text);
  assert.deepStrictEqual(back.errors, []);
  assert.deepStrictEqual(back.meta, src.meta);
  assert.deepStrictEqual(back.bases, src.bases);
  assert.strictEqual(back.from, src.from);
  assert.deepStrictEqual(back.parameters, src.parameters);
  assert.strictEqual(back.system, src.system);
  // Shown without the instructions: the placeholder, and none of the text.
  const hidden = modelfile.render(src, { hideSystem: true });
  assert.doesNotMatch(hidden, /Second paragraph/);
  assert.match(hidden, /SYSTEM """ArcFlare's instructions for this Arc\. They are not published\."""/);
});

test("ArcFlare's own Arcs are Modelfiles, and are shown without their instructions", () => {
  const dir = path.join(__dirname, "..", "lib", "arcs");
  const files = [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, "unbound")).map((f) => "unbound/" + f)].filter((f) => f.endsWith(".Modelfile"));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const m = modelfile.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.deepStrictEqual(m.errors, [], f);
    assert.deepStrictEqual(m.warnings, [], f);
    assert.ok(m.bases.some((b) => b.ref === m.from), `${f}: FROM is one of its bases`);
    assert.strictEqual(/unbound\//.test(f), m.meta.side === "abliterated", f);
  }
  const code = arcs.find("arc-code", { file: path.join(tmp(), "x"), customDir: tmp() });
  const shown = arcs.toModelfile(code);
  assert.match(shown, /^FROM unsloth\/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M$/m);
  assert.match(shown, /PARAMETER temperature 0\.4/);
  assert.doesNotMatch(shown, /You are Arc Code/);
});

test("arcflare create: a model of your own from a Modelfile, run as written", () => {
  const dir = tmp();
  const opts = { file: path.join(dir, "none.dat"), customDir: dir };
  const made = arcs.create("pirate", 'FROM unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M\nPARAMETER temperature 0.3\nSYSTEM """You are Pirate."""\n', { dir });
  assert.strictEqual(made.arc.id, "pirate");
  assert.strictEqual(made.arc.custom, true);
  const p = arcs.find("pirate", opts);
  assert.deepStrictEqual(p.sampling, { temperature: 0.3 });
  assert.ok(arcs.looksLikeArc("pirate", opts));
  // Your instructions are yours: nothing added, nothing kept quiet, and the file is shown as you wrote it.
  assert.strictEqual(arcs.compose(p, { surface: "chat" }), "You are Pirate.");
  assert.match(arcs.toModelfile(p, { dir }), /SYSTEM """You are Pirate\."""/);
  // It runs on that repo's model when it is here, whatever the quant.
  const here = { id: "qwen3.8-27b:ud-q4_k_m", file: "/m/Qwen3.8-27B-UD-Q4_K_M.gguf" };
  assert.strictEqual(arcs.pickBase(p, { local: [here], freeGb: 24 }).model, here);
  assert.strictEqual(arcs.pickBase(p, { local: [], freeGb: 24 }).installed, false);

  // FROM a model already on this machine, by its name in `arcflare ls`.
  arcs.create("mine", "FROM gemma4-12b\nSYSTEM Short answers.", { dir });
  const local = { id: "gemma4-12b:q4_k_m", file: "/m/gemma-4-12b-it-Q4_K_M.gguf" };
  assert.strictEqual(arcs.pickBase(arcs.find("mine", opts), { local: [local, here] }).model, local);

  assert.throws(() => arcs.create("arc-code", "FROM x", { dir }), /one of ArcFlare's own/);
  assert.throws(() => arcs.create("Bad Name", "FROM x", { dir }), /a name is lowercase/);
  assert.throws(() => arcs.create("broken", "SYSTEM hi", { dir }), /no FROM line/);
  assert.strictEqual(arcs.remove("pirate", { dir }), true);
  assert.strictEqual(arcs.find("pirate", opts), null);
  assert.strictEqual(arcs.remove("../../etc/passwd", { dir }), false);
});
