#!/bin/bash
# Bootstrap/redeploy the stable recovery entry point without replacing a transaction's runner.
set -euo pipefail
cd "${1:-/home/test/duet-ai}"
install -d -m 755 .updates
# The transactional updater calls install.sh while holding this same lock. Its
# durable journal means it owns runner publication after the health check.
if [ -f .updates/pending.json ]; then
  exit 0
fi
exec 9>.updates/lock
flock -x 9
# An updater may have acquired the lock between our first check and flock.
if [ -f .updates/pending.json ]; then
  exit 0
fi
install -m 644 services/pi/update.py .updates/update-runner.py.new
mv -f .updates/update-runner.py.new .updates/update-runner.py
