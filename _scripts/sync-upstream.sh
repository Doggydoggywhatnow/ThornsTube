#!/usr/bin/env bash
# Merges the latest FreeTube changes into the current branch.
#
# Usage: pnpm sync-upstream [branch]     (default branch: development)
#
# Git remotes live in .git/config and are not part of the repository, so this
# script re-creates the `upstream` remote whenever it is missing.
set -euo pipefail

UPSTREAM_URL="https://github.com/FreeTubeApp/FreeTube.git"
BRANCH="${1:-development}"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

git fetch upstream "$BRANCH"

if git merge --no-edit "upstream/$BRANCH"; then
  echo "Merged upstream/$BRANCH. Run 'pnpm install' if dependencies changed, then 'pnpm pack:tauri'."
  echo "If upstream changed src/preload/interface.js, mirror the change in src/tauri/ftElectron.js."
else
  echo "Merge conflicts. Resolve them, then commit. Conflicts should be limited to package.json, pnpm-lock.yaml and README.md." >&2
  exit 1
fi
