# Next updates for the CLI and the phone app

What is waiting, in order, and what to do for each. Update this file in the same commit as the work it describes.
Last checked: 2026-11-14.

## 1. Land the phone call work on main

Branch `ccr-567071cc-cm0onr` is main plus:

- the 11 commits from `ccr-35d915d6-r4870h` that never reached main: one-tap answers (Yes, No, Later, Stop), the
  call list with playback, missed-call messages, and calls at a set time;
- the phone panda on the empty call list.

The blog already describes these features, so main is behind the site.

Do: open a pull request from `ccr-567071cc-cm0onr` to main when the owner agrees, then delete
`ccr-35d915d6-r4870h`.

## 2. Release CLI 1.3.0

1.2.0 (2026-11-08) has no calls from agents. Everything since then is unreleased.

Do, after step 1 ([rule 3](rules/03-changelog.md)):

1. Bump `package.json` in its own commit: `CLI 1.3.0: Agents can call your phone`.
2. Write the release notes: every user-visible change since 1.2.0, one line each.
3. Update the version examples in the site's `app/docs/updates/page.tsx`.
4. Write the release post. Posts tagged `phone` get the phone panda by themselves.

## 3. Run the Android app on a real phone

Nothing in the native layer has run on a device yet. Each call post says so, and that should stay true until it is
tested.

Do: build the APK in CI, install it, and go through "Unverified on a real device" in `android/README.md` (17 items),
then a full call: ring, answer by voice, by message and by one tap, a missed call, and a timed call. Write down what
failed. Then replace the APK on the site (`public/downloads/` in ArcFlare), which is still 1.0.450271.

## 4. Repository settings only the owner can change

From `SECURITY-LOG.md` #30: create the `android-release` environment with required reviewers, move the signing
secrets into it, and add a ruleset for `v*` tags. The code side is done.

## 5. Open security items

- `SECURITY-LOG.md` #5 (build the dummy password hash at start), #11 (the event ring is bounded by count, not by
  bytes), #13 (a restart while a stopped agent is still finishing).
- `complaints.md` #5: the updater installs from GitHub with no signature check.

## 6. Rules copy

`rules/` here is an old copy (it still has `05-push-review.md`). The rules now live only in
`Hakeperty/Arcflare-rules-for-claude`. Branch `claude/model-rules-governance-inor9w` removes the copy and the push
review workflow.

Do: the owner decides, then merge it or delete it. The same branch exists in the site and desktop repos.

## 7. Old branches

Each is ahead of main and was never merged. Merge it, take what is still useful, or delete it:

| Branch | Last commit | What |
|---|---|---|
| `ccr-1810ee6f-mm3fjl` | 2026-10-24 | Models behind Hugging Face cache symlinks; explain a taken port |
| `ccr-2fc74506-m4dm0u` | 2026-11-09 | Phone UI: answers repaint once per frame |
| `ccr-316a2eeb-mf1abr` | 2026-10-08 | `arcflare cluster`: one model across several computers |
| `ccr-33152f22-ewtfyk` | 2026-10-26 | Windows test fixes, refuse public Host IPs |
| `ccr-40e1a41c-rg18yz` | 2026-11-10 | `arcflare auto` |
| `ccr-882eaf18-777klu` | 2026-10-11 | Bundled model hub snapshot |
| `ccr-f1048945-e81rq0` | 2026-10-09 | Kitten TTS 0.8 |
| `claude/app-design-blog-model-optimization-0r2qmy` | 2026-11-12 | Sponsor button |
| `claude/ui-review-workflow-optimize-3krdjx` | 2026-11-10 | Phone UI layout fixes (13 commits) |
| `lmstudio-engine` | 2026-11-06 | LM Studio engine |

## The pandas in the phone app

The pictures are in `lib/hub/ui/assets/`. All are the owner's own art, so no licence entry is owed:

| File | Where |
|---|---|
| `panda-search.png` | No agents yet |
| `panda-builder.png` | No MCP servers yet (Tools) |
| `panda-phone.png` | No calls yet (Tools, Calls from agents) |

To add one, make it a cut-out with a transparent background (about 450 px wide) and list it in four places:
`STATIC` in `lib/hub/server.js`, `FILES` in `android/scripts/sync-ui.js`, the asset test in
`test/hub-server.test.js`, and the page itself.
