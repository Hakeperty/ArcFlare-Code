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
