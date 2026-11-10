---
name: write-tests
description: Add tests for existing code using the project's own test framework, covering behaviour and edge cases
---
# Writing tests

## Before writing
1. Find how this project tests: look for a test folder, the `test` script in the manifest, and an existing test near the code. Copy its style, helpers and file naming exactly. Do not add a framework.
2. Read the code under test until you can say what it promises: inputs, outputs, errors, side effects.
3. Run the existing tests once, so you know they pass before you touch anything.

## What to test
- The promise, in plain cases first: one test per behaviour, named for the behaviour ("returns an empty list when nothing matches"), not for the function.
- Edges: empty, one, many; zero and negative; missing and null; the boundary value and one either side; text with spaces, quotes and non-ASCII.
- Failure: bad input raises the documented error; a failing dependency is handled.
- A bug you were asked to fix: first a test that fails because of it, then the fix.

## Rules
- A test must be able to fail. After writing one, break the code on purpose (or reason carefully about it) and see the test catch it.
- Test behaviour through the public surface. Do not assert on private details that a refactor would change.
- No network, clock or randomness without control: use the project's fakes, a temp directory, a fixed time.
- Keep each test independent: it sets up what it needs and leaves nothing behind.

## Finish
Run the tests and report the real result: how many ran, how many passed, and anything you could not test and why.
