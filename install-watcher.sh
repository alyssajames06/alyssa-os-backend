#!/bin/bash
set -e

PLIST_NAME="com.alyssaos.imessage-watcher.plist"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

# Unload existing agent if already installed
if launchctl list | grep -q "com.alyssaos.imessage-watcher"; then
  echo "Unloading existing agent..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

echo "Copying plist to ~/Library/LaunchAgents/..."
cp "$PLIST_SRC" "$PLIST_DEST"

echo "Loading agent..."
launchctl load "$PLIST_DEST"

echo "Done. imessage-watcher is running and will start automatically on login."
echo "Logs: ~/Library/Logs/imessage-watcher.log"
