# 4. Blog posts, written like a reviewer

Every release of the CLI or the desktop app, and every change a user would notice (new models, a new feature, a
removed feature, a fixed bug people hit), gets a post on arcflare.net/blog. Write it the way an independent reviewer
would: what it does, how well, what is missing, and what we have not tested. Not marketing.

## Where posts go

Posts are data in `lib/posts.ts` in the site repo (`Hakeperty/ArcFlare`), newest at the top of the array. The shape
is `Post` in `lib/types.ts`:

```ts
{
  slug: "kebab-case-from-the-title",       // unique, never reused or changed once published
  title: "What changed, in plain words",
  summary: "One or two sentences: what changed, for whom, and the honest catch.",
  date: "YYYY-MM-DD",                       // the day it is published
  author: "ArcFlare",                       // always. Never a model name (rule 1)
  tags: ["release", "cli"],                 // reuse existing tags: release, cli, desktop, agent, models, skills, ...
  readingMinutes: 3,                        // words / 200, rounded up
  body: `## ...`,                           // Markdown, rendered by components/Markdown.tsx
}
```

Commit the post on its own, with a subject starting `Post: `, after the change it describes has been pushed.
Check that it renders: `npm run build`, then open `/blog` and `/blog/<slug>`. The RSS feed picks it up by itself.

## How to write it

Use these sections, in this order, and leave out any that would be empty:

1. **What changed.** The change in a few short paragraphs or a list. Show the command or the screen.
2. **What is good about it.** Only what you can back up: a test, a measurement, something you ran.
3. **What is not good yet.** Rough edges, known bugs, platforms it does not work on, what it costs (download size,
   VRAM, speed).
4. **What we have not measured.** Say plainly when there are no figures. Never invent speeds, scores or user numbers.
5. **Verdict.** Who should update or try it now, and who should wait.
6. **How to get it.** The update command, download link or `arcflare` command.

Style:

- Plain, short sentences. Second person ("you") for the reader, "we" for the project.
- Every number comes from something you ran or read today, and the post says where it came from.
- Name the models, licences and tools exactly as their makers do. A post about a new model says its licence and
  any restriction (non-commercial, not in the EU, user limits), the same as `/licenses` ([rule 6](06-licensing.md)).
- No hype words (revolutionary, blazing, game-changing, seamless), no emoji, no exclamation marks.
- Read the latest three posts in `lib/posts.ts` first and match their voice.
