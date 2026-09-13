#!/usr/bin/env bash
# Supervisor loop for one AMT process: restart it whenever it exits (a fatal CUDA error makes
# server.py exit on purpose; see die_after_cuda_error). Run inside a tmux session so the
# process keeps a parent and the watchdog's orphan reaper leaves it alone.
#
#   run-amt.sh <port> [max_sessions] [log_file]
#
# The log is appended (a restart used to truncate it and lose every committed= line) and
# rotated once past 50 MB.
set -u
PORT="${1:?port}"
MAX="${2:-3}"
LOG="${3:-/var/log/amt-${PORT}.log}"
cd "$(dirname "$0")"
while :; do
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 52428800 ]; then mv -f "$LOG" "$LOG.1"; fi
  echo "$(date -u +%FT%TZ) run-amt: starting server.py on port $PORT (max $MAX sessions)" | tee -a "$LOG"
  AMT_MAX_SESSIONS="$MAX" PORT="$PORT" /opt/amt-venv/bin/python server.py 2>&1 | tee -a "$LOG"
  echo "$(date -u +%FT%TZ) run-amt: server.py exited (${PIPESTATUS[0]}), restarting in 3 s" | tee -a "$LOG"
  sleep 3
done
