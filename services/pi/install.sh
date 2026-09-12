#!/bin/bash
# Run on the stock LYDIA image after copying the build and services to /home/test/duet-ai.
set -euo pipefail
cd /home/test/duet-ai
test -f site/backline/index.html
if [ ! -f original-morpho-enabled ]; then
  systemctl is-enabled PiMorpho.service > original-morpho-enabled || true
fi
sudo install -m 644 services/pi/duet-web.service services/pi/duet-browser.service services/pi/duet-lcd.service services/pi/duet-arturia.service services/pi/duet-update.service services/pi/duet-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable --now PiMorpho.service
if systemctl cat duet-amt.service >/dev/null 2>&1; then
  sudo systemctl disable --now duet-amt.service
fi
sudo systemctl enable duet-web.service duet-browser.service duet-lcd.service duet-arturia.service duet-update.timer
sudo systemctl start duet-update.timer
sudo systemctl restart duet-web.service duet-browser.service duet-lcd.service duet-arturia.service
python3 - <<'PY'
import json
import time
from urllib.request import urlopen
for attempt in range(30):
    try:
        with urlopen('http://127.0.0.1:8088/api/status', timeout=2) as response:
            state = json.load(response)
        if state.get('online') and state.get('power') == 'on' and state.get('sources', {}).get('mic') == 'on' and not state.get('audioSuspended'):
            print('duet.ai ready: local audio active; network controller on port 8088')
            break
    except OSError:
        pass
    time.sleep(1)
else:
    raise SystemExit('duet.ai did not become ready. Inspect journalctl -u duet-browser -u duet-web.')
PY
