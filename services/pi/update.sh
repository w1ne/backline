#!/bin/bash
# Runs on the pedal from duet-update.timer: install the newest main build when it differs
# from the installed one. No Node, no git and no token needed; the release is public.
set -euo pipefail
base=https://github.com/w1ne/backline/releases/download/pi-latest
home=/home/test/duet-ai
cd "$home"
latest=$(curl -fsSL --max-time 20 "$base/COMMIT" | tr -d '[:space:]') || { echo "update: release unreachable"; exit 0; }
current=$(cat COMMIT 2>/dev/null | tr -d '[:space:]' || true)
[ -n "$latest" ] || exit 0
[ "$latest" != "$current" ] || exit 0
echo "update: $current -> $latest"
tmp=$(mktemp -d /tmp/duet-update.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 600 -o "$tmp/duet-pi.tar.gz" "$base/duet-pi.tar.gz"
mkdir -p "$tmp/pkg" && tar -C "$tmp/pkg" -xzf "$tmp/duet-pi.tar.gz"
test -f "$tmp/pkg/site/backline/index.html"
test -f "$tmp/pkg/services/pi/install.sh"
[ "$(tr -d '[:space:]' < "$tmp/pkg/COMMIT")" = "$latest" ]
rm -rf site.new && mv "$tmp/pkg/site" site.new
rm -rf services/pi.new && mv "$tmp/pkg/services/pi" services/pi.new
rm -rf services/unoq && mv "$tmp/pkg/services/unoq" services/unoq
rm -rf site.old services/pi.old
mv site site.old 2>/dev/null || true
mv site.new site
mv services/pi services/pi.old 2>/dev/null || true
mv services/pi.new services/pi
cp "$tmp/pkg/COMMIT" COMMIT
rm -rf site.old services/pi.old
chown -R test:test "$home"
bash services/pi/install.sh
echo "update: installed $latest"
