---
name: readme
description: Write or update a README from what the project actually is and does, with commands that have been run
---
# Writing a README

A README answers, in order: what is this, how do I get it running, how do I use it.

## Find out before writing
- Read the manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) for the name, version, scripts and requirements.
- Read the entry point and the main commands or exports.
- Run the install and the start or test command if you can. Only write down commands you ran or can see defined.

## Structure
1. **Name and one sentence** saying what it does and for whom. No slogan.
2. **A short example** of it working: a command and its output, or a few lines of code.
3. **Install**: requirements with versions, then the exact commands.
4. **Use**: the common tasks, each with a command or snippet that works as pasted.
5. **Configuration**: options and environment variables in a table, with defaults.
6. **Development**: how to run the tests and build.
7. **Licence**.

## Rules
- Plain words. Say what it does, not that it is powerful, modern or seamless.
- Every command in a code block, exactly as it is typed. No `$` prompts in commands meant to be copied.
- Do not document features that do not exist yet, and do not invent badges, benchmarks or numbers.
- When updating: keep what is still true, fix what is not, and match the existing tone and heading style.
- If something could not be verified, say so in the README or to the user, rather than writing it as fact.
