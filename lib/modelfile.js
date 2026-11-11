// Modelfiles: a model described in a text file.
//
// The format is Ollama's, because that is the one people already know:
//
//   FROM unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
//   PARAMETER temperature 0.7
//   SYSTEM """
//   You are ...
//   """
//
// FROM names the weights, PARAMETER sets how to sample from them, SYSTEM is
// what the model is told first. An Arc is exactly this, so ArcFlare's own are
// written as Modelfiles (lib/arcs/*.Modelfile) and anyone can make one with
// `arcflare create`.
//
// What ArcFlare adds is carried in comments, so the same file still loads in
// Ollama: `# arcflare: name Arc Code`, and `# arcflare: base ...` lines for
// the other sizes an Arc can run on, since one name has to work on a laptop
// and on a workstation.
//
// Not supported, and said so rather than silently dropped: TEMPLATE and
// ADAPTER. llama.cpp takes the chat template from the GGUF, and there is no
// LoRA loading here.

const PARAMS = {
  temperature: "number", top_p: "number", top_k: "integer", min_p: "number",
  repeat_penalty: "number", presence_penalty: "number", frequency_penalty: "number",
  seed: "integer", num_ctx: "integer", num_predict: "integer", stop: "string",
};

const REF = /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `"""multi-line"""`, `"quoted"` or the rest of the line: the three ways a value is written. */
function readValue(lines, i, first) {
  const rest = first.trimStart();
  if (rest.startsWith('"""')) {
    const after = rest.slice(3);
    const end = after.indexOf('"""');
    if (end >= 0) return { value: after.slice(0, end), next: i + 1 };
    const out = [after];
    for (let j = i + 1; j < lines.length; j++) {
      const k = lines[j].indexOf('"""');
      if (k >= 0) { out.push(lines[j].slice(0, k)); return { value: out.join("\n").replace(/^\n/, "").replace(/\n$/, ""), next: j + 1 }; }
      out.push(lines[j]);
    }
    return { value: out.join("\n"), next: lines.length, unterminated: true };
  }
  const q = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(rest);
  if (q) { try { return { value: JSON.parse(`"${q[1]}"`), next: i + 1 }; } catch { /* as written */ } }
  return { value: rest.trim(), next: i + 1 };
}

/**
 * Read a Modelfile.
 * @returns {{ from, bases, system, parameters, license, messages, meta, errors, warnings }}
 *   `from` is the FROM line as written; `bases` are the `# arcflare: base` lines;
 *   `meta` holds name, focus, description, side, group and needs.
 */
function parse(text) {
  const out = { from: null, bases: [], system: "", parameters: {}, license: [], messages: [], meta: {}, errors: [], warnings: [] };
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    if (t.startsWith("#")) {
      const m = /^#\s*arcflare:\s*(\w+)\s+(.*)$/i.exec(t);
      if (m) {
        const key = m[1].toLowerCase(), val = m[2].trim();
        if (key === "base") {
          // slug ref 8GB licence
          const b = /^(\S+)\s+(\S+)\s+([\d.]+)\s*GB(?:\s+(.+))?$/i.exec(val);
          if (b && REF.test(b[2])) out.bases.push({ slug: b[1], ref: b[2], gb: Number(b[3]), license: (b[4] || "").trim() });
          else out.errors.push(`line ${i + 1}: a base is written "# arcflare: base <name> <owner/repo[:quant]> <N>GB <licence>"`);
        } else if (key === "needs") out.meta.needs = val.split(/[\s,]+/).filter((n) => n === "web" || n === "desktop");
        else if (["name", "focus", "description", "side", "group"].includes(key)) out.meta[key] = val;
      }
      i++;
      continue;
    }
    const m = /^([A-Za-z]+)(\s+|$)(.*)$/.exec(t);
    if (!m) { out.errors.push(`line ${i + 1}: not an instruction: ${t.slice(0, 40)}`); i++; continue; }
    const word = m[1].toUpperCase();
    const rest = line.slice(line.toUpperCase().indexOf(word) + word.length);
    if (word === "FROM") {
      const v = rest.trim();
      if (!v) out.errors.push(`line ${i + 1}: FROM needs a model`);
      else if (out.from) out.errors.push(`line ${i + 1}: only one FROM; other sizes go in "# arcflare: base" lines`);
      else out.from = v;
      i++;
    } else if (word === "SYSTEM") {
      const r = readValue(lines, i, rest);
      if (r.unterminated) out.errors.push(`line ${i + 1}: SYSTEM """ is never closed`);
      out.system = r.value;
      i = r.next;
    } else if (word === "PARAMETER") {
      const p = /^\s*(\S+)\s+(.+)$/.exec(rest);
      if (!p) { out.errors.push(`line ${i + 1}: PARAMETER needs a name and a value`); i++; continue; }
      const name = p[1].toLowerCase();
      const raw = readValue(lines, i, p[2]).value;
      const kind = PARAMS[name];
      if (!kind) out.warnings.push(`line ${i + 1}: PARAMETER ${name} is not one ArcFlare uses; ignored`);
      else if (kind === "string") (out.parameters[name] = out.parameters[name] || []).push(String(raw));
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || (kind === "integer" && !Number.isInteger(n))) out.errors.push(`line ${i + 1}: PARAMETER ${name} must be ${kind === "integer" ? "a whole number" : "a number"}`);
        else out.parameters[name] = n;
      }
      i++;
    } else if (word === "LICENSE") {
      const r = readValue(lines, i, rest);
      if (r.value) out.license.push(r.value);
      i = r.next;
    } else if (word === "MESSAGE") {
      const p = /^\s*(system|user|assistant)\s+(.*)$/i.exec(rest);
      if (!p) { out.errors.push(`line ${i + 1}: MESSAGE needs a role (user or assistant) and text`); i++; continue; }
      const r = readValue(lines, i, p[2]);
      out.messages.push({ role: p[1].toLowerCase(), content: r.value });
      i = r.next;
    } else if (word === "TEMPLATE" || word === "ADAPTER") {
      const r = readValue(lines, i, rest);
      out.warnings.push(`line ${i + 1}: ${word} is not supported (${word === "TEMPLATE" ? "the chat template comes from the model file" : "there is no adapter loading"}); ignored`);
      i = r.next;
    } else {
      out.errors.push(`line ${i + 1}: unknown instruction ${m[1]}`);
      i++;
    }
  }
  if (!out.from) out.errors.push("no FROM line: a Modelfile starts from a model");
  return out;
}

const block = (text) => (/\n|"/.test(text) ? `"""\n${text}\n"""` : JSON.stringify(text));

/**
 * Write a Modelfile from its parts.
 * @param {boolean} [o.hideSystem]  put a placeholder where the instructions are (ArcFlare's own are not shown)
 */
function render(m, { hideSystem = false } = {}) {
  const out = [];
  const meta = m.meta || {};
  for (const k of ["name", "focus", "description", "side", "group"]) if (meta[k]) out.push(`# arcflare: ${k} ${meta[k]}`);
  if (meta.needs && meta.needs.length) out.push(`# arcflare: needs ${meta.needs.join(" ")}`);
  for (const b of m.bases || []) out.push(`# arcflare: base ${b.slug} ${b.ref} ${b.gb}GB${b.license ? " " + b.license : ""}`);
  if (out.length) out.push("");
  out.push(`FROM ${m.from}`);
  for (const [k, v] of Object.entries(m.parameters || {})) {
    for (const one of Array.isArray(v) ? v : [v]) out.push(`PARAMETER ${k} ${typeof one === "string" ? JSON.stringify(one) : one}`);
  }
  if (hideSystem) out.push(`SYSTEM """ArcFlare's instructions for this Arc. They are not published."""`);
  else if (m.system) out.push(`SYSTEM ${block(m.system)}`);
  for (const msg of m.messages || []) out.push(`MESSAGE ${msg.role} ${block(msg.content)}`);
  for (const l of m.license || []) out.push(`LICENSE ${block(l)}`);
  return out.join("\n") + "\n";
}

/** The sampling settings a server request takes, from a Modelfile's PARAMETER lines. */
function sampling(parameters = {}) {
  const s = {};
  for (const k of ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty", "seed"]) {
    if (parameters[k] !== undefined) s[k] = parameters[k];
  }
  if (parameters.num_predict !== undefined) s.max_tokens = parameters.num_predict;
  if (parameters.stop && parameters.stop.length) s.stop = parameters.stop;
  return s;
}

module.exports = { parse, render, sampling, PARAMS, REF, NAME };
