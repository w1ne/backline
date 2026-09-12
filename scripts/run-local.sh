#!/usr/bin/env bash
# Run duet.ai locally on macOS or Linux.
#
#   scripts/run-local.sh            app only, talks to the hosted relay
#   scripts/run-local.sh --relay    also run the relay locally (wrangler dev)
#   scripts/run-local.sh --no-open  don't open a browser
#
# The app is served at http://localhost:8088/backline/ (port 8088 is one of the
# origins the hosted relay accepts). With --relay the Worker runs on :8787 and
# needs GEMINI_API_KEY (from the environment or ~/.local/secrets/gemini.env);
# ACESTEP_UPSTREAM / AMT_UPSTREAM are optional and enable those engines.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PORT="${APP_PORT:-8088}"
RELAY_PORT="${RELAY_PORT:-8787}"
RUN_RELAY=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --relay) RUN_RELAY=1 ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "node is required (https://nodejs.org, v18+)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "node v18+ required, found $(node -v)" >&2; exit 1; }

cd "$ROOT"
[ -d node_modules ] || npm install

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [ "$RUN_RELAY" = 1 ]; then
  if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$HOME/.local/secrets/gemini.env" ]; then
    # shellcheck disable=SC1091
    set -a; . "$HOME/.local/secrets/gemini.env"; set +a
  fi
  [ -n "${GEMINI_API_KEY:-}" ] || { echo "GEMINI_API_KEY not set; export it or put it in ~/.local/secrets/gemini.env" >&2; exit 1; }
  ( cd relay && { [ -d node_modules ] || npm install; } )
  {
    echo "GEMINI_API_KEY=$GEMINI_API_KEY"
    [ -n "${ACESTEP_UPSTREAM:-}" ] && echo "ACESTEP_UPSTREAM=$ACESTEP_UPSTREAM"
    [ -n "${AMT_UPSTREAM:-}" ] && echo "AMT_UPSTREAM=$AMT_UPSTREAM"
    true
  } > relay/.dev.vars
  ( cd relay && npx wrangler dev --port "$RELAY_PORT" --local ) &
  PIDS+=($!)
  export VITE_RELAY_URL="http://localhost:$RELAY_PORT"
  echo "relay: $VITE_RELAY_URL"
fi

URL="http://localhost:$APP_PORT/backline/"
echo "app:   $URL"
if [ "$OPEN" = 1 ]; then
  ( sleep 2; if command -v open >/dev/null; then open "$URL"; elif command -v xdg-open >/dev/null; then xdg-open "$URL"; fi ) >/dev/null 2>&1 &
fi
exec npx vite --port "$APP_PORT" --strictPort --host localhost
