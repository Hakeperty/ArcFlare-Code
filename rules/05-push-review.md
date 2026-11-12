# 5. A hard review on every push

Every push to every branch of the CLI, desktop and site repos is reviewed by the cheapest capable model, Claude
Haiku (`claude-haiku-5-5`). Its job is not to be nice. It asks of each change: why does this exist, is it needed,
will a user ever see it, and is it right.

## How it runs

`.github/workflows/push-review.yml` (copied into each repo by `./sync.sh`) runs three jobs on every push:

| Job | Model? | Fails the push when |
|---|---|---|
| `rules` | No | A commit has a `Co-Authored-By` or other attribution line, or a model as author or committer ([rule 1](01-authorship.md)); or `node rules/check-licenses.mjs` fails ([rule 6](06-licensing.md)) |
| `review` | Haiku | The verdict is **REVERT** |
| `post` | No | Never. Puts the review on the commit as a comment, and in the run summary |

The review reads the pushed diff and the reviewer instructions in `rules/review-prompt.md`. It can read the repo
but cannot change anything. Pushes that are only a merged pull request landing on `main` are not reviewed again,
because each of their commits was reviewed when it was pushed.

It needs one repository secret, `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`), the same one the CLI's
autofix workflow uses. Without it the `review` job is skipped with a notice and the `rules` job still runs.

## What the reviewer asks

For every change in the push:

1. **Why was this added?** Does the commit message give a reason a user would care about?
2. **Is it necessary?** Could it be smaller, or not exist at all? Does it duplicate something already there?
3. **Will a user see it or feel it?** If not, is it worth its weight (maintenance, download size, attack surface)?
4. **Is it correct?** Bugs, edge cases, missing tests, security problems.
5. **Did it follow the rules?** Changelog wording, docs, a blog post for a release, a licence entry for anything new.

It ends with exactly one verdict line:

- `VERDICT: KEEP`: fine as it is.
- `VERDICT: CHANGE`: keep it, but fix the listed points in a follow-up commit.
- `VERDICT: REVERT`: it should not exist, or it is broken. The check goes red.

## What you do with it

After pushing, read the review (the comment on the commit, or the run summary). Fix every **CHANGE** point in a
new commit, or say in your final message why you disagree. A **REVERT** goes to the owner before you continue.

## Without GitHub Actions

If you push from somewhere the workflow does not run, review your own push the same way before you report back:
start a subagent on the cheapest model available (Haiku, otherwise Sonnet), give it `rules/review-prompt.md` and the
output of `git diff <before>..HEAD`, and act on its verdict as above.
