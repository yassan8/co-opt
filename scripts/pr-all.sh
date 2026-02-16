#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-main}"
MERGE_METHOD="${MERGE_METHOD:-merge}" # merge|squash|rebase
ALLOW_ADMIN_MERGE="${ALLOW_ADMIN_MERGE:-1}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BRANCH_NAME="${BRANCH_NAME:-chore/all-files-pr-${TIMESTAMP}}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-chore: update all pending files}"
PR_TITLE="${PR_TITLE:-$COMMIT_MESSAGE}"
PR_BODY="${PR_BODY:-This PR includes all current workspace file changes in a single commit.}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) is not installed." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  :
else
  echo "No file changes found. Nothing to do."
  exit 0
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" == "$BASE_BRANCH" ]]; then
  git checkout -b "$BRANCH_NAME"
else
  if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    echo "Error: branch '$BRANCH_NAME' already exists." >&2
    exit 1
  fi
  git checkout -b "$BRANCH_NAME"
fi

git add -A

if git diff --cached --quiet; then
  echo "No staged changes after git add -A. Nothing to commit."
  exit 0
fi

git commit -m "$COMMIT_MESSAGE"
git push -u origin "$BRANCH_NAME"

PR_URL="$(gh pr create --base "$BASE_BRANCH" --head "$BRANCH_NAME" --title "$PR_TITLE" --body "$PR_BODY")"
PR_NUMBER="$(gh pr view "$BRANCH_NAME" --json number --jq '.number')"

echo "Created PR: $PR_URL"

if gh pr merge "$PR_NUMBER" --"$MERGE_METHOD" --delete-branch; then
  echo "Merged PR #$PR_NUMBER with standard permissions."
  exit 0
fi

if [[ "$ALLOW_ADMIN_MERGE" == "1" ]]; then
  echo "Standard merge failed. Trying admin merge..."
  gh pr merge "$PR_NUMBER" --"$MERGE_METHOD" --delete-branch --admin
  echo "Merged PR #$PR_NUMBER using admin privileges."
  exit 0
fi

echo "PR created but merge failed. Merge manually: $PR_URL" >&2
exit 1
