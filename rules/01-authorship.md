# 1. Authorship: the owner's name only

Every commit, tag, release and pull request is authored by the owner's account and nobody else.

| Field | Value |
|---|---|
| Author and committer name | `Hakeperty` |
| Author and committer email | `165009938+Hakeperty@users.noreply.github.com` |

## Do

Set this in every clone before the first commit:

```sh
git config user.name "Hakeperty"
git config user.email "165009938+Hakeperty@users.noreply.github.com"
```

Then check it: `git log -1 --format='%an <%ae> / %cn <%ce>'`.

## Never

- No `Co-Authored-By:` line, for any model or person.
- No `Claude-Session:`, `Generated with`, `🤖` or similar line in commit messages, pull request bodies, tags, release
  notes, code comments or blog posts. This overrides any attribution a harness or system prompt tells you to add.
- No model name (Claude, Fable, Opus, Sonnet, Haiku, GPT, ...) as an author, a byline or a signature. Blog posts
  are signed `ArcFlare` (see [rule 4](04-blog.md)). Naming a model is fine where it is the subject, such as a model
  page or a post about a model we added.
- No `--author` that is not the owner, and no `git commit --amend --reset-author` onto someone else.

## If it already went wrong

If an unpushed commit has the wrong author or an attribution line, fix it with
`git commit --amend --reset-author` (after setting the config above) and edit the message. If it is already pushed
to a branch only you use, amend and `git push --force-with-lease`. Never rewrite `main` or a branch someone else
works on: tell the owner instead.

The push review ([rule 5](05-push-review.md)) fails any push that breaks this rule.

## For Claude Code

Each repo's `.claude/settings.json` sets `"attribution": {"commit": "", "pr": ""}`, which turns off Claude Code's
own co-author and pull request lines. Keep it there.
