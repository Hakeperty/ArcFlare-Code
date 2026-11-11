"use strict";
// Linux firewall check for the LAN path: can a phone on this Wi-Fi reach the hub's port?
//
// Windows asks "allow Node.js through the firewall?" on screen, and lib/hub/winfw.js reads the
// answer. Linux asks nothing: a distribution that ships a firewall switched on (Fedora and
// openSUSE with firewalld, anyone who ran `ufw enable`) drops the phone's packets silently, the
// phone reports "did not answer in time", and nothing in the hub can see the drop. So this looks
// at the two front ends people actually have and says what to run.
//
// Read-only, and honest about what it cannot see. firewalld answers a question about one port
// without privileges, so its verdict is certain. ufw keeps its rules where only root can read
// them: when it is on and the rules are out of reach, the answer is "it may be", said once and
// quietly, not a warning that fires for someone who opened the port months ago.

const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

/** 192.168.1.23 with mask 255.255.255.0 -> "192.168.1.0/24": the home network, for a rule that lets in only it. */
function subnetOf(address, interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const i of list || []) {
      if (i.address !== address || i.family !== "IPv4" || !i.netmask) continue;
      const a = i.address.split(".").map(Number), m = i.netmask.split(".").map(Number);
      const bits = m.reduce((n, o) => n + o.toString(2).split("1").length - 1, 0);
      return `${a.map((o, k) => o & m[k]).join(".")}/${bits}`;
    }
  }
  return null;
}

function run(cmd, args, exec, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      exec(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || "").trim() }));
    } catch { resolve({ ok: false, code: "ENOENT", out: "" }); }
  });
}

/** Does a ufw rules file (user.rules) allow TCP to this port? Its "### tuple ###" lines name each rule. */
function ufwAllows(text, port) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^### tuple ### (allow|limit) (\S+) (\S+) /.exec(line);
    if (!m || !/^(tcp|any)$/.test(m[2])) continue;
    for (const part of m[3].split(",")) {
      const [lo, hi] = part.split(":").map(Number);
      if (m[3] === "any" || port === lo || (hi && port >= lo && port <= hi)) return true;
    }
  }
  return false;
}

/**
 * The verdict for the hub's port on this machine: null when nothing is known to be in the way, else
 * { reason, fix, certain }. `certain` is false when a firewall is on but its rules cannot be read.
 */
async function checkFirewall({ port, address, exec = execFile, readFile = (f) => fs.readFileSync(f, "utf8"), interfaces } = {}) {
  if (process.platform !== "linux" && exec === execFile) return null;
  if (!Number.isInteger(port)) return null;

  // firewalld: Fedora, RHEL, openSUSE. `--state` exits 0 only when it is running.
  const state = await run("firewall-cmd", ["--state"], exec);
  if (state.ok && /running/.test(state.out)) {
    const q = await run("firewall-cmd", [`--query-port=${port}/tcp`], exec);
    if (q.out === "yes") return null;
    if (q.out === "no") {
      return {
        certain: true,
        reason: `firewalld is on and port ${port} is not open, so phones on your Wi-Fi cannot reach the hub`,
        fix: `sudo firewall-cmd --add-port=${port}/tcp && sudo firewall-cmd --permanent --add-port=${port}/tcp`,
      };
    }
    return null;                                        // it would not say: do not guess
  }

  // ufw: Ubuntu, Debian, Mint, Arch. Whether it is on, and what it does by default, are world-readable.
  let conf = "", defaults = "";
  try { conf = readFile("/etc/ufw/ufw.conf"); } catch { return null; }
  if (!/^\s*ENABLED\s*=\s*yes/im.test(conf)) return null;
  try { defaults = readFile("/etc/default/ufw"); } catch { /* assume the stock default, which drops */ }
  const policy = (/^\s*DEFAULT_INPUT_POLICY\s*=\s*"?(\w+)/im.exec(defaults) || [])[1] || "DROP";
  if (/^ACCEPT$/i.test(policy)) return null;
  const from = (address && subnetOf(address, interfaces)) || null;
  const fix = from ? `sudo ufw allow from ${from} to any port ${port} proto tcp` : `sudo ufw allow ${port}/tcp`;
  let rules = null;
  try { rules = readFile("/etc/ufw/user.rules"); } catch { /* root only, normally */ }
  if (rules != null) {
    if (ufwAllows(rules, port)) return null;
    return { certain: true, reason: `ufw is on and no rule lets port ${port} in, so phones on your Wi-Fi cannot reach the hub`, fix };
  }
  return { certain: false, reason: `ufw is on and drops incoming connections unless a rule allows them. If the phone cannot connect on your Wi-Fi, let the hub's port in`, fix };
}

module.exports = { checkFirewall, ufwAllows, subnetOf };
