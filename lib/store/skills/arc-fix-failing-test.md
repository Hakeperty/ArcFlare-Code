---
name: arc-fix-failing-test
description: Reproduce one failing test, find the cause, fix the code (not the test), rerun it, and report.
---
# Fix one failing test

One job: one failing test. Fix the cause in the code. Do not change the test to make it pass.

1. Run the failing test alone with `bash` (use the project's test command; if unsure, read `package.json` or the README). Copy the exact error and the file and line it names.
2. If it passes, stop and report that it did not fail.
3. Use `read_file` on the test, then on the code it calls. Use `grep` for a name you need. Read at most 6 files in total.
4. Say the cause in one sentence before you edit.
5. Fix the cause with `edit_file`. Change as little as possible. Touch the test only if it is itself wrong, and say so.
6. Rerun the same test with `bash`.
7. If it still fails, try one different fix. After 3 fixes in total, stop and report what you know.
8. Run the whole test suite once. If something else broke, undo the part that broke it.

Stop when the test passes and the suite is not worse, or after 3 tries.

Final report, exactly this shape:
- Test: name
- Cause: one sentence
- Fix: file and what changed
- Result: test passes or fails; suite counts passed/failed
