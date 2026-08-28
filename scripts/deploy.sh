#!/usr/bin/env bash
#
# Publish the built game to GitHub Pages.
#
# Pages serves a branch, not a directory of the default branch, so the built
# bundle lives on an orphan branch called `deploy` that shares no history with
# main. That branch is checked out as a *worktree* under .deploy/ rather than by
# switching branches: switching would blow away node_modules and dist on every
# publish, and a worktree lets the build and the publish target coexist.
#
#   yarn deploy
#
# Everything here is idempotent — run it as often as you like.
set -euo pipefail

BRANCH=deploy
WORKTREE=.deploy
REMOTE=origin

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# A project Pages site is served from /<repo>/, so the bundle has to be built
# with that prefix or every asset URL 404s. Derived from the remote instead of
# hardcoded, so a fork or a rename needs no edit here.
REPO=$(basename -s .git "$(git remote get-url "$REMOTE")")
BASE="/${REPO}/"

echo "==> building with base ${BASE}"
yarn workspace @retro/client build --base="${BASE}"

DIST="${ROOT}/packages/client/dist"
[ -d "$DIST" ] || { echo "no build output at $DIST" >&2; exit 1; }

# Reuse the worktree if it is already there; otherwise attach it to the branch,
# creating the branch as an orphan the first time round.
if [ ! -d "$WORKTREE" ]; then
  git worktree prune
  if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git worktree add "$WORKTREE" "$BRANCH"
  elif git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
    git fetch "$REMOTE" "${BRANCH}:${BRANCH}"
    git worktree add "$WORKTREE" "$BRANCH"
  else
    echo "==> creating orphan branch ${BRANCH}"
    git worktree add --orphan -b "$BRANCH" "$WORKTREE"
  fi
fi

echo "==> staging the bundle"
# Wipe everything except .git so deleted assets do not linger between deploys.
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$DIST"/. "$WORKTREE"/
# Without this, Pages runs Jekyll and drops any path beginning with _.
touch "$WORKTREE/.nojekyll"

SHA=$(git rev-parse --short HEAD)
cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "==> no change since the last deploy"
else
  git commit -q -m "Deploy ${SHA}"
  echo "==> pushing ${BRANCH}"
  git push -u "$REMOTE" "$BRANCH"
fi

echo "==> done: https://$(git -C "$ROOT" remote get-url "$REMOTE" \
  | sed -E 's#.*[:/]([^/]+)/[^/]+$#\1#' | tr '[:upper:]' '[:lower:]').github.io/${REPO}/"
