---
name: arc-commit
description: Stage the right files and make one commit with a plain-English message. Never stages secrets, never pushes.
---
# Commit

One job: make one commit. Do not fix, edit or refactor anything.

1. Run `bash`: `git status --short` and `git diff`. Read at most 5 changed files with `read_file`.
2. Choose the files that belong to one change. Leave out files you did not change and unrelated edits.
3. Never stage: `.env`, keys, tokens, passwords, `node_modules`, build output, large generated files. If one is in the list, skip it and say so in the report.
4. Stage by name with `bash`: `git add path/one path/two`. Never `git add -A` or `git add .`.
5. Run `git diff --staged --stat` and check the list is right.
6. Look at `git log --oneline -5` and match its style.
7. Write the message: a subject in plain English, imperative, under 70 characters ("Fix crash when the config file is empty"). Add a short body only if the why is not obvious. No co-author line. No mention of AI.
8. Run `git commit -m "subject"`. Use one more `-m "body"` if you wrote a body.
9. Never run `git push`. Never use `--amend`, `--no-verify` or `--force`.

Stop when the commit succeeds, or when nothing is left to commit.

Final report, exactly this shape:
- Commit: hash and subject
- Files: the staged list
- Skipped: files left out, and why (or "none")
