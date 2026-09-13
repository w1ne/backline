#!/usr/bin/env bash
# Roll the live AMT pool (nginx upstream amt_live on pod port 8081) onto main.
# Eight processes, each capped at 4 sessions (32 admitted; 7 per process still get every plan on time), every one under its own tmux session running
# run-amt.sh, so a crash restarts in seconds and the watchdog's orphan reaper never sees them.
# Order keeps downtime near zero: the seven extras first, the primary (18081, tmux `amt`) last.
#
#   ssh -p <port> root@<pod> 'bash /opt/backline/services/amt/rollout-live.sh'
set -e
cd /opt/backline && git checkout -q main && git pull -q --no-rebase origin main && git log --oneline -1
chmod +x services/amt/run-amt.sh
EXTRA="18093 18094 18095 18096 18097 18098 18099"

start_one() {  # port tmux-session log
  tmux kill-session -t "$2" 2>/dev/null || true
  pid=$(ss -ltnp | grep ":$1 " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
  [ -n "$pid" ] && kill "$pid" && sleep 2
  tmux new-session -d -s "$2" "bash /opt/backline/services/amt/run-amt.sh $1 ${AMT_MAX_SESSIONS:-4} $3"
}
wait_ok() {  # ports...
  for i in $(seq 1 40); do ok=0; for p in "$@"; do curl -s -m 2 "localhost:$p/health" | grep -q '"status":"ok"' && ok=$((ok+1)); done; [ "$ok" = "$#" ] && return 0; sleep 5; done; echo "only $ok/$# healthy" >&2; return 1
}

for port in $EXTRA; do start_one "$port" "amt-$port" "/var/log/amt-$port.log"; done
wait_ok $EXTRA && echo "extras healthy"
start_one 18081 amt /var/log/amt.log
wait_ok 18081 && echo "primary healthy"
for port in 18081 $EXTRA; do echo "$port $(curl -s -m 2 localhost:$port/health | grep -o '"maxSessions":[0-9]*')"; done
