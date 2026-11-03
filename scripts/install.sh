#!/bin/bash
# Installs or updates Curator from the latest GitHub release, and connects it to Claude Code.
#   curl -fsSL https://raw.githubusercontent.com/BostelJ/curator/main/scripts/install.sh | bash
set -euo pipefail

REPO="BostelJ/curator"
DEST="${CURATOR_INSTALL_DIR:-/Applications}"
APP="$DEST/Curator.app"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

[ "$(uname)" = "Darwin" ] || { echo "Curator is a Mac app."; exit 1; }
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 13 ] || { echo "Curator needs macOS 13 or newer."; exit 1; }

say "Finding the latest release…"
release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
url=$(printf '%s' "$release" | grep -o '"browser_download_url": *"[^"]*\.zip"' | head -1 | cut -d'"' -f4)
tag=$(printf '%s' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$url" ] || { echo "Couldn't find a release to download."; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
say "Downloading Curator $tag…"
curl -fsSL "$url" -o "$work/Curator.zip"
ditto -x -k "$work/Curator.zip" "$work"
[ -d "$work/Curator.app" ] || { echo "The download didn't contain Curator.app."; exit 1; }

if pgrep -f "$APP/Contents/MacOS/Curator\$" >/dev/null 2>&1; then
  osascript -e 'quit app "Curator"' >/dev/null 2>&1 || true
  sleep 1
fi
mkdir -p "$DEST"
rm -rf "$APP"
ditto "$work/Curator.app" "$APP"
# Downloaded with curl, so macOS hasn't quarantined it; this just makes sure.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
say "Installed $APP"

if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user curator >/dev/null 2>&1 || true
  claude mcp add --scope user curator -- "$APP/Contents/MacOS/Curator" mcp >/dev/null
  mkdir -p "$HOME/.claude/skills/curator"
  cp "$APP/Contents/Resources/skill/SKILL.md" "$HOME/.claude/skills/curator/SKILL.md"
  say "Connected to Claude Code. Restart any open Claude Code sessions to use it."
else
  echo "Claude Code isn't installed, so Curator wasn't connected to it. Install Claude Code, then run this again."
fi

open -g "$APP"
say "Done. Curator is in your menu bar (the tilted print). ⌃⌥G opens the art gallery."
