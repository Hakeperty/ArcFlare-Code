# Next updates for the CLI and the phone app

What is waiting, in order, and what to do for each. Update this file in the same commit as the work it describes.
Last checked: 2026-11-15.

## 1. Land AI on the phone on main

The phone call work (one-tap answers, the call list, missed-call messages, timed calls, updates from arcflare.net)
is on main since pull request #18. Branch `ccr-0fc581e7-7ocf3s` is main plus Local AI (Arc Pocket). The site's branch
of the same name has its pages, its post and the signed 1.0.457825 download.

Do: merge the pull requests from `ccr-0fc581e7-7ocf3s` in this repo and in the site repo, then delete
`ccr-567071cc-cm0onr` and `ccr-35d915d6-r4870h`, which are fully contained in it.

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
then a full call: ring, answer by voice, by message and by one tap, a missed call, and a timed call. Also try
**Update the app** on the pairing screen once a newer APK is on the site. Write down what failed.

The owner has a Galaxy S24 Ultra (Snapdragon 8 Gen 3) to test on, once the download is on arcflare.net.

To put a new version on the site, so phones can update without a computer: build it unsigned in CI, sign it with the
release key and publish it with `scripts/site-publish.js`. Rule 9 in `Hakeperty/Arcflare-rules-for-claude`
(`rules/09-android-signing.md`) has the steps and says where the key is kept. Never make a new key: the keys of
1.0.450271 and of the first 1.0.457825 build were lost, so 1.0.450271 has to be uninstalled once, and it has no
**Update the app** button either.

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

## 8. AI on the phone: what is done and what comes next

Done on `ccr-567071cc-cm0onr`: Local AI in the app (Arc Pocket on Qwen3 0.6B or 1.7B, llama.cpp on the CPU), with
the notice before download, Models and storage, and settings per chip. See "Local AI" in `android/README.md`.

Next, in this order, each as its own commit:

1. **Test Local AI on real phones** (step 3 above): a Galaxy S22 or later, a Pixel, and one MediaTek phone. Write down
   speed, heat and battery for each, and adjust `CHIPS` in `lib/hub/ui/localai.js` from what you see.
2. **Two Android builds from one project**: done. Gradle product flavors `chat` (ArcFlare, `net.arcflare.app`) and
   `agent` (ArcFlare Agent, `net.arcflare.app.agent`); the agent's code is in `android/android/app/src/agent`. CI builds
   and inspects both. ArcFlare Agent updates from its own `android-agent.json` on the site.
   Still to do: sign the agent APK and put it on the site behind its own warnings (rule 9 has the signing steps;
   `site-publish.js --agent`), with its section on /android, its docs and its post.
3. **The on-phone agent (agent build only)**: tools always run on the phone, each one shown and approved.
   1. Files, only in folders picked with Android's folder picker: done (see "Files for Arc Pocket" in
      `android/README.md`). Only Qwen3 1.7B gets tools; the measurements are in that section.
   2. Next: the person picks the model for each chat, the phone's Arc Pocket or the paired computer's model when it
      can be reached.
   3. Phone actions the person finishes: open apps and links, alarms and timers, calendar events, drafted texts and
      emails, sharing. Each opens Android's own screen.
   4. Reading notifications (NotificationListenerService, switched on in Android settings). It can see message
      previews from every app, so the warning says so.
   5. Controlling other apps (AccessibilityService): tap, type, read the screen. It can see everything, passwords
      included, and Google Play allows it only for uses an app declares and Google approves, so plan on the agent
      build coming from arcflare.net only. It gets the loudest warning, an off switch in the app, and a notice while
      it is active.
   Each new tool gets its own warning screen, and its permission or service goes in `src/agent/AndroidManifest.xml`
   only, so the chat build never asks for it.
4. **NPU (Snapdragon)**: ONNX Runtime with Qualcomm's QNN libraries. Stopped until the owner decides
   ([rule 6](rules/06-licensing.md)). Read on 2026-11-14: the POM of `com.qualcomm.qti:qnn-runtime` 2.51.0 on Maven
   Central names the "Qualcomm AI Hub Model License" (softwarecenter.qualcomm.com, `licenses/ai_model_hub/v1/LICENSE.pdf`).
   That text allows distributing "the Software solely in object code format and as incorporated in Your software
   application", never by itself, and has us indemnify Qualcomm for apps we post for download (section 9a), forbids
   reverse engineering (2a) and lists uses the software may not be put to (2c). It does not name the QNN libraries,
   and the licence of the QNN SDK itself (Qualcomm AI Engine Direct) could not be opened without an account. So we
   cannot yet say the libraries may be bundled. Models for the NPU are compiled per chip.
5. **Faster model files**: 4-bit files (Q4_0) run faster on ARM than Q8_0, but Qwen's own repos publish only Q8_0 for
   these sizes (checked on Hugging Face, 2026-11-14). Community quants need their licence read (rule 6) and a measured
   speed and quality gain on a phone before they are offered. Read on 2026-11-14: `unsloth/Qwen3-0.6B-GGUF` and
   `unsloth/Qwen3-1.7B-GGUF` have Q4_0 and Q4_K_M, say apache-2.0 on the card and link Qwen's LICENSE, but carry no
   LICENSE file of their own. `ggml-org` says apache-2.0 and has one 4-bit file per size. `bartowski` and
   `MaziyarPanahi` state no licence, so they are out. Read the card again and take the size and SHA-256 from the file
   page on the day a file is added; nothing has been measured on a phone.

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
