---
name: arc-write-tests
description: Add tests for existing code in the project's own test style, run them, and report what they cover.
---
# Write tests

One job: add tests for the code you were named. Do not change the code under test.

1. Find the project's test style. Use `glob` for `test/**` or `**/*.test.*`, then `read_file` one existing test next to this code. Copy its imports, helpers, naming and layout. Add no framework and no dependency.
2. Read the code under test with `read_file`. Read at most 3 other files.
3. Run the existing tests once with `bash` so you know they pass first.
4. Write the tests with `write_file`, in a new file or at the end of the matching test file. Cover: one normal case per behaviour, empty input, one boundary value, and one bad input. Name each test for the behaviour it checks. Write 3 to 8 tests.
5. Run the new tests with `bash`.
6. If a test fails, decide: the test is wrong (fix the test) or the code has a bug (keep the test, and report the bug). Do not edit the code.
7. Fix a failing test at most 2 times, then report.

Stop when the new tests pass, or after step 7.

Final report, exactly this shape:
- File: path of the tests
- Covers: one line per test
- Result: passed/failed counts
- Bugs found: or "none"
