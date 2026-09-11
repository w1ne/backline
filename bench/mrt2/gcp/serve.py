#!/usr/bin/env python3
"""
MRT2 (Magenta RealTime 2) GPU WebSocket server — provider-agnostic
(RunPod pod, GCE VM, Cloud Run w/ GPU, or bare metal all work the same way:
a container listening on $PORT, no provider-specific code).

Difference from ../serve.py (the CPU/Mac starting point):
  - JAX/CUDA backend: `magenta_rt.jax.system.MagentaRT2System` (per the repo
    README's "Verified on Linux CPU" section — this is the real entry point,
    not `magenta_rt.system.MagentaRT`, which does not exist).
  - Warm-up generation at startup (a few throwaway chunks) so the first real
    client doesn't eat JIT/XLA compilation latency (JAX traces + compiles the
    step function on first call; this can be many seconds on GPU).
  - One shared model instance for the process; per-connection mutable state
    (style embedding, rolling generation state, playing/paused) lives in the
    Session object, matching the CPU version's design.
  - `--bench` flag: loads the model, runs `--bench-chunks` (default 20)
    generation steps with no network I/O, prints per-chunk time + RTF, and
    exits. Use this as the *first* check on a freshly booted GPU box before
    wiring up the relay — `python serve.py --model mrt2_base --bench`.
  - `/health` endpoint (plain HTTP, not WebSocket) for Cloud Run / load
    balancer / RunPod readiness probes. Implemented by branching in the
    websockets HTTP-request handler (the `process_request` hook), since this
    is a single process serving both HTTP health checks and the WS upgrade
    on the same port — there's no separate HTTP framework here.

Output format (unchanged from CPU version): binary WebSocket frames of
PCM16, 48kHz, stereo, interleaved little-endian samples, one frame per
generated audio chunk. JSON text frames for control. See ../serve.py's
module docstring for the message schema — it is identical here.

UNVERIFIED items carried over from ../serve.py (chunk object shape,
MIDI/bpm conditioning params) are unchanged: this file only changes how the
model is loaded and how the server is wired for a GPU host + `/health`. It
still introspects `generate_chunk`'s signature at runtime rather than
hard-coding assumptions, and logs what it finds.

Env vars:
  PORT              listen port (Cloud Run sets this; default 8080 — RunPod
                     and GCE both default to exposing 8080 too, so this one
                     default works unchanged across all three targets)
  MRT2_MODEL        mrt2_small | mrt2_base (default mrt2_base — verify it
                     fits on your GPU's VRAM with --bench before assuming it
                     does; fall back to mrt2_small if not)
  MRT2_CHECKPOINT_DIR  where `mrt checkpoints download` puts safetensors
                     weights (default ~/.cache/magenta_rt or as set by the
                     Dockerfile's ENV; see gcp/README.md checkpoint strategy)

Requires: pip install websockets  (already a magenta-rt dependency's peer;
listed explicitly in the Dockerfile regardless)
"""
import argparse
import asyncio
import inspect
import json
import os
import struct
import sys
import time

import websockets

SAMPLE_RATE = 48000
CHANNELS = 2
DEFAULT_PORT = int(os.environ.get("PORT", "8080"))
DEFAULT_MODEL = os.environ.get("MRT2_MODEL", "mrt2_base")


def log(msg):
    print(f"[serve] {msg}", flush=True)


def load_model(model_name):
    """Load MRT2 via the JAX/CUDA backend.

    Per bench/mrt2/README.md's "Verified on Linux CPU" section: the real
    entry point is `magenta_rt.jax.system.MagentaRT2System`, not
    `magenta_rt.system.MagentaRT` (that name does not exist in the installed
    package). On a CUDA host with `jax[cuda12]` installed, JAX picks up the
    GPU backend automatically — no code-level CPU/GPU switch is needed,
    JAX's device placement does this by default when a CUDA device is
    visible. UNVERIFIED: exact `MagentaRT2System.__init__` kwarg for
    checkpoint directory / model size selection — introspected at runtime
    below, same defensive pattern as ../bench.py.
    """
    from magenta_rt.jax import system as jax_system

    ctor_sig = inspect.signature(jax_system.MagentaRT2System.__init__)
    log(f"MagentaRT2System.__init__ signature: {ctor_sig}")
    kwargs = {}
    for candidate in ("model", "checkpoint", "model_name"):
        if candidate in ctor_sig.parameters:
            kwargs[candidate] = model_name
            break
    else:
        log("WARNING: no model-selection kwarg found by name on "
            "MagentaRT2System.__init__; trying positional arg.")

    t0 = time.perf_counter()
    try:
        mrt = jax_system.MagentaRT2System(**kwargs) if kwargs else jax_system.MagentaRT2System(model_name)
    except TypeError as e:
        log(f"Constructor call failed ({e}); retrying with no args (library default checkpoint).")
        mrt = jax_system.MagentaRT2System()
    log(f"model load time: {time.perf_counter() - t0:.2f}s")

    # Report which JAX backend actually got picked up — this is the single
    # most important line in the boot log on a GPU box. If this prints
    # "cpu" on a machine with a GPU, the CUDA wheel/driver setup is broken
    # and RTF will be ~9.9 again regardless of anything else in this file.
    try:
        import jax
        log(f"jax.default_backend() = {jax.default_backend()}  "
            f"devices = {jax.devices()}")
    except Exception as e:
        log(f"could not introspect jax backend: {e}")

    return mrt, jax_system.embed_style


def warmup(mrt, embed_style, n_chunks=2):
    """Run a couple of throwaway generation steps so the first real client
    doesn't pay JAX's JIT-compilation cost. UNVERIFIED: how many chunks it
    actually takes for JAX to settle into steady-state latency on L4 —
    2 is a conservative guess; --bench's per-chunk timings will show if the
    first 1-2 are outliers and whether more warm-up is worth adding.
    """
    log(f"warming up ({n_chunks} chunks)...")
    style = embed_style("ambient")
    state = None
    for i in range(n_chunks):
        t0 = time.perf_counter()
        state, _ = mrt.generate_chunk(state=state, style=style)
        log(f"warm-up chunk {i+1}/{n_chunks}: {time.perf_counter()-t0:.2f}s")
    log("warm-up done")


def run_bench(mrt, embed_style, n_chunks):
    """--bench: generate n_chunks with no network I/O, print RTF, exit.
    This is the first check to run on a freshly booted GPU box — before
    touching the relay — to confirm CUDA is actually being used and RTF<=1.
    """
    style_a = embed_style("ambient piano")
    style_b = embed_style("disco funk")
    state = None
    times = []
    for i in range(n_chunks):
        style = style_a if i < n_chunks // 2 else style_b
        t0 = time.perf_counter()
        state, chunk = mrt.generate_chunk(state=state, style=style)
        dt = time.perf_counter() - t0
        dur = getattr(chunk, "duration_seconds", None) or getattr(chunk, "duration", None) or 2.0
        rtf = dt / dur
        times.append(rtf)
        log(f"chunk {i+1}/{n_chunks}: gen={dt*1000:.0f}ms audio_dur={dur:.2f}s rtf={rtf:.3f}")
    mean_rtf = sum(times) / len(times)
    print("\n=== --bench summary ===")
    print(f"chunks:        {n_chunks}")
    print(f"mean RTF:      {mean_rtf:.3f}  (<=1.0 required for live use)")
    print(f"max RTF:       {max(times):.3f}")
    print(f"min RTF:       {min(times):.3f}")
    sys.exit(0 if mean_rtf <= 1.0 else 1)


class Session:
    def __init__(self, mrt, embed_style, gen_sig):
        self.mrt = mrt
        self.embed_style = embed_style
        self.gen_sig = gen_sig
        self.state = None
        self.style = embed_style("ambient")
        self.midi = None
        self.playing = False
        self.midi_param = next(
            (p for p in ("midi", "pitch", "notes") if p in gen_sig.parameters), None
        )

    def chunk_to_pcm16_bytes(self, chunk):
        arr = None
        for attr in ("samples", "audio", "array"):
            if hasattr(chunk, attr):
                arr = getattr(chunk, attr)
                break
        if arr is None and hasattr(chunk, "to_numpy"):
            arr = chunk.to_numpy()
        if arr is None:
            arr = chunk

        import numpy as np
        arr = np.asarray(arr)
        if arr.ndim == 2 and arr.shape[0] in (1, 2) and arr.shape[0] != arr.shape[1]:
            arr = arr.T
        if arr.ndim == 1:
            arr = np.repeat(arr[:, None], CHANNELS, axis=1)
        pcm16 = np.clip(arr, -1.0, 1.0)
        pcm16 = (pcm16 * 32767.0).astype("<i2")
        return pcm16.tobytes()

    async def handle_control(self, msg):
        try:
            data = json.loads(msg)
        except json.JSONDecodeError:
            return
        t = data.get("type")
        if t == "style" and "text" in data:
            self.style = self.embed_style(data["text"])
        elif t == "notes" and self.midi_param:
            self.midi = data.get("midi", [])
        elif t == "bpm":
            pass  # UNVERIFIED: no known conditioning hook
        elif t == "play":
            self.playing = True
        elif t == "pause":
            self.playing = False

    async def generate_and_send(self, ws):
        while True:
            if not self.playing:
                await asyncio.sleep(0.05)
                continue
            kwargs = {"state": self.state, "style": self.style}
            if self.midi_param and self.midi:
                kwargs[self.midi_param] = self.midi
            loop = asyncio.get_event_loop()
            self.state, chunk = await loop.run_in_executor(
                None, lambda: self.mrt.generate_chunk(**kwargs)
            )
            pcm = self.chunk_to_pcm16_bytes(chunk)
            await ws.send(pcm)


async def handler(ws, mrt, embed_style, gen_sig):
    session = Session(mrt, embed_style, gen_sig)
    sender_task = asyncio.create_task(session.generate_and_send(ws))
    try:
        async for message in ws:
            if isinstance(message, bytes):
                continue
            await session.handle_control(message)
    finally:
        sender_task.cancel()


def process_request(path, request_headers):
    """websockets legacy hook for a plain HTTP /health response on the same
    port as the WS upgrade. Required by Cloud Run (container health check)
    and useful for RunPod/GCE readiness probes too.
    UNVERIFIED: exact hook name/signature across websockets versions differs
    (`process_request` sync in older releases, coroutine in 11+, replaced by
    a `ServerConnection`-based hook in 13+). Pinned websockets version in the
    Dockerfile; if this breaks after a version bump, check the installed
    websockets changelog for the current health-check hook name.
    """
    if path == "/health":
        return (200, [("Content-Type", "text/plain")], b"ok\n")
    return None


async def main_async(args):
    mrt, embed_style = load_model(args.model)

    if args.bench:
        run_bench(mrt, embed_style, args.bench_chunks)
        return

    warmup(mrt, embed_style)
    gen_sig = inspect.signature(mrt.generate_chunk)
    log(f"generate_chunk signature: {gen_sig}")

    async def bound_handler(ws):
        await handler(ws, mrt, embed_style, gen_sig)

    log(f"listening on ws://0.0.0.0:{args.port}  (PCM16 {SAMPLE_RATE}Hz {CHANNELS}ch, /health on same port)")
    async with websockets.serve(bound_handler, "0.0.0.0", args.port, process_request=process_request):
        await asyncio.Future()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=["mrt2_small", "mrt2_base"])
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--bench", action="store_true",
                     help="load model, run --bench-chunks generation steps, print RTF, exit")
    ap.add_argument("--bench-chunks", type=int, default=20)
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
