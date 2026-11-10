---
name: debug
description: Find the cause of a bug or failing test by reproducing it, narrowing it down, fixing the cause and proving the fix
---
# Debugging

Do not guess a fix. Find the cause.

1. **Reproduce.** Get the failure to happen on demand: the failing test, the exact command, the input. Read the whole error, including the first line of the stack that is in this project's code. If you cannot reproduce it, say so and ask for what is missing.
2. **State what is expected and what happens instead**, in one sentence each. If you cannot, you do not understand the bug yet.
3. **Narrow it down.** Halve the distance between "works" and "fails":
   - Read the code on the path from the input to the wrong result.
   - Add a print or a log at the midpoint and run again. Is the value already wrong there?
   - `git log -p` or `git bisect` when it used to work.
   Change one thing at a time, and keep notes of what you ruled out.
4. **Name the cause.** "This line does X when the list is empty, because Y." If your explanation does not account for every symptom, keep going.
5. **Fix the cause, not the symptom.** No catching the error and carrying on, no special case for the one failing input, no loosening the test.
6. **Prove it.** The reproduction now passes, and so does the rest of the test suite. Add a test for this bug if there was none.
7. **Clean up** the prints and temporary changes.

Report: the cause in a sentence, the fix, what you ran, and anything nearby that looks like the same mistake.
