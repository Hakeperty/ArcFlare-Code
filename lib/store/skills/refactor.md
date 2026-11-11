---
name: refactor
description: Change the structure of code without changing what it does, in small steps that are each verified
---
# Refactoring

A refactor changes how code is arranged and nothing about what it does. If behaviour changes, it is not a refactor; say so and do that separately.

## Before
1. Run the tests and note the result. If the code has no tests for the part you will change, write a few that pin down its current behaviour first, including behaviour that looks wrong.
2. Say in one sentence what the refactor is for: "split this 300-line function so the parsing can be tested alone". No reason, no refactor.

## During
- One kind of change at a time: rename, or extract, or move, or inline. Not several at once.
- After each step, run the tests. A red test means undo the step, not patch forward.
- Use search to find every use before renaming or changing a signature: `grep` for the name across the project, including tests, docs and config.
- Keep the public surface the same unless changing it is the point. If it is, list every caller you updated.
- Do not tidy unrelated code on the way past. Note it instead.

## Things that look safe and are not
- Reordering code that has side effects.
- Merging two "duplicate" functions that differ in an edge case.
- Changing a default argument.
- Making something lazy or cached.

## After
Run the full test suite and the build. Report what changed in structure, that behaviour is unchanged and how you know, and anything you left for later.
