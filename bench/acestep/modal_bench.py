"""
Modal.com benchmark for ACE-Step 1.5 — fallback path if RunPod keeps failing.

Pinned commit: ca1e85fe9430179831e6bc6be790c332190a3866
  (github.com/ace-step/ACE-Step-1.5, main, 2026-08-29)

This has NOT been run — no Modal token exists yet in this environment.
Verified against modal.com/docs (2026-09-12) and the ACE-Step-1.5 repo tree
at the pinned commit (cli.py, requirements.txt, README.md read via `gh api`).
Anything not directly confirmed from those sources is flagged
`# UNVERIFIED:`.

Usage:
    pip install modal
    modal token new
    modal run bench/acestep/modal_bench.py
    GPU=A10 modal run bench/acestep/modal_bench.py   # override GPU type
"""

import io
import json
import os
import time

import modal

ACESTEP_COMMIT = "ca1e85fe9430179831e6bc6be790c332190a3866"
GPU_TYPE = os.environ.get("GPU", "L4")  # Modal GPU strings verified 2026-09-12: T4, L4, A10, L40S, A100(-40GB/-80GB), H100, H200, B200, B300
TIMEOUT_S = 60 * 30

app = modal.App("acestep-1-5-bench")

# --- Image -------------------------------------------------------------
# ACE-Step 1.5 requirements.txt (read from repo at pinned commit) pins torch
# via its own CUDA wheel index; we start from Modal's CUDA devel base and let
# pip resolve the repo's requirements.txt so versions stay in lockstep with
# upstream rather than us guessing a compatible torch/CUDA pairing.
# UNVERIFIED: exact CUDA toolkit version required by ACE-Step-1.5's own
# requirements.txt — repo does not pin a single canonical CUDA image, so we
# use CUDA 12.4 devel (broadly compatible with recent torch cu12x wheels) and
# let the repo's requirements.txt pin its own torch build.
CUDA_TAG = "12.4.0-devel-ubuntu22.04"

image = (
    modal.Image.from_registry(f"nvidia/cuda:{CUDA_TAG}", add_python="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .run_commands(
        f"git clone https://github.com/ace-step/ACE-Step-1.5.git /opt/acestep"
        f" && cd /opt/acestep && git checkout {ACESTEP_COMMIT}",
    )
    .run_commands(
        "cd /opt/acestep && pip install --no-cache-dir -r requirements.txt",
        # UNVERIFIED: whether requirements.txt alone is sufficient without
        # `uv` (repo's own install docs favor install_uv.sh/uv sync); pip -r
        # is used here for a plain, reproducible Modal image build instead.
        gpu=GPU_TYPE,  # torch install inside requirements.txt may probe for a GPU/CUDA at build time
    )
    .pip_install("librosa", "soundfile", "scipy", "numpy")
    .env({"PYTHONPATH": "/opt/acestep", "ACESTEP_CHECKPOINTS_DIR": "/weights"})
)

# --- Volume for model weights -------------------------------------------
weights_volume = modal.Volume.from_name("acestep-1-5-weights", create_if_missing=True)
WEIGHTS_DIR = "/weights"


@app.function(
    image=image,
    gpu=GPU_TYPE,
    timeout=TIMEOUT_S,
    volumes={WEIGHTS_DIR: weights_volume},
)
def run_benchmark() -> bytes:
    import sys

    sys.path.insert(0, "/opt/acestep")
    import numpy as np
    import soundfile as sf
    import torch

    # Python API used directly (per repo's own cli.py, which imports the
    # same modules rather than shelling out) — NOT the HTTP server and NOT
    # cli.py's subprocess/CLI path, because cli.py is wizard/TOML-driven
    # (argparse in main() only exposes --config/--configure/--backend/
    # --log-level; all generation params come from a TOML file or an
    # interactive wizard — confirmed by reading cli.py at the pinned
    # commit). Importing the library modules directly avoids needing to
    # fabricate a TOML config or drive the wizard non-interactively.
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music
    from acestep.gpu_config import get_gpu_config, set_global_gpu_config

    results = {"gpu_type": GPU_TYPE, "commit": ACESTEP_COMMIT, "calls": []}

    gpu_config = get_gpu_config()
    set_global_gpu_config(gpu_config)

    checkpoint_dir = WEIGHTS_DIR

    # --- Load model (timed; weights auto-download into the Volume on first run) ---
    t0 = time.time()
    handler = AceStepHandler(
        checkpoint_dir=checkpoint_dir,
        device="cuda",
        # UNVERIFIED: exact AceStepHandler constructor signature beyond
        # checkpoint_dir/device — confirmed these two exist via cli.py's own
        # wizard defaults (checkpoint_dir, device="auto"); other kwargs
        # (offload_to_cpu, backend) are read from GenerationConfig below
        # per cli.py's pattern rather than passed to the handler directly.
    )
    load_s = time.time() - t0
    weights_volume.commit()  # persist any newly downloaded weights
    torch.cuda.reset_peak_memory_stats()
    results["model_load_seconds"] = load_s

    config = GenerationConfig(batch_size=1, use_random_seed=False)

    def _band_energy(wav: np.ndarray, sr: int, lo=80, hi=1200):
        # Rough 80-1200 Hz band energy via FFT magnitude sum — used only for
        # a coarse guitar-preservation correlation, not a rigorous metric.
        n = len(wav)
        spec = np.abs(np.fft.rfft(wav))
        freqs = np.fft.rfftfreq(n, d=1.0 / sr)
        band = (freqs >= lo) & (freqs <= hi)
        return spec[band]

    def _call(label, **kwargs):
        params = GenerationParams(**kwargs)
        t0 = time.time()
        # generate_music signature per acestep/inference.py usage in cli.py:
        # generate_music(handler, params, config) -> list of (audio_np, sr) or similar.
        # UNVERIFIED: exact return type of generate_music (repo internals not
        # fully traced) — assumed to yield (audio_array, sample_rate) pairs,
        # matching cli.py's save-to-wav pattern.
        out = generate_music(handler, params, config)
        dt = time.time() - t0
        audio, sr = out[0] if isinstance(out, (list, tuple)) and not isinstance(out[0], (int, float)) else out
        peak_vram = torch.cuda.max_memory_allocated() / (1024**3)
        entry = {
            "label": label,
            "wall_seconds": dt,
            "output_duration_seconds": len(audio) / sr,
            "peak_vram_gb": peak_vram,
        }
        results["calls"].append(entry)
        return audio, sr

    prompt = "lofi hip hop, drums, bass, electric piano"

    # 1. text2music x3
    t2m_audio = None
    for i in range(3):
        audio, sr = _call(
            f"text2music_{i}",
            task_type="text2music",
            instruction="Generate music from the given caption.",
            prompt=prompt,
            duration=10,
            bpm=100,
            keyscale="A Minor",
            timesignature=4,
        )
        if t2m_audio is None:
            t2m_audio = (audio, sr)

    # 2. solo guitar clip (10s) then `complete` x3 to add drums/bass/EP
    guitar_audio, guitar_sr = _call(
        "solo_guitar_seed",
        task_type="text2music",
        instruction="Generate music from the given caption.",
        prompt="solo acoustic guitar, instrumental",
        duration=10,
        bpm=100,
        keyscale="A Minor",
        timesignature=4,
    )
    guitar_path = "/tmp/guitar_seed.wav"
    sf.write(guitar_path, guitar_audio, guitar_sr)

    complete_audio = None
    for i in range(3):
        # `complete_tracks` per cli.py wizard: comma-separated TRACK_CHOICES
        # (drums, bass, keyboard, ...); instruction auto-built from tracks
        # via TASK_INSTRUCTIONS["complete"] when not explicitly given.
        audio, sr = _call(
            f"complete_{i}",
            task_type="complete",
            src_audio=guitar_path,
            instruction=None,  # let library auto-build from complete_tracks, mirroring cli.py
            complete_tracks="drums,bass,keyboard",
            prompt="add drums, bass and electric piano, lofi hip hop",
            bpm=100,
            keyscale="A Minor",
            timesignature=4,
            duration=10,
        )
        if complete_audio is None:
            complete_audio = (audio, sr)

    # Guitar-preservation correlation: 80-1200Hz band energy, input vs first `complete` output
    try:
        in_band = _band_energy(guitar_audio, guitar_sr)
        out_band = _band_energy(complete_audio[0], complete_audio[1])
        n = min(len(in_band), len(out_band))
        corr = float(np.corrcoef(in_band[:n], out_band[:n])[0, 1]) if n > 1 else None
    except Exception as e:
        corr = None
        results["guitar_correlation_error"] = str(e)
    results["guitar_band_correlation_80_1200hz"] = corr

    # 3. Continuation/extend, if the API exposes a distinct primitive.
    # UNVERIFIED: cli.py's task_type set is {text2music, cover, repaint,
    # lego, extract, complete} — no separate "continuation"/"extend" task
    # beyond `complete` (which itself extends/completes partial tracks) was
    # found in cli.py at the pinned commit. We treat `complete` above as the
    # continuation primitive per the earlier research note and do not call
    # a separate API here; flagging in case a newer commit adds one.
    results["continuation_note"] = (
        "No distinct continuation/extend task found beyond `complete` "
        "at commit " + ACESTEP_COMMIT + "; complete_* calls above serve this role."
    )

    # Bundle audio for local entrypoint
    buf_t2m = io.BytesIO()
    sf.write(buf_t2m, t2m_audio[0], t2m_audio[1], format="WAV")
    buf_guitar = io.BytesIO()
    sf.write(buf_guitar, guitar_audio, guitar_sr, format="WAV")
    buf_complete = io.BytesIO()
    sf.write(buf_complete, complete_audio[0], complete_audio[1], format="WAV")

    payload = {
        "results": results,
        "wavs": {
            "text2music_0.wav": buf_t2m.getvalue().hex(),
            "guitar_seed.wav": buf_guitar.getvalue().hex(),
            "complete_0.wav": buf_complete.getvalue().hex(),
        },
    }
    return json.dumps(payload).encode("utf-8")


@app.local_entrypoint()
def main():
    raw = run_benchmark.remote()
    payload = json.loads(raw.decode("utf-8"))
    results = payload["results"]

    with open("results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("Wrote results.json")

    for name, hexdata in payload["wavs"].items():
        with open(name, "wb") as f:
            f.write(bytes.fromhex(hexdata))
        print(f"Wrote {name}")

    print(json.dumps(results, indent=2))
