#!/usr/bin/env bash
# Bumps one package's version, commits, tags and pushes it, then reports the new version.
# Usage: bump-version.sh <package-dir> <npm|python>
# Env:   BRANCH (branch to push to), DRY_RUN=true (compute and report only, change nothing),
#        GITHUB_OUTPUT (the step output file; `current-version` is written to it).
#
# Used by release.yml for every package, so they all bump the same way:
#  - the bump type comes from the commit messages that touched the package since its
#    last "CI: bumps <package> version to ..." commit (not from the push event, so a
#    catch-up run bumps correctly): BREAKING CHANGE / "!:" / "major" -> major,
#    feat: / feature: / "minor" -> minor, anything else -> patch
#  - the push retries after a rebase if the branch moved while the run was going
set -euo pipefail

PKG="${1:?package directory}"
KIND="${2:?npm or python}"
DRY_RUN="${DRY_RUN:-false}"
BRANCH="${BRANCH:?branch name}"

BASE="$(git log -1 --format=%H --grep="^CI: bumps ${PKG} version to" || true)"
if [[ -n "$BASE" ]]; then
  MESSAGES="$(git log "${BASE}..HEAD" --format=%B -- "$PKG")"
else
  # Never bumped by CI: judge by the latest change only, not the whole history.
  MESSAGES="$(git log -1 --format=%B -- "$PKG")"
fi

if [[ "$KIND" == "npm" ]]; then
  CURRENT="$(node -p "require('./${PKG}/package.json').version")"
else
  CURRENT="$(grep -m1 '^version = ' "${PKG}/pyproject.toml" | sed -E 's/version = "(.*)"/\1/')"
fi
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
if [[ ! "$MAJOR" =~ ^[0-9]+$ || ! "$MINOR" =~ ^[0-9]+$ || ! "$PATCH" =~ ^[0-9]+$ ]]; then
  echo "Version '$CURRENT' of $PKG is not in MAJOR.MINOR.PATCH format"
  exit 1
fi

BUMP="patch"
if echo "$MESSAGES" | grep -Eiq 'BREAKING CHANGE|(^|[[:space:]])major([[:space:]]|$)|!:'; then
  BUMP="major"
elif echo "$MESSAGES" | grep -Eiq '(^feat(\(.+\))?:)|(^feature(\(.+\))?:)|(^|[[:space:]])minor([[:space:]]|$)'; then
  BUMP="minor"
fi
case "$BUMP" in
  major) NEXT="$((MAJOR + 1)).0.0" ;;
  minor) NEXT="${MAJOR}.$((MINOR + 1)).0" ;;
  *)     NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac
echo "$PKG: $CURRENT -> $NEXT ($BUMP bump)"
echo "current-version=${NEXT}" >> "${GITHUB_OUTPUT:-/dev/null}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run: nothing changed, committed, tagged or pushed."
  exit 0
fi

FILES=()
if [[ "$KIND" == "npm" ]]; then
  (cd "$PKG" && npm version "$NEXT" --no-git-tag-version --allow-same-version >/dev/null)
  FILES+=("${PKG}/package.json")
  [[ -f "${PKG}/package-lock.json" ]] && FILES+=("${PKG}/package-lock.json")
else
  sed -i -E "s/^version = \".*\"/version = \"${NEXT}\"/" "${PKG}/pyproject.toml"
  UPDATED="$(grep -m1 '^version = ' "${PKG}/pyproject.toml" | sed -E 's/version = "(.*)"/\1/')"
  if [[ "$UPDATED" != "$NEXT" ]]; then
    echo "Version update failed: expected $NEXT, got $UPDATED"
    exit 1
  fi
  FILES+=("${PKG}/pyproject.toml")
fi

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add -- "${FILES[@]}"
git commit -m "CI: bumps ${PKG} version to ${NEXT} [skip ci]"

PUSHED=false
for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:refs/heads/${BRANCH}"; then
    PUSHED=true
    break
  fi
  echo "Push rejected (attempt ${attempt}/5): the branch moved. Rebasing and retrying."
  git pull --rebase origin "$BRANCH"
  sleep $((attempt * 3))
done
if [[ "$PUSHED" != "true" ]]; then
  echo "Could not push the version bump after 5 attempts."
  exit 1
fi

# Tag after the push so it points at the commit that is actually on the branch.
TAG="${PKG}-v${NEXT}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists, skipping tag creation."
else
  git tag "$TAG"
  git push origin "refs/tags/${TAG}"
fi
