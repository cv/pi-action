#!/bin/sh
set -eu

# Auto-append issue number from branch name to commit message.
# Example: branch "fix/123-bug-description" will append "Refs #123".

COMMIT_MSG_FILE=${1:?commit message file is required}
COMMIT_SOURCE=${2:-}

# Only modify regular commits (not merge, squash, etc.).
if [ -n "$COMMIT_SOURCE" ]; then
	exit 0
fi

BRANCH_NAME=$(git symbolic-ref --short HEAD 2>/dev/null || true)
ISSUE_NUMBER=$(echo "$BRANCH_NAME" | grep -oE '[0-9]+' | head -1)

if [ -n "$ISSUE_NUMBER" ]; then
	if ! grep -qE "#$ISSUE_NUMBER" "$COMMIT_MSG_FILE"; then
		echo "" >> "$COMMIT_MSG_FILE"
		echo "Refs #$ISSUE_NUMBER" >> "$COMMIT_MSG_FILE"
	fi
fi
