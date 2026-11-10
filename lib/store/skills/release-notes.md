---
name: release-notes
description: Write release notes from the git history since the last release, grouped by what users will notice
---
# Writing release notes

Release notes are for the people who use the software, not the people who wrote it.

## Gather
1. Find the last release: `git describe --tags --abbrev=0`, or the latest entry in the changelog.
2. List what changed since: `git log <last>..HEAD --oneline`, and `git diff <last>..HEAD --stat` for the size of it.
3. For any commit whose subject does not say what a user would notice, read the commit (`git show`). Do not write a note from a subject line you do not understand.
4. Check the existing changelog for its format, tense and headings, and match them.

## Write
Group by what the reader cares about, most important first:
- **New**: things they can now do.
- **Changed**: behaviour that is different, especially anything that needs action.
- **Fixed**: bugs, described by the symptom the user saw ("the app no longer hangs when the file is empty"), not by the cause.
- **Removed** or **deprecated**, with what to use instead.

Rules:
- One line per item, starting with what changed. Plain words; no "various improvements".
- Say what breaks, and how to migrate, at the top if anything does.
- Leave out refactors, test changes and internal renames, unless they affect users.
- Credit and issue numbers the way the project already does.
- Do not invent items. If the history does not say, ask.

Finish with the version and date in the project's format, and say which range of commits the notes cover.
