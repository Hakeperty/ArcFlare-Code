---
name: arc-think-once
description: Stop going round in circles. Decide once, test the idea with a tool, and move on. Load it when you catch yourself rechecking or repeating.
---
# Think once, then test

One job: get unstuck and spend fewer tokens. Use it when you notice you are rechecking an answer you already have, repeating a call, or doubting instead of testing.

Rules:
1. Think each step through once. Write the conclusion in one line. Do not work it out again.
2. A settled fact stays settled. If you worked out that 2 + 2 = 4, it is 4. Do not check it a second time.
3. If you are unsure whether an idea works, do not argue with yourself about it. Test it: run the command, read the file, or try the small case with `bash`. The tool answers faster than more thinking.
4. One passing check is enough. Do not run it again to be sure.
5. A failing check is information. Read the error. Change one thing because of what it says. Then check again.
6. Never repeat a call with the same arguments. The same input gives the same output. Change something first.
7. After 2 failed tries at one approach, switch to a different approach. After 2 approaches, stop and report.
8. Do not apologise, and do not blame yourself, the user or the tools. Say what happened and what you will do next.

When you notice a loop (the same thought, or the same call, twice):
- Stop thinking.
- Write three lines: `Known:`, `Unknown:`, `Next check:`.
- Do the next check with one tool call.

Final report, exactly this shape:
- Answer: the result, or "stuck"
- Checked by: the one command or read that showed it (or "not checked")
- Tried: each approach in a few words, if there was more than one
