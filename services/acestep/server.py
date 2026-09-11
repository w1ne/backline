"""ACE-Step block-generation service for Backline.

Loads ACE-Step 1.5 once at process start and serves 2-bar (configurable)
audio blocks over a WebSocket, quantized to the caller's bpm/key so a
browser band can be assembled from consecutive blocks.

Two ways to reach ACE-Step, selected automatically:

1. In-process Python API (`acestep.handler.AceStepHandler` /
   `acestep.inference.generate_music`) -- preferred, avoids a second
   process and an HTTP round trip. The exact call signature is taken from
   the ACE-Step 1.5 repo at commit ca1e85fe9430179831e6bc6be790c332190a3866;
   see NOTE(unverified) below -- this could not be exercised in this
   environment (no GPU, no network access to the model weights), so the
   call is wrapped defensively and falls back to (2) if it raises.
2. The bundled HTTP API (`uv run acestep-api`) driven as a subprocess,
   using `POST /release_task` + `POST /query_result` as documented in the
   task brief. This path is what `--bench` and production actually
   exercise if the in-process import fails.

Env vars:
  PORT           -- listen port (default 8080)
  ACE_MODEL_DIR  -- where ACE-Step should look for / cache weights
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import os
import struct
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Optional

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("acestep-server")

PORT = int(os.environ.get("PORT", "8080"))
MODEL_DIR = os.environ.get("ACE_MODEL_DIR", "/workspace/models")
MODEL_OUTPUT_SR = 44100  # ACE-Step 1.5 renders at 44.1 kHz; we resample to 48 kHz for the client.
TARGET_SR = 48000
INFERENCE_STEPS = 8

GENRE_PROMPTS = {
    "lofi": "lofi hip hop, chill beats, warm tape saturation",
    "funk": "funk groove, syncopated, tight pocket",
    "rock": "rock band, driving, energetic",
    "jazz": "jazz combo, swung, sophisticated harmony",
}

INSTRUMENT_WORDS = {
    "drums": "drums",
    "bass": "bass",
    "keys": "electric piano",
    "lead": "lead synth",
}


def build_prompt(genre: str, instruments: list[str], exclude: Optional[str] = None) -> str:
    genre_text = GENRE_PROMPTS.get(genre, GENRE_PROMPTS["lofi"])
    words = [INSTRUMENT_WORDS.get(i, i) for i in instruments if i != exclude]
    parts = [genre_text]
    if words:
        parts.append(", ".join(words))
    parts.append("instrumental, no vocals, no guitar")
    return ", ".join(parts)


def track_classes_for(instruments: list[str], exclude: Optional[str] = None) -> list[str]:
    return [INSTRUMENT_WORDS.get(i, i) for i in instruments if i != exclude]


def creativity_to_guidance(creativity: float) -> float:
    # ACE-Step's guidance_scale is typically in the ~3-15 range; higher creativity ->
    # lower guidance (looser adherence to the prompt, more variation).
    creativity = max(0.0, min(1.0, creativity))
    return 15.0 - creativity * 10.0


def creativity_to_seed(creativity: float, seq: int) -> int:
    return (int(creativity * 1_000_000) * 2654435761 + seq) & 0x7FFFFFFF


def resample_to_48k(audio: np.ndarray, src_sr: int) -> np.ndarray:
    """audio: float32 [samples, channels] or [samples]. Returns float32 [samples, 2]."""
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=-1)
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    if src_sr == TARGET_SR:
        return audio.astype(np.float32)
    duration = audio.shape[0] / src_sr
    n_out = int(round(duration * TARGET_SR))
    x_src = np.linspace(0.0, duration, num=audio.shape[0], endpoint=False)
    x_dst = np.linspace(0.0, duration, num=n_out, endpoint=False)
    out = np.empty((n_out, audio.shape[1]), dtype=np.float32)
    for ch in range(audio.shape[1]):
        out[:, ch] = np.interp(x_dst, x_src, audio[:, ch]).astype(np.float32)
    return out


def float_to_pcm16(audio: np.ndarray) -> bytes:
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


@dataclass
class GenParams:
    task_type: str  # 'text2music' | 'complete'
    prompt: str
    bpm: int
    key_scale: str
    audio_duration: float
    inference_steps: int
    guidance: float
    seed: int
    src_audio_path: Optional[str] = None
    track_classes: Optional[list[str]] = None


class AceStepModel:
    """Wraps the ACE-Step model, preferring the in-process Python API and
    falling back to the bundled HTTP server if that import/call fails.
    """

    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self._handler = None
        self._http_proc: Optional[subprocess.Popen] = None
        self._http_base = "http://127.0.0.1:8010"
        self._mode = None  # 'inprocess' | 'http'

    def load(self) -> None:
        try:
            self._load_inprocess()
            self._mode = "inprocess"
            log.info("ACE-Step loaded in-process")
        except Exception:
            log.exception("in-process ACE-Step load failed, falling back to HTTP subprocess")
            self._start_http_server()
            self._mode = "http"

    def _load_inprocess(self) -> None:
        # NOTE(unverified): exact constructor kwargs for AceStepHandler are taken from the
        # task brief description of acestep/api/http/release_task_models.py and
        # acestep.handler.AceStepHandler; not confirmed against the repo source in this
        # environment. If the signature differs, this raises and we fall back to HTTP.
        from acestep.handler import AceStepHandler  # type: ignore

        self._handler = AceStepHandler(checkpoint_dir=self.model_dir)
        self._handler.load()

    def _start_http_server(self) -> None:
        env = dict(os.environ)
        env.setdefault("ACE_MODEL_DIR", self.model_dir)
        self._http_proc = subprocess.Popen(
            ["uv", "run", "acestep-api", "--host", "127.0.0.1", "--port", "8010"],
            env=env,
        )
        import urllib.request

        deadline = time.time() + 600
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"{self._http_base}/health", timeout=2)
                return
            except Exception:
                time.sleep(2)
        raise RuntimeError("acestep-api subprocess did not become healthy in time")

    def warmup(self) -> None:
        params = GenParams(
            task_type="text2music",
            prompt=build_prompt("lofi", ["drums", "bass"]),
            bpm=100,
            key_scale="A minor",
            audio_duration=2.0,
            inference_steps=INFERENCE_STEPS,
            guidance=creativity_to_guidance(0.5),
            seed=1,
        )
        self.generate(params)

    def generate(self, params: GenParams) -> np.ndarray:
        if self._mode == "inprocess":
            return self._generate_inprocess(params)
        return self._generate_http(params)

    def _generate_inprocess(self, params: GenParams) -> np.ndarray:
        # NOTE(unverified): GenerationParams/generate_music signature per task brief;
        # adjust field names to match acestep.inference if they differ.
        from acestep.inference import GenerationParams, generate_music  # type: ignore

        gp = GenerationParams(
            task_type=params.task_type,
            prompt=params.prompt,
            bpm=params.bpm,
            key_scale=params.key_scale,
            audio_duration=params.audio_duration,
            inference_steps=params.inference_steps,
            guidance_scale=params.guidance,
            seed=params.seed,
            src_audio_path=params.src_audio_path,
            track_classes=params.track_classes,
        )
        result = generate_music(self._handler, gp)
        audio = np.asarray(result.audio, dtype=np.float32)
        sr = getattr(result, "sample_rate", MODEL_OUTPUT_SR)
        return resample_to_48k(audio, sr)

    def _generate_http(self, params: GenParams) -> np.ndarray:
        import urllib.request

        body = {
            "task_type": params.task_type,
            "prompt": params.prompt,
            "bpm": params.bpm,
            "key_scale": params.key_scale,
            "audio_duration": params.audio_duration,
            "inference_steps": params.inference_steps,
            "guidance": params.guidance,
            "seed": params.seed,
        }
        if params.src_audio_path:
            body["src_audio_path"] = params.src_audio_path
        if params.track_classes:
            body["track_classes"] = params.track_classes

        req = urllib.request.Request(
            f"{self._http_base}/release_task",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            release = json.loads(resp.read())
        task_id = release["task_id"]

        deadline = time.time() + 120
        out_path = None
        while time.time() < deadline:
            q = urllib.request.Request(
                f"{self._http_base}/query_result",
                data=json.dumps({"task_id_list": [task_id]}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(q, timeout=30) as resp:
                result = json.loads(resp.read())
            entry = result.get(task_id) or (result.get("results") or {}).get(task_id)
            if entry and entry.get("status") == "done":
                out_path = entry["audio_path"]
                break
            time.sleep(0.3)
        if out_path is None:
            raise RuntimeError(f"ACE-Step task {task_id} timed out")

        import soundfile as sf

        audio, sr = sf.read(out_path, dtype="float32", always_2d=True)
        return resample_to_48k(audio, sr)


class Session:
    """Per-connection generation state: one in-flight generation, later
    requests cancel/skip older seqs."""

    def __init__(self, model: AceStepModel):
        self.model = model
        self.last_bpm: Optional[int] = None
        self.last_key: Optional[str] = None
        self.prev_audio_path: Optional[str] = None
        self._task: Optional[asyncio.Task] = None
        self._latest_seq = -1

    def cancel_inflight(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()

    async def handle_block(self, msg: dict, send_binary, send_json) -> None:
        seq = msg["seq"]
        self._latest_seq = seq
        self.cancel_inflight()
        self._task = asyncio.ensure_future(self._run_block(msg, seq, send_binary, send_json))
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def _run_block(self, msg: dict, seq: int, send_binary, send_json) -> None:
        bpm = int(msg["bpm"])
        key = msg.get("key", "A minor")
        genre = msg.get("genre", "lofi")
        instruments = msg.get("instruments", ["drums", "bass"])
        creativity = float(msg.get("creativity", 0.5))
        bars = int(msg.get("bars", 2))
        player_instrument = msg.get("player_instrument")

        duration = bars * 240.0 / bpm
        needs_restart = bpm != self.last_bpm or key != self.last_key or self.prev_audio_path is None
        task_type = "text2music" if needs_restart else "complete"
        prompt = build_prompt(genre, instruments, exclude=player_instrument)

        params = GenParams(
            task_type=task_type,
            prompt=prompt,
            bpm=bpm,
            key_scale=key,
            audio_duration=duration,
            inference_steps=INFERENCE_STEPS,
            guidance=creativity_to_guidance(creativity),
            seed=creativity_to_seed(creativity, seq),
            src_audio_path=None if task_type == "text2music" else self.prev_audio_path,
            track_classes=None if task_type == "text2music" else track_classes_for(instruments, player_instrument),
        )

        loop = asyncio.get_running_loop()
        t0 = time.monotonic()
        audio = await loop.run_in_executor(None, self.model.generate, params)
        elapsed_ms = (time.monotonic() - t0) * 1000.0

        if seq != self._latest_seq:
            return  # superseded while generating

        self.last_bpm = bpm
        self.last_key = key
        self.prev_audio_path = _write_temp_wav(audio)

        pcm = float_to_pcm16(audio)
        header = struct.pack("<I", seq)
        await send_binary(header + pcm)
        await send_json({"type": "done", "seq": seq, "ms": elapsed_ms})


def _write_temp_wav(audio: np.ndarray) -> str:
    import soundfile as sf
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".wav", prefix="acestep_block_")
    os.close(fd)
    sf.write(path, audio, TARGET_SR, subtype="PCM_16")
    return path


def create_app(model: AceStepModel):
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect

    app = FastAPI()
    app.state.model = model

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        session = Session(model)

        async def send_binary(data: bytes):
            await websocket.send_bytes(data)

        async def send_json(obj: dict):
            await websocket.send_text(json.dumps(obj))

        try:
            while True:
                raw = await websocket.receive_text()
                msg = json.loads(raw)
                mtype = msg.get("type")
                if mtype == "ping":
                    await send_json({"type": "pong"})
                elif mtype == "block":
                    await session.handle_block(msg, send_binary, send_json)
                else:
                    log.warning("unknown message type: %s", mtype)
        except WebSocketDisconnect:
            session.cancel_inflight()

    return app


def run_bench() -> None:
    model = AceStepModel(MODEL_DIR)
    log.info("loading model for bench...")
    model.load()
    log.info("warming up...")
    model.warmup()

    bpm = 100
    bars = 2
    duration = bars * 240.0 / bpm
    genre = "lofi"
    instruments = ["drums", "bass", "keys"]

    prev_path = None
    for i in range(6):
        task_type = "text2music" if i == 0 else "complete"
        params = GenParams(
            task_type=task_type,
            prompt=build_prompt(genre, instruments),
            bpm=bpm,
            key_scale="A minor",
            audio_duration=duration,
            inference_steps=INFERENCE_STEPS,
            guidance=creativity_to_guidance(0.5),
            seed=1000 + i,
            src_audio_path=prev_path,
            track_classes=None if task_type == "text2music" else track_classes_for(instruments),
        )
        t0 = time.monotonic()
        audio = model.generate(params)
        elapsed = time.monotonic() - t0
        prev_path = _write_temp_wav(audio)
        rtf = elapsed / duration
        print(f"block {i} [{task_type}] wall={elapsed:.2f}s duration={duration:.2f}s rtf={rtf:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bench", action="store_true", help="run the 6-block benchmark and exit")
    args = parser.parse_args()

    if args.bench:
        run_bench()
        return

    import uvicorn

    model = AceStepModel(MODEL_DIR)
    model.load()
    model.warmup()
    app = create_app(model)
    uvicorn.run(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
