# Rules for every model working on ArcFlare

These rules apply to every AI model and agent (Claude, any other model, any harness) that changes code, content
or settings in an ArcFlare repository:

| Repo | What it is |
|---|---|
| `Hakeperty/ArcFlare` | The website (arcflare.net): models, blog, changelog, docs, licences |
| `Hakeperty/ArcFlare-Code` | The `arcflare` CLI and engine |
| `Hakeperty/Arcflare-Desktop` | The desktop app (Electron) |
| `Hakeperty/Arcflare-browser` | The browser |
| `Hakeperty/Arcflare-rules-for-claude` | This folder's home. Edit the rules here, then run `./sync.sh` |

They are not suggestions. If a rule cannot be followed (a check cannot run, a repo is out of reach), stop and say
so in your final message to the owner. Do not quietly skip it.

| # | Rule | In one line |
|---|---|---|
| 1 | [Authorship](01-authorship.md) | Commits are by the owner only. No co-author, no model name, no session link. |
| 2 | [Check, then push every change](02-verify-and-push.md) | One feature or fix per commit, checked before it is committed, pushed right after. |
| 3 | [Changelog](03-changelog.md) | Every CLI, desktop or site change shows up on /changelog in words a user understands. |
| 4 | [Blog](04-blog.md) | User-visible releases get an honest, reviewer-style post on /blog. |
| 5 | [Review on every push](05-push-review.md) | A cheap model (Haiku) reviews every push and asks whether it should exist at all. |
| 6 | [Licensing](06-licensing.md) | Every model, library, font, asset or tool we add has its licence recorded, so we cannot get sued. |

## The checklist before every push

- [ ] `git config user.name` is `Hakeperty` and the message has no `Co-Authored-By` or other attribution line ([1](01-authorship.md))
- [ ] The commit holds one change, and its subject says what a user gets ([2](02-verify-and-push.md), [3](03-changelog.md))
- [ ] The repo's checks pass, and you looked at UI changes running ([2](02-verify-and-push.md))
- [ ] `node rules/check-licenses.mjs` passes, and anything new with a licence is on the licences page ([6](06-licensing.md))
- [ ] Docs, changelog wording and (for a release) a blog post are updated ([3](03-changelog.md), [4](04-blog.md))
- [ ] You can answer the reviewer's questions: why add it, is it needed, will a user see it ([5](05-push-review.md))

## Where the rules live

The source of truth is `rules/` in `Hakeperty/Arcflare-rules-for-claude`. Each app repo carries a copy in its own
`rules/` folder, loaded through its `CLAUDE.md`, so a model working in one repo has them without the others. To
change a rule, edit it here and run `./sync.sh`, which copies the rules and the review workflow into the sibling
repos. Never edit the copies in the app repos.
