// Places where Linux lagged behind Windows: finding and starting installed applications, reading how much
// GPU memory is in use, knowing who listens on a port, and noticing a firewall in the way of the phone.
// Each is tested against files shaped like the real ones, so they run on any system.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const apps = require("../lib/mcp/apps");
const backend = require("../lib/backend");
const procs = require("../lib/mcp/procs");
const fw = require("../lib/hub/linuxfw");

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `af-linux-${n}-`));
const LINUX = process.platform === "linux";

test("a menu entry is read for what the application is called and what it runs", () => {
  const e = apps.parseDesktopEntry(`[Desktop Entry]
Type=Application
Name=Visual Studio Code
Name[sv]=Kod
Exec=/usr/share/code/code --unity-launch %F
Terminal=false

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=/usr/share/code/code --new-window %F
`);
  assert.deepStrictEqual(e, { name: "Visual Studio Code", exec: ["/usr/share/code/code", "--unity-launch"], terminal: false });
  // Hidden entries, links and entries with nothing to run are not applications to offer.
  assert.strictEqual(apps.parseDesktopEntry("[Desktop Entry]\nName=X\nExec=x\nNoDisplay=true"), null);
  assert.strictEqual(apps.parseDesktopEntry("[Desktop Entry]\nName=X\nExec=x\nHidden=true"), null);
  assert.strictEqual(apps.parseDesktopEntry("[Desktop Entry]\nType=Link\nName=X\nURL=https://x"), null);
  assert.strictEqual(apps.parseDesktopEntry("[Desktop Entry]\nName=X"), null);
  // Exec lines: quotes, a literal percent, and the codes a menu would fill in.
  assert.deepStrictEqual(apps.desktopExec('"/opt/My App/run" --flag="a b" %U 100%%'), ["/opt/My App/run", "--flag=a b", "100%"]);
  assert.deepStrictEqual(apps.desktopExec("env GTK_THEME=dark gimp-2.10 %i %c %k %f"), ["env", "GTK_THEME=dark", "gimp-2.10"]);
  assert.deepStrictEqual(apps.desktopExec('sh -c "echo \\"hi\\""'), ["sh", "-c", 'echo "hi"']);
});

test("applications are found by name, id or program, and launching one runs its command", { skip: LINUX ? false : "Linux application menus" }, async () => {
  const data = tmp("apps"), out = path.join(data, "ran.txt");
  const appDir = path.join(data, "applications");
  fs.mkdirSync(appDir, { recursive: true });
  const script = path.join(data, "my-tool.sh");
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" > "${out}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(appDir, "org.example.MyTool.desktop"), `[Desktop Entry]\nType=Application\nName=My Tool Deluxe\nExec="${script}" --from-menu %U\n`);
  fs.writeFileSync(path.join(appDir, "hidden.desktop"), "[Desktop Entry]\nType=Application\nName=Secret Helper\nExec=true\nNoDisplay=true\n");
  // A Flatpak export, in the folder the user's own installs go to.
  const flat = path.join(data, "flatpak", "exports", "share", "applications");
  fs.mkdirSync(flat, { recursive: true });
  fs.writeFileSync(path.join(flat, "org.blender.Blender.desktop"), "[Desktop Entry]\nType=Application\nName=Blender\nExec=flatpak run org.blender.Blender %f\n");
  const keep = { h: process.env.XDG_DATA_HOME, d: process.env.XDG_DATA_DIRS };
  process.env.XDG_DATA_HOME = data;
  process.env.XDG_DATA_DIRS = path.join(data, "nothing-here");
  try {
    const list = apps.installed({ fresh: true });
    const names = list.map((a) => a.name);
    assert.ok(names.includes("My Tool Deluxe"), "listed by its name, not its file's id");
    assert.ok(names.includes("Blender"), "Flatpak applications are found");
    assert.ok(!names.includes("Secret Helper"));
    assert.strictEqual(apps.search("deluxe")[0].name, "My Tool Deluxe");
    assert.strictEqual(apps.search("org.example")[0].name, "My Tool Deluxe", "found by the entry's id");
    assert.strictEqual(apps.search("my-tool")[0].name, "My Tool Deluxe", "found by the program it runs");
    const found = apps.resolveApp("My Tool Deluxe");
    assert.deepStrictEqual(found.exec, [script, "--from-menu"]);
    // Started for real: its command runs with the extra arguments, instead of the entry file being "opened".
    const r = await apps.launch("My Tool Deluxe", ["--extra"]);
    assert.strictEqual(r.launcher, "spawn");
    for (let i = 0; i < 40 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(fs.readFileSync(out, "utf8").trim(), "--from-menu --extra");
  } finally {
    if (keep.h === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = keep.h;
    if (keep.d === undefined) delete process.env.XDG_DATA_DIRS; else process.env.XDG_DATA_DIRS = keep.d;
    apps.installed({ fresh: true });
  }
});

test("AMD: memory in use comes from the driver, and an integrated card's shared memory counts", () => {
  const sys = tmp("sys");
  const card = (name, files) => {
    const dev = path.join(sys, "class", "drm", name, "device");
    fs.mkdirSync(dev, { recursive: true });
    for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dev, k), String(v) + "\n");
  };
  const GB = 1024 ** 3;
  // A discrete card: 16 GB of VRAM, 6 in use; what spills into system RAM is not the card's memory.
  card("card0", { mem_info_vram_total: 16 * GB, mem_info_vram_used: 6 * GB, mem_info_gtt_total: 32 * GB, mem_info_gtt_used: 1 * GB });
  fs.mkdirSync(path.join(sys, "class", "drm", "card0-DP-1"), { recursive: true });   // a connector, not a card
  assert.strictEqual(backend.amdSysfsUsedBytes({ sysRoot: sys, totalBytes: 16 * GB }), 6 * GB);
  // An integrated card: a 2 GB carve-out, and the engine reports 48 GB because it can map system RAM.
  const apu = tmp("sys");
  const dev = path.join(apu, "class", "drm", "card1", "device");
  fs.mkdirSync(dev, { recursive: true });
  for (const [k, v] of Object.entries({ mem_info_vram_total: 2 * GB, mem_info_vram_used: 1 * GB, mem_info_gtt_total: 46 * GB, mem_info_gtt_used: 20 * GB })) fs.writeFileSync(path.join(dev, k), String(v));
  assert.strictEqual(backend.amdSysfsUsedBytes({ sysRoot: apu, totalBytes: 48 * GB }), 21 * GB);
  assert.strictEqual(backend.amdSysfsUsedBytes({ sysRoot: apu }), 21 * GB, "recognised as shared even with no total to compare");
  // No AMD card (an Intel or NVIDIA machine): nothing to read, and that is not zero.
  assert.strictEqual(backend.amdSysfsUsedBytes({ sysRoot: tmp("sys") }), null);
});

test("Intel and others: memory in use is summed from each GPU client the kernel lists, once", { skip: process.platform === "win32" ? "symlinks to /dev need a unix" : false }, () => {
  const proc = tmp("proc");
  const client = (pid, fd, target, info) => {
    fs.mkdirSync(path.join(proc, pid, "fd"), { recursive: true });
    fs.mkdirSync(path.join(proc, pid, "fdinfo"), { recursive: true });
    fs.symlinkSync(target, path.join(proc, pid, "fd", fd));
    if (info != null) fs.writeFileSync(path.join(proc, pid, "fdinfo", fd), info);
  };
  const i915 = (id, kib) => `pos:\t0\ndrm-driver:\ti915\ndrm-client-id:\t${id}\ndrm-pdev:\t0000:00:02.0\ndrm-total-system0:\t${kib * 2} KiB\ndrm-resident-system0:\t${kib} KiB\n`;
  client("100", "5", "/dev/dri/renderD128", i915(7, 1024));
  client("100", "6", "/dev/dri/renderD128", i915(7, 1024));          // the same client through a second handle
  client("200", "9", "/dev/dri/card0", i915(8, 2048));
  client("200", "3", "/dev/null", "pos:\t0\n");                       // not a GPU handle
  // A driver that only reports totals, in MiB.
  client("300", "4", "/dev/dri/renderD129", "drm-driver:\txe\ndrm-client-id:\t3\ndrm-pdev:\t0000:03:00.0\ndrm-total-vram0:\t4 MiB\ndrm-total-system:\t1 MiB\n");
  fs.mkdirSync(path.join(proc, "self"));                               // not a pid
  assert.strictEqual(backend.drmFdinfoUsedBytes({ procRoot: proc }), (1024 + 2048) * 1024 + 5 * 1024 * 1024);
  assert.strictEqual(backend.drmFdinfoUsedBytes({ procRoot: tmp("proc") }), null, "no GPU clients is not the same as none in use");
});

test("who listens on a port: read from ss, and found for a real listener", async () => {
  const out = `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1234,fd=21),("node",pid=1235,fd=21))
LISTEN 0 4096 [::]:3000 [::]:* users:(("node",pid=1234,fd=22))
LISTEN 0 128 *:13000 *:* users:(("other",pid=9,fd=3))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*`;
  assert.deepStrictEqual([...new Set(procs.parseSs(out, 3000))], [1234, 1235]);
  assert.deepStrictEqual(procs.parseSs(out, 22), [], "a listener that belongs to someone else shows no pid");
  assert.deepStrictEqual(procs.portListeners(0), []);

  // A real one, in this process: left out by default (the list is for stopping strays), included on request.
  const srv = require("http").createServer((q, r) => r.end("x"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port;
    const seen = procs.portListeners(port, { includeSelf: true });
    if (seen === null) return;                                         // no ss, lsof or netstat here: nothing to check
    assert.ok(seen.includes(process.pid), `this process listens on ${port}`);
    assert.ok(!procs.portOwners(port).includes(process.pid), "never offered as a process to stop");
  } finally { srv.close(); }
});

test("a firewall in the phone's way: firewalld answers for certain, ufw only when its rules can be read", async () => {
  const ifs = { wlan0: [{ address: "192.168.1.23", netmask: "255.255.255.0", family: "IPv4" }] };
  const exec = (answers) => (cmd, args, o, cb) => {
    const a = answers[`${cmd} ${args.join(" ")}`];
    if (a === undefined) return cb(Object.assign(new Error("not found"), { code: "ENOENT" }), "");
    cb(a.code ? Object.assign(new Error("exit"), { code: a.code }) : null, a.out);
  };
  const files = (m) => (f) => { if (f in m) return m[f]; throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
  const none = exec({});

  let v = await fw.checkFirewall({ port: 7878, address: "192.168.1.23", interfaces: ifs,
    exec: exec({ "firewall-cmd --state": { out: "running" }, "firewall-cmd --query-port=7878/tcp": { out: "no", code: 1 } }) });
  assert.strictEqual(v.certain, true);
  assert.match(v.reason, /firewalld is on and port 7878 is not open/);
  assert.match(v.fix, /firewall-cmd --add-port=7878\/tcp .*--permanent/);
  assert.strictEqual(await fw.checkFirewall({ port: 7878, exec: exec({ "firewall-cmd --state": { out: "running" }, "firewall-cmd --query-port=7878/tcp": { out: "yes" } }) }), null);

  // ufw on, rules readable only by root: a possibility, with a rule that lets in the home network only.
  v = await fw.checkFirewall({ port: 7878, address: "192.168.1.23", interfaces: ifs, exec: none,
    readFile: files({ "/etc/ufw/ufw.conf": "# comment\nENABLED=yes\n", "/etc/default/ufw": 'DEFAULT_INPUT_POLICY="DROP"\n' }) });
  assert.strictEqual(v.certain, false);
  assert.strictEqual(v.fix, "sudo ufw allow from 192.168.1.0/24 to any port 7878 proto tcp");
  // Rules readable (running as root): a real answer, in the format ufw writes them.
  const rules = "### tuple ### allow tcp 7878 0.0.0.0/0 any 0.0.0.0/0 in\n### tuple ### allow tcp 9000:9010 0.0.0.0/0 any 192.168.1.0/24 in\n### tuple ### allow any 8080 0.0.0.0/0 any 0.0.0.0/0 in\n### tuple ### deny tcp 23 0.0.0.0/0 any 0.0.0.0/0 in\n";
  for (const [port, open] of [[7878, true], [9005, true], [8080, true], [23, false], [9011, false]]) assert.strictEqual(fw.ufwAllows(rules, port), open, String(port));
  const withRules = files({ "/etc/ufw/ufw.conf": "ENABLED=yes\n", "/etc/ufw/user.rules": rules });
  assert.strictEqual(await fw.checkFirewall({ port: 7878, exec: none, readFile: withRules }), null);
  v = await fw.checkFirewall({ port: 7000, exec: none, readFile: withRules });
  assert.strictEqual(v.certain, true);
  assert.strictEqual(v.fix, "sudo ufw allow 7000/tcp");
  // Off, absent, or set to accept by default: nothing to say.
  assert.strictEqual(await fw.checkFirewall({ port: 7878, exec: none, readFile: files({ "/etc/ufw/ufw.conf": "ENABLED=no\n" }) }), null);
  assert.strictEqual(await fw.checkFirewall({ port: 7878, exec: none, readFile: files({}) }), null);
  assert.strictEqual(await fw.checkFirewall({ port: 7878, exec: none, readFile: files({ "/etc/ufw/ufw.conf": "ENABLED=yes\n", "/etc/default/ufw": 'DEFAULT_INPUT_POLICY="ACCEPT"\n' }) }), null);
  assert.strictEqual(fw.subnetOf("10.1.2.3", { e: [{ address: "10.1.2.3", netmask: "255.255.0.0", family: "IPv4" }] }), "10.1.0.0/16");
});
