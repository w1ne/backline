# ACE-Step live deployment

Pod ID: `51midnuq8qqmuz`
GPU: NVIDIA L4
Cost: $0.49/h (on-demand, no network volume)
Proxy URL: `wss://51midnuq8qqmuz-8080.proxy.runpod.net/ws`
Relay upstream secret: `ACESTEP_UPSTREAM` set on the `backline-relay` Worker.

Set up manually via SSH (no Docker image built): base image
`runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`, ACE-Step 1.5
cloned at `ca1e85fe9430179831e6bc6be790c332190a3866` into `/opt/ace-step`,
`server.py` copied to `/opt/backline-acestep/server.py`, running under
`nohup` on `PORT=8080`.

## `/ws` 403 fix

`server.py` had `from __future__ import annotations` at the top. That
turns the `websocket: WebSocket` parameter's type hint into a string at
runtime (PEP 563), so FastAPI can't recognize it as the special
WebSocket parameter and silently mis-registers the route -- every `/ws`
connection then gets rejected with a bare `403 Forbidden` before
`websocket.accept()` ever runs. Removing that import fixed it. (The
uvicorn/websockets version pin mentioned in the README's "known
unresolved gap" was a red herring -- confirmed by reproducing the same
403 with a trimmed-down file containing only the future-import plus a
minimal FastAPI app, with uvicorn/websockets versions held constant.)

Also fixed: `AceStepModel._start_http_server` invoked `uv run
acestep-api`, which re-syncs the shared `.venv` against
`pyproject.toml`/`uv.lock` on every launch -- this silently reverted any
manual `pip`/`uv pip install` version pin applied to that venv. Changed
to invoke `<ACE_REPO_DIR>/.venv/bin/acestep-api` directly.

## Verified

- Local on pod: `/health` OK, WS round trip (2 chained blocks) OK --
  983044 bytes each, ~2.0-2.4s server-side generation time.
- Through the RunPod proxy from a laptop (`wss://51midnuq8qqmuz-8080.proxy.runpod.net/ws`):
  block 1 wall=3.27s, block 2 wall=2.73s, 983044 bytes each. Saved
  block 1 to `live-block1.wav` for inspection.
- Relay: `ACESTEP_UPSTREAM` secret set on `backline-relay`;
  `curl -sI https://backline-relay.shylenkoa.workers.dev/acestep` now
  returns 403 (no Origin/upgrade headers), not the earlier 503.

## Known gap

No RunPod network volume is attached, so ACE-Step's checkpoints
(~13 GB) live on the container's ephemeral disk and will need to
re-download if this pod is ever restarted rather than just
stopped/resumed.

## Stop / resume / terminate

Pod is left **running** for live use. To terminate when done:

```bash
source /home/andrii/.local/secrets/runpod.env
curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": "mutation { podTerminate(input: {podId: \"51midnuq8qqmuz\"}) }"}'
```
