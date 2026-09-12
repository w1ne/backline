#!/usr/bin/env bash
# Starts/stops the local dev stack: AMT model server, local relay (wrangler
# dev), and the Vite dev server -- wired together so the browser's AMT engine
# talks to a locally-running model instead of the cloud pod.
#
#   scripts/dev-stack.sh start   # launch all three, wait for health checks
#   scripts/dev-stack.sh stop    # kill all three
#   scripts/dev-stack.sh status  # show what's up
#   scripts/dev-stack.sh restart
#
# Requires: relay/.dev.vars with AMT_UPSTREAM=ws://localhost:8080/ws, and
# .env.local at the repo root with VITE_RELAY_URL=http://localhost:8787.
# Requires the `ml` pyenv virtualenv (services/amt/requirements.txt installed
# there) -- override with AMT_PYTHON=/path/to/python.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT/.dev-pids"
LOG_DIR="$ROOT/.dev-logs"
AMT_PYTHON="${AMT_PYTHON:-$HOME/.pyenv/versions/ml/bin/python}"

mkdir -p "$PID_DIR" "$LOG_DIR"

AMT_PID_FILE="$PID_DIR/amt.pid"
RELAY_PID_FILE="$PID_DIR/relay.pid"
VITE_PID_FILE="$PID_DIR/vite.pid"

is_running() {
  local pid_file="$1"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

# npm/vite and wrangler/workerd fork a child that ends up holding the actual
# listening socket, so killing the tracked launcher PID alone leaves an
# orphan bound to the port. Track by port and kill whatever's listening.
pid_on_port() {
  lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true
}

start_one() {
  local name="$1" pid_file="$2" log_file="$3" dir="$4" port="$5"
  shift 5
  if is_running "$pid_file" || [ -n "$(pid_on_port "$port")" ]; then
    echo "$name: already running"
    return
  fi
  ( cd "$dir" && nohup "$@" >"$log_file" 2>&1 & echo $! >"$pid_file" )
  echo "$name: started, logging to $log_file"
}

stop_one() {
  local name="$1" pid_file="$2" port="$3"
  local killed=0
  if is_running "$pid_file"; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    killed=1
  fi
  local pid
  for pid in $(pid_on_port "$port"); do
    kill "$pid" 2>/dev/null || true
    killed=1
  done
  if [ "$killed" = 1 ]; then
    for _ in $(seq 1 20); do
      [ -z "$(pid_on_port "$port")" ] && break
      sleep 0.25
    done
    for pid in $(pid_on_port "$port"); do
      kill -9 "$pid" 2>/dev/null || true
    done
    echo "$name: stopped"
  else
    echo "$name: not running"
  fi
  rm -f "$pid_file"
}

wait_for_http() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      echo "$name: healthy ($url)"
      return 0
    fi
    sleep 0.5
  done
  echo "$name: did not become healthy in time ($url) -- check its log" >&2
  return 1
}

cmd_start() {
  if [ ! -x "$AMT_PYTHON" ]; then
    echo "AMT_PYTHON not found at $AMT_PYTHON -- set AMT_PYTHON=/path/to/python" >&2
    exit 1
  fi

  start_one "amt" "$AMT_PID_FILE" "$LOG_DIR/amt.log" "$ROOT/services/amt" 8080 \
    "$AMT_PYTHON" server.py
  start_one "relay" "$RELAY_PID_FILE" "$LOG_DIR/relay.log" "$ROOT/relay" 8787 \
    npx wrangler dev --port 8787
  start_one "vite" "$VITE_PID_FILE" "$LOG_DIR/vite.log" "$ROOT" 5173 \
    npm run dev -- --port 5173

  wait_for_http "http://localhost:8080/health" "amt" || true
  wait_for_http "http://localhost:8787/health" "relay" || true
  wait_for_http "http://localhost:5173/backline/" "vite" || true

  echo
  echo "App:   http://localhost:5173/backline/"
  echo "Relay: http://localhost:8787"
  echo "AMT:   http://localhost:8080/health"
}

cmd_stop() {
  stop_one "vite" "$VITE_PID_FILE" 5173
  stop_one "relay" "$RELAY_PID_FILE" 8787
  stop_one "amt" "$AMT_PID_FILE" 8080
}

cmd_status() {
  local entry name port
  for entry in "amt:8080" "relay:8787" "vite:5173"; do
    name="${entry%%:*}" port="${entry#*:}"
    local pid
    pid="$(pid_on_port "$port")"
    if [ -n "$pid" ]; then
      echo "$name: running (port $port, pid $pid)"
    else
      echo "$name: stopped"
    fi
  done
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  *)
    echo "usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
