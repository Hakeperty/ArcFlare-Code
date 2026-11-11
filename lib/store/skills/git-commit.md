---
name: git-commit
description: Stage the right files and write a clear commit message, without committing secrets or unrelated changes
---
# Committing

1. **Look first.** `git status` and `git diff` (and `git diff --staged`). Know every change you are about to commit.
2. **One commit, one purpose.** If the work tree holds two unrelated changes, commit them separately. Leave alone changes you did not make and were not asked about.
3. **Never commit** secrets (`.env`, keys, tokens, passwords), build output, dependency folders, or large generated files. If one is in the diff, stop and say so.
4. **Stage by name**: `git add path/one path/two`. Not `git add -A` unless you have read everything it would add.
5. **Run the project's quick checks** (tests, lint) if it has them, and say so if they fail rather than committing around them.

## The message
Look at `git log --oneline -10` and match how this repository writes them.

- Subject: what the change does, in the imperative, under about 70 characters. "Fix crash when the config file is empty", not "fixes" or "bug fix".
- Blank line.
- Body, when the subject is not enough: why the change was needed and what it does that is not obvious from the diff. Wrap at 72.
- No "updated files", no list of file names, no praise for the change.

## Do not
- `git commit --amend`, `git rebase` or `git push --force` on work that is already pushed, unless asked.
- Push, unless asked.
- Skip hooks with `--no-verify`.

Finish by showing `git log -1 --stat`.
