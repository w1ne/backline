"""ACE-Step block-generation service for Backline.

Loads ACE-Step 1.5 once at process start and serves 2-bar (configurable)
audio blocks over a WebSocket, quantized to the caller's bpm/key so a
browser band can be assembled from consecutive blocks.

Reaches ACE-Step by driving the bundled HTTP API (`uv run acestep-api`,
entry point `acestep.api_server:main`) as a subprocess, using
`POST /release_task` + `POST /query_result`. This was verified end-to-end
against the ACE-Step 1.5 repo at commit
ca1e85fe9430179831e6bc6be790c332190a3866 on an A40 GPU.

An in-process path (calling `acestep.handler.AceStepHandler` /
`acestep.inference.generate_music` directly) was evaluated and rejected:
`AceStepHandler()` takes no constructor args and needs a separate
`LLMHandler` plus manual `initialize_service()` wiring; `generate_music`
requires *both* handlers plus a `GenerationConfig` (batch size / seeds /
output format); `GenerationParams` uses different field names than the
HTTP request (`caption` not `prompt`, `keyscale` not `key_scale`,
`duration` not `audio_duration`, `src_audio` not `src_audio_path`); and
`track_classes` isn't a `GenerationParams` field at all -- it's rendered
into the `instruction` prompt text by
`acestep/api/job_generation_setup.py::_resolve_instruction` before ever
reaching `generate_music`. Reimplementing that translation layer
in-process would just be a worse copy of `acestep/api_server.py`, so the
HTTP subprocess is the only generation path.

Env vars:
  PORT           -- listen port (default 8080)
  ACE_MODEL_DIR  -- where ACE-Step should look for / cache weights (passed
                    through as ACESTEP_MODEL_DIR isn't a real ACE-Step env
                    var; weights live under <ace repo>/checkpoints and are
                    downloaded on first use -- see README)
"""

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
ACE_REPO_DIR = os.environ.get("ACE_REPO_DIR", "/opt/ace-step")
# DiT checkpoint folder under ACESTEP_CHECKPOINTS_DIR. The 4B XL-turbo renders a
# 4.8 s block in ~1.2 s on an L40S (the 2B turbo took ~1.6 s) with clearly better
# fidelity, so it is the default. Weights on the pod are a bf16 conversion of the
# 20 GB fp32 HF repo (services/acestep/README.md).
DIT_MODEL = os.environ.get("ACE_DIT_MODEL", "acestep-v15-xl-turbo")
MODEL_OUTPUT_SR = 44100  # ACE-Step 1.5 renders at 44.1 kHz; we resample to 48 kHz for the client.
TARGET_SR = 48000
INFERENCE_STEPS = 8
# Block engine v2 (feature flag, off by default until A/B-tested by ear):
#  - every request spans at least MIN_GEN_SECONDS: ACE-Step's documented minimum is
#    10 s (constants.DURATION_MIN) and the model was never trained on our ~7 s canvases.
#    The extra tail is repainted with the block and discarded;
#  - up to CONTEXT_MAX_SECONDS of already-played audio is kept as repaint context
#    instead of a single bar, so the model hears the groove it is continuing;
#  - one seed per session instead of a new one per block, and an explicit
#    instrumental lyric so the model stops hallucinating vocal-like material.
BLOCK_V2 = os.environ.get("ACE_BLOCK_V2", "0").lower() in ("1", "true", "yes")
MIN_GEN_SECONDS = float(os.environ.get("ACE_MIN_GEN_SECONDS", "15"))
CONTEXT_MAX_SECONDS = float(os.environ.get("ACE_CONTEXT_MAX_SECONDS", "12"))
# Song mode (feature flag, off by default; implies the v2 canvas/context/seed rules): the
# first block renders a whole SONG_SEGMENT_BARS segment in one pass (XL: ~2 s for a
# minute of audio), later blocks are sliced from it and paced one block ahead of
# playback, and when the segment runs out the next one is repainted with the last
# CONTEXT_MAX_SECONDS as context. One coherent arrangement instead of a new 2-bar idea
# every request; the client protocol (2-bar blocks) is unchanged.
SONG_MODE = os.environ.get("ACE_SONG_MODE", "0").lower() in ("1", "true", "yes")
SONG_SEGMENT_BARS = int(os.environ.get("ACE_SONG_SEGMENT_BARS", "16"))
# how far ahead of the block's due time a sliced block may be sent (gives the client
# a buffer to ride out a 2-5 s re-render)
SONG_PACE_LEAD_SECONDS = 3.0
# tempo drift below this fraction does not restart the song (the client cuts and resyncs
# to the new grid; the current segment keeps playing at its old tempo until it runs out)
SONG_BPM_RESTART_FRACTION = 0.10
# Voice-following: the client streams its mic as 16 kHz mono PCM16 frames prefixed with
# HUM_MAGIC. Once a full segment of singing has been heard, the next segment is rendered
# with ACE-Step's `cover` task on that audio, which keeps the sung melody, harmony and
# groove and re-voices them as the band (strength 0.6 measured: chroma corr 0.31 vs 0.03
# for text-only; 0.3 did nothing).
SONG_COVER = os.environ.get("ACE_SONG_COVER", "1").lower() in ("1", "true", "yes")
COVER_STRENGTH = float(os.environ.get("ACE_COVER_STRENGTH", "0.6"))
# Creativity slider -> how tightly the band follows the voice: low creativity clings to the
# sung melody, high creativity reinterprets it. Kept inside the range that measurably
# followed (0.3 did nothing).
COVER_STRENGTH_TIGHT = 0.75
COVER_STRENGTH_LOOSE = 0.45


def creativity_to_cover_strength(creativity: float) -> float:
    c = max(0.0, min(1.0, creativity))
    return round(COVER_STRENGTH_TIGHT - c * (COVER_STRENGTH_TIGHT - COVER_STRENGTH_LOOSE), 3)
HUM_SR = 16000
HUM_MAGIC = b"MIC0"
HUM_MAX_SECONDS = 120.0
if SONG_MODE:
    BLOCK_V2 = True
# Point at an already-running acestep-api instead of spawning one (lets a flagged test
# instance share the GPU model with the live service).
ACE_HTTP_BASE = os.environ.get("ACE_HTTP_BASE")
# Block source wavs go to RAM: a full container disk broke tempfile lookup on the pod
# (1.5 TB RAM there). Must be set before the first tempfile call, and acestep-api
# validates src_audio_path against *its* tempfile.gettempdir(), so it inherits this.
if os.path.isdir("/dev/shm") and "TMPDIR" not in os.environ:
    os.environ["TMPDIR"] = "/dev/shm"
# Chords named in the prompt; more than a bar or two of history just dilutes it.
CHORD_PROMPT_MAX = 4

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
    "lead": "electric guitar lead",
}
# the accompaniment tiles, as prompt colours
EXTRA_WORDS = {
    "sax": "saxophone",
    "strings": "string section",
    "orchestral": "orchestral ensemble, harp",
    "ambient": "ambient pads, flute",
}


def density_words(density: float) -> str:
    # How full the band should sound, as prompt text. ACE-Step has no density control, so
    # this is the only lever the block request has on how busy the band sounds. The client
    # sends `density` (busy player -> ~1, space -> 0); a busy player wants the band to lay
    # back and leave room, a quiet player wants it to fill out.
    density = max(0.0, min(1.0, density))
    if density > 0.6:
        return "sparse, laid back, leave space"
    if density < 0.3:
        return "restrained accompaniment, leave space between phrases"
    return "medium"


# Back-compat alias: older callers referred to this as intensity_words.
intensity_words = density_words


def audible_instruments(instruments: list[str], exclude: Optional[str] = None, space: bool = True) -> list[str]:
    # The lead answers the player rather than playing over them: it is only prompted for
    # while the player has left space.
    return [i for i in instruments if i != exclude and (space or i != "lead")]


def build_prompt(
    genre: str,
    instruments: list[str],
    exclude: Optional[str] = None,
    chords: Optional[list[str]] = None,
    intensity: float = 0.5,
    space: bool = True,
    density: Optional[float] = None,
    fill: bool = False,
    extras: Optional[list[str]] = None,
) -> str:
    genre_text = GENRE_PROMPTS.get(genre, GENRE_PROMPTS["lofi"])
    # The client already chose the instrument set from the player's activity; when it marks a
    # FILL block, keep the lead in regardless of the space gate so the answer is audible.
    words = [
        INSTRUMENT_WORDS.get(i, i)
        for i in audible_instruments(instruments, exclude, space or fill)
    ]
    # density defaults to intensity for callers that only pass intensity (e.g. warmup).
    d = intensity if density is None else density
    parts = [genre_text, "cohesive backing for a live melody, steady recurring groove", density_words(d)]
    if fill and INSTRUMENT_WORDS["lead"] in words:
        parts.append("one brief guitar answer in the melody's gap, then leave space")
    for e in extras or []:
        if e in EXTRA_WORDS and EXTRA_WORDS[e] not in words:
            words.append(EXTRA_WORDS[e])
    if words:
        parts.append(", ".join(words))
    if chords:
        # ACE-Step 1.5 has no structured harmony input beyond `key_scale` (one key per
        # generation), so the chords the player is outlining can only reach the model as
        # prompt text. It is a nudge, not a constraint -- the model is free to ignore it.
        parts.append("chord progression: " + " ".join(chords[-CHORD_PROMPT_MAX:]))
    has_lead = INSTRUMENT_WORDS["lead"] in words
    parts.append("instrumental, no vocals" if has_lead else "instrumental, no vocals, no guitar")
    return ", ".join(parts)


def track_classes_for(
    instruments: list[str], exclude: Optional[str] = None, space: bool = True, fill: bool = False
) -> list[str]:
    # On a FILL block keep the lead in the track_classes even without space, so the answering
    # guitar actually renders; on busy blocks the client has already dropped it.
    return [INSTRUMENT_WORDS.get(i, i) for i in audible_instruments(instruments, exclude, space or fill)]


def creativity_to_guidance(creativity: float) -> float:
    # ACE-Step's guidance_scale is typically in the ~3-15 range; higher creativity ->
    # lower guidance (looser adherence to the prompt, more variation).
    creativity = max(0.0, min(1.0, creativity))
    return 15.0 - creativity * 10.0


def density_to_guidance(creativity: float, density: float) -> float:
    # Start from the creativity-driven guidance, then nudge with density: a busy player (high
    # density) wants the band to lay back, so loosen guidance slightly (lower) to keep it out of
    # the way; a quiet player (low density, fills) wants a committed answer, so tighten it a
    # little. The nudge is small (+-1.5) so creativity stays the dominant control.
    base = creativity_to_guidance(creativity)
    density = max(0.0, min(1.0, density))
    return max(1.0, base + (0.5 - density) * 3.0)


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


def _local_path_from_audio_url(file_url: str) -> str:
    """"/v1/audio?path=%2Fworkspace%2F..." -> "/workspace/...". The
    acestep-api subprocess and this process share a filesystem (same
    container), so the file is read directly instead of over HTTP."""
    from urllib.parse import urlparse, parse_qs, unquote

    parsed = urlparse(file_url)
    qs = parse_qs(parsed.query)
    path = qs.get("path", [None])[0]
    if not path:
        raise RuntimeError(f"could not parse local path out of audio url: {file_url}")
    return unquote(path)


def float_to_pcm16(audio: np.ndarray) -> bytes:
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


@dataclass
class GenParams:
    task_type: str  # 'text2music' | 'repaint'
    prompt: str
    bpm: int
    key_scale: str
    audio_duration: float
    inference_steps: int
    guidance: float
    seed: int
    lyrics: Optional[str] = None
    audio_cover_strength: Optional[float] = None
    src_audio_path: Optional[str] = None
    track_classes: Optional[list[str]] = None
    repainting_start: Optional[float] = None
    repainting_end: Optional[float] = None


class AceStepModel:
    """Drives the bundled ACE-Step HTTP API as a subprocess.

    Note: RunPod's own nginx already listens on port 8001 (the port the
    acestep-api CLI defaults to), so this binds the subprocess to 8010
    instead -- confirmed by hitting a real pod (see README).
    """

    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self._http_proc: Optional[subprocess.Popen] = None
        self._http_base = ACE_HTTP_BASE or "http://127.0.0.1:8010"

    def load(self) -> None:
        if ACE_HTTP_BASE:
            log.info("reusing acestep-api at %s", ACE_HTTP_BASE)
            return
        self._start_http_server()

    def _start_http_server(self) -> None:
        # The real env var (acestep/model_downloader.py:get_checkpoints_dir)
        # is ACESTEP_CHECKPOINTS_DIR, not ACE_MODEL_DIR/ACESTEP_MODEL_DIR --
        # the original draft used a made-up name that ACE-Step never reads,
        # so ACE_MODEL_DIR silently had no effect and weights always went to
        # the default <ace repo>/checkpoints.
        env = dict(os.environ)
        env.setdefault("ACESTEP_CHECKPOINTS_DIR", self.model_dir)
        env.setdefault("ACESTEP_CONFIG_PATH", DIT_MODEL)
        # No 5Hz LM: it only rewrote the caption (bpm/key come from the player),
        # cost ~2 s of every block, and on a big GPU acestep-api auto-downloads
        # the 8 GB lm-4B for it -- which filled the 40 GB pod disk to 100%.
        env.setdefault("ACESTEP_INIT_LLM", "false")
        # acestep-api only accepts src/reference audio paths inside ITS temp dir, so the
        # subprocess must inherit exactly the TMPDIR this process writes block wavs to
        # (set process-wide at import below).
        # Invoke the venv's acestep-api binary directly rather than "uv run
        # acestep-api": "uv run" re-syncs the environment against
        # pyproject.toml/uv.lock on every invocation, which silently reverts
        # any manual uvicorn/websockets version pin applied to this shared
        # .venv (see README -- this was the actual cause of the /ws 403,
        # not a uvicorn/websockets/starlette version mismatch).
        acestep_bin = os.path.join(ACE_REPO_DIR, ".venv", "bin", "acestep-api")
        self._http_proc = subprocess.Popen(
            [acestep_bin, "--host", "127.0.0.1", "--port", "8010"],
            cwd=ACE_REPO_DIR,
            env=env,
        )
        import urllib.request

        deadline = time.time() + 600
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"{self._http_base}/health", timeout=2)
                log.info("acestep-api subprocess healthy")
                return
            except Exception:
                if self._http_proc.poll() is not None:
                    raise RuntimeError("acestep-api subprocess exited during startup")
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
        return self._generate_http(params)

    def _generate_http(self, params: GenParams) -> np.ndarray:
        # Field names below match acestep/api/http/release_task_param_parser.py's
        # PARAM_ALIASES exactly (verified against the real /release_task route):
        # "prompt", "key_scale", "audio_duration", "guidance_scale" (NOT
        # "guidance" -- the original draft used the wrong key and every
        # request would silently fall back to the request model's guidance_scale
        # default of 7.0), "src_audio_path", "track_classes". audio_format=wav
        # avoids mp3 lossy round-tripping and skips an extra ffmpeg decode.
        # batch_size=1 avoids generating (and paying for) 2 candidates per
        # block -- the server's own default is 2.
        body = {
            "task_type": params.task_type,
            "prompt": params.prompt,
            "bpm": params.bpm,
            "key_scale": params.key_scale,
            "audio_duration": params.audio_duration,
            "inference_steps": params.inference_steps,
            "guidance_scale": params.guidance,
            "seed": params.seed,
            "use_random_seed": False,
            "batch_size": 1,
            "audio_format": "wav",
        }
        if params.lyrics is not None:
            body["lyrics"] = params.lyrics
        if params.audio_cover_strength is not None:
            body["audio_cover_strength"] = params.audio_cover_strength
        if params.src_audio_path:
            body["src_audio_path"] = params.src_audio_path
        if params.track_classes:
            body["track_classes"] = params.track_classes
        if params.task_type == "repaint":
            body.update(repainting_start=params.repainting_start,
                        repainting_end=params.repainting_end, chunk_mask_mode="explicit")

        import urllib.request

        req = urllib.request.Request(
            f"{self._http_base}/release_task",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            release = json.loads(resp.read())
        task_id = release["data"]["task_id"]

        # /query_result's actual response shape (verified live):
        # {"data": [{"task_id", "status": 0|1|2, "result": <JSON-encoded
        # list of per-candidate dicts>, "progress_text"}]}. status 1 =
        # succeeded, 2 = failed, 0 = queued/running. Each candidate's
        # "file" is "/v1/audio?path=<urlencoded local path>" -- since this
        # process runs on the same host as the acestep-api subprocess, the
        # local path is decoded and read directly instead of round-tripping
        # over HTTP.
        deadline = time.time() + 300
        out_path = None
        while time.time() < deadline:
            q = urllib.request.Request(
                f"{self._http_base}/query_result",
                data=json.dumps({"task_id_list": [task_id]}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(q, timeout=30) as resp:
                envelope = json.loads(resp.read())
            entries = envelope.get("data") or []
            entry = next((e for e in entries if e.get("task_id") == task_id), None)
            if entry is None:
                raise RuntimeError(f"ACE-Step task {task_id} missing from query_result response")
            status = entry.get("status")
            if status == 2:
                raise RuntimeError(f"ACE-Step task {task_id} failed: {entry.get('progress_text')}")
            if status == 1:
                candidates = json.loads(entry["result"])
                if not candidates or not candidates[0].get("file"):
                    raise RuntimeError(f"ACE-Step task {task_id} succeeded with no audio file")
                out_path = _local_path_from_audio_url(candidates[0]["file"])
                break
            time.sleep(0.1)
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
        self.prev_audio: Optional[np.ndarray] = None
        self._task: Optional[asyncio.Task] = None
        self._latest_seq = -1
        self.seed: Optional[int] = None
        # song mode: the pre-rendered segment being sliced, the read position, and the
        # wall-clock moment its first block was due (for pacing).
        self.song: Optional[np.ndarray] = None
        self.song_pos = 0
        self.song_t0 = 0.0
        self.song_blocks_served = 0
        # what the current segment was rendered with; a change re-renders at the next block
        self.song_prompt_key: Optional[tuple] = None
        # the player's voice, 16 kHz mono float32, most recent HUM_MAX_SECONDS
        self.hum = np.zeros(0, dtype=np.float32)

    def ingest_audio(self, data: bytes) -> None:
        if not data.startswith(HUM_MAGIC):
            return
        pcm = np.frombuffer(data[len(HUM_MAGIC):], dtype="<i2").astype(np.float32) / 32768.0
        keep = int(HUM_MAX_SECONDS * HUM_SR)
        self.hum = np.concatenate([self.hum, pcm])[-keep:]

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
        chords = [str(c) for c in (msg.get("chords") or [])]
        intensity = float(msg.get("intensity", 0.5))
        space = bool(msg.get("space", True))
        fill = bool(msg.get("fill", False))
        density = float(msg.get("density", intensity))

        duration = bars * 240.0 / bpm
        needs_restart = bpm != self.last_bpm or key != self.last_key or self.prev_audio is None
        if SONG_MODE:
            drift = abs(bpm - (self.last_bpm or bpm)) / max(1, self.last_bpm or bpm)
            song_restart = key != self.last_key or self.prev_audio is None or drift > SONG_BPM_RESTART_FRACTION
            await self._run_song_block(msg, seq, bpm, key, duration, song_restart, send_binary, send_json)
            return
        # `complete` adds tracks over source audio. Feeding its mix back repeatedly layers
        # instruments over the same passage. Instead preserve one bar of context and repaint
        # a NEW, silent two-bar interval; send only that new interval to the browser.
        task_type = "text2music" if needs_restart else "repaint"
        context_samples = 0
        source_path = None
        target_samples = round(duration * TARGET_SR)
        # v2 repaints a longer silent tail than we keep, so the model always works on a
        # canvas of at least MIN_GEN_SECONDS; the surplus is discarded below.
        tail_samples = 0
        if BLOCK_V2:
            context_seconds = CONTEXT_MAX_SECONDS
        else:
            context_seconds = 240.0 / bpm
        if not needs_restart:
            context = self.prev_audio[-round(context_seconds * TARGET_SR):]
            context_samples = len(context)
        if BLOCK_V2:
            tail_samples = max(0, round(MIN_GEN_SECONDS * TARGET_SR) - context_samples - target_samples)
        if not needs_restart:
            source_path = _write_temp_wav(np.concatenate([
                context, np.zeros((target_samples + tail_samples, 2), dtype=np.float32),
            ]))
        context_duration = context_samples / TARGET_SR
        tail_duration = tail_samples / TARGET_SR
        if BLOCK_V2:
            if needs_restart or self.seed is None:
                self.seed = creativity_to_seed(creativity, 0)
            seed = self.seed
        else:
            seed = creativity_to_seed(creativity, seq)
        prompt = build_prompt(
            genre,
            instruments,
            exclude=player_instrument,
            chords=chords,
            intensity=intensity,
            space=space,
            density=density,
            fill=fill,
        )

        params = GenParams(
            task_type=task_type,
            prompt=prompt,
            bpm=bpm,
            key_scale=key,
            audio_duration=context_duration + duration + tail_duration,
            inference_steps=INFERENCE_STEPS,
            guidance=density_to_guidance(creativity, density),
            seed=seed,
            src_audio_path=source_path,
            repainting_start=context_duration if source_path else None,
            repainting_end=context_duration + duration + tail_duration if source_path else None,
            lyrics="[Instrumental]" if BLOCK_V2 else None,
        )

        loop = asyncio.get_running_loop()
        t0 = time.monotonic()
        # Keep the source file alive until the worker is finished, including when this
        # coroutine is cancelled by a disconnected client.
        def generate():
            try:
                return self.model.generate(params)
            finally:
                if source_path:
                    try:
                        os.unlink(source_path)
                    except FileNotFoundError:
                        pass

        audio = await loop.run_in_executor(None, generate)
        audio = audio[context_samples:context_samples + target_samples]
        if len(audio) != target_samples:
            raise RuntimeError("ACE returned a shorter block than the requested continuation window")
        elapsed_ms = (time.monotonic() - t0) * 1000.0

        if seq != self._latest_seq:
            return  # superseded while generating

        self.last_bpm = bpm
        self.last_key = key
        if BLOCK_V2 and self.prev_audio is not None:
            keep = round(CONTEXT_MAX_SECONDS * TARGET_SR)
            self.prev_audio = np.concatenate([self.prev_audio, audio])[-keep:]
        else:
            self.prev_audio = audio.copy()

        pcm = float_to_pcm16(audio)
        header = struct.pack("<I", seq)
        await send_binary(header + pcm)
        await send_json({"type": "done", "seq": seq, "ms": elapsed_ms})


async def pace_sleep(seconds: float) -> None:
    if seconds > 0:
        await asyncio.sleep(seconds)


async def _run_song_block(self: "Session", msg: dict, seq: int, bpm: int, key: str, duration: float,
                          needs_restart: bool, send_binary, send_json) -> None:
    target_samples = round(duration * TARGET_SR)
    t0 = time.monotonic()
    elapsed_ms = 0.0
    if needs_restart:
        self.song = None
        self.prev_audio = None
    # Song mode arranges for everything the user switched on ("enabled"); the per-block
    # dynamics-thinned "instruments" list would otherwise re-render the song every time the
    # player got busy or left space.
    instruments = msg.get("enabled") or msg.get("instruments", ["drums", "bass"])
    extras = [str(e) for e in (msg.get("extras") or [])]
    prompt_key = (msg.get("genre", "lofi"), tuple(sorted(instruments)), tuple(sorted(extras)), msg.get("player_instrument"))
    if self.song is not None and self.song_prompt_key is not None and prompt_key != self.song_prompt_key:
        # style or instrument switch: drop the rest of this segment and re-render from here,
        # continuing from what was already heard
        self.song = None
    if self.song is None or self.song_pos + target_samples > len(self.song):
        # render the next segment: text2music on a fresh start, otherwise a repaint that
        # continues the last CONTEXT_MAX_SECONDS of what the player already heard.
        segment = SONG_SEGMENT_BARS * 240.0 / bpm
        context_samples = 0
        source_path = None
        hum_needed = int(segment * HUM_SR)
        cover = SONG_COVER and len(self.hum) >= hum_needed
        if cover:
            # re-voice the last segment of singing as the band; no repaint context (cover
            # takes the whole canvas), continuity comes from the fixed seed + the voice itself
            source_path = _write_temp_wav(self.hum[-hum_needed:].reshape(-1, 1), HUM_SR)
        elif self.prev_audio is not None:
            context = self.prev_audio[-round(CONTEXT_MAX_SECONDS * TARGET_SR):]
            context_samples = len(context)
            source_path = _write_temp_wav(np.concatenate([
                context, np.zeros((round(segment * TARGET_SR), 2), dtype=np.float32),
            ]))
        context_duration = context_samples / TARGET_SR
        if self.seed is None or needs_restart:
            self.seed = creativity_to_seed(float(msg.get("creativity", 0.5)), 0)
        prompt = build_prompt(
            msg.get("genre", "lofi"), instruments, exclude=msg.get("player_instrument"),
            chords=[str(c) for c in (msg.get("chords") or [])],
            intensity=float(msg.get("intensity", 0.5)), space=True,
            density=float(msg.get("density", msg.get("intensity", 0.5))), fill=False,
            extras=extras,
        )
        task = "cover" if cover else ("text2music" if source_path is None else "repaint")
        params = GenParams(
            task_type=task,
            prompt=prompt, bpm=bpm, key_scale=key,
            audio_duration=context_duration + segment,
            inference_steps=INFERENCE_STEPS,
            guidance=density_to_guidance(float(msg.get("creativity", 0.5)), 0.5),
            seed=self.seed, src_audio_path=source_path,
            repainting_start=context_duration if task == "repaint" else None,
            repainting_end=context_duration + segment if task == "repaint" else None,
            lyrics="[Instrumental]",
            audio_cover_strength=creativity_to_cover_strength(float(msg.get("creativity", 0.5))) if cover else None,
        )
        loop = asyncio.get_running_loop()

        def generate():
            try:
                return self.model.generate(params)
            finally:
                if source_path:
                    try:
                        os.unlink(source_path)
                    except FileNotFoundError:
                        pass

        audio = await loop.run_in_executor(None, generate)
        audio = audio[context_samples:context_samples + round(segment * TARGET_SR)]
        if len(audio) < target_samples:
            raise RuntimeError("ACE returned a shorter segment than requested")
        if seq != self._latest_seq:
            return
        log.info("song segment: task=%s bars=%d bpm=%d key=%s hum=%.0fs render=%.0fms",
                 task, SONG_SEGMENT_BARS, bpm, key, len(self.hum) / HUM_SR, (time.monotonic() - t0) * 1000.0)
        self.song = audio
        self.song_prompt_key = prompt_key
        self.song_pos = 0
        self.song_t0 = time.monotonic()
        self.song_blocks_served = 0
        elapsed_ms = (time.monotonic() - t0) * 1000.0
    else:
        # pacing: block k of the segment is due k*duration after the segment's first block
        due = self.song_t0 + self.song_blocks_served * duration - SONG_PACE_LEAD_SECONDS
        await pace_sleep(due - time.monotonic())
        if seq != self._latest_seq:
            return

    block = self.song[self.song_pos:self.song_pos + target_samples]
    self.song_pos += target_samples
    self.song_blocks_served += 1
    self.last_bpm = bpm
    self.last_key = key
    keep = round(CONTEXT_MAX_SECONDS * TARGET_SR)
    self.prev_audio = block.copy() if self.prev_audio is None else np.concatenate([self.prev_audio, block])[-keep:]
    header = struct.pack("<I", seq)
    await send_binary(header + float_to_pcm16(block))
    await send_json({"type": "done", "seq": seq, "ms": elapsed_ms})


Session._run_song_block = _run_song_block


def _write_temp_wav(audio: np.ndarray, sr: int = TARGET_SR) -> str:
    import soundfile as sf
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".wav", prefix="acestep_block_")
    os.close(fd)
    sf.write(path, audio, sr, subtype="PCM_16")
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
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    raise WebSocketDisconnect(message.get("code", 1000))
                if message.get("bytes") is not None:
                    session.ingest_audio(message["bytes"])
                    continue
                raw = message.get("text") or ""
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
