#!/bin/sh
# Merge a teammate's branch into main, verify, push.
#   npm run merge                    # feat/ui-phase3 (the default)
#   npm run merge -- feat/cron-goals # any other branch
# Stops without pushing if the merge conflicts or tests/build fail, and puts main back as it was.
set -e
cd "$(dirname "$0")/.."
BRANCH="${1:-feat/ui-phase3}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ You have uncommitted changes here. Commit or stash them first:"; git status --short --untracked-files=no; exit 1
fi
git checkout -q main
git pull -q --ff-only origin main
git fetch -q origin "$BRANCH"

AHEAD=$(git rev-list --count "main..origin/$BRANCH")
if [ "$AHEAD" = 0 ]; then echo "✓ Nothing to merge: main already has everything on $BRANCH."; exit 0; fi
echo "→ Merging $AHEAD commit(s) from $BRANCH:"; git log --oneline "main..origin/$BRANCH" | sed 's/^/    /'

BEFORE=$(git rev-parse HEAD)
if ! git merge -q --no-ff "origin/$BRANCH" -m "Merge $BRANCH"; then
  git merge --abort
  echo "✗ Merge conflict. main is unchanged. Ask Axo-Manager to resolve it."; exit 1
fi

undo() { git reset -q --hard "$BEFORE"; echo "✗ $1 failed, so nothing was pushed and main is back where it was. Ask Axo-Manager to look."; exit 1; }
echo "→ Installing dependencies…"; npm install --no-audit --no-fund --loglevel=error >/dev/null || undo "npm install"
echo "→ Running tests…";           npm test >/tmp/axo-merge-test.log 2>&1 || { tail -30 /tmp/axo-merge-test.log; undo "Tests"; }
echo "→ Building…";                npm run build >/tmp/axo-merge-build.log 2>&1 || { tail -30 /tmp/axo-merge-build.log; undo "Build"; }

git push -q origin main
echo "✓ Merged $BRANCH and pushed ($(git rev-parse --short HEAD)). Quit and reopen Axo to see the changes."
