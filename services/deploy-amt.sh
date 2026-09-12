#!/usr/bin/env bash
# Redeploy the AMT service on the pod, wait for it to come healthy, then run the live smoke test.
# Exits non-zero (and prints the last 30 lines of the pod's AMT log) if the smoke fails.
#
#   services/deploy-amt.sh
#
# Env overrides (defaults match services/DEPLOYED.md):
#   POD_HOST      root@103.196.86.81
#   POD_SSH_PORT  34907
#   AMT_PORT      18081
#   RELAY_BASE    https://backline-relay.shylenkoa.workers.dev
#   HEALTH_WAIT_S 180   (max seconds to wait for /health to report amt:true)
set -euo pipefail

POD_HOST="${POD_HOST:-root@103.196.86.81}"
POD_SSH_PORT="${POD_SSH_PORT:-34907}"
AMT_PORT="${AMT_PORT:-18081}"
RELAY_BASE="${RELAY_BASE:-https://backline-relay.shylenkoa.workers.dev}"
HEALTH_WAIT_S="${HEALTH_WAIT_S:-180}"

ssh_pod() {
  ssh -p "$POD_SSH_PORT" "$POD_HOST" "$@"
}

echo "==> redeploying amt on ${POD_HOST}:${POD_SSH_PORT}"
ssh_pod "cd /opt/backline && git pull --no-rebase origin main && tmux kill-session -t amt; tmux new-session -d -s amt \"cd /opt/backline/services/amt && PORT=${AMT_PORT} /opt/amt-venv/bin/python server.py 2>&1 | tee /var/log/amt.log\""

echo "==> waiting up to ${HEALTH_WAIT_S}s for ${RELAY_BASE}/health to report amt:true"
deadline=$((SECONDS + HEALTH_WAIT_S))
healthy=false
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl -s -m 5 "${RELAY_BASE}/health" | grep -q '"amt":true'; then
    healthy=true
    break
  fi
  sleep 5
done

if [ "$healthy" != true ]; then
  echo "FAIL: amt did not report healthy within ${HEALTH_WAIT_S}s" >&2
  echo "==> last 30 lines of /var/log/amt.log on the pod:" >&2
  ssh_pod "tail -n 30 /var/log/amt.log" >&2 || true
  exit 1
fi

echo "==> amt healthy, running live smoke"
if ! npm run smoke:live -- "$RELAY_BASE"; then
  echo "FAIL: smoke test failed after redeploy" >&2
  echo "==> last 30 lines of /var/log/amt.log on the pod:" >&2
  ssh_pod "tail -n 30 /var/log/amt.log" >&2 || true
  exit 1
fi

echo "==> deploy-amt OK"
