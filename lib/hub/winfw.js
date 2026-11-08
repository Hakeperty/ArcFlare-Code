// Windows Firewall check for the LAN path: can a phone on this Wi-Fi reach the hub's node.exe?
//
// Windows asks "allow Node.js through the firewall?" on the computer's screen, per program and
// network type. An answer given on a Public network leaves node.exe allowed on Public only; on
// the home Wi-Fi (Private) every phone is then silently dropped until someone at the computer
// answers the new prompt, and clicking Cancel leaves a Block rule. The phone only ever reports
// "did not answer in time", and nothing in the hub can see the drop (the packets never arrive),
// so this asks Windows directly and says what to run.
//
// Read-only: it lists rules, it never adds one (that needs an administrator).

const { execFile } = require("child_process");

/** Does a rule's profile string ("Public", "Private, Public", "Any") cover the network category? */
function covers(profile, category) {
  const p = String(profile || "").toLowerCase();
  return p === "any" || p.split(/[\s,]+/).includes(String(category || "").toLowerCase());
}

/**
 * Pure verdict. `category` is the network the address is on (Public / Private / DomainAuthenticated),
 * `rules` the enabled inbound rules for the hub's program: [{ profile, action }].
 * Returns null when nothing is known to be wrong, else { reason, fix }.
 * No rules at all is not a problem: Windows asks on the first connection.
 */
function firewallVerdict({ category, rules, exe, port }) {
  if (!category || !Array.isArray(rules) || !rules.length) return null;
  const cat = /domain/i.test(category) ? "Domain" : category;
  const applies = rules.filter((r) => covers(r.profile, cat));
  const fix = `New-NetFirewallRule -DisplayName "ArcFlare hub" -Direction Inbound -Action Allow -Protocol TCP -Program "${exe}"` +
    (port ? ` -LocalPort ${port}` : "") + ` -Profile ${cat}`;
  if (applies.some((r) => /block/i.test(r.action))) {
    return { reason: `Windows Firewall BLOCKS ${exe} on ${cat} networks (this Wi-Fi is ${cat}), so phones cannot reach the hub`, fix: `remove the Block rule for node.exe in "Windows Defender Firewall > Allow an app", or as administrator: ${fix}` };
  }
  if (!applies.some((r) => /allow/i.test(r.action))) {
    const where = [...new Set(rules.map((r) => r.profile))].join(" / ");
    return { reason: `Windows Firewall allows ${exe} only on ${where} networks, but this Wi-Fi is ${cat}: phones will time out until the firewall prompt on this screen is answered with Allow`, fix: `answer the prompt with Allow, or as administrator: ${fix}` };
  }
  return null;
}

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** Ask Windows. Resolves { category, rules } or null (not Windows, address not on this computer, error, timeout). */
function queryFirewall({ address, exe, timeoutMs = 15000, run = execFile } = {}) {
  if (process.platform !== "win32" && run === execFile) return Promise.resolve(null);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(address))) return Promise.resolve(null);
  const script = [
    "$ErrorActionPreference='Stop'",
    `$idx=(Get-NetIPAddress -IPAddress ${psQuote(address)}).InterfaceIndex`,
    "$cat=[string](Get-NetConnectionProfile -InterfaceIndex $idx).NetworkCategory",
    `$r=@(Get-NetFirewallApplicationFilter -Program ${psQuote(exe)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' } | ForEach-Object { @{ profile=[string]$_.Profile; action=[string]$_.Action } })`,
    "@{ category=$cat; rules=$r } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  return new Promise((resolve) => {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(String(stdout).trim());
        const rules = Array.isArray(j.rules) ? j.rules : j.rules ? [j.rules] : [];
        resolve({ category: j.category || null, rules });
      } catch { resolve(null); }
    });
  });
}

/** The verdict for the hub's program on the network that carries `address`; null if fine or unknown. */
async function checkFirewall({ address, exe, port, run } = {}) {
  const q = await queryFirewall({ address, exe, run });
  return q ? firewallVerdict({ category: q.category, rules: q.rules, exe, port }) : null;
}

module.exports = { firewallVerdict, queryFirewall, checkFirewall, covers };
