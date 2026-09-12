#!/bin/bash
set -euo pipefail
export DISPLAY=:0
export XAUTHORITY=/home/test/.Xauthority
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus

pactl set-default-sink alsa_output.platform-sound-ak4554.stereo-fallback
pactl set-default-source alsa_input.platform-sound-ak4554.stereo-fallback
pactl set-sink-mute @DEFAULT_SINK@ 0
pactl set-source-mute @DEFAULT_SOURCE@ 0

# Scope unattended MIDI permission to the local device app, in its own profile.
python3 - <<'PYPREFS'
import json
from pathlib import Path
path = Path('/home/test/duet-ai/chromium/Default/Preferences')
path.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(path.read_text()) if path.exists() else {}
exceptions = data.setdefault('profile', {}).setdefault('content_settings', {}).setdefault('exceptions', {})
for permission in ('midi', 'midi_sysex'):
    exceptions.setdefault(permission, {})['http://127.0.0.1:8088,*'] = {'setting': 1}
path.write_text(json.dumps(data))
PYPREFS

exec /usr/bin/chromium \
  --user-data-dir=/home/test/duet-ai/chromium \
  --password-store=basic --disable-extensions \
  --no-first-run --no-default-browser-check --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream \
  --disable-background-networking --disable-component-update --disable-sync \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --kiosk --app='http://127.0.0.1:8088/backline/?debug=1'
