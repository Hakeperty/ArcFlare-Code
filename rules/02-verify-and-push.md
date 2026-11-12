# 2. Check the work, then push every change

Small pushes make bugs easy to find: `git bisect` lands on one change, the push review reads one change, and a
revert removes one change. So each feature or fix becomes its own commit, and each commit is pushed as soon as it
is checked.

## One change per commit

- One feature, one fix, one model, one post: one commit. Two unrelated fixes are two commits.
- A change and what it owes go in the same commit: its test, its docs, its licence entry ([rule 6](06-licensing.md))
  and its changelog wording ([rule 3](03-changelog.md)).
- Do not batch up a session's work into one commit at the end. Do not push half a feature that leaves the app broken
  either; if a feature is big, split it into steps that each work.

## Check before you commit

Run the repo's checks and read the output. "It should work" is not a check.

| Repo | Always | When the UI changed |
|---|---|---|
| ArcFlare (site) | `npm run lint`, `npx tsc --noEmit`, `npm run build`, `node rules/check-licenses.mjs` | Run `npm run dev`, open the page you changed at desktop and phone width (Playwright screenshot), in light and dark theme |
| ArcFlare-Code (CLI) | `npm test`, `node rules/check-licenses.mjs` | Run the command you changed for real, e.g. `node bin/arcflare.js <command>` |
| Arcflare-Desktop | `npm run typecheck`, `npm test`, `node rules/check-licenses.mjs` | `npm run test:smoke`, and look at the view you changed |

Also:

- A bug fix comes with a test that fails without the fix, where the repo has tests.
- Read your own diff (`git diff --staged`) before committing. Remove debug output, commented-out code and files you
  did not mean to add.
- If a check fails, fix it. Never skip, disable or loosen a test, lint rule or check to get a green result.
- If a check cannot run here (no network, no GPU, missing secret), say which one and why in your final message.

## Push straight after

```sh
git push -u origin <your-branch>
```

- Push to the branch you were given, never to `main` unless the owner says so.
- On a network error, retry up to four times, waiting 2, 4, 8, then 16 seconds.
- After the push, the review workflow runs ([rule 5](05-push-review.md)). If it says **CHANGE** or **REVERT**, deal
  with it in the next commit, or tell the owner why you disagree.

## Commit messages

- Subject: what changed for the user, in plain words, under about 90 characters. It is shown on /changelog
  ([rule 3](03-changelog.md)). Good: `Model pages say in a sentence whether a model fits your GPU`. Bad:
  `refactor fitcheck util`, `fix bug`, `update stuff`.
- Body: why, what you checked, and anything the reviewer should know (a licence you read, a figure you measured).
- No attribution lines ([rule 1](01-authorship.md)).
