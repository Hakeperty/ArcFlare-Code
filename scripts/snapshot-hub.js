#!/usr/bin/env node
// Refresh lib/hub-snapshot.json: the copy of the model hub that ships with the
// CLI, so `arcflare shop` works on a machine that has never been online.
//
//   node scripts/snapshot-hub.js [https://arcflare.net]
//
// Run it before a release, after the website's model list changes.

const fs = require("fs");
const path = require("path");

const url = String(process.argv[2] || "https://arcflare.net").replace(/\/+$/, "");
const out = path.join(__dirname, "..", "lib", "hub-snapshot.json");

(async () => {
  const res = await fetch(`${url}/api/hub`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url}/api/hub answered ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.models) || !data.models.length) throw new Error("no models in the answer");
  // Point the snapshot's links at the public site even when it was taken
  // from a dev server.
  data.site = "https://arcflare.net";
  for (const m of data.models) m.url = `https://arcflare.net/models/${m.slug}`;
  fs.writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
  console.log(`wrote ${data.models.length} models to ${path.relative(process.cwd(), out)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
