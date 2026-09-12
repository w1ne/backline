# StreamMUSE vs our AMT service as the duet.ai accompaniment engine

Research spike, 2026-09-12. Question: is StreamMUSE (RTAS 2026, "Real-Time
Language Model Jamming", https://github.com/StreamMUSE/AE, arXiv 2606.11886)
a better live accompaniment engine than `services/amt` for a hummed melody?

Short answer: **no, not as a drop-in**. It answers faster and writes a
denser piano part, but it needs a request every 167-333 ms at 90 bpm, which
the browser-to-RunPod path cannot sustain (measured 615 ms round trip from
here), it has no key/chord conditioning so it drifted out of A minor on
three of four runs, and the repo ships no license. Its one real advantage is
architectural: it starts playing on beat 1 instead of after a listen window.

## What StreamMUSE is

- Model: a 0.12B RoFormer ("cp_transformer", checkpoint
  `Jianshu001/music/cp_transformer_909+ac+1k7_..._val_loss=0.90296.ckpt`,
  1.34 GB on Hugging Face). Trained on POP909 + AC + 1k7 piano datasets:
  melody-to-piano-accompaniment, interleaved melody/accompaniment frames.
- Input: a **monophonic melody as note events** `{pitch, tick, duration}`,
  4 ticks per beat, sent over HTTP POST (`/generate_accompaniment`, FastAPI).
  The client is a wall-clock tick loop: every `generation_interval_ticks`
  it POSTs the notes played since the last request plus
  `generation_start_tick = now + 1`, and the server returns
  `generation_length_frames` frames of piano (2 frames = 1 tick) which the
  client schedules and plays. No key, chord, tempo or style controls; the
  only conditioning is the melody itself and the server's own history.
  It takes a live monophonic melody by design, so it fits the hummed-input
  case in principle.
- Output: polyphonic piano (up to 4 notes per tick), GM program 0.
- Requirements: CUDA GPU, "16 GB+ recommended"; measured ~2.1 GB VRAM on
  the L4 with the 384-frame window. `pyproject.toml` pulls deepspeed,
  tensorflow, wandb, a vendored `transformers` fork; a lean venv with
  torch (pod system), pytorch-lightning, wandb, pretty_midi, mido, fastapi,
  uvicorn and `pip install -e transformers` (tokenizers pinned <0.22) was
  enough to serve.
- License: **none** in the StreamMUSE code repo or the AE repo (GitHub
  reports no license; no LICENSE file). Only the vendored `transformers`
  fork carries Apache-2.0. The checkpoint repo on HF has no license tag
  either. That alone blocks shipping it in duet.ai without asking the
  authors.

## Test material

Both clips from `bench/voice/synth.ts`, 90 bpm, 8 bars, one note per beat,
exported with `tools/make_midi.py` (`out/melody_am.mid`, `out/arpeggio_am.mid`):

- `melody_am`: `A_MINOR_MELODY_DEGREES` at root 57 (A3).
- `arpeggio_am`: `ARPEGGIO_CHORDS` Am F C G Am Dm Em Am, root-3rd-5th-3rd,
  kept in the octave above G3.

StreamMUSE's `midi_to_note` drops the last note (strict `end < max_tick`),
so it saw 31 of 32 notes.

## Setup and commands

Pod `51midnuq8qqmuz` (L4, $0.49/h) was already running with ACE + AMT.

```bash
# pod: clone https://github.com/StreamMUSE/StreamMUSE into /opt/StreamMUSE, then
python3 -m venv --system-site-packages /opt/sm-venv
/opt/sm-venv/bin/pip install --no-cache-dir pytorch_lightning wandb pretty_midi mido six joblib \
  fastapi uvicorn requests "tokenizers>=0.21,<0.22" safetensors huggingface_hub regex pyyaml \
  filelock packaging tqdm python-rtmidi
/opt/sm-venv/bin/pip install --no-cache-dir --no-deps -e /opt/StreamMUSE/transformers
/opt/sm-venv/bin/hf download Jianshu001/music "cp_transformer_909+ac+1k7_trackemb_interleavepos_v0.2_large_batch_40_schedule.epoch=00.val_loss=0.90296.ckpt" --local-dir /opt/StreamMUSE/ckpt
cd /opt/StreamMUSE && CHECKPOINT_PATH=ckpt/cp_transformer_...ckpt MODEL_MAX_SEQ_LEN_FRAMES=384 \
  PYTHONPATH=$PWD /opt/sm-venv/bin/python -m uvicorn app.server:app --host 0.0.0.0 --port 8988
# their client, headless (no ALSA on the pod -> tools/nullmidi.py as MIDO_BACKEND)
MIDO_BACKEND=nullmidi PYTHONPATH=$PWD /opt/sm-venv/bin/python app/client.py \
  --server_url http://localhost:8988/generate_accompaniment --tempo 90 --ticks_per_beat 4 \
  --beats_per_bar 4 --midi-file-input melody_am.mid --midi-file-use-original-duration \
  --generation_length 272 --generation_interval_ticks 2 --generation_length_per_request 5
# repeated with --generation_interval_ticks 1 --generation_length_per_request 3, and for arpeggio_am
# laptop: same melodies through the production relay, browser protocol, real time
python tools/amt_client.py wss://backline-relay.shylenkoa.workers.dev/amt out/melody_am.mid amt_melody_am
# laptop: remote round trip for StreamMUSE requests through an ssh tunnel to the pod
ssh -f -N -L 18988:localhost:8988 -p <port> root@<pod>
python tools/replay_remote.py http://localhost:18988/generate_accompaniment <inferences.json>
python tools/metrics.py .
```

Configs: `i2/g5` = request every 2 ticks, 5 frames (2.5 ticks) per request,
the paper's middle setting; `i1/g3` = every tick, 3 frames, its most
responsive setting. AMT: `lookaheadBeats 4, commitBeats 2, listenBeats 4`,
`key "A minor"`, plan requested once per bar as the app does.

## Results

Latency (ms). StreamMUSE "local" = client on the pod (paper's local
setting); "remote" = replay of the same requests from this laptop through
an ssh tunnel. AMT = laptop -> Cloudflare relay -> pod, the production path.

| engine / config | requests | server mean / p95 | RTT mean / p95 (local) | RTT mean / p95 (remote) | budget per request |
|---|---|---|---|---|---|
| StreamMUSE i2/g5, melody | 60 | 226 / 256 | 230 / 261 | 615 / 773 | 333 (2 ticks) |
| StreamMUSE i2/g5, arpeggio | 60 | 114 / 136 | 119 / 140 | - | 333 |
| StreamMUSE i1/g3, melody | 120 | 82 / 99 | 86 / 103 | 627 / 829 | 167 (1 tick) |
| StreamMUSE i1/g3, arpeggio | 120 | 66 / 92 | 70 / 95 | - | 167 |
| AMT, melody | 9 (1/bar) | 104 / 136 | - | 278 / 378 | 2667 (1 bar) |
| AMT, arpeggio | 9 (1/bar) | 107 / 194 | - | 276 / 362 | 2667 |

Per beat at 90 bpm (667 ms): StreamMUSE i2/g5 spends 2 x ~115-230 ms of
GPU per beat, i1/g3 4 x ~70-85 ms; AMT ~105 ms per 4 beats. StreamMUSE's
pod-local hit rate was 97.5-99.2 %, but the remote RTT (615 ms) is 2-4x
its request budget, so from a browser every request would land 2-3 ticks
late; the paper's Fig. 4 says the same (remote deployments only satisfy
the constraint with longer generation lengths, which cost coherence).

Musical (accompaniment notes in the 8 bars; in-key = share of pitch
classes in A natural minor; chord-tone = per-bar share of notes in that
bar's triad, arpeggio only; chance for diatonic notes is 3/7 = 0.43):

| engine / config | notes | notes/bar | in-key | chord-tone mean | chord-tone per bar (Am F C G Am Dm Em Am) | first note (beat) |
|---|---|---|---|---|---|---|
| StreamMUSE i2/g5, melody | 52 | 6.5 | 0.98 | - | - | 1.25 |
| StreamMUSE i2/g5, arpeggio | 31 | 3.9 | 0.74 | 0.29 | 0 / - / 0 / .33 / 0 / .43 / .25 / 1 | 1.25 |
| StreamMUSE i1/g3, melody | 132 | 16.5 | 0.35 | - | - | 1.0 |
| StreamMUSE i1/g3, arpeggio | 47 | 5.9 | 0.91 | 0.45 | 1 / .2 / .17 / .33 / .75 / .5 / .62 / 0 | 1.5 |
| AMT, melody (keys+bass) | 26 | 3.3 | 1.00 | - | - | 8.0 |
| AMT, arpeggio (keys+bass) | 19 | 2.4 | 1.00 | 0.39 | - / 0 / 0 / .33 / .5 / 1 / .5 / .4 | 8.0 |
| AMT, arpeggio (keys only) | 13 | 1.6 | 1.00 | 0.35 | | 8.0 |

Reading the note lists (`out/*.mid`):

- StreamMUSE i2/g5 on the melody is a plausible pop piano part: bass
  notes in the 38-48 range under sustained mid-register chords, 98 % in
  key, playing from beat 1. This is its best run.
- StreamMUSE i2/g5 on the arpeggio drifts flat: Bb (58/70), Eb (51) and
  F-Bb-D chords against the Am/F/C/G bars, i.e. it reharmonised the sung
  triads into a different key. The i1/g3 melody run is worse: 16.5
  notes/bar, 35 % in key, a chromatic flurry. Short generation windows with
  no harmonic conditioning make it re-decide the harmony every few ticks.
- AMT is 100 % in key on every run because `services/amt/arrangement.py`
  post-filters to the key the app sends, and its bass is the key root held
  per bar (A2 on every bar, since no `chord` was sent). The keys voice is a
  monophonic counter-line (a descending A-minor scale from E6 on the
  melody run), thin against a real performance, and it starts at beat 8
  (listen 4 beats + one bar of lead time).
- Chord-following: no engine follows the arpeggio's chords. StreamMUSE
  i1/g3 (0.45) and AMT (0.39) are both at chance; StreamMUSE i2/g5 is
  below it. AMT's bass never leaves A because the client did not send
  `chord`; with the app's chord detector feeding `set {chord}` the bass
  would track, but the keys line would still be at chance.

No audio render: no fluidsynth/timidity on this laptop and none was
installed on the pod to keep the spike inside budget.

## Errors and gotchas hit

- Vendored `transformers` requires `tokenizers<0.22`; pip pulled 0.23.
- `app/client.py` crashes with `_rtmidi.SystemError` when there is no ALSA
  sequencer (it only catches OSError); a null mido backend fixes it.
- `wandb` and `pytorch_lightning` are imported at module level by the
  model file, so both must be installed to serve inference.
- Output paths are hard-coded to `experiments-AE5/...` in `client.py`.
- The instruction's `uv sync` would have installed deepspeed + tensorflow
  (~10 GB) on a disk with 7 GB free; the lean venv above was ~2.5 GB.

## Cost

Pod already running when the spike started (it is the live ACE/AMT pod).
Spike wall time on the pod ~17 min at $0.49/h; balance $18.58 -> $18.45
(~$0.13). Nothing else was billed. **The pod was stopped at the end
(`podStop`, desiredStatus EXITED).** Resuming wipes `/opt`; rerun
`services/pod-bootstrap.sh` (ACE on 8080, AMT on 8081) before the next
live use. StreamMUSE files were in `/opt/StreamMUSE` and `/opt/sm-venv`
and are gone with the disk.

## Recommendation

Keep the AMT service. StreamMUSE is not better for duet.ai on a hummed
melody: it has no key or chord conditioning, so on three of four runs it
left A minor or contradicted the sung triads, and its frame-synchronous
design needs a request round trip well under 167-333 ms at 90 bpm, which
the browser -> relay -> RunPod path (measured 615 ms; even the AMT path is
~280 ms) cannot meet, so a hosted deployment would either miss most ticks
or have to run with long generation windows that the paper itself shows
degrade quality. It also ships without a license. What is worth taking
from it is the one thing it did clearly better: it played from beat 1 with
a polyphonic piano texture, whereas AMT waited 8 beats and answered with a
single-note line. Two cheap changes on our side would close most of that
gap without changing engines: drop `listenBeats` to 0-2 with a key-only
default plan for the first bar, and let the plan carry two or three
simultaneous voices (chord tones from the detected chord) instead of the
monophonic committer, since the arrangement filter already guarantees key
safety.
