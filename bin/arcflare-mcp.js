#!/usr/bin/env node
// The MCP server entry point: `arcflare mcp`, or this file directly.
//
// A client spawns this and talks JSON-RPC over stdin/stdout, so stdout belongs
// to the protocol — every human-readable word here goes to stderr, and --tools
// exits before the transport starts.

const path = require("path");
const { createServer } = require("../lib/mcp/tools");

function parseArgs(argv) {
  const o = { roots: [], cwd: null, allowOpen: true, print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.roots.push(path.resolve(argv[++i] || "."));
    else if (a === "--cwd") o.cwd = path.resolve(argv[++i] || ".");
    else if (a === "--no-open") o.allowOpen = false;
    else if (a === "--bridge") {
      o.bridge = true;
      // `--bridge blender,desktop` narrows it; a bare --bridge takes them all.
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        o.bridgeOnly = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
      }
    }
    else if (a === "--tools" || a === "--list") o.print = true;
    else if (a === "--help" || a === "-h") o.help = true;
  }
  if (process.env.ARCFLARE_MCP_ROOTS) {
    for (const r of process.env.ARCFLARE_MCP_ROOTS.split(path.delimiter)) {
      if (r.trim()) o.roots.push(path.resolve(r.trim()));
    }
  }
  return o;
}

const HELP = `arcflare mcp — run ArcFlare's machine server on stdio

  --root <dir>   restrict cwd to this directory (repeatable; default: anywhere)
  --cwd <dir>    default working directory for commands
  --no-open      disable the open, launch and desktop tools
  --bridge [a,b] also expose the other MCP servers in your config
  --tools        print the tool list and exit

  Add it to a client with:
    claude mcp add arcflare -- arcflare mcp
  or in mcp.json:
    { "mcpServers": { "arcflare": { "command": "arcflare", "args": ["mcp"] } } }
`;

function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { process.stderr.write(HELP); return; }

  if (o.cwd) { try { process.chdir(o.cwd); } catch {} }
  const server = createServer(o);

  if (o.print) {
    for (const t of server.list()) {
      const first = String(t.description).split(/\.\s|\n/)[0];
      process.stdout.write(`${t.name.padEnd(15)} ${first}\n`);
    }
    return;
  }

  // Servers that exit when their client goes away leave nothing behind; the
  // supervisor's onClose kills anything still running.
  server.listen();
}

if (require.main === module) main();

module.exports = { main, parseArgs, HELP };
