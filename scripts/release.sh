#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
# Defaults to "patch" if no argument is given.

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Ensure we're on the main branch with a clean working tree
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: releases must be made from the main branch (currently on '$BRANCH')"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

git pull --ff-only origin main

# Bump version in package.json (no automatic git tag from npm)
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
echo "Bumped to $NEW_VERSION"

# Build and verify
npm run clean
npm run build
npm pack --dry-run

echo ""
read -rp "Publish ${NEW_VERSION} to npm? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted. Reverting version bump."
  git checkout -- package.json package-lock.json 2>/dev/null || git checkout -- package.json
  exit 1
fi

# Publish to npm (will prompt for OTP if 2FA is enabled)
npm publish --access public

# Commit the version bump, tag, and push
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "release: ${NEW_VERSION}"
git tag -a "$NEW_VERSION" -m "release: ${NEW_VERSION}"
git push origin main
git push origin "$NEW_VERSION"

# Create GitHub release from the tag
if command -v gh &>/dev/null; then
  gh release create "$NEW_VERSION" --title "$NEW_VERSION" --generate-notes
  echo "GitHub release created: $NEW_VERSION"
else
  echo "gh CLI not found — tag pushed but GitHub release was not created."
  echo "Create it manually at: https://github.com/manthan787/context-ledger/releases/new?tag=$NEW_VERSION"
fi

echo "Done! Published ${NEW_VERSION}"
