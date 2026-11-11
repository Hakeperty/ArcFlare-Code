---
name: arc-read-codebase
description: Answer "where is X" or "how does Y work" in an unfamiliar repo. Search first, read little, answer with file paths.
---
# Read a codebase

One job: answer one question about the code. Change nothing.

1. Write the question as one sentence. Pick 2 or 3 keywords from it.
2. Search first. Use `grep` for each keyword. Use `glob` for file names. Use `list_dir` once on the repo root if you need the layout.
3. From the matches, choose the 3 most likely files. Skip tests, `node_modules`, build output and lockfiles.
4. Read those files with `read_file`, using `offset` and `limit` to read only the part around the match (about 80 lines). Read at most 5 files and at most 400 lines in total.
5. Follow one call into another file only if the answer is not yet clear. Do this at most twice.
6. Stop as soon as you can answer. Do not read more to be thorough.
7. If you cannot find it after 8 tool calls, stop and say what you searched for.

Final report, exactly this shape:
- Answer: 1 to 3 sentences
- Where: `path:line - what is there`, up to 5 lines
- Not checked: anything you did not look at that could change the answer (or "none")
