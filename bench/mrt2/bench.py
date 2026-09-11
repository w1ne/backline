#!/usr/bin/env python3
"""
MRT2 (Magenta RealTime 2) local benchmark.

Run on the target Mac (Apple Silicon) inside the `magenta-rt[mlx]` venv.
See README.md for install steps and for what is UNVERIFIED about the API
used here. This script introspects the installed `magenta_rt` package at
runtime rather than assuming an exact signature, and prints what it found
so any wrong assumption in this file is visible immediately instead of
silently benchmarking the wrong thing.

Usage:
    python bench.py --model mrt2_base --chunks 30
    python bench.py --model mrt2_small --chunks 30
"""
import argparse
import inspect
import json
import time
import tracemalloc
import sys

CHUNK_SECONDS = 2.0  # per docs: MRT2 generates in 2s chunks. Verified at runtime below if possible.


def log(msg):
    print(f"[bench] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mrt2_small", choices=["mrt2_small", "mrt2_base"])
    ap.add_argument("--chunks", type=int, default=30)
    ap.add_argument("--out", default="results.json")
    args = ap.parse_args()

    try:
        from magenta_rt import audio, system
    except ImportError as e:
        log(f"FATAL: could not import magenta_rt ({e}). Did you `uv pip install \"magenta-rt[mlx]\"`?")
        sys.exit(1)

    results = {"model": args.model, "chunks_requested": args.chunks}

    # ---- introspect MagentaRT constructor ----
    ctor_sig = inspect.signature(system.MagentaRT.__init__)
    log(f"system.MagentaRT.__init__ signature: {ctor_sig}")
    ctor_kwargs = {}
    for candidate in ("model", "checkpoint", "model_name"):
        if candidate in ctor_sig.parameters:
            ctor_kwargs[candidate] = args.model
            break
    else:
        log("WARNING: could not find a model-selection kwarg on MagentaRT.__init__ "
            "by name; trying positional. UNVERIFIED assumption in README may be wrong.")

    # ---- model load time + peak memory ----
    tracemalloc.start()
    t0 = time.perf_counter()
    try:
        mrt = system.MagentaRT(**ctor_kwargs) if ctor_kwargs else system.MagentaRT(args.model)
    except TypeError as e:
        log(f"Constructor call failed ({e}); retrying with no args (uses library default checkpoint).")
        mrt = system.MagentaRT()
    load_time_s = time.perf_counter() - t0
    results["model_load_time_s"] = load_time_s
    log(f"model load time: {load_time_s:.2f}s")

    # ---- introspect generate_chunk signature for MIDI support ----
    gc_sig = inspect.signature(mrt.generate_chunk)
    log(f"generate_chunk signature: {gc_sig}")
    supports_midi = any(p in gc_sig.parameters for p in ("midi", "pitch", "notes"))
    results["generate_chunk_signature"] = str(gc_sig)
    results["midi_conditioning_exposed"] = supports_midi
    if not supports_midi:
        log("MIDI/pitch conditioning parameter NOT found on generate_chunk(). "
            "Per README this is UNVERIFIED as a public API surface — benchmarking "
            "text/audio style conditioning only, and skipping the MIDI-latency measurement.")

    # ---- style embedding ----
    style_a = system.embed_style("ambient piano")
    style_b = system.embed_style("disco funk")

    # ---- streaming generation loop ----
    state = None
    chunk_times = []
    chunk_audio_durations = []
    first_chunk_time_s = None
    style_switch_at_chunk = args.chunks // 2
    style_switch_latency_s = None
    current_style = style_a

    t_start_stream = time.perf_counter()
    for i in range(args.chunks):
        if i == style_switch_at_chunk:
            current_style = style_b
            t_switch = time.perf_counter()

        t0 = time.perf_counter()
        state, chunk = mrt.generate_chunk(state=state, style=current_style)
        t1 = time.perf_counter()

        gen_time = t1 - t0
        chunk_times.append(gen_time)

        # duration of the produced audio chunk, if the object exposes it
        dur = getattr(chunk, "duration_seconds", None) or getattr(chunk, "duration", None) or CHUNK_SECONDS
        chunk_audio_durations.append(dur)

        if i == 0:
            first_chunk_time_s = t1 - t_start_stream

        if i == style_switch_at_chunk:
            style_switch_latency_s = t1 - t_switch

        log(f"chunk {i+1}/{args.chunks}: gen={gen_time*1000:.0f}ms audio_dur={dur:.2f}s "
            f"rtf={gen_time/dur:.3f}")

    peak_mem_bytes = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    rtfs = [g / d for g, d in zip(chunk_times, chunk_audio_durations)]
    results.update({
        "time_to_first_chunk_s": first_chunk_time_s,
        "per_chunk_gen_time_s": chunk_times,
        "per_chunk_audio_duration_s": chunk_audio_durations,
        "real_time_factor_per_chunk": rtfs,
        "real_time_factor_mean": sum(rtfs) / len(rtfs),
        "real_time_factor_max": max(rtfs),
        "style_switch_latency_s": style_switch_latency_s,
        "peak_memory_traced_python_bytes": peak_mem_bytes,
        "peak_memory_note": "tracemalloc only tracks Python-heap allocations; MLX/Metal "
                             "buffers live outside this. UNVERIFIED: true peak RSS. "
                             "Cross-check with Activity Monitor or `psutil` if available.",
    })

    # ---- optional MIDI latency measurement ----
    if supports_midi:
        midi_param = next(p for p in ("midi", "pitch", "notes") if p in gc_sig.parameters)
        try:
            t0 = time.perf_counter()
            kwargs = {"state": state, "style": current_style, midi_param: [60, 64, 67]}
            state, chunk = mrt.generate_chunk(**kwargs)
            midi_latency_s = time.perf_counter() - t0
            results["midi_conditioning_change_latency_s"] = midi_latency_s
            log(f"MIDI conditioning change latency: {midi_latency_s*1000:.0f}ms")
        except Exception as e:
            log(f"MIDI conditioning call failed at runtime: {e}. Recording as unsupported.")
            results["midi_conditioning_exposed"] = False
            results["midi_conditioning_error"] = str(e)
    else:
        results["midi_conditioning_change_latency_s"] = None

    try:
        import psutil
        proc = psutil.Process()
        results["peak_rss_bytes"] = proc.memory_info().rss
    except ImportError:
        results["peak_rss_bytes"] = None
        log("psutil not installed; skipping RSS measurement (pip install psutil for a real number).")

    with open(args.out, "w") as f:
        json.dump(results, f, indent=2)

    # ---- summary table ----
    print("\n=== MRT2 Benchmark Summary ===")
    print(f"{'model':<28}{args.model}")
    print(f"{'load time (s)':<28}{load_time_s:.2f}")
    print(f"{'time to first chunk (s)':<28}{first_chunk_time_s:.2f}")
    print(f"{'mean real-time factor':<28}{results['real_time_factor_mean']:.3f}  "
          f"(<1.0 = faster than real time)")
    print(f"{'max real-time factor':<28}{results['real_time_factor_max']:.3f}")
    print(f"{'style switch latency (s)':<28}{style_switch_latency_s:.2f}")
    print(f"{'midi conditioning exposed':<28}{supports_midi}")
    if supports_midi:
        print(f"{'midi latency (s)':<28}{results.get('midi_conditioning_change_latency_s')}")
    print(f"{'peak RSS (MB)':<28}"
          f"{(results['peak_rss_bytes'] or 0) / 1e6:.0f}")
    print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()
