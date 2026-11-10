---
name: explain-codebase
description: Map an unfamiliar codebase and explain how it is organised, how it runs and where to make a given change
---
# Explaining a codebase

Work from the outside in, and read less than you think you need.

1. **What is it?** The README, then the manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`): name, dependencies, scripts. The dependencies tell you the kind of program.
2. **The shape.** List the top-level directories and one level down. Count files per directory rather than opening them. Notes for agents (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) come first if present.
3. **Where it starts.** Find the entry points: the `main`, the `bin` scripts, the server's route table, the CLI's command table. Read those files properly.
4. **Follow one real path** end to end: one command or one request, from entry point to result. This shows the layers better than any directory listing.
5. **The data.** Where state lives (database schema, config files, the main types) and who is allowed to change it.
6. **How it is tested and built.** The test command, the build command, the CI file.

Use `grep` and `glob` to find things; read parts of large files, not all of them.

## The explanation
- One paragraph: what it is and how it is built.
- A short map: each main directory or module and its job, one line each.
- The path you followed, as a numbered list with file names.
- The conventions that matter when changing it.
- If the user wants to make a particular change: the files to touch, in order, and what to watch for.

Say what you read and what you inferred. If part of the codebase is unexplored, say which part.
