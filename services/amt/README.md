# AMT (Anticipatory Music Transformer) service

FastAPI/uvicorn WebSocket service wrapping the lookahead/commit scheduler
prototyped in `bench/amt/live_duet.py`. Unlike that prototype (which drives
its own synthetic melody on a wall-clock transport), this service is driven
by the client -- the browser sends the human's real notes and a `tick` cue
every half bar, and the server replies with the accompaniment plan for the
half bar one bar ahead.

Model: `stanford-crfm/music-small-800k`, loaded once at process start (CUDA
if available, else CPU).

## WebSocket contract (`/ws`)

- client -> `{type:'start', bpm, key, genre, lookaheadBeats, commitBeats, listenBeats, accompInstruments?, accompBias?}`
- client -> `{type:'notes', notes:[{beat, pitch, dur, vel}]}`
- client -> `{type:'bar', bar}` -- server replies with the plan for `bar+1`
- client -> `{type:'set', genre?, key?, chord?, creativity?, amount?, space?, intensity?, silenceBeats?, instruments?, accompInstruments?, accompBias?}` (`instruments` accepted, no-op on generation; `intensity`/`silenceBeats` drive the song form)
- client -> `{type:'ping'}` -> server `{type:'pong'}`
- server -> `{type:'ready', tick:true}` after `start`; a client cues with `tick` only once it has seen this
- server -> `{type:'plan', fromBeat, toBeat, chord?, chordFrom?, section, notes:[{beat, pitch, dur, vel, voice:'keys'|'bass'}]}` (`chord`/`chordFrom`/`section` from `brain.py`; see ../README.md)
- server -> `{type:'status', latencyMs, tokensPerSec}` after each generation
- server -> `{type:'error', message}`

Bass is the inferred chord root (mode of accompaniment pitch classes in the
window) one octave below the accompaniment register, held for the commit
window; omitted when no accompaniment notes were committed.

`accompInstruments` is a list of preset names from `instruments.py`
(`TOGGLEABLE_PRESETS`: guitar, sax, brass, ambient), mixed in on top of the
default string ensemble; empty/absent falls back to strings only.
`accompBias` (default 2.0) is `generate_duet`'s own sampling knob -- see `bench/amt/amt.py`.
Temperature is derived server-side from `creativity`.

## Chord prediction

`brain.py` decides a chord every half bar (`predict.py`). The default predictor (`PREDICTOR = 'hmm'`)
steps through degree transitions learned from the Chordonomicon corpus
(`data/transitions.json`, 5 KB, committed) after a Viterbi decode of the last two bars; the
hand-written table is still there as `'table'`. `HARMONY_BENCH.md` has the numbers
(`python3 bench_harmony.py --md HARMONY_BENCH.md`).

To refit the matrices (not needed to run the service):

```bash
python3 fit_transitions.py                       # streams the 264 MB CSV from Hugging Face
python3 fit_transitions.py --csv chordonomicon_v2.csv --out data/transitions.json
```

Chordonomicon (ailsntua/Chordonomicon, Kantarelis et al. 2024) is CC BY-NC 4.0; the corpus
itself is never committed, only the fitted counts.

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
