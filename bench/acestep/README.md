# ACE-Step 1.5 — Modal.com benchmark (fallback for RunPod)

Not yet run — no Modal token exists in this environment. Prepared as the
fallback path if RunPod keeps failing. Verified against modal.com/docs and
github.com/ace-step/ACE-Step-1.5 on 2026-09-12; unverified items are marked
`# UNVERIFIED:` in `modal_bench.py`.

Pinned commit: `ca1e85fe9430179831e6bc6be790c332190a3866` (main, 2026-08-29).

## Run

```bash
pip install modal
modal token new
modal run bench/acestep/modal_bench.py
# override GPU (default L4):
GPU=A10 modal run bench/acestep/modal_bench.py
```

First run downloads ACE-Step 1.5 weights into a `modal.Volume`
(`acestep-1-5-weights`) and installs the repo's `requirements.txt` into the
image — both are cached, so subsequent runs skip the download/build.

Output: `results.json` (per-call wall time, output duration, peak VRAM,
guitar-preservation correlation) and a few `.wav` files, written to the
current directory by the local entrypoint.

## Cost estimate

Modal per-second GPU compute pricing (modal.com/pricing, checked
2026-09-12):

| GPU | $/sec | $/hour (approx) |
|---|---|---|
| L4 | $0.000222 | ~$0.80 |
| A10 | $0.000306 | ~$1.10 |

The benchmark does ~8 generation calls (3× text2music, 1× guitar seed, 3×
complete) plus model load. If model load takes ~1-2 min and each 10s
generation call is well under a minute (per prior research: ACE-Step 1.5
renders 10s of audio in well under 1s of pure compute on an RTX 4090; L4 is
slower — no official L4 number from ACE-Step, so treat generation time as
`# UNVERIFIED` for this GPU), a full run should cost well under $0.50 on L4.
This is a rough estimate, not a quote — actual cost depends on image build
time (first run only, several minutes) and real per-call latency once
measured.

## What "good" looks like

A 10 s `complete` call finishing in **under 2.5 s** of wall time (excluding
model load) is the target — this is the latency budget for the bar-quantized
play-along use case this benchmark exists to validate (see
`bar-quantized-models-research.md`). Anything slower on L4 likely means
stepping up to A10/L40S, or reconsidering GPU choice for production.

## Unverified items (see also `# UNVERIFIED:` comments in `modal_bench.py`)

- Exact CUDA base image version compatible with ACE-Step 1.5's own
  `requirements.txt` torch pin — used CUDA 12.4 devel as a reasonable
  default, not confirmed against the repo's tested matrix.
- `AceStepHandler` constructor's full kwarg surface beyond
  `checkpoint_dir`/`device` (used in `cli.py`'s wizard defaults).
- Exact return type/shape of `acestep.inference.generate_music`.
- Whether a distinct continuation/extend task exists beyond `complete` at
  the pinned commit (none found in `cli.py`'s task_type set).
- L4 generation speed for ACE-Step 1.5 (no official vendor number; only
  RTX 4090 and A100 figures were found in prior research).
- Whether `pip install -r requirements.txt` alone (vs. the repo's own
  `uv`-based install scripts) produces a fully working environment on
  Modal's base image.
