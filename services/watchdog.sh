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
#   RESTART_GRACE_S 180 (seconds after a restart during which the watchdog only observes: the
#                        model takes a while to load and /health says 503 "loading" meanwhile)
#   LOG_FILE      ~/backline-watchdog.log
#   STATE_FILE    ~/.backline-watchdog-restarted-at  (epoch seconds of the last restart)
set -euo pipefail

POD_HOST="${POD_HOST:-root@103.196.86.81}"
POD_SSH_PORT="${POD_SSH_PORT:-34907}"
AMT_PORT="${AMT_PORT:-18081}"
RELAY_BASE="${RELAY_BASE:-https://backline-relay.shylenkoa.workers.dev}"
RESTART_WAIT_S="${RESTART_WAIT_S:-60}"
RESTART_GRACE_S="${RESTART_GRACE_S:-180}"
LOG_FILE="${LOG_FILE:-$HOME/backline-watchdog.log}"
STATE_FILE="${STATE_FILE:-$HOME/.backline-watchdog-restarted-at}"

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

# Reap orphaned service processes on every run, healthy or not: a `python server.py` whose
# parent is init (its tmux/bash is gone) is a leak from an interrupted deploy or benchmark,
# each one holding ~1 GB of GPU. Match the exact venv interpreters and nothing else -- a broad
# `pgrep -f server.py` once matched the tmux server itself and took prod down.
reaped="$(ssh_pod 'for p in $(pgrep -f "^/opt/(ace-step/\.venv|amt-venv)/bin/python .*server\.py"); do
  if [ "$(ps -o ppid= -p "$p" | tr -d " ")" = "1" ]; then kill "$p" && echo "$p"; fi; done' 2>/dev/null || true)"
if [ -n "$reaped" ]; then
  log "reaped orphan service processes: $(echo "$reaped" | tr '\n' ' ')"
fi

if [ "$amt_ok" = "true" ] && [ "$acestep_ok" = "true" ]; then
  exit 0
fi

# A pod whose /health is 503 is up and loading its model: not ready, not broken. Leave it.
if echo "$health_json" | grep -q '"amtState":"loading"'; then
  log "amt loading (503), not restarting: ${health_json}"
  amt_ok="true"
fi
if echo "$health_json" | grep -q '"acestepState":"loading"'; then
  log "acestep loading (503), not restarting: ${health_json}"
  acestep_ok="true"
fi
if [ "$amt_ok" = "true" ] && [ "$acestep_ok" = "true" ]; then
  exit 0
fi

# After a restart the service needs time to load before /health can go green; another restart
# inside that window would only reset the clock.
if [ -f "$STATE_FILE" ]; then
  last_restart="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
  since=$(( $(date +%s) - ${last_restart:-0} ))
  if [ "$since" -lt "$RESTART_GRACE_S" ]; then
    log "unhealthy but restarted ${since}s ago (< ${RESTART_GRACE_S}s grace), waiting: ${health_json}"
    exit 0
  fi
fi

log "unhealthy: ${health_json}"
date +%s > "$STATE_FILE"

if [ "$amt_ok" != "true" ]; then
  log "restarting amt tmux session"
  ssh_pod "tmux kill-session -t amt 2>/dev/null; f=/var/log/amt.log; if [ -f \$f ] && [ \$(stat -c%s \$f) -gt 52428800 ]; then mv -f \$f \$f.1; fi; tmux new-session -d -s amt \"cd /opt/backline/services/amt && PORT=${AMT_PORT} /opt/amt-venv/bin/python server.py 2>&1 | tee -a /var/log/amt.log\"" || log "amt restart command failed"
fi

if [ "$acestep_ok" != "true" ]; then
  log "restarting ace tmux session"
  ssh_pod "tmux kill-session -t ace 2>/dev/null; tmux new-session -d -s ace \"cd /opt/backline/services/acestep && ACESTEP_CHECKPOINTS_DIR=/opt/ace-step/checkpoints ACE_REPO_DIR=/opt/ace-step PORT=8080 /opt/ace-step/.venv/bin/python server.py 2>&1 | tee /var/log/ace.log\"" || log "ace restart command failed"
fi

sleep "$RESTART_WAIT_S"

health_json2="$(curl -s -m 10 "${RELAY_BASE}/health" || echo '{}')"
log "after restart: ${health_json2}"
