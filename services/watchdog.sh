#!/usr/bin/env bash
# Cron watchdog: check relay health, and if amt or acestep is reported down, restart just that
# service's tmux session on the pod (never stop/restart the pod itself). Re-checks health after
# the restart and appends one line to ~/backline-watchdog.log describing what happened. Prints
# nothing when everything is already healthy, so cron doesn't mail on every run.
#
#   services/watchdog.sh
#
# Install with cron, every 5 minutes:
#
#   */5 * * * * /path/to/backline/services/watchdog.sh >/dev/null 2>&1
#
# Env overrides (defaults match services/DEPLOYED.md):
#   POD_HOST      root@103.196.86.81
#   POD_SSH_PORT  34907
#   AMT_PORT      18081
#   RELAY_BASE    https://backline-relay.shylenkoa.workers.dev
#   RESTART_WAIT_S 60   (seconds to wait after restarting a session before re-checking health)
#   LOG_FILE      ~/backline-watchdog.log
set -euo pipefail

POD_HOST="${POD_HOST:-root@103.196.86.81}"
POD_SSH_PORT="${POD_SSH_PORT:-34907}"
AMT_PORT="${AMT_PORT:-18081}"
RELAY_BASE="${RELAY_BASE:-https://backline-relay.shylenkoa.workers.dev}"
RESTART_WAIT_S="${RESTART_WAIT_S:-60}"
LOG_FILE="${LOG_FILE:-$HOME/backline-watchdog.log}"

ssh_pod() {
  ssh -p "$POD_SSH_PORT" "$POD_HOST" "$@"
}

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG_FILE"
}

health_json="$(curl -s -m 10 "${RELAY_BASE}/health" || echo '{}')"

amt_ok="false"
acestep_ok="false"
echo "$health_json" | grep -q '"amt":true' && amt_ok="true"
echo "$health_json" | grep -q '"acestep":true' && acestep_ok="true"

if [ "$amt_ok" = "true" ] && [ "$acestep_ok" = "true" ]; then
  exit 0
fi

log "unhealthy: ${health_json}"

if [ "$amt_ok" != "true" ]; then
  log "restarting amt tmux session"
  ssh_pod "tmux kill-session -t amt 2>/dev/null; tmux new-session -d -s amt \"cd /opt/backline/services/amt && PORT=${AMT_PORT} /opt/amt-venv/bin/python server.py 2>&1 | tee /var/log/amt.log\"" || log "amt restart command failed"
fi

if [ "$acestep_ok" != "true" ]; then
  log "restarting ace tmux session"
  ssh_pod "tmux kill-session -t ace 2>/dev/null; tmux new-session -d -s ace \"cd /opt/backline/services/acestep && ACESTEP_CHECKPOINTS_DIR=/opt/ace-step/checkpoints ACE_REPO_DIR=/opt/ace-step PORT=8080 /opt/ace-step/.venv/bin/python server.py 2>&1 | tee /var/log/ace.log\"" || log "ace restart command failed"
fi

sleep "$RESTART_WAIT_S"

health_json2="$(curl -s -m 10 "${RELAY_BASE}/health" || echo '{}')"
log "after restart: ${health_json2}"
