#!/bin/bash
# Build on the development computer; the Pi does not need Node or internet access.
set -euo pipefail
cd "$(dirname "$0")/../.."
target=${1:-test@192.168.10.1}
control=${DUET_SSH_CONTROL:-/tmp/duet-pi-%r@%h:%p}
ssh_args=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$control")
npm run build:pi
ssh "${ssh_args[@]}" "$target" 'mkdir -p /home/test/duet-ai/site/backline /home/test/duet-ai/services/pi'
tar -C dist-pi -cf - . | ssh "${ssh_args[@]}" "$target" 'tar --warning=no-timestamp -C /home/test/duet-ai/site/backline -xf -'
tar --exclude=__pycache__ -cf - services/pi | ssh "${ssh_args[@]}" "$target" 'tar --warning=no-timestamp -C /home/test/duet-ai -xf -'
ssh "${ssh_args[@]}" "$target" 'bash /home/test/duet-ai/services/pi/install.sh'
