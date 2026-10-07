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

## Risk Level
Medium to High for untrusted repos or untrusted MCP configs.
Low to Medium when used with trusted repos and a human approving each risky action.

## Conclusion
This project is designed to operate as a local execution environment for AI tooling. It is useful, but it should be treated as a high-risk automation tool rather than a safe or sandboxed app. The code contains mitigations, but they are not equivalent to proper isolation or privilege separation.
