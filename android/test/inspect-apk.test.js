// The APK inspector: its parser on a realistic `aapt2 dump xmltree` and its checks, with one broken manifest per rule.

const test = require("node:test");
const assert = require("node:assert");
const { parseXmlTree, cleanValue, summarize, check } = require("../scripts/inspect-apk.js");

const GOOD = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: android:versionCode(0x0101021b)=1
    A: android:versionName(0x0101021c)="1.0" (Raw: "1.0")
    A: package="net.arcflare.app" (Raw: "net.arcflare.app")
    E: uses-sdk (line=6)
      A: android:minSdkVersion(0x0101020c)=26
      A: android:targetSdkVersion(0x01010270)=36
    E: uses-permission (line=9)
      A: android:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
    E: permission (line=11)
      A: android:name(0x01010003)="net.arcflare.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "net.arcflare.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
      A: android:protectionLevel(0x01010009)=(type 0x11)0x2
    E: uses-permission (line=14)
      A: android:name(0x01010003)="net.arcflare.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "net.arcflare.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
    E: application (line=17)
      A: android:allowBackup(0x01010280)=(type 0x12)0x0
      A: android:dataExtractionRules(0x010111b6)=@xml/data_extraction_rules
      A: android:fullBackupContent(0x010104ea)=@xml/backup_rules
      A: android:networkSecurityConfig(0x01010527)=@xml/network_security_config
      E: activity (line=30)
        A: android:name(0x01010003)="net.arcflare.app.MainActivity" (Raw: "net.arcflare.app.MainActivity")
        A: android:exported(0x01010010)=(type 0x12)0xffffffff
        E: intent-filter (line=37)
          E: action (line=38)
            A: android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
          E: category (line=39)
            A: android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")
        E: intent-filter (line=42)
          E: action (line=43)
            A: android:name(0x01010003)="android.intent.action.VIEW" (Raw: "android.intent.action.VIEW")
          E: category (line=44)
            A: android:name(0x01010003)="android.intent.category.DEFAULT" (Raw: "android.intent.category.DEFAULT")
          E: category (line=45)
            A: android:name(0x01010003)="android.intent.category.BROWSABLE" (Raw: "android.intent.category.BROWSABLE")
          E: data (line=46)
            A: android:scheme(0x01010027)="arcflare" (Raw: "arcflare")
            A: android:host(0x01010028)="pair" (Raw: "pair")
      E: provider (line=50)
        A: android:name(0x01010003)="androidx.startup.InitializationProvider" (Raw: "androidx.startup.InitializationProvider")
        A: android:exported(0x01010010)=(type 0x12)0x0
      E: receiver (line=58)
        A: android:name(0x01010003)="androidx.profileinstaller.ProfileInstallReceiver" (Raw: "androidx.profileinstaller.ProfileInstallReceiver")
        A: android:permission(0x01010006)="android.permission.DUMP" (Raw: "android.permission.DUMP")
        A: android:exported(0x01010010)=(type 0x12)0xffffffff
`;

// aapt2 (build-tools 34+) prints attribute names with the full namespace URL; the first CI run showed it.
const NS = "http://schemas.android.com/apk/res/android:";
const GOOD_NS = GOOD.replace(/A: android:/g, "A: " + NS);

const sum = (text) => summarize(parseXmlTree(text));
const rows = (text, mode = "release") => check(sum(text), { mode });
const failed = (text, mode) => rows(text, mode).filter((r) => !r.ok).map((r) => r.what);

test("values: aapt2 booleans, quoted strings and raw suffixes are read correctly", () => {
  assert.strictEqual(cleanValue("(type 0x12)0x0"), false);
  assert.strictEqual(cleanValue("(type 0x12)0xffffffff"), true);
  assert.strictEqual(cleanValue("true"), true);
  assert.strictEqual(cleanValue('"x" (Raw: "x")'), "x");
  assert.strictEqual(cleanValue("26"), 26);
});

test("a good manifest parses into what the checks need, and passes every check", () => {
  const s = sum(GOOD);
  assert.strictEqual(s.package, "net.arcflare.app");
  assert.deepStrictEqual([s.minSdk, s.targetSdk], [26, 36]);
  assert.strictEqual(s.application.allowBackup, false);
  assert.ok(s.components.some((c) => c.name === "net.arcflare.app.MainActivity" && c.filters.length === 2));
  assert.deepStrictEqual(failed(GOOD, "release"), []);
  assert.deepStrictEqual(failed(GOOD, "debug"), []);
});

// One break per rule: each must fail exactly the check that guards it.
const BREAKS = {
  "backup turned on": [GOOD.replace("allowBackup(0x01010280)=(type 0x12)0x0", "allowBackup(0x01010280)=(type 0x12)0xffffffff"), "cloud and device backup is off"],
  "backup rules missing": [GOOD.replace(/ {6}A: android:fullBackupContent.*\n/, ""), "backup rules files are present"],
  "wrong package": [GOOD.replace('package="net.arcflare.app"', 'package="evil.app"'), "package name"],
  "extra permission": [GOOD.replace("E: uses-permission (line=9)", 'E: uses-permission (line=8)\n      A: android:name(0x01010003)="android.permission.READ_CONTACTS"\n    E: uses-permission (line=9)'), "no other permissions"],
  "exported service": [GOOD.replace("      E: provider (line=50)", '      E: service (line=49)\n        A: android:name(0x01010003)="net.arcflare.app.Svc"\n        A: android:exported(0x01010010)=(type 0x12)0xffffffff\n      E: provider (line=50)'), "nothing else is exported"],
  "filter without exported attribute": [GOOD.replace("      E: provider (line=50)", '      E: receiver (line=49)\n        A: android:name(0x01010003)="net.arcflare.app.R"\n        E: intent-filter (line=50)\n          E: action (line=51)\n            A: android:name(0x01010003)="x.Y"\n      E: provider (line=50)'), "nothing else is exported"],
  "exported provider": [GOOD.replace('"androidx.startup.InitializationProvider" (Raw: "androidx.startup.InitializationProvider")\n        A: android:exported(0x01010010)=(type 0x12)0x0', '"androidx.startup.InitializationProvider" (Raw: "androidx.startup.InitializationProvider")\n        A: android:exported(0x01010010)=(type 0x12)0xffffffff'), "no content provider is exported"],
  "web link added": [GOOD.replace('A: android:scheme(0x01010027)="arcflare" (Raw: "arcflare")', 'A: android:scheme(0x01010027)="https" (Raw: "https")'), "the only link scheme"],
  "a second link": [GOOD.replace('E: data (line=46)', 'E: data (line=46)\n            A: android:scheme(0x01010027)="arcflare"\n            A: android:host(0x01010028)="open"\n          E: data (line=47)'), "the app opens exactly one link"],
  "old minSdk": [GOOD.replace("minSdkVersion(0x0101020c)=26", "minSdkVersion(0x0101020c)=21"), "minSdk is 26"],
  "no launcher": [GOOD.replace("android.intent.category.LAUNCHER", "android.intent.category.INFO"), "it has the launcher entry"],
  "legacy storage": [GOOD.replace("      A: android:networkSecurityConfig", "      A: android:requestLegacyExternalStorage(0x01010603)=(type 0x12)0xffffffff\n      A: android:networkSecurityConfig"), "no legacy external storage"],
  "no network security config": [GOOD.replace(/ {6}A: android:networkSecurityConfig.*\n/, ""), "a network security config is set"],
};
for (const [name, [text, rule]] of Object.entries(BREAKS)) {
  test(`a defect is caught: ${name}`, () => {
    const bad = failed(text, "release");
    assert.ok(bad.some((w) => w.includes(rule)), `expected "${rule}" to fail, got: ${JSON.stringify(bad)}`);
  });
}

test("a debuggable release build fails; a debuggable debug build is fine", () => {
  const dbg = GOOD.replace("      A: android:networkSecurityConfig", "      A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff\n      A: android:networkSecurityConfig");
  assert.ok(failed(dbg, "release").some((w) => w.includes("NOT debuggable")));
  assert.deepStrictEqual(failed(dbg, "debug"), []);
});

test("garbage in is an error, not a silent pass", () => {
  assert.throws(() => sum("nothing useful here"), /no <manifest>/);
});

test("the real aapt2 format (attribute names with the full namespace URL) reads the same as the short form", () => {
  assert.notStrictEqual(GOOD_NS, GOOD, "the variant really uses the long names");
  assert.deepStrictEqual(sum(GOOD_NS), sum(GOOD));
  assert.deepStrictEqual(failed(GOOD_NS, "release"), []);
  const bad = GOOD_NS.replace(NS + "allowBackup(0x01010280)=(type 0x12)0x0", NS + "allowBackup(0x01010280)=true");
  assert.ok(failed(bad, "release").some((w) => w.includes("cloud and device backup is off")), "and a defect is still caught in the long form");
});
