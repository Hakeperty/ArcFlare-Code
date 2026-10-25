"use strict";
// Static checks on .github/workflows/android.yml: the release key must be unreachable from untrusted code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const text = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "android.yml"), "utf8");
const code = text.replace(/^\s*#.*$/gm, "");

/** The text of a top-level job (two-space indented key under `jobs:`), up to the next job. */
function job(name) {
  const m = code.match(new RegExp("^  " + name + ":\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))", "m"));
  assert.ok(m, "job " + name + " exists");
  return m[1];
}
const build = job("build"), release = job("release");

test("no pull_request_target anywhere, not even in comments", () => assert.doesNotMatch(text, /pull_request_target/));

test("exactly the two jobs build and release", () => {
  assert.deepEqual([...code.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)].map((m) => m[1]).filter((n) => !["push", "pull_request", "workflow_dispatch"].includes(n)), ["build", "release"]);
});

test("build job: no secrets, no signing env, read-only token, no environment", () => {
  assert.doesNotMatch(build, /secrets\./);
  assert.doesNotMatch(build, /\$\{\{\s*secrets/);
  assert.doesNotMatch(build, /ARCFLARE_|KEYSTORE|\.jks/i);
  assert.doesNotMatch(build, /^\s+environment:/m);
  assert.match(build, /permissions:\s*\n\s+contents: read\s*$/m);
  assert.doesNotMatch(build, /contents: write/);
  assert.match(build, /assembleDebug/);
});

test("build job uploads only apk files and builds release unsigned", () => {
  const paths = [...build.matchAll(/^\s+path: (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(paths.length >= 1);
  for (const p of paths) assert.match(p, /\*\.apk$/);
});

test("secrets are referenced only inside the release job", () => {
  const before = code.slice(0, code.indexOf("\n  release:\n"));
  assert.doesNotMatch(before, /secrets\./);
  assert.match(release, /secrets\.ANDROID_KEYSTORE_BASE64/);
});

test("release job: tags only, protected environment, needs build, read-only token", () => {
  assert.match(release, /^\s+if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\s*$/m);
  assert.match(release, /^\s+environment: android-release\s*$/m);
  assert.match(release, /^\s+needs: build\s*$/m);
  assert.match(release, /permissions:\s*\n\s+contents: read\s*$/m);
  assert.doesNotMatch(release, /contents: write/);
});

test("release job checks out the tagged commit, deletes the keystore under always(), uploads only the signed apk", () => {
  assert.match(release, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(release, /if: always\(\)[\s\S]*rm -f/);
  const paths = [...release.matchAll(/^\s+path: (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(paths, ["android/android/app/build/outputs/apk/release/app-release.apk"]);
  assert.doesNotMatch(release, /cache:/);
  assert.doesNotMatch(release, /actions\/cache/);
  assert.doesNotMatch(release, /(echo|printf)[^\n]*\$\{?(KEYSTORE_B64|ARCFLARE_\w+)\}?[^\n]*(?<!base64 -d > "\$RUNNER_TEMP\/arcflare-release\.jks")$/im);
});

test("both jobs validate the gradle wrapper before running gradle and install without lifecycle scripts", () => {
  for (const j of [build, release]) {
    assert.ok(j.indexOf("gradle/actions/wrapper-validation@") !== -1);
    assert.ok(j.indexOf("wrapper-validation@") < j.indexOf("./gradlew"));
    assert.match(j, /npm ci --ignore-scripts/);
    assert.doesNotMatch(j, /npm ci(?! --ignore-scripts)/);
  }
});

test("no signing happens on pull_request or workflow_dispatch: only the tag-gated job has signing env", () => {
  assert.equal([...code.matchAll(/ARCFLARE_KEYSTORE_PASSWORD/g)].length, release.match(/ARCFLARE_KEYSTORE_PASSWORD/g).length);
});

test("every `uses:` is pinned by a full 40-hex commit SHA with a tag comment", () => {
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 8);
  for (const m of uses) {
    assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, m[0].trim());
    assert.match(m[2], /#\s*v\d+\.\d+\.\d+/, "tag comment: " + m[0].trim());
  }
});
