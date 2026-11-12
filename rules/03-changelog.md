# 3. Keep the changelog up to date

Every change to the CLI, the desktop app or the website must show up on arcflare.net/changelog, worded for the
people who use it.

## How /changelog is built

`app/changelog/page.tsx` in the site repo builds the page from three sources:

| Source | Where it comes from | What you must do |
|---|---|---|
| CLI (`ArcFlare-Code`) | The last 60 commit subjects and the releases, read from GitHub every hour | Write the commit subject for users. It is shown as written. |
| Desktop (`Arcflare-Desktop`) | Same as the CLI | Same as the CLI. |
| Website (`ArcFlare`) | `lib/site-changelog.json`, written by `scripts/changelog.mjs` from `git log` | Run `npm run changelog` and commit the updated JSON with your change. Where a subject means nothing to a visitor, map its short hash to better wording (or to `null` to hide it) in `lib/changelog-wording.json`. |

Merges, reverts, `wip`, lint and README commits, and any subject naming an environment variable are left out
automatically. Put `[no log]` in a subject to leave it out on purpose (housekeeping only, never a user-visible change).

## Every time the CLI or the desktop app changes

1. The commit subject reads as a changelog line: what the user can now do, or what no longer goes wrong.
2. If a command, flag, setting or screen changed, update the matching docs page in the site repo
   (`app/docs/*/page.tsx`, the list in `lib/docs.ts`) in the same piece of work.
3. If what the app can do changed (new feature, removed feature, new platform), check the site pages that describe
   it: `/desktop`, `/android`, `/harnesses`, `/store`, the home page, `lib/faq.ts`.

## Every release (a version bump)

1. Bump the version in `package.json` (CLI: `ArcFlare-Code`, desktop: `Arcflare-Desktop`) in its own commit, with
   the subject `CLI 1.3.0: <the headline change>` or `Desktop 0.6.0: <the headline change>`.
2. The GitHub release notes list every user-visible change since the last release, one line each, in the same plain
   words. No internal refactors, no attribution lines.
3. If a site page shows the version (for example the examples in `app/docs/updates/page.tsx`), update it.
4. Write the release's blog post ([rule 4](04-blog.md)).

## When the site repo is not in your session

If you changed the CLI or the desktop app but cannot reach `Hakeperty/ArcFlare`, finish your change, then say in
your final message exactly what the site still needs (docs pages, wording, post). Never mark the work done
without saying this.
