#!/usr/bin/env bash
#
# Manually test the LeanEdits extension against concurrent VS Code launches.
#
# What this script does:
#   - Packages the extension from source into a fresh .vsix.
#   - Creates a throwaway VS Code profile (user-data-dir + extensions-dir) so
#     no settings, globalState, or other extensions from your real install
#     leak into the test.
#   - Snapshots and resets your real global .gitignore for the duration of
#     the test, then restores it on exit (even on Ctrl-C).
#   - Removes any leftover .changes/ directories in the two test repos.
#   - Launches two VS Code windows concurrently against the two repos so you
#     can manually verify the focus/race behavior of the activation prompts.
#
# Usage:
#   scripts/test-extension.sh <lean-repo-a> <lean-repo-b>
#

set -e

REPO_A="$1"
REPO_B="$2"

if [ -z "$REPO_A" ] || [ -z "$REPO_B" ]; then
  echo "usage: $0 <lean-repo-a> <lean-repo-b>"
  exit 1
fi

GITIGNORE=$(git config --global core.excludesfile 2>/dev/null || echo "$HOME/.gitignore_global")
SNAPSHOT=$(mktemp -t leanedits-gitignore-XXXX)
HAD_FILE=0
if [ -f "$GITIGNORE" ]; then
  cp "$GITIGNORE" "$SNAPSHOT"
  HAD_FILE=1
fi

PROFILE=""
cleanup() {
  if [ "$HAD_FILE" -eq 1 ]; then
    mv "$SNAPSHOT" "$GITIGNORE"
  else
    rm -f "$GITIGNORE" "$SNAPSHOT"
  fi
  echo "Restored $GITIGNORE"
  if [ -n "$PROFILE" ] && [ -d "$PROFILE" ]; then
    if rm -rf "$PROFILE" 2>/dev/null; then
      echo "Removed profile $PROFILE"
    else
      echo "Could not fully remove profile $PROFILE (VS Code may still be running). Delete manually after closing the windows."
    fi
  fi
}
trap cleanup EXIT

# Reset state for the test run
rm -f "$GITIGNORE"
rm -rf "$REPO_A/.changes" "$REPO_B/.changes"

# Fresh VS Code profile + freshly packaged extension + the upstream Lean extension
PROFILE=$(mktemp -d -t leanedits-test-XXXX)
npx vsce package --out /tmp/lean-edits-dev.vsix >/dev/null
code --user-data-dir "$PROFILE" --extensions-dir "$PROFILE/ext" \
     --install-extension leanprover.lean4 \
     --install-extension /tmp/lean-edits-dev.vsix >/dev/null

code --user-data-dir "$PROFILE" --extensions-dir "$PROFILE/ext" -n "$REPO_A" &
code --user-data-dir "$PROFILE" --extensions-dir "$PROFILE/ext" -n "$REPO_B" &

echo
echo "Two VS Code windows launched against profile: $PROFILE"
echo "Close both VS Code windows, then press Enter to restore your gitignore and delete the profile..."
read -r
