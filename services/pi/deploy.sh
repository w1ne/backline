#!/bin/bash
# Build on the development computer; the Pi needs internet for RunPod inference but does not need Node.
set -euo pipefail
cd "$(dirname "$0")/../.."
target=${1:-test@192.168.10.1}
control=${DUET_SSH_CONTROL:-/tmp/duet-pi-%r@%h:%p}
ssh_args=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$control")
node services/pi/fetch-samples.mjs
npm run build:pi
mkdir -p dist-pi/samples
cp -a .pi-samples/. dist-pi/samples/
git rev-parse HEAD > COMMIT.pi
ssh "${ssh_args[@]}" "$target" 'mkdir -p /home/test/duet-ai/site/backline /home/test/duet-ai/services/pi'
tar -C dist-pi -cf - . | ssh "${ssh_args[@]}" "$target" 'tar --warning=no-timestamp -C /home/test/duet-ai/site/backline -xf -'
tar --exclude=__pycache__ -cf - services/pi services/unoq | ssh "${ssh_args[@]}" "$target" 'tar --warning=no-timestamp -C /home/test/duet-ai -xf -'
ssh "${ssh_args[@]}" "$target" 'cat > /home/test/duet-ai/COMMIT' < COMMIT.pi
ssh "${ssh_args[@]}" "$target" 'bash /home/test/duet-ai/services/pi/install.sh'
