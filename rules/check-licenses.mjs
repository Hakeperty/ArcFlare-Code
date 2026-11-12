#!/usr/bin/env node
// Licence check, run before every push (see rules/06-licensing.md).
//
//   node rules/check-licenses.mjs
//
// 1. Every package we ship (package-lock.json, not dev-only) must carry a
//    licence on the allowlist below. Anything else fails: GPL, AGPL, SSPL,
//    "UNLICENSED", "SEE LICENSE IN ..." or no licence at all. Add an
//    exception to EXCEPTIONS only after the owner has said yes, with the
//    reason next to it.
// 2. In the website repo, every model in lib/models.ts must name a licence
//    that lib/licenses.ts explains (LICENSE_INFO), so the /licenses page never
//    lists a model without its terms.
//
// No dependencies. Exits 1 and prints every problem when something is wrong.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const problems = [];

// Licences that let us ship the code inside our own MIT apps, given the
// notices are kept. Everything else needs the owner's sign-off.
const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0",
  "Unlicense", "CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "BlueOak-1.0.0", "Python-2.0",
  "Zlib", "MPL-2.0", "WTFPL", "OFL-1.1",
]);

// "package-name" (or "prefix*") → { why, applies(rootPackageJson) }. New
// entries need the owner's yes; say so in the commit body.
const EXCEPTIONS = {
  // Next.js's optional image optimiser. libvips is LGPL-3.0, dynamically
  // linked, and runs only on the web server: nothing is handed to visitors,
  // so the LGPL's distribution terms are not triggered. Only in the website:
  // in the CLI or the desktop app it would be shipped, so it fails there.
  "@img/sharp-*": { why: "LGPL libvips, server-side only", applies: (root) => Boolean(root.dependencies?.next) },
};

function spdxOk(expr) {
  if (!expr || typeof expr !== "string") return false;
  const e = expr.trim().replace(/^\((.*)\)$/, "$1");
  // "A OR B": we may pick either, so one allowed licence is enough.
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(spdxOk);
  // "A AND B": every part applies.
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(spdxOk);
  return ALLOWED.has(e.replace(/[()]/g, "").trim());
}

function checkLockfile() {
  const file = join(ROOT, "package-lock.json");
  if (!existsSync(file)) return 0;
  const lock = JSON.parse(readFileSync(file, "utf8"));
  if (!lock.packages) {
    problems.push("package-lock.json has no \"packages\" list (lockfile version 1), so nothing can be checked. Regenerate it with npm 7 or later.");
    return 0;
  }
  const root = existsSync(join(ROOT, "package.json")) ? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) : {};
  const excepted = (name) =>
    Object.entries(EXCEPTIONS).some(
      ([k, e]) => (k.endsWith("*") ? name.startsWith(k.slice(0, -1)) : name === k) && e.applies(root),
    );
  let shipped = 0;
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path === "" || pkg.dev || pkg.devOptional || pkg.link) continue;
    // A local file: dependency (the desktop app's engine) is our own code.
    if (pkg.resolved && pkg.resolved.startsWith("file:")) continue;
    const name = pkg.name ?? path.replace(/^.*node_modules\//, "");
    shipped++;
    if (excepted(name)) continue;
    const lic = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
    if (!spdxOk(lic)) problems.push(`package ${name}@${pkg.version}: licence "${lic ?? "none"}" is not on the allowlist`);
  }
  return shipped;
}

function checkModels() {
  const models = join(ROOT, "lib/models.ts");
  const licenses = join(ROOT, "lib/licenses.ts");
  if (!existsSync(models) || !existsSync(licenses)) return 0;
  const used = new Set([...readFileSync(models, "utf8").matchAll(/\blicense:\s*"([^"]+)"/g)].map((m) => m[1]));
  const src = readFileSync(licenses, "utf8");
  const start = src.indexOf("LICENSE_INFO");
  // Each entry runs from its key to the next key: it must give the full
  // text's url, a plain-English note and whether commercial use is allowed.
  const body = src.slice(start);
  const keys = [...body.matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z_][\w]*)):\s*\{/gm)];
  const known = new Map(keys.map((m, i) => [m[1] ?? m[2], body.slice(m.index, keys[i + 1]?.index ?? body.length)]));
  for (const l of used) {
    const entry = known.get(l);
    if (!entry) {
      problems.push(`model licence "${l}" is used in lib/models.ts but has no entry in LICENSE_INFO (lib/licenses.ts)`);
      continue;
    }
    for (const field of ["url", "note", "commercial"]) {
      if (!new RegExp(`\\b${field}:`).test(entry)) problems.push(`LICENSE_INFO["${l}"] has no ${field}`);
    }
  }
  return used.size;
}

const pkgs = checkLockfile();
const lics = checkModels();

if (problems.length) {
  console.error(`Licence check failed (${problems.length}):`);
  for (const p of problems) console.error("  - " + p);
  console.error("See rules/06-licensing.md.");
  process.exit(1);
}
console.log(`Licence check passed: ${pkgs} shipped packages, ${lics} model licences.`);
