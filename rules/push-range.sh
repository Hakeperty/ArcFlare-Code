#!/usr/bin/env bash
# Prints base=<commit or tree> (for git diff) and range=<revs> (for git log and
# rev-list): what this push added.
# Used by .github/workflows/push-review.yml.
#
#   push-range.sh <before> <sha> <default-branch>
#
# A normal push starts at <before>. A new branch (before is all zeros) starts
# where it left the default branch. A force-push whose <before> is gone, or a
# brand-new repo, falls back to the parent commit, or the empty tree.
set -euo pipefail
before="${1:-}"; sha="$2"; default="${3:-main}"
empty=4b825dc642cb6eb9a060e54bf8d69288fbee4904

if [[ -n "$before" && ! "$before" =~ ^0+$ ]] && git cat-file -e "$before^{commit}" 2>/dev/null; then
  base="$before"
else
  base=$(git merge-base "origin/$default" "$sha" 2>/dev/null || true)
  if [[ -z "$base" || "$base" == "$sha" ]]; then
    base=$(git rev-parse --verify --quiet "$sha~1" || echo "$empty")
  fi
fi
echo "base=$base"
if [[ "$base" == "$empty" ]]; then echo "range=$sha"; else echo "range=$base..$sha"; fi
