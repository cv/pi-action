#!/bin/sh
set -eu

# Check if tracked dist files changed after build.
if ! git diff --quiet dist/; then
	echo ""
	echo "❌ ERROR: dist/ is out of date!"
	echo ""
	echo "The following files in dist/ have changed after build:"
	git diff --name-only dist/
	echo ""
	echo "Please stage the updated dist/ files:"
	echo "  git add dist/"
	echo ""
	exit 1
fi

# Also check for untracked files in dist/.
UNTRACKED=$(git ls-files --others --exclude-standard dist/)
if [ -n "$UNTRACKED" ]; then
	echo ""
	echo "❌ ERROR: New files in dist/ are not staged!"
	echo ""
	echo "The following new files need to be added:"
	echo "$UNTRACKED"
	echo ""
	echo "Please add them:"
	echo "  git add dist/"
	echo ""
	exit 1
fi

echo "✅ dist/ is up to date!"
