#!/bin/bash
# Keeps the Arduino UNO Q (USB) fed by the pedal: adb reverse so the board reaches
# 127.0.0.1:8088, and push + restart the hearts app whenever the installed build changes.
set -uo pipefail
home=/home/test/duet-ai
app=/home/arduino/ArduinoApps/duet-hearts
while true; do
  if ! adb get-state >/dev/null 2>&1; then
    sleep 5
    continue
  fi
  adb reverse tcp:8088 tcp:8088 >/dev/null 2>&1 || true
  want=$(cat "$home/COMMIT" 2>/dev/null || echo dev)
  have=$(adb shell "cat $app/COMMIT 2>/dev/null" 2>/dev/null | tr -d '[:space:]')
  if [ "$want" != "$have" ]; then
    echo "unoq: installing $want (had ${have:-none})"
    adb shell "mkdir -p $app" && \
    adb push "$home/services/unoq/." "$app/" >/dev/null && \
    adb shell "echo $want > $app/COMMIT && arduino-app-cli app restart $app" \
      || { echo "unoq: install failed"; sleep 30; continue; }
  fi
  sleep 10
done
