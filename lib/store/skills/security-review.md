---
name: security-review
description: Review code for the common classes of vulnerability and report each with where it is, how it is reached and the fix
---
# Security review

A defensive review of code the user owns or is responsible for. Report what you find; change nothing unless asked.

## Start with how data gets in
List the entry points: HTTP routes, command-line arguments, files read, environment, messages from other services. Everything arriving there is untrusted until checked. Follow it to where it is used.

## What to look for
- **Injection**: input reaching a shell command, an SQL or NoSQL query, a template, `eval`, a regular expression built from input. Look for string concatenation into any of these.
- **Paths**: input used to build a file path (`..`, absolute paths, symlinks), in reads, writes, archive extraction and static file serving.
- **Web**: output into HTML without escaping (XSS), state-changing requests without a CSRF defence, open redirects, permissive CORS, server-side requests to an address taken from input (SSRF).
- **Access**: a check on who the user is but not on whether this object is theirs; admin routes without a check; checks done in the client only.
- **Secrets**: keys and passwords in code, config or logs; weak or home-made cryptography; predictable tokens; passwords stored without a slow hash.
- **Trust in data**: deserialising untrusted input, unsafe YAML or pickle loading, missing size and rate limits.
- **Dependencies**: known-vulnerable versions, if the project has an audit command (`npm audit`, `pip-audit`, `cargo audit`), run it.

## Confirm before reporting
For each suspicion, trace the path from the entry point to the dangerous use and check what validation sits between. If you could not confirm it is reachable, say "possible" and what would settle it.

## The report
Most serious first. For each: where (file and line), what an attacker controls and what they get, how it is reached, and the fix, preferring the standard one for the language (parameterised queries, a path-normalising helper, the framework's escaping). Finish with what you reviewed and what you did not.
