# Security Complaints

Date: 2026-10-07
Repository: Hakeperty/ArcFlare-Code

## Summary
The project is a local AI coding agent that runs shell commands and launches external MCP servers. That makes it powerful, but it also creates meaningful security risk if used with untrusted repositories, untrusted MCP configuration, or hostile inputs.

## Findings

### 1. Arbitrary shell execution is built into the agent
The `bash` tool executes arbitrary shell commands using `/bin/sh -c`.

Relevant code:
- `lib/agent/tools.js`
- `bash({ command, cwd, timeout_ms })`

This is not a sandbox and effectively allows the model to run commands on the host machine once the user approves the action.

### 2. MCP configs can spawn external processes
MCP server definitions are started through `spawn(command, args, ...)`.

Relevant code:
- `lib/agent/mcp.js`
- `_startStdio()`

Because a workspace `.mcp.json` may contain arbitrary commands, a malicious or compromised repo can attempt to run commands automatically unless the config is gated.

### 3. Trust gate exists, but it is advisory and user-dependent
The code explicitly acknowledges the earlier problem and adds a trust gate for workspace MCP configs.

Relevant code:
- `lib/agent/trust.js`
- `gate(cfg, opts)`

This is a good mitigation, but it still relies on the user explicitly trusting a repo's config. It is not a sandbox boundary.

### 4. Environment-derived secrets may be passed into remote MCP servers
MCP config values can expand environment variables into headers and bearer tokens.

Relevant code:
- `lib/agent/mcp.js`
- `expandEnv(value)`
- `_startHttp()`

If a config is malicious or trusted by mistake, it may leak environment secrets to external services.

### 5. The updater can fetch and install code from GitHub automatically
The project has a built-in updater that checks GitHub for the latest package version and then performs a `git pull` or `npm install -g github:...` workflow.

Relevant code:
- `lib/update.js`
- `check()`
- `apply()`
- `refreshInBackground()`

This is a remote code execution path that trusts a remote repository and executes install commands without a proper verification or sandbox model. If the upstream repo is compromised, or if a malicious actor can influence the update source, the local machine may run attacker-controlled code.

### 6. The machine server is intentionally privileged
The `arcflare mcp` server exposes tool access to desktop actions, file access, and likely system integration.

Relevant code:
- `bin/arcflare-mcp.js`
- `lib/mcp/tools.js`

This is a powerful local automation surface and should be treated like a privileged execution interface. It is not a general-purpose safe runtime.

### 7. OAuth tokens are stored locally for remote MCP services
Hosted MCP servers can authenticate with OAuth, and the tokens are stored in a local JSON file.

Relevant code:
- `lib/agent/oauth.js`
- `saveStore()`
- `login()`
- `refresh()`

The code tries to set file permissions (`0o600`), which is helpful, but these tokens are still long-lived local credentials. If the machine is compromised, the whole OAuth identity for external services can be replayed.

### 8. The project is designed around a machine-control model, so the risk is operational rather than code-only
This is not just a library; it is a local agent that can open apps, read the clipboard, and interact with the desktop environment. That makes it functionally akin to an automation agent with local privileges.

Relevant code:
- `bin/arcflare.js`
- `MACHINE_NOTE`
- machine server enablement in the CLI

This means the “security issue” is not limited to command injection: the app is intentionally built around controlling the user’s machine.

## Risk Level
Medium to High for untrusted repos or untrusted MCP configs.
High for any environment where automatic updates, OAuth tokens, and remote MCP servers are all enabled.
Low to Medium when used with trusted repos and a human approving each risky action.

## Conclusion
This project is designed to operate as a local execution environment for AI tooling. It is useful, but it should be treated as a high-risk automation tool rather than a safe or sandboxed app. The code contains mitigations, but they are not equivalent to proper isolation or privilege separation.

## Response (2026-10-07)

Thanks for the review. The overall verdict is right: ArcFlare is a local automation tool that runs with your privileges, and it is not a sandbox. That is now written down in [SECURITY.md](SECURITY.md) (threat model, what is gated, recommendations, how to report). Finding by finding:

1. **Arbitrary shell execution:** *by design, gated.* The `bash` tool asks before every command (terminal or `/rc` page) unless auto mode (`--yolo`) was chosen; with no terminal and no auto mode it refuses. The refusal list for destructive commands remains a seatbelt, not a boundary. SECURITY.md says so and recommends a container/VM for untrusted code.
2. **MCP configs spawn processes:** *mitigated (already).* A workspace `.mcp.json` is inert until `arcflare mcp trust`; the gate runs before anything is spawned (agent and machine-server bridge).
3. **Trust gate is advisory:** *mitigated.* It is a consent gate, not a sandbox, and SECURITY.md says that plainly. `arcflare mcp trust` now **asks** (y/N; `--yes` to skip) after showing exactly what it allows, instead of trusting on sight. Any change to command, args, env, cwd, url, headers or token needs approving again.
4. **Env secrets into remote MCP:** *fixed.* The trust prompt lists every `${VAR}` each server references and where it goes, e.g. `sends $GITHUB_TOKEN to api.example.com` / `hands it $AWS_SECRET`. Those fields are part of the fingerprint, so adding a variable to a header re-triggers the prompt.
5. **Updater installs from GitHub without verification:** *fixed (within what GitHub allows).* The background check never installs. `arcflare update` fetches the official repository by URL (not `origin`), lists the incoming commits and asks before a fast-forward-only merge; npm installs are pinned to the exact commit sha (`github:Hakeperty/ArcFlare-Code#<sha>`), never a moving branch. Other sources need an explicit `--source owner/repo` / `ARCFLARE_UPDATE_SOURCE` and are named on every update. `/update` in a session shows the commits; `/update --yes` installs. There are no signed releases yet; offline `--from` lets you install a copy you reviewed.
6. **Privileged machine server:** *by design.* Documented as a privileged interface; `--no-open` removes desktop tools and `--tools` lists what is exposed.
7. **OAuth tokens stored locally:** *mitigated.* `0600` on POSIX; on Windows the file's inherited ACL is now replaced with a single grant to the current user. `arcflare mcp logout <server>` works even for servers no longer configured, and `arcflare mcp logout --all` deletes every token.
8. **Machine-control model / operational risk:** *by design, documented.* SECURITY.md covers the operational risk and the recommendations: approve tools on untrusted code, review MCP configs, keep secrets out of the launch environment, isolate with a container/VM/separate user.

Report further problems at [arcflare.net/report](https://arcflare.net/report) or with `arcflare report`; vulnerabilities via a private GitHub security advisory.
