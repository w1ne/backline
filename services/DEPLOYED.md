# Backline live deployment (ACE-Step + AMT)

Pod ID: `51midnuq8qqmuz`
GPU: NVIDIA L4
Cost: $0.49/h (on-demand, no network volume, 40 GB container disk)

- ACE-Step (block generation): `wss://51midnuq8qqmuz-8080.proxy.runpod.net/ws`
- AMT (accompaniment): `wss://51midnuq8qqmuz-8081.proxy.runpod.net/ws`

Relay upstream secrets on the `backline-relay` Worker:
`ACESTEP_UPSTREAM` (unchanged, same pod) and `AMT_UPSTREAM` (set this
session).

## Redeploying a server change

`pod-bootstrap.sh` pulls `main` into `/opt/backline`, so a change to
`services/acestep/server.py` needs main pushed first, then on the pod:

```bash
git -C /opt/backline pull --no-rebase origin main
tmux kill-session -t ace
tmux new-session -d -s ace "cd /opt/backline/services/acestep && \
  ACESTEP_CHECKPOINTS_DIR=/opt/ace-step/checkpoints ACE_REPO_DIR=/opt/ace-step \
  PORT=8080 /opt/ace-step/.venv/bin/python server.py 2>&1 | tee /var/log/ace.log"
curl -s http://127.0.0.1:8080/health
```

Model load takes a couple of minutes, so `/health` stays unreachable for
a while after the restart.

## Resume wipes the disk -- rerun pod-bootstrap.sh

`podResume` on this pod does not preserve the container's ephemeral
disk. Whenever the pod is resumed after being stopped, `/opt` is empty
again -- weights, both venvs, everything. Re-provision with:

```bash
scp -P <ssh_port> services/pod-bootstrap.sh root@<ssh_ip>:/root/pod-bootstrap.sh
ssh -p <ssh_port> root@<ssh_ip> "bash /root/pod-bootstrap.sh"
```

Get the current SSH mapping and HTTP proxy ports with:

```bash
source /home/andrii/.local/secrets/runpod.env
curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { pod(input: {podId: \"51midnuq8qqmuz\"}) { desiredStatus runtime { ports { ip publicPort privatePort type } } } }"}'
```

`pod-bootstrap.sh` is idempotent: apt packages, clones/updates
`backline` and ACE-Step 1.5 (pinned commit
`ca1e85fe9430179831e6bc6be790c332190a3866`), installs both services'
deps, patches the pod's default nginx 8081 vhost (see below), and
(re)starts both services under tmux (`ace`, `amt`), printing health at
the end.

## Layout

- `/opt/ace-step` -- ACE-Step 1.5 checkout + its own `uv`-managed
  `.venv` (repo deps via `uv sync`, plus the acestep service's own
  `requirements.txt` + `websockets` installed with
  `uv pip install --python .venv/bin/python ...` -- `uv sync`'s venv has
  no `pip` binary).
- `/opt/backline` -- this repo, `main` branch.
- `/opt/amt-venv` -- separate standard venv for the AMT service:
  `torch` (cu124 wheel), `transformers`, `musicpy`, `mido` (musicpy only
  depends on the `mido-fix` fork, which installs under the distribution
  name `mido_fix` but does **not** provide the importable `mido` module
  that `anticipation.convert` needs -- both packages must be installed),
  and `anticipation` (`git+https://github.com/jthickstun/anticipation.git`).
- ACE-Step's internal `acestep-api` subprocess runs on port 8010;
  `services/acestep/server.py` fronts it on `PORT=8080`.
- `services/amt/server.py` listens on `PORT=18081` internally (see nginx
  note below), not 8081 directly.

## nginx 8081 gotcha

The pod image ships a default nginx vhost that maps public port 8081 to
`proxy_pass http://localhost:8080` (a leftover "code-server" preset)
with no WebSocket upgrade headers -- so naively running the AMT service
on 8081 gets silently shadowed by ACE-Step on 8080, and `/health` looks
fine (both serve it) while `/ws` looks like the AMT app doesn't work.
`pod-bootstrap.sh` rewrites that vhost in `/etc/nginx/nginx.conf` to
`proxy_pass http://localhost:18081` with `Upgrade`/`Connection: upgrade`
headers and a long `proxy_read_timeout`, then `nginx -s reload`s. AMT
itself runs with `PORT=18081` to match.

## Disk

Container disk is 40 GB with no network volume. ACE-Step's checkpoints
alone are ~24 GB (turbo DiT + VAE + the 5Hz LM, auto-selected up to the
4B variant on this GPU's free VRAM) and the two Python venvs add
another ~6 GB, so pip/uv download caches (which peaked at ~12 GB during
this bring-up) must be purged after installs
(`rm -rf ~/.cache/pip ~/.cache/uv`) or the LM download fails partway
with `No space left on device`. `pod-bootstrap.sh` does this
automatically after both services' deps are installed.

## Verified (per-block fill redeploy, 2026-09-12)

- `services/acestep/server.py` now reads `fill`/`density` off the block
  request; the client (`acestepEngine.ts::selectBlockInstruments`) picks
  the instrument set from the effective dynamics. Pulled on the pod, tmux
  `ace` restarted, `/health` OK.
- End-to-end in real Chrome (raw CDP, `?debug=1`, fake Web MIDI, busy 4
  bars / silent 4 bars x2): block requests tracked the player exactly ---
  busy blocks (intensity ~0.63-0.70) asked for `['drums','bass']` only;
  every silent stretch (space=true, intensity 0.28-0.42) flipped to
  `['drums','bass','keys','lead']` with `fill=true`. So the band lays back
  to the rhythm section under the player and answers with the full set +
  guitar in the gaps. Block-audio RMS stayed ~0.15-0.23 across both (the
  model loudness-normalizes), so the texture change is spectral
  (instrumentation), not amplitude --- expected, since drums+bass keep the
  groove going when the lead drops.

## Verified (dynamics redeploy, 2026-09-12)

- `services/acestep/server.py` now reads `intensity` and `space` off the
  block request (prompt words "sparse, laid back" / "medium" / "energetic,
  busy", and the lead instrument is dropped from the prompt and from
  `track_classes` unless the player has left space). Pulled on the pod,
  tmux `ace` restarted, `/health` OK on
  `https://51midnuq8qqmuz-8080.proxy.runpod.net/health`.

## Verified (bring-up session, 2026-09-12)

- `/health` OK on both `https://51midnuq8qqmuz-8080.proxy.runpod.net/health`
  and `-8081.proxy.runpod.net/health`.
- ACE-Step WS round trip (`{"type":"block","seq":1,...}`): 3252 ms wall,
  2282 ms server-side generation, 983044 bytes of PCM back.
- AMT WS round trip (`start` -> `notes` -> `bar` -> `plan`): 1447 ms
  wall, 1216 ms server latency, 71.5 tokens/sec; plan came back with 0
  committed notes for the minimal 2-note smoke input used here (not a
  failure -- the scheduler simply had nothing in its commit window to
  quantize from that short a listen), pipeline itself (model load,
  generation, JSON contract) fully round-trips.

## Stop / resume / terminate

Pod is left **running** for live use.

```bash
source /home/andrii/.local/secrets/runpod.env

# stop (keeps billing off, but disk is wiped on next resume anyway)
curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": "mutation { podStop(input: {podId: \"51midnuq8qqmuz\"}) { id } }"}'

# terminate for good
curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": "mutation { podTerminate(input: {podId: \"51midnuq8qqmuz\"}) }"}'
```
