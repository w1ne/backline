#!/usr/bin/env python3
"""
Minimal WebSocket server streaming MRT2 audio to a browser.

Starting point for a Mac-hosted "band" backend, not production code.

Output format: PCM16, 48kHz, stereo, interleaved little-endian samples, sent
as binary WebSocket frames — one frame per generated ~2s audio chunk (per
docs: MRT2's native chunk size). UNVERIFIED: exact chunk size and whether the
installed version's chunk object exposes raw PCM directly (see below).

Control messages (JSON text frames), all optional fields ignored if unknown:
    {"type": "style", "text": "disco funk"}
    {"type": "bpm", "bpm": 120}                # UNVERIFIED: not confirmed exposed by API; ignored if unsupported
    {"type": "notes", "midi": [60, 64, 67]}    # UNVERIFIED: see README MIDI conditioning section
    {"type": "play"}
    {"type": "pause"}

Requires: pip install websockets
"""
import argparse
import asyncio
import inspect
import json
import struct

import websockets

SAMPLE_RATE = 48000
CHANNELS = 2


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
        if self.midi_param is None:
            print("[serve] WARNING: no MIDI/pitch parameter found on generate_chunk(); "
                  "'notes' control messages will be accepted but have no effect. "
                  "UNVERIFIED whether this API surface exists in your installed version.")
        if "bpm" not in gen_sig.parameters:
            print("[serve] NOTE: generate_chunk() has no 'bpm' parameter. "
                  "'bpm' control messages are accepted but currently no-ops. UNVERIFIED "
                  "whether tempo conditioning is exposed anywhere in the public API.")

    def chunk_to_pcm16_bytes(self, chunk):
        """Convert whatever the library returns into interleaved PCM16 bytes.

        UNVERIFIED: exact chunk object shape. We try a numpy array first
        (float32 in [-1, 1], shape [samples, channels] or [channels, samples]),
        falling back to a `.samples` / `.to_numpy()` accessor if present.
        """
        arr = None
        for attr in ("samples", "audio", "array"):
            if hasattr(chunk, attr):
                arr = getattr(chunk, attr)
                break
        if arr is None and hasattr(chunk, "to_numpy"):
            arr = chunk.to_numpy()
        if arr is None:
            arr = chunk  # assume chunk itself is array-like

        import numpy as np
        arr = np.asarray(arr)
        if arr.ndim == 2 and arr.shape[0] in (1, 2) and arr.shape[0] != arr.shape[1]:
            arr = arr.T  # -> [samples, channels]
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
            pass  # UNVERIFIED: no known conditioning hook; accepted, no-op
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
                continue  # no binary control messages expected
            await session.handle_control(message)
    finally:
        sender_task.cancel()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mrt2_small")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    from magenta_rt import system

    ctor_sig = inspect.signature(system.MagentaRT.__init__)
    kwargs = {"model": args.model} if "model" in ctor_sig.parameters else {}
    print(f"[serve] loading {args.model} ...")
    mrt = system.MagentaRT(**kwargs) if kwargs else system.MagentaRT()
    gen_sig = inspect.signature(mrt.generate_chunk)
    print(f"[serve] generate_chunk signature: {gen_sig}")

    async def bound_handler(ws):
        await handler(ws, mrt, system.embed_style, gen_sig)

    print(f"[serve] listening on ws://0.0.0.0:{args.port}  "
          f"(PCM16 {SAMPLE_RATE}Hz {CHANNELS}ch binary frames)")
    async with websockets.serve(bound_handler, "0.0.0.0", args.port):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
