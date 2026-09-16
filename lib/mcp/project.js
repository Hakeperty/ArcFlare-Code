// Working out what a directory *is*, and what its build and test output means.
//
// Everything here is pure: it reads files and parses text, and never runs
// anything. That split matters for two reasons. It makes the interesting parts
// testable without spawning a toolchain, and it keeps the expensive half —
// running a build — behind a decision that was already made cheaply.
//
// The parsers exist because raw test output is the worst possible thing to hand
// a model on a small context budget. `npm test` on this repo is 900 lines, of
// which the useful content is "56 pass, 0 fail". A failing run is worse: the
// answer is three test names buried in a wall of stack frames. So build/test
// return a verdict first, the failures next, and the log last.

const fs = require("fs");
const path = require("path");

function read(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}
function readJson(file) {
  const t = read(file);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}
function has(dir, name) {
  try { return fs.existsSync(path.join(dir, name)); } catch { return false; }
}
function entries(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// ------------------------------------------------------------- detection ----

/** Which package manager a Node project actually uses. */
function nodeManager(dir, pkg) {
  const declared = pkg && typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const named = declared.split("@")[0];
  if (["npm", "pnpm", "yarn", "bun"].includes(named)) return named;
  if (has(dir, "bun.lockb") || has(dir, "bun.lock")) return "bun";
  if (has(dir, "pnpm-lock.yaml")) return "pnpm";
  if (has(dir, "yarn.lock")) return "yarn";
  return "npm";
}

function nodeProject(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return null;
  const mgr = nodeManager(dir, pkg);
  const scripts = pkg.scripts || {};
  const run = (s) => (mgr === "npm" ? `npm run ${s}` : `${mgr} run ${s}`);
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  let test = scripts.test ? `${mgr} test` : null;
  if (!test || /no test specified/.test(scripts.test || "")) {
    if (deps.vitest) test = "npx vitest run";
    else if (deps.jest) test = "npx jest";
    else if (deps.mocha) test = "npx mocha";
    // Node 18+ discovers test files itself, which is enough for a repo whose
    // tests are just files named *.test.js.
    else if (has(dir, "test") || has(dir, "tests")) test = "node --test";
    else test = null;
  }

  let start = null;
  if (scripts.dev) start = run("dev");
  else if (scripts.start) start = `${mgr} start`;
  else if (scripts.serve) start = run("serve");
  else if (pkg.bin) {
    const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0];
    if (bin) start = `node ${bin}`;
  } else if (pkg.main) start = `node ${pkg.main}`;

  return {
    kind: "node",
    label: `node (${mgr})`,
    marker: "package.json",
    name: pkg.name || path.basename(dir),
    version: pkg.version || null,
    manager: mgr,
    scripts,
    commands: {
      install: Object.keys(deps).length
        ? (mgr === "npm" ? "npm install" : `${mgr} install`)
        : null,
      build: scripts.build ? run("build") : null,
      test,
      start,
      lint: scripts.lint ? run("lint") : null,
    },
  };
}

function makeTargets(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.\-\/]+)\s*:(?!=)/.exec(line);
    if (m && !m[1].startsWith(".")) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Identify a project directory.
 *
 * Several kinds can be true at once — a Rust workspace with a web front end is
 * normal — so this returns all of them, ordered, with the first treated as
 * primary by build/test.
 */
function detect(dir) {
  const found = [];

  const node = nodeProject(dir);
  if (node) found.push(node);

  if (has(dir, "Cargo.toml")) {
    found.push({
      kind: "rust", label: "rust (cargo)", marker: "Cargo.toml",
      commands: {
        install: "cargo fetch", build: "cargo build", test: "cargo test",
        start: "cargo run", lint: "cargo clippy",
      },
    });
  }

  if (has(dir, "go.mod")) {
    found.push({
      kind: "go", label: "go", marker: "go.mod",
      commands: {
        install: "go mod download", build: "go build ./...", test: "go test ./...",
        start: "go run .", lint: "go vet ./...",
      },
    });
  }

  if (has(dir, "pyproject.toml") || has(dir, "requirements.txt") || has(dir, "setup.py")) {
    const py = process.platform === "win32" ? "python" : "python3";
    const pyproject = read(path.join(dir, "pyproject.toml")) || "";
    const usesPytest = /pytest/.test(pyproject) ||
      /pytest/.test(read(path.join(dir, "requirements.txt")) || "") ||
      has(dir, "pytest.ini") || has(dir, "conftest.py");
    const main = ["main.py", "app.py", "run.py", "manage.py"].find((f) => has(dir, f));
    found.push({
      kind: "python", label: "python", marker: has(dir, "pyproject.toml") ? "pyproject.toml" : "requirements.txt",
      commands: {
        install: has(dir, "requirements.txt")
          ? `${py} -m pip install -r requirements.txt`
          : `${py} -m pip install -e .`,
        build: has(dir, "pyproject.toml") ? `${py} -m build` : null,
        test: usesPytest ? `${py} -m pytest -q` : `${py} -m unittest discover`,
        start: main ? `${py} ${main}` : null,
        lint: null,
      },
    });
  }

  const sln = entries(dir).find((f) => /\.(sln|csproj|fsproj)$/i.test(f));
  if (sln) {
    found.push({
      kind: "dotnet", label: ".net", marker: sln,
      commands: {
        install: "dotnet restore", build: "dotnet build", test: "dotnet test",
        start: "dotnet run", lint: null,
      },
    });
  }

  if (has(dir, "pom.xml")) {
    found.push({
      kind: "maven", label: "java (maven)", marker: "pom.xml",
      commands: { install: "mvn -q dependency:resolve", build: "mvn -q -DskipTests package", test: "mvn test", start: null, lint: null },
    });
  }

  if (has(dir, "build.gradle") || has(dir, "build.gradle.kts")) {
    const w = has(dir, "gradlew") ? (process.platform === "win32" ? "gradlew.bat" : "./gradlew") : "gradle";
    found.push({
      kind: "gradle", label: "java (gradle)", marker: "build.gradle",
      commands: { install: null, build: `${w} build -x test`, test: `${w} test`, start: `${w} run`, lint: null },
    });
  }

  if (has(dir, "CMakeLists.txt")) {
    found.push({
      kind: "cmake", label: "c/c++ (cmake)", marker: "CMakeLists.txt",
      commands: {
        install: null,
        build: "cmake -S . -B build && cmake --build build",
        test: "ctest --test-dir build --output-on-failure",
        start: null, lint: null,
      },
    });
  }

  const mk = ["Makefile", "makefile", "GNUmakefile"].find((f) => has(dir, f));
  if (mk) {
    const targets = makeTargets(read(path.join(dir, mk)) || "");
    found.push({
      kind: "make", label: "make", marker: mk, targets,
      commands: {
        install: null,
        build: targets.includes("build") ? "make build" : "make",
        test: targets.includes("test") ? "make test" : null,
        start: targets.includes("run") ? "make run" : null,
        lint: null,
      },
    });
  }

  if (!found.length && has(dir, "index.html")) {
    found.push({
      kind: "static", label: "static site", marker: "index.html",
      commands: { install: null, build: null, test: null, start: "npx --yes http-server -p 8080 .", lint: null },
    });
  }

  const primary = found[0] || null;
  return {
    dir,
    types: found,
    primary,
    // One merged view, so a caller does not have to know which kind won.
    commands: primary ? primary.commands : { install: null, build: null, test: null, start: null, lint: null },
    scripts: node ? node.scripts : null,
  };
}

/** Pick the command for a phase, preferring the first project kind that has one. */
function commandFor(info, phase) {
  for (const t of info.types) {
    if (t.commands && t.commands[phase]) return { command: t.commands[phase], from: t.label };
  }
  return null;
}

// --------------------------------------------------------------- parsing ----

const TEST_PATTERNS = [
  // node:test / TAP
  {
    framework: "node:test",
    match: (t) => /^# (?:pass|fail) \d+/m.test(t),
    parse: (t) => ({
      passed: num(/^# pass (\d+)/m.exec(t)),
      failed: num(/^# fail (\d+)/m.exec(t)),
      skipped: num(/^# skipped (\d+)/m.exec(t)),
      failing: lines(t, /^not ok \d+ - (.+)$/gm),
    }),
  },
  // jest, and vitest in its verbose reporter
  {
    framework: "jest/vitest",
    match: (t) => /^Tests:\s+/m.test(t),
    parse: (t) => {
      const row = /^Tests:\s+(.+)$/m.exec(t);
      const s = row ? row[1] : "";
      return {
        passed: num(/(\d+) passed/.exec(s)),
        failed: num(/(\d+) failed/.exec(s)),
        skipped: num(/(\d+) (?:skipped|todo)/.exec(s)),
        failing: lines(t, /^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm),
      };
    },
  },
  // vitest default reporter: "Tests  1 failed | 5 passed (6)"
  {
    framework: "vitest",
    match: (t) => /^\s*Tests\s+\d+/m.test(t) || /\d+ failed \| \d+ passed/.test(t),
    parse: (t) => ({
      passed: num(/(\d+) passed/.exec(t)),
      failed: num(/(\d+) failed/.exec(t)),
      skipped: num(/(\d+) skipped/.exec(t)),
      failing: lines(t, /^\s*[✕×]\s+(.+?)(?:\s+\d+ms)?$/gm),
    }),
  },
  {
    framework: "pytest",
    match: (t) => /=+ (?:FAILURES|short test summary|\d+ (?:passed|failed))/.test(t),
    parse: (t) => ({
      passed: num(/(\d+) passed/.exec(t)),
      failed: num(/(\d+) (?:failed|error)/.exec(t)),
      skipped: num(/(\d+) skipped/.exec(t)),
      failing: lines(t, /^FAILED (\S+)/gm).concat(lines(t, /^_{3,} (\S+) _{3,}$/gm)),
    }),
  },
  {
    framework: "cargo test",
    match: (t) => /^test result: /m.test(t),
    parse: (t) => ({
      passed: sum(t, /test result: \w+\. (\d+) passed/g),
      failed: sum(t, /(\d+) failed/g),
      skipped: sum(t, /(\d+) ignored/g),
      failing: lines(t, /^---- (\S+) stdout ----$/gm),
    }),
  },
  {
    framework: "go test",
    match: (t) => /^(?:ok|FAIL|---\s+FAIL)\s/m.test(t),
    parse: (t) => {
      const failing = lines(t, /^---\s+FAIL: (\S+)/gm);
      const passedPkgs = (t.match(/^ok\s+\S+/gm) || []).length;
      return {
        passed: (t.match(/^---\s+PASS: /gm) || []).length || passedPkgs,
        failed: failing.length,
        skipped: (t.match(/^---\s+SKIP: /gm) || []).length,
        failing,
      };
    },
  },
  {
    framework: "dotnet test",
    match: (t) => /(?:Passed!|Failed!)\s+-\s+Failed:/.test(t),
    parse: (t) => ({
      passed: num(/Passed:\s+(\d+)/.exec(t)),
      failed: num(/Failed:\s+(\d+)/.exec(t)),
      skipped: num(/Skipped:\s+(\d+)/.exec(t)),
      failing: lines(t, /^\s*(?:Failed|X)\s+(\S+)/gm),
    }),
  },
  {
    framework: "mocha",
    match: (t) => /^\s*\d+ (?:passing|failing)/m.test(t),
    parse: (t) => ({
      passed: num(/(\d+) passing/.exec(t)),
      failed: num(/(\d+) failing/.exec(t)),
      skipped: num(/(\d+) pending/.exec(t)),
      failing: lines(t, /^\s*\d+\)\s+(.+)$/gm),
    }),
  },
];

function num(m) { return m ? Number(m[1]) : 0; }
function sum(text, re) {
  let n = 0, m;
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = r.exec(text))) n += Number(m[1]) || 0;
  return n;
}
function lines(text, re) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = r.exec(text))) {
    const v = String(m[1]).trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Reduce a test run to a verdict.
 *
 * Returns null when nothing recognisable was printed — better to say "I could
 * not parse this, here is the tail" than to invent a green run.
 */
function summarizeTests(text) {
  const t = String(text || "");
  for (const p of TEST_PATTERNS) {
    if (!p.match(t)) continue;
    const r = p.parse(t);
    const total = (r.passed || 0) + (r.failed || 0) + (r.skipped || 0);
    if (!total && !r.failing.length) continue;
    return {
      framework: p.framework,
      passed: r.passed || 0,
      failed: r.failed || 0,
      skipped: r.skipped || 0,
      total,
      ok: (r.failed || 0) === 0,
      failing: (r.failing || []).slice(0, 20),
    };
  }
  return null;
}

const DIAGNOSTIC_PATTERNS = [
  /^.*?[^\s:]+:\d+:\d+:\s*(?:fatal\s+)?error\b.*$/i,      // gcc/clang/rust/eslint
  /^.*?\berror\s+(?:TS|CS|BC)\d+\s*:.*$/,                  // tsc, csc
  /^\s*error(?:\[[A-Z]\d+\])?:\s.*$/,                      // rust, generic
  /^.*?\b(?:Syntax|Type|Reference|Range|Assertion)Error\b.*$/,
  /^Traceback \(most recent call last\):$/,
  /^\s*(?:\w+\.)*\w*(?:Error|Exception):\s.*$/,            // python, java
  /^npm ERR!.*$/,
  /^ERROR in .*$/,                                         // webpack
  /^.*?:\s*error\s*:.*$/i,                                 // msbuild
  /^FAILED\b.*$/,
];

/**
 * Pull the lines a human would actually look at out of a failed build.
 *
 * Deduplicated and capped: a broken header in a C++ project can produce the
 * same error 400 times, and reading it 400 times helps nobody.
 */
function diagnostics(text, limit = 25) {
  const out = [];
  const seen = new Set();
  const all = String(text || "").split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const line = all[i].replace(/\s+$/, "");
    if (!line || line.length > 400) continue;
    if (/^\s+at\s/.test(line)) continue;                   // stack frames
    if (!DIAGNOSTIC_PATTERNS.some((re) => re.test(line))) continue;
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    // A Python traceback header is useless without the exception under it.
    if (/^Traceback/.test(line)) {
      const tail = all.slice(i + 1, i + 8).find((l) => /^\s*\w*(?:Error|Exception):/.test(l));
      out.push(tail ? `${key} … ${tail.trim()}` : key);
    } else {
      out.push(key);
    }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  detect, commandFor, summarizeTests, diagnostics, makeTargets, nodeManager,
};
