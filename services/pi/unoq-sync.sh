#!/bin/bash
# Keeps the Arduino UNO Q (USB) fed by the pedal: adb reverse so the board reaches
# 127.0.0.1:8088, a DNAT on the board so its app container reaches that listener through
# the host-gateway alias, and push + restart the hearts app whenever the installed build changes.
# Runs as root (adb needs the USB device; the board shell is root anyway).
set -uo pipefail
home=/home/test/duet-ai
app=/home/arduino/ArduinoApps/duet-hearts
# arduino-app-cli must run as the board's `arduino` user; adbd's shell env carries an
# Android TMPDIR that does not exist on the board's Debian.
as_arduino='runuser -u arduino -- env TMPDIR=/tmp HOME=/home/arduino USER=arduino LOGNAME=arduino'
while true; do
  if ! adb get-state >/dev/null 2>&1; then
    sleep 5
    continue
  fi
  adb reverse tcp:8088 tcp:8088 >/dev/null 2>&1 || true
  adb shell "sysctl -qw net.ipv4.conf.all.route_localnet=1; iptables -t nat -C PREROUTING -p tcp --dport 8088 -j DNAT --to-destination 127.0.0.1:8088 2>/dev/null || iptables -t nat -I PREROUTING -p tcp --dport 8088 -j DNAT --to-destination 127.0.0.1:8088" >/dev/null 2>&1 || true
  want=$(cat "$home/COMMIT" 2>/dev/null || echo dev)
  have=$(adb shell "cat $app/COMMIT 2>/dev/null" 2>/dev/null | tr -d '[:space:]')
  if [ "$want" != "$have" ]; then
    echo "unoq: installing $want (had ${have:-none})"
    adb shell "mkdir -p $app" && \
    adb push "$home/services/unoq/." "$app/" >/dev/null && \
    adb shell "echo $want > $app/COMMIT && chown -R arduino:arduino $app && $as_arduino arduino-app-cli app restart $app" \
      || { echo "unoq: install failed"; sleep 30; continue; }
  fi
  sleep 10
done
