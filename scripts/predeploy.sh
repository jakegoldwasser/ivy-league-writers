#!/bin/sh
# Runs before every `npm run deploy`. A Workers deploy uploads this folder as is, so
# deploying from a checkout that's behind GitHub silently wipes out whatever was
# shipped from another computer or session (this happened 2026-10-02: the Students
# tab vanished). Refuse unless this checkout is exactly what's on GitHub.
set -e
branch=$(git rev-parse --abbrev-ref HEAD)
git fetch -q origin "$branch"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✋ Uncommitted changes. Commit and push first, so GitHub matches what goes live." >&2; exit 1
fi
behind=$(git rev-list --count "HEAD..origin/$branch")
ahead=$(git rev-list --count "origin/$branch..HEAD")
if [ "$behind" != 0 ]; then
  echo "✋ $branch is $behind commit(s) behind GitHub. Run: git pull --rebase, retest, then deploy." >&2; exit 1
fi
if [ "$ahead" != 0 ]; then
  echo "✋ $branch has $ahead unpushed commit(s). Run: git push, then deploy." >&2; exit 1
fi
# Live database ahead of this code = someone deployed code this checkout doesn't have.
remote=$(npx wrangler d1 execute palisade-portal --remote --json --command "SELECT name FROM d1_migrations" 2>/dev/null | grep -o '"name": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
for m in $remote; do
  [ -f "migrations/$m" ] || { echo "✋ Production has migration $m, which this checkout doesn't. Pull first." >&2; exit 1; }
done
echo "✓ Up to date with origin/$branch — deploying."
