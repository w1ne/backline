# Cloud model review — 2026-09-12

This review targets duet.ai: a Raspberry Pi MIDI/audio client with all generative inference on the existing RunPod NVIDIA L4. The desired behavior is coherent support while the performer plays and musical answers in gaps.

## Magenta RealTime 2

MRT2 is relevant: the official June 4, 2026 release describes 230M/2.4B audio models, MIDI note/drum conditioning, 40 ms audio frames and approximately 200 ms control latency on its supported streaming engine. These are audio-generation models, so replacing AMT also requires a streamed audio transport and buffering rather than merely returning note plans. [Official release](https://magenta.withgoogle.com/magenta-realtime-2)

The current official installation guide explicitly places real-time streaming, DAW plugins and live performance on Apple Silicon using MLX. Linux NVIDIA/TPU JAX is documented for offline/batch generation and research. A CUDA JAX installation and a batch clip that generates faster than its duration would not establish bounded frame latency, live MIDI updates, streaming codec behavior or uninterrupted audio under network jitter. [Official installation guide](https://github.com/magenta/magenta-realtime/blob/main/docs/installation.md), [official inference guide](https://github.com/magenta/magenta-realtime/blob/main/docs/inference.md)

Decision: do not deploy MRT2 on this NVIDIA pod as a claimed supported live backend. No MRT2 packages/checkpoints were installed. The existing pod had only 8.4 GiB disk free initially and two running music services; building a separate JAX stack and downloading codec/style/model assets would spend that limited space without testing the product's required live path. This is a deployment-support limitation, not evidence that a custom NVIDIA streaming port is impossible. A future port needs an isolated pod and a sustained, frame-level latency and MIDI-response benchmark before adoption.

## AMT benchmark method

`benchmark.py` records the pre-ensemble comparison at commit `b3d395f`; reproduce with that checkout (or point `AMT_BENCH_DIR` at its `bench/amt` directory). It is reproducible in the existing `/opt/amt-venv` environment. The original experiment imports the pre-ensemble `/opt/backline/bench/amt/amt.py`; use `AMT_BENCH_DIR` pointing to `bench/amt` from commit `b3d395f` to reproduce after the ensemble merge. Its old single-instrument sampler API is intentionally preserved; use `benchmark-merged.py` for the newer ensemble API. It does not import/start the web service or modify production files. Run:

```sh
/opt/amt-venv/bin/python benchmark.py --output results.json
```

The GPU-cached sampler snapshots the Pi sampler's three relevant functions, with both newly created token tensors explicitly on `model.device`. We retain float32, eager attention and top-p 0.85 for both model sizes. Each model is loaded sequentially and deleted, followed by garbage collection and CUDA cache release. The medium checkpoint is documented as a 360M-parameter anticipatory model trained for 800k steps on Lakh MIDI. [Official model card](https://huggingface.co/stanford-crfm/music-medium-800k)

Each model/sampler/tempo cell has 12 trials: four future four-beat windows at bars 2, 4, 6, 8, with three deterministic seeds. Every trial sees exactly the same observed C-major melody tokens, with the current bar deliberately unknown as in next-bar planning. Prior generated accompaniment is excluded to keep the inputs identical between models. Tempos are 100 and 150 BPM; a window has 2400/1600 ms lead and an 80% generation budget of 1920/1280 ms. Warm-up is excluded. This benchmark measures isolated generation while existing services remain loaded; it does not include network or client audio latency or concurrent live inference load.

Nonempty is the fraction of generated windows containing accompaniment-instrument notes. Occupied fraction is the union of raw note durations inside the window. Diatonic fraction counts C-major pitch classes; tonic-triad fraction counts C/E/G. These are deliberately weak raw-output harmony proxies, not listening scores or evidence of responsive gap answering. They must not be interpreted as proving that a model feels like a musical partner. Arranger quantization, key correction, bass construction and monophonic trimming are not applied.

## AMT results and decision

NVIDIA L4, PyTorch 2.6.0+cu124. Each row is 12 trials. All 96 trials met both the generation budget and the first-note scheduling deadline.

| Model | Sampler | BPM | Nonempty | Median / max ms | Occupied | Diatonic |
|---|---|---:|---:|---:|---:|---:|
| small | original | 100 | 4/12 | 120 / 348 | 19% | 100% |
| small | original | 150 | 9/12 | 116 / 183 | 31% | 100% |
| small | cached_gpu | 100 | 11/12 | 101 / 182 | 61% | 98% |
| small | cached_gpu | 150 | 11/12 | 100 / 124 | 70% | 97% |
| medium | original | 100 | 8/12 | 263 / 434 | 50% | 97% |
| medium | original | 150 | 10/12 | 269 / 285 | 60% | 100% |
| medium | cached_gpu | 100 | 9/12 | 191 / 280 | 50% | 97% |
| medium | cached_gpu | 150 | 11/12 | 185 / 196 | 69% | 100% |

Prefer small AMT with the GPU-adapted cached sampler as the production candidate. It produced 22/24 nonempty windows compared with medium cached at 20/24 and took approximately half as long. Medium is affordable on this L4 but this small controlled sample does not demonstrate a musical-quality gain; do not substitute parameter count for listening evidence. No larger AMT was downloaded: medium did not establish a quality improvement and a larger checkpoint would further consume scarce disk without addressing the principal demonstrated failure, empty windows.

The cached sampler includes corrected retained-window padding as well as KV caching and a selective output projection; its comparison with original is therefore a package comparison, not a pure speed ablation. Both preserve model-selected rests, so neither provides guaranteed nonempty accompaniment. Musical support/answer behavior still needs an explicit arranger and evaluation with real performer phrases. The latest input is intentionally historical: these results do not prove immediate response to notes played after planning starts.

`results.json` records every raw event, deadline, seed, parameter count and model revision. The benchmark process exited successfully and released its model memory. The medium model download remains in Hugging Face's cache for potential follow-up use; no live services were restarted or modified.

## Context-padding ablation

A further 24 small-model trials run the original sampler with only `ops.pad(...)` replaced by `prepare_context(...)`. Reproduce with:

```sh
/opt/amt-venv/bin/python benchmark.py --models small --samplers original_contextfixed --output context-ablation.json
```

All 24 raw event lists exactly match the GPU-cached sampler's same-seed event lists. Corrected padding produces the same 11/12 nonempty windows at each tempo and the same occupied/harmonic fractions. Thus the measured coverage gain comes from corrected context padding, not KV caching. The original sampler with corrected context takes median 148/146 ms at 100/150 BPM versus cached 101/100 ms, approximately 32% less latency with caching/selective projection. This clean separation strengthens the recommendation to carry over both corrections, while avoiding any claim that caching improves music quality. All 24 ablation trials met budgets too.

Final resource check after both benchmark processes exited: GPU allocation returned to its initial 7,990 MiB, with 14,584 MiB free. Disk free was 7.0 GiB after retaining the medium checkpoint download. Total measured trials: 120.

## Merged ensemble Session verification

After merging upstream ensemble instruments 40/41/42, `benchmark-merged.py` runs the actual merged `Session.generate_next_bar_plan` with the shared CUDA cached sampler. `merged-results.json` is the relevant final implementation evidence; the earlier raw single-instrument comparison and context ablation remain historical evidence and are not relabeled as ensemble measurements.

Run against an isolated copy of the merged tree:

```sh
MERGED_ROOT=/tmp/duet-cloud-merged /opt/amt-venv/bin/python benchmark-merged.py
# Output: /tmp/duet-merged-results.json
```

There are 48 trials: small/medium, 100/150 BPM, the same three seeds and four fixed melody prompts as before. Bar 2/6 trials exercise support with C-major key/C chord; bar 4/8 exercise the short-answer mode. Every trial starts a fresh Session with observed melody notes. Key-note nonemptiness excludes deterministic bass. End-to-end wall time includes arrangement/commit/serialization preparation. The source hashes captured at startup identify the actual benchmark snapshot. A subsequent no-performer early-return guard was added by the parent agent; it cannot affect these trials, all of which contain performer notes.

Harmony/answer-bound checks here validate arranger constraints, not the raw model's harmony: support keys must lie in C/E/G, answer keys must stay in C major and end within two beats. This is a synthetic functional check, not a listening evaluation, a network latency test or a demonstration of actual performer-gap detection.

| Model | BPM | Nonempty key plans | Median / max ms | Mean key notes |
|---|---:|---:|---:|---:|
| small | 100 | 11/12 | 108 / 184 | 2.08 |
| small | 150 | 11/12 | 108 / 134 | 2.00 |
| medium | 100 | 9/12 | 202 / 296 | 1.58 |
| medium | 150 | 11/12 | 197 / 207 | 1.92 |

All 48 merged trials met generation budgets and scheduling deadlines. All support chord constraints, answer two-beat bounds and output diatonic checks passed. Final recommendation remains **small AMT with corrected context and shared GPU caching**: 22/24 nonempty plans and approximately 108 ms median, versus medium at 20/24 and approximately 197–202 ms median. This is enough to favor small for deployment latency and coverage; it does not establish a subjective musical-quality ranking. The final ensemble path can still return a model-selected empty window.
