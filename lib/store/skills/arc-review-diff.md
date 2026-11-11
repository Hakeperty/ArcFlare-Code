---
name: arc-review-diff
description: Review a diff you are given, or the last commit, and list real problems most serious first. Changes nothing.
---
# Review a diff

One job: list problems the diff shows. Change no file. Run no commit.

1. Get the diff. If one was given, use it. Otherwise run `bash`: `git show HEAD`.
2. Read the diff once, top to bottom. Read at most 3 other files with `read_file`, and only to check a name or call the diff uses.
3. Look for, in this order: wrong results, crashes, lost data, security holes, missing error handling, missing tests for new logic.
4. Report only what the diff itself shows. Do not guess about code you have not seen. Do not comment on style or taste.
5. Each finding needs a file and a line number from the diff, one sentence on what is wrong, and one sentence on the fix.
6. "Nothing found" is a valid answer. Do not invent findings to fill the list.

Stop after step 6. Do not fix anything.

Final report, exactly this shape:
- Reviewed: what the diff was (files changed, count)
- Findings, most serious first, one per line: `file:line - problem - fix`
- If there are none, write: `Nothing found.`
