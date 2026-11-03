#!/bin/bash
# Builds dist/Curator.app. With --install, also replaces /Applications/Curator.app.
set -euo pipefail
cd "$(dirname "$0")/.."

# --universal builds for Apple Silicon and Intel (what releases ship). VERSION sets the version.
ARCHS=()
for arg in "$@"; do [ "$arg" = "--universal" ] && ARCHS=(--arch arm64 --arch x86_64); done
VERSION="${VERSION:-0.0.0-dev}"
swift build -c release --product Curator ${ARCHS[@]+"${ARCHS[@]}"}
BIN="$(swift build -c release --show-bin-path ${ARCHS[@]+"${ARCHS[@]}"})/Curator"

APP="dist/Curator.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Curator"
cp -R Resources/web "$APP/Contents/Resources/web"
mkdir -p "$APP/Contents/Resources/skill"
cp skill/curator/SKILL.md "$APP/Contents/Resources/skill/SKILL.md"
[ -f Resources/Curator.icns ] && cp Resources/Curator.icns "$APP/Contents/Resources/Curator.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Curator</string>
  <key>CFBundleDisplayName</key><string>Curator</string>
  <key>CFBundleIdentifier</key><string>com.bostelj.curator</string>
  <key>CFBundleExecutable</key><string>Curator</string>
  <key>CFBundleIconFile</key><string>Curator</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null
echo "Built $APP"

INSTALL=0
for arg in "$@"; do [ "$arg" = "--install" ] && INSTALL=1; done
if [ "$INSTALL" = 1 ]; then
  osascript -e 'quit app "Curator"' >/dev/null 2>&1 || true
  rm -rf /Applications/Curator.app
  cp -R "$APP" /Applications/Curator.app
  echo "Installed /Applications/Curator.app"
fi
