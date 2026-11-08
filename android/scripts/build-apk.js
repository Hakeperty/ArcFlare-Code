#!/usr/bin/env node
// Build the debug APK with a fresh, increasing versionCode, and optionally publish it to this computer's hub
// so signed-in phones can update in place (Devices screen -> App update), no uninstall.
//
//   node scripts/build-apk.js [--publish]
//
// versionCode = minutes since 2026-01-01 UTC: always higher than the last build, fits Android's int for
// thousands of years. Updates install over the old app only when both are signed with the same key: build
// on the same computer (the same ~/.android/debug.keystore), or use the release signing config.
"use strict";
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const versionCode = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000);
const versionName = `1.0.${versionCode}`;
// npm and gradlew.bat need a shell on Windows; node does not (and its path may contain spaces).
const run = (cmd, args, cwd, shell = process.platform === "win32") => {
  const r = spawnSync(shell && /\s/.test(cmd) ? `"${cmd}"` : cmd, args, { cwd, stdio: "inherit", shell });
  if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(" ")}`); process.exit(r.status || 1); }
};

run("npm", ["run", "cap:sync"], root);
const gradlew = path.join(root, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
run(gradlew, ["assembleDebug", "--console=plain", `-ParcflareVersionCode=${versionCode}`, `-ParcflareVersionName=${versionName}`], path.join(root, "android"));
const apk = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!fs.existsSync(apk)) { console.error("no APK at " + apk); process.exit(1); }
console.log(`\n  built ${versionName} (code ${versionCode})\n  ${apk}`);

if (process.argv.includes("--publish")) {
  run(process.execPath, [path.join(root, "..", "bin", "arcflare.js"), "phone", "app", "publish", apk, "--version-code", String(versionCode), "--version-name", versionName], root, false);
}
