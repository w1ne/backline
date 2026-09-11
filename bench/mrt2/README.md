# MRT2 (Magenta RealTime 2) benchmark kit — for the M3 Pro Mac

Prepared on a Linux box with no GPU, so none of this was actually run against
the real model. Everything below is what I could verify against Google's
official sources on 2026-09-11 (links in "What we know"). Anything I couldn't
verify is marked `UNVERIFIED`. Please run the actual benchmark and send back
`results.json` + the printed summary table, plus anything that didn't match
this doc so I can fix it for next time.

## 1. Install (macOS, Apple Silicon)

```bash
# Python 3.12, via uv (the project's documented package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv --python 3.12
source .venv/bin/activate

# "mlx" extra pulls in the Metal/MLX backend (this is the one you want on Mac;
# the plain package defaults to the JAX backend, which is CPU-only on Mac)
uv pip install "magenta-rt[mlx]"

# downloads model config + fetches checkpoint weights from Hugging Face
# (google/magenta-realtime-2 repo, CC-BY-4.0 license)
mrt models init
mrt models download
```

Sanity check the install works before benchmarking:

```bash
mrt mlx generate --prompt "disco funk" --duration 4.0 --model=mrt2_small
```

### Which checkpoint to run

Two checkpoints ship in `google/magenta-realtime-2`:

| Checkpoint  | Params | Real-time on... |
|---|---|---|
| `mrt2_small` | 230M | any Apple Silicon Mac, M1 and up |
| `mrt2_base`  | 2.4B | higher-tier chips only for real-time streaming |

**This is the one place the docs are internally inconsistent** and I could
not resolve it from a Linux box: the GitHub README says `mrt2_base` needs "a
Pro Max chip" for real-time streaming, but a compatibility table on the same
site lists M3 Pro and M4 Pro (not just Max) as supported for real-time
`mrt2_base`. `UNVERIFIED`: whether a stock M3 Pro (not Max) actually hits
real-time factor ≤ 1 on `mrt2_base`.

**What to do about it:** `bench.py` benchmarks whichever checkpoint you pass
it (`--model`). Run it against `mrt2_base` first. If the real-time factor
(RTF) column in `results.json` comes out > 1.0 (i.e., a chunk takes longer to
generate than its own audio duration), that settles it — fall back to
`mrt2_small` for the live-band use case and note in your reply that M3 Pro
does not hit real-time on `mrt2_base`. Both checkpoints can run offline
(non-real-time) on any Apple Silicon Mac regardless, per the docs.

### Download size

Not stated precisely anywhere in the docs I could reach. The Hugging Face
repo `google/magenta-realtime-2` as a whole is listed at ~15.6 GB (both
checkpoints plus SpectroStream codec + MusicCoCa embedder weights combined).
`UNVERIFIED`: the per-checkpoint split. Expect `mrt2_small` to be well under
that and `mrt2_base` to dominate it. Make sure there's headroom before
`mrt models download` runs.

### License / attribution

- Codebase: Apache 2.0.
- Model weights: **CC-BY-4.0**. Attribution required. The repo's own
  citation guidance points at the original Magenta RealTime technical report
  rather than a specific attribution sentence, so use:

  > Magenta RealTime 2 model weights by Google, licensed under CC-BY-4.0.
  > Caillon et al., "Live Music Models," arXiv:2508.04651, 2025.

  Carry this text wherever generated audio or the app credits models.

## 2. Running the benchmark

```bash
source .venv/bin/activate
python bench.py --model mrt2_base --chunks 30
python bench.py --model mrt2_small --chunks 30   # for comparison
```

Send back both `results.json` files (rename them `results_base.json` /
`results_small.json`) and the console summary table.

## 3. Running the WebSocket server (starting point, not final)

```bash
python serve.py --model mrt2_small --port 8765
```

Then connect a browser WebSocket client to `ws://localhost:8765` — it sends
binary PCM16 48kHz stereo frames and accepts JSON control messages. See the
`# UNVERIFIED` comments in `serve.py` for the parts I could not confirm
against the real API (in particular, whether `generate_chunk` takes a MIDI
argument directly).

## What we know (sources)

- GitHub repo (install steps, checkpoint names, `mrt` CLI, C++ engine,
  license): https://github.com/magenta/magenta-realtime
- Docs site: https://magenta.github.io/magenta-realtime/
- HF model card (weights license CC-BY-4.0, architecture: SpectroStream +
  MusicCoCa + decoder-only LLM, conditioning types):
  https://huggingface.co/google/magenta-realtime-2
- HF weights repo (checkpoint files, ~15.6GB total):
  https://huggingface.co/google/magenta-realtime-2/tree/main
- Apps/plugins page (AUv3, standalone app):
  https://magenta.withgoogle.com/mrt2
- Announcement: https://x.com/GoogleMagenta/status/2062589313372594538
- Predecessor technical report (cited by the repo for attribution):
  arXiv:2508.04651 ("Live Music Models", Caillon et al., 2025)

**Latency Google publishes:** "<200ms" end-to-end is what the launch
announcement claims for running natively on a MacBook (marketing copy, not a
methodology). Separately, DeepWiki's summary of the docs cites "~2 seconds"
for a style-prompt change to take effect (this is roughly one chunk's
duration — makes sense given the chunked/streaming design). These two
numbers are about different things (raw generation latency vs. time for a
control change to audibly land) — don't conflate them when you report your
own measurements.

**Hardware tiers:** `mrt2_small` — real time on any Apple Silicon Mac (M1+).
`mrt2_base` — needs a higher tier; exact cutoff `UNVERIFIED` (see above).
Offline/non-real-time inference for both checkpoints works on any Apple
Silicon Mac or an NVIDIA GPU via the plain Python library (no MLX needed).

**Live audio input:** Yes — the model accepts audio as a *style/conditioning*
input (an audio example gets embedded via MusicCoCa, same as a text prompt
would), and it consumes its own generated audio as rolling context (10s of
prior audio tokens) to continue the stream. `UNVERIFIED`: whether there is a
true live *microphone* input path in the Python API today, versus only
file/array audio passed to `embed_style`. Treat "live audio input" as "you
can hand it an audio clip as a style reference," not confirmed as "it listens
to you play in real time and responds to your audio content" (that's a
different, unverified claim).

**Conditioning inputs the model accepts (per HF model card):**
1. Text prompts, embedded via MusicCoCa into a 768-dim style embedding.
2. Audio examples, embedded via the same MusicCoCa embedder into the same
   768-dim style space.
3. MIDI — described on the model card as "128-dimensional multihot vectors
   representing pitch states" (i.e., a piano-roll-style pitch condition, not
   a MIDI file/CC-message stream). `UNVERIFIED`: the exact parameter name and
   whether it's exposed in the public `system.MagentaRT.generate_chunk()`
   Python API at all, versus being a training-time input that hasn't
   surfaced in the released inference library yet. `bench.py` and `serve.py`
   both try to detect this at runtime (`hasattr`/signature inspection) and
   fall back to text-only conditioning with a clear message if it's absent —
   check the console output when you run them, that's the ground truth for
   your machine's installed version.

**Python API surface (confirmed from repo/docs, not run):**
```python
from magenta_rt import audio, system
mrt = system.MagentaRT(model="mrt2_base")   # UNVERIFIED: exact kwarg name for model choice
style = system.embed_style("funk")           # text or 16kHz mono audio -> 768-dim embedding
state = None
chunks = []
for _ in range(30):
    state, chunk = mrt.generate_chunk(state=state, style=style)
    chunks.append(chunk)
audio.concatenate(chunks)
```
Chunk size: 2 seconds of audio. Context window: 10 seconds (1000 tokens).
Output: 48kHz stereo.

Everything else asked for in the task (exact `MagentaRT` constructor kwargs,
whether `generate_chunk` takes a `midi=` argument, exact download sizes,
memory footprint) is either not published in a form I could reach from here,
or contradicted itself between sources. `bench.py`/`serve.py` are written to
introspect the installed library at runtime and print/log what they actually
find, rather than hard-coding my guesses — please read their console output,
it will correct anything wrong in this doc.
