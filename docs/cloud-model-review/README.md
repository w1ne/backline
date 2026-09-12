# Cloud model review — 2026-09-12

This review targets duet.ai: a Raspberry Pi MIDI/audio client with all generative inference on the existing RunPod NVIDIA L4. The desired behavior is coherent support while the performer plays and musical answers in gaps.

## Magenta RealTime 2

MRT2 is relevant: the official June 4, 2026 release describes 230M/2.4B audio models, MIDI note/drum conditioning, 40 ms audio frames and approximately 200 ms control latency on its supported streaming engine. These are audio-generation models, so replacing AMT also requires a streamed audio transport and buffering rather than merely returning note plans. [Official release](https://magenta.withgoogle.com/magenta-realtime-2)

The current official installation guide explicitly places real-time streaming, DAW plugins and live performance on Apple Silicon using MLX. Linux NVIDIA/TPU JAX is documented for offline/batch generation and research. A CUDA JAX installation and a batch clip that generates faster than its duration would not establish bounded frame latency, live MIDI updates, streaming codec behavior or uninterrupted audio under network jitter. [Official installation guide](https://github.com/magenta/magenta-realtime/blob/main/docs/installation.md), [official inference guide](https://github.com/magenta/magenta-realtime/blob/main/docs/inference.md)

Decision: do not deploy MRT2 on this NVIDIA pod as a claimed supported live backend. No MRT2 packages/checkpoints were installed. The existing pod had only 8.4 GiB disk free initially and two running music services; building a separate JAX stack and downloading codec/style/model assets would spend that limited space without testing the product's required live path. This is a deployment-support limitation, not evidence that a custom NVIDIA streaming port is impossible. A future port needs an isolated pod and a sustained, frame-level latency and MIDI-response benchmark before adoption.

## AMT benchmark method

`benchmark.py` is reproducible in the existing `/opt/amt-venv` environment. It imports the existing `/opt/backline/bench/amt/amt.py`; use `AMT_BENCH_DIR` to override. It does not import/start the web service or modify production files. Run:

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
