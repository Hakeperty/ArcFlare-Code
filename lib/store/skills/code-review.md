---
name: code-review
description: Review a change for bugs before it is merged, and report findings ranked by how much they matter
---
# Reviewing a change

Review the change, not the whole codebase. Find what was changed first:
`git diff` for unstaged work, `git diff --staged`, or `git diff main...HEAD` for a branch.

## What to look for, in this order
1. **Does it do what it says?** Read the intent (commit message, issue, the user's words), then check the code does that and nothing else.
2. **Correctness.** Wrong conditions, off-by-one, null or empty input, error paths that swallow the error, state changed and not restored, async work that is not awaited.
3. **What it breaks.** Search for every caller of anything whose behaviour or signature changed (`grep` the name). A change is only as safe as its callers.
4. **Tests.** Is the new behaviour tested? Would the test fail if the code were wrong? A test that cannot fail is not a test.
5. **Security.** Input that reaches a shell, a query, a file path or HTML without being checked. Secrets in the diff.
6. Only then: naming, duplication, style. Follow the project's conventions, not your own.

## How to work
- Read each changed file around the change, not only the changed lines.
- When something looks wrong, confirm it: read the code it calls, or run it. A finding you did not check is a guess, and must be labelled as one.
- Do not rewrite the change. Say what is wrong and what would fix it.

## The report
Most severe first. For each finding: the file and line, what is wrong in one sentence, an input or situation that shows it, and the fix. Separate **must fix** from **worth considering**. If you found nothing, say what you checked.
