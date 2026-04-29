#!/bin/sh
set -eu

# Install lightweight git hooks that enforce conventional commits.
# These are standalone shell scripts with no dependencies.

HOOKS_DIR=".git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
	echo "⚠️ Not a git repository, skipping hooks installation"
	exit 0
fi

echo "🪝 Installing pi-agent git hooks..."

# Create commit-msg hook for conventional commits (standalone, no deps).
# Only install if no existing hook.
if [ ! -f "$HOOKS_DIR/commit-msg" ]; then
	cat > "$HOOKS_DIR/commit-msg" << 'HOOK'
#!/bin/sh
# pi-agent: Enforce conventional commits format
# This hook is installed by pi-action to ensure agent commits follow conventions

commit_msg=$(cat "$1")

# Pattern for conventional commits: type(scope)?: description
pattern="^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .{1,}"

if ! echo "$commit_msg" | grep -qE "$pattern"; then
	echo ""
	echo "❌ Commit message does not follow Conventional Commits format!"
	echo ""
	echo "Expected format: type(scope?): description"
	echo ""
	echo "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert"
	echo ""
	echo "Examples:"
	echo "  feat: add new feature"
	echo "  fix(auth): resolve login issue"
	echo "  docs: update README"
	echo ""
	echo "Your message: $commit_msg"
	echo ""
	exit 1
fi
HOOK
	chmod +x "$HOOKS_DIR/commit-msg"
	echo "  ✓ commit-msg hook installed (conventional commits)"
else
	echo "  ⏭️ commit-msg hook already exists, skipping"
fi

# Create prepare-commit-msg hook for auto-linking issues.
if [ ! -f "$HOOKS_DIR/prepare-commit-msg" ]; then
	cat > "$HOOKS_DIR/prepare-commit-msg" << 'HOOK'
#!/bin/sh
# pi-agent: Auto-append issue number from branch name

COMMIT_MSG_FILE=$1
COMMIT_SOURCE=$2

# Only for regular commits (not merge, squash, etc.)
if [ -z "$COMMIT_SOURCE" ]; then
	BRANCH_NAME=$(git symbolic-ref --short HEAD 2>/dev/null)
	ISSUE_NUMBER=$(echo "$BRANCH_NAME" | grep -oE '[0-9]+' | head -1)

	if [ -n "$ISSUE_NUMBER" ]; then
		if ! grep -qE "#$ISSUE_NUMBER" "$COMMIT_MSG_FILE"; then
			echo "" >> "$COMMIT_MSG_FILE"
			echo "Refs #$ISSUE_NUMBER" >> "$COMMIT_MSG_FILE"
		fi
	fi
fi
HOOK
	chmod +x "$HOOKS_DIR/prepare-commit-msg"
	echo "  ✓ prepare-commit-msg hook installed (auto issue linking)"
else
	echo "  ⏭️ prepare-commit-msg hook already exists, skipping"
fi

echo "✅ Git hooks ready!"
