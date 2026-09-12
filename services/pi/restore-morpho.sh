#!/bin/bash
set -euo pipefail
sudo systemctl disable --now duet-browser.service duet-lcd.service duet-web.service
if systemctl cat duet-arturia.service >/dev/null 2>&1; then
  sudo systemctl disable --now duet-arturia.service
fi
if systemctl cat duet-amt.service >/dev/null 2>&1; then
  sudo systemctl disable --now duet-amt.service
fi
if [ "$(cat /home/test/duet-ai/original-morpho-enabled)" = enabled ]; then
  sudo systemctl enable PiMorpho.service
fi
sudo systemctl start PiMorpho.service
