# Security

ArcFlare is a local execution environment for AI tools. It runs a model, and
that model can run commands, start MCP servers, read and write files and, with
the machine server, operate your desktop, all **with your privileges**. That is
what it is for. It is not a sandbox, and nothing below turns it into one.

This page says what is gated, how, and what isn't, so you can decide where to
run it.

## Threat model

| Who | What they could try | What stands in the way |
| --- | --- | --- |
| A repository you cloned | A `.mcp.json` that starts a process or sends your env vars somewhere | The trust gate (below). Nothing in a repo's MCP config runs until you approve its exact content |
| A model, or a prompt injection it read | Run a destructive or exfiltrating command | Tool approval (below), plus a refusal list for obviously destructive commands. The refusal list is a seatbelt, not a boundary |
| The update channel | Ship you code | Updates come only from the official repository, show what they install and ask first; npm installs are pinned to an exact commit |
| Another computer on your network | Use a cluster worker's GPU (`ggml-rpc-server` runs what it is sent, unauthenticated) | The worker listens on localhost only; a gate accepts connections only from `--allow` addresses and refuses to bind a public address. Addresses can be spoofed on a shared LAN: use a VPN there |
| Someone with your remote-control link | Type into your session | The key is 192 random bits, carried in the URL fragment (never sent to the server); the relay stores only its SHA-256. `/rc off` ends it, `arcflare rc new` replaces the key |
| Malware already on your machine | Read `~/.arcflare` | Out of scope. OAuth tokens there are files: `0600` on macOS/Linux, ACL'd to your user on Windows |

## What runs with your privileges

- **The agent's `bash` tool** (`lib/agent/tools.js`) runs `/bin/sh -c` (or the
  Windows equivalent) as you.
- **MCP servers** (`lib/agent/mcp.js`): a stdio server *is* a process ArcFlare
  spawns; a hosted one receives whatever headers its config names.
- **The machine server** (`arcflare mcp`): process control, files, the clipboard,
  screenshots, mouse and keyboard. It is a privileged interface by design.
  `--no-open` removes the desktop tools; `--tools` prints what is exposed.
- **Harnesses** you launch (Codex, OpenCode, Hermes) apply their own rules.

## What is gated, and how

**Tool approval.** The agent asks before every `bash` and MCP tool call, in the
terminal or on the `/rc` page, unless you chose auto mode (`--yolo`). Without a
terminal and without auto mode, the answer is no.

**The MCP trust gate** (`lib/agent/trust.js`). Config from your home directory is
yours and not gated. Config from the working directory, a repo's `.mcp.json`,
starts nothing until you run `arcflare mcp trust`. That command prints every
command it would run, every host it would connect to and **every environment
variable that would be sent and where** ("sends $GITHUB_TOKEN to
api.example.com"), then asks. What is recorded is a fingerprint of the
command, args, env, cwd, url, headers and token, so any change to any of those
needs approving again. `arcflare mcp untrust` withdraws it.

**Updates** (`lib/update.js`). The background check only checks; it never
installs. `arcflare update`:

- fetches from `https://github.com/Hakeperty/ArcFlare-Code.git` by URL, not
  from whatever `origin` a clone points at;
- lists the incoming commits and asks before fast-forwarding (`--ff-only`;
  a diverged clone is refused);
- for npm installs, resolves `main` to a full commit sha first and installs
  exactly `github:Hakeperty/ArcFlare-Code#<sha>`;
- uses another source only when you name it (`--source owner/repo` or
  `ARCFLARE_UPDATE_SOURCE`), and says so every time.

This trusts GitHub and the repository's maintainers. There are no signed
releases yet. If that is not enough for you, read the commits it lists, or
update offline from a copy you reviewed (`--from`).

**OAuth tokens** for hosted MCP servers live in `~/.arcflare/oauth.json`:
`0600` on POSIX, and on Windows the file's inherited ACL is replaced with a
single grant to your user. `arcflare mcp logout <server>` or `--all` deletes
them. They are refreshable credentials. Treat that file like an SSH key.

## Recommendations

- Run auto mode only on code you trust. On anything else, approve each tool.
- Read a repo's `.mcp.json` before trusting it, and look at the "sends …" lines.
- Don't keep secrets you don't need in the environment you start ArcFlare from.
- For real isolation, run ArcFlare (or the harness) in a container, a VM, or a
  separate user account. Nothing inside the process is a substitute.
- Leave the machine server off unless a harness needs it, and prefer
  `--no-open` when it doesn't need the desktop.
- `arcflare rc new` if your remote-control link was ever shared by mistake.
- Run cluster workers (`arcflare cluster join`) only on networks you control,
  or over a VPN, and `--allow` only the main computer's address.

## Reporting a vulnerability

Please don't open a public issue for a vulnerability. Use a
[private security advisory](https://github.com/Hakeperty/ArcFlare-Code/security/advisories/new)
on GitHub. For everything else, bugs, complaints and ideas, there's
[arcflare.net/report](https://arcflare.net/report) or `arcflare report`.
