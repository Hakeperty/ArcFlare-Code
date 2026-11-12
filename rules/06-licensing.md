# 6. Licensing: record everything we add, so we cannot get sued

Anything made by someone else that we list, link, ship, bundle or copy needs its licence checked and recorded before
it is pushed. When unsure whether something is allowed, do not add it: ask the owner. Licence summaries on the site
are informational, never legal advice, and must say so.

## Run the check

```sh
node rules/check-licenses.mjs
```

It fails when a package we ship has a licence outside the allowlist (GPL, AGPL, SSPL, LGPL, unknown, none), and in
the site repo when a model's licence has no entry on the licences page. The push review runs it too
([rule 5](05-push-review.md)). Never add an exception to it without the owner's yes, written in the commit body.

## What to record, by kind

| You add | Read the licence from | Record it in |
|---|---|---|
| **A model** (site `lib/models.ts`) | The model's own Hugging Face card and its `LICENSE` file, on the day you add it. Not a third-party summary, not a quantizer's repo | Set `license` on the model to the exact name. If `lib/licenses.ts` has no `LICENSE_INFO` entry for that licence, add one: `url` to the full text, a plain-English `note`, `commercial` true or false, and `restriction` for anything that bars some users (EU, revenue or user thresholds, non-commercial). Say in the commit body where and when you read it |
| **A community quant or finetune** | Its card and the base model's licence: the stricter one applies | As above. Mark `abliterated`/`uncensored` models with the existing tags |
| **An npm package** (any repo) | `npm view <pkg> license`, and its `LICENSE` file | Must pass the check. For the site, name it in the "This project" box on `/licenses` if it ends up in what visitors download. For the desktop app, which ships its dependencies inside the installer, keep the package's `LICENSE` file in what is shipped. The CLI has no dependencies: keep it that way unless the owner agrees |
| **A font** | The font's licence file (usually OFL-1.1) | Put the full licence text in the site's `public/licenses/` and link it from `/licenses`, like `OFL-bitcount-single.txt` |
| **An image, icon, sound or other asset** | Its source page | Only use assets that are ours, public domain, or under a licence allowing commercial use. Credit it on `/licenses` when the licence asks for credit |
| **Code copied or adapted from elsewhere** | Its repository's licence | Keep its copyright header in the file, and credit it on `/licenses` (like the QR code generator credit) |
| **A harness or tool ArcFlare installs or launches** | Its repository | Add it to `lib/harnesses.ts` with its licence, and to `THIRD_PARTY_NOTICE`. ArcFlare installs from the official source; it never redistributes the tool |
| **A binary we download for the user** (llama.cpp, cloudflared, ...) | Its release page | Say on `/licenses` what it is, its licence, and where it is downloaded from |
| **A trademark or product name** used in text | - | Add the name to the trademarks paragraph on `/licenses` |

## Never

- Never host, mirror or redistribute model weights. ArcFlare links to the model's own source.
- Never list a model as `commercial: true` when its licence limits commercial use; say what the limit is in `note`.
- Never add GPL, AGPL, LGPL or SSPL code or packages to the CLI or desktop app without the owner's yes.
- Never remove a licence file, copyright header or credit to make something smaller.
- Never guess a licence. If the card and the repo disagree or say nothing, leave the model out and tell the owner.

## Blog posts

A post about a new model or a new bundled tool states its licence and any restriction, in the same words as
`/licenses` ([rule 4](04-blog.md)).
