# AMT (Anticipatory Music Transformer) service

FastAPI/uvicorn WebSocket service wrapping the lookahead/commit scheduler
prototyped in `bench/amt/live_duet.py`. Unlike that prototype (which drives
its own synthetic melody on a wall-clock transport), this service is driven
by the client -- the browser sends the human's real notes and a `bar` cue
each bar, and the server replies with the accompaniment plan for the next
bar.

Model: `stanford-crfm/music-small-800k`, loaded once at process start (CUDA
if available, else CPU).

## WebSocket contract (`/ws`)

- client -> `{type:'start', bpm, key, genre, lookaheadBeats, commitBeats, listenBeats}`
- client -> `{type:'notes', notes:[{beat, pitch, dur, vel}]}`
- client -> `{type:'bar', bar}` -- server replies with the plan for `bar+1`
- client -> `{type:'set', genre?, creativity?, instruments?}` (accepted, no-op on generation)
- client -> `{type:'ping'}` -> server `{type:'pong'}`
- server -> `{type:'plan', fromBeat, notes:[{beat, pitch, dur, vel, voice:'keys'|'bass'}]}`
- server -> `{type:'status', latencyMs, tokensPerSec}` after each generation
- server -> `{type:'error', message}`

Bass is the inferred chord root (mode of accompaniment pitch classes in the
window) one octave below the accompaniment register, held for the commit
window; omitted when no accompaniment notes were committed.

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py            # serves on :8080 (PORT env to override)
python server.py --bench    # 16-bar, 100 BPM local benchmark, no server
```

`--bench` prints per-bar generation time and a beats-of-accompaniment/sec
figure for the machine it runs on.

## Deploy

Same pattern as `services/acestep`: a RunPod pod, `server.py` run under
`nohup` in its own venv, fronted by the relay's `/amt` route via
`AMT_UPSTREAM`. See `services/acestep/DEPLOYED.md`.
