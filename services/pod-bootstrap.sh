#!/usr/bin/env bash
# Idempotent pod bootstrap for ACE-Step (8080) + AMT (8081) services.
# Run as root on the RunPod pod. Re-running after a disk-wiping resume
# is expected and safe.
set -uo pipefail

ACE_COMMIT=ca1e85fe9430179831e6bc6be790c332190a3866
ACE_REPO_DIR=/opt/ace-step
BACKLINE_DIR=/opt/backline
AMT_VENV=/opt/amt-venv
LOG_DIR=/var/log

log() { echo "[bootstrap] $*"; }

log "apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/var/log/apt-update.log 2>&1
apt-get install -y ffmpeg git tmux >/var/log/apt-install.log 2>&1

log "clone/update backline"
if [ -d "$BACKLINE_DIR/.git" ]; then
  git -C "$BACKLINE_DIR" fetch origin main
  git -C "$BACKLINE_DIR" checkout main
  git -C "$BACKLINE_DIR" pull --no-rebase origin main
else
  rm -rf "$BACKLINE_DIR"
  git clone https://github.com/w1ne/duet.ai "$BACKLINE_DIR"
fi

log "clone ACE-Step @ $ACE_COMMIT"
if [ -d "$ACE_REPO_DIR/.git" ]; then
  git -C "$ACE_REPO_DIR" fetch --all
else
  rm -rf "$ACE_REPO_DIR"
  git clone https://github.com/ace-step/ACE-Step-1.5.git "$ACE_REPO_DIR"
fi
git -C "$ACE_REPO_DIR" checkout "$ACE_COMMIT"

log "uv sync in ACE-Step repo"
if ! command -v uv >/dev/null 2>&1; then
  pip install uv
fi
( cd "$ACE_REPO_DIR" && uv sync )

log "install acestep service deps into ACE venv"
( cd "$ACE_REPO_DIR" && uv pip install --python .venv/bin/python \
  -r "$BACKLINE_DIR/services/acestep/requirements.txt" websockets )

log "set up AMT venv"
if [ ! -d "$AMT_VENV" ]; then
  python3 -m venv "$AMT_VENV"
fi
"$AMT_VENV/bin/pip" install --upgrade pip
# torch: keep whatever CUDA wheel the base image already ships if present,
# else pull a CUDA 12.4-compatible wheel to match the pod image.
if ! "$AMT_VENV/bin/python" -c "import torch" >/dev/null 2>&1; then
  "$AMT_VENV/bin/pip" install torch --index-url https://download.pytorch.org/whl/cu124
fi
"$AMT_VENV/bin/pip" install fastapi "uvicorn[standard]" websockets transformers musicpy mido \
  git+https://github.com/jthickstun/anticipation.git

log "patch RunPod's default nginx 8081 vhost to proxy our AMT service"
# The pod image ships a default nginx vhost that proxies public port 8081
# to localhost:8080 (a leftover "code-server" preset) and does not forward
# WebSocket upgrade headers. Our AMT app listens on 18081 internally;
# rewrite the 8081 server block to reverse-proxy there with upgrade support.
NGINX_CONF=/etc/nginx/nginx.conf
if ! grep -q "proxy_pass http://localhost:18081" "$NGINX_CONF"; then
  python3 - "$NGINX_CONF" <<'PYEOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
# Find the "# code-server" server block that listens on 8081 and replace its whole body.
# Brace counting, not a regex: the body holds several nested location blocks, and a
# non-greedy match stops at the first "}" and leaves the rest (and a stray brace) behind.
m = re.search(r"# code-server\s*\n\s*server \{", s)
if m and "listen 8081;" in s[m.end():m.end() + 200]:
    depth, i = 1, m.end()
    while depth and i < len(s):
        if s[i] == "{": depth += 1
        elif s[i] == "}": depth -= 1
        i += 1
    body = (
        "\n        listen 8081;\n"
        "\n        location / {\n"
        "            proxy_pass http://localhost:18081;\n"
        "            proxy_http_version 1.1;\n"
        "            proxy_set_header Upgrade $http_upgrade;\n"
        "            proxy_set_header Connection \"upgrade\";\n"
        "            proxy_set_header Host $host;\n"
        "            proxy_read_timeout 3600s;\n"
        "        }\n"
        "    }\n"
    )
    open(p, "w").write(s[:m.end()] + body + s[i:])
    print("patched nginx 8081 vhost")
else:
    print("WARNING: could not find default 8081 vhost to patch (already patched or image changed)")
PYEOF
  nginx -t && nginx -s reload
fi

log "fetch ACE-Step XL-turbo DiT as bf16 (HF repo is 20 GB fp32; converted shard-by-shard via /dev/shm)"
if [ ! -f "$ACE_REPO_DIR/checkpoints/acestep-v15-xl-turbo/model-00004-of-00004.safetensors" ]; then
  ( cd "$ACE_REPO_DIR" && .venv/bin/python "$BACKLINE_DIR/services/acestep/xl_bf16.py" )
fi

log "purge pip/uv caches (40GB container disk fills fast with ACE checkpoints + 2 venvs)"
rm -rf /root/.cache/pip /root/.cache/uv
pip cache purge >/dev/null 2>&1 || true

log "kill any stale tmux sessions"
tmux kill-session -t ace 2>/dev/null || true
tmux kill-session -t amt 2>/dev/null || true

log "start ACE-Step service (tmux: ace, port 8080)"
tmux new-session -d -s ace "cd $BACKLINE_DIR/services/acestep && \
  ACESTEP_CHECKPOINTS_DIR=$ACE_REPO_DIR/checkpoints \
  ACE_REPO_DIR=$ACE_REPO_DIR \
  ACE_SONG_MODE=1 PORT=8080 \
  $ACE_REPO_DIR/.venv/bin/python server.py 2>&1 | tee $LOG_DIR/ace.log"

log "start AMT service (tmux: amt, internal port 18081, public via nginx 8081)"
# Append to the log (a restart used to truncate it and lose every committed= line);
# rotate once it passes 50 MB.
if [ -f "$LOG_DIR/amt.log" ] && [ "$(stat -c%s "$LOG_DIR/amt.log")" -gt 52428800 ]; then
  mv -f "$LOG_DIR/amt.log" "$LOG_DIR/amt.log.1"
fi
tmux new-session -d -s amt "cd $BACKLINE_DIR/services/amt && \
  PORT=18081 \
  $AMT_VENV/bin/python server.py 2>&1 | tee -a $LOG_DIR/amt.log"

log "waiting for services to come up..."
for i in $(seq 1 60); do
  ACE_OK=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health 2>/dev/null)
  AMT_OK=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/health 2>/dev/null)
  log "attempt $i: ace=$ACE_OK amt=$AMT_OK"
  if [ "$ACE_OK" = "200" ] && [ "$AMT_OK" = "200" ]; then
    break
  fi
  sleep 10
done

log "final health:"
echo "ACE  8080: $(curl -s http://127.0.0.1:8080/health)"
echo "AMT  8081: $(curl -s http://127.0.0.1:8081/health)"
