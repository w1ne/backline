"""
Minimal additive synth for rendering a recorded performance to a WAV file.
Has nothing to do with the VAE -- it just turns a list of
(onset_s, dur_s, role, pitch) events into something you can listen to.
"""

import numpy as np

SR = 44100


def midi_to_hz(pitch):
    return 440.0 * 2 ** ((pitch - 69) / 12.0)


def _adsr(n, sr, attack=0.01, release=0.08):
    env = np.ones(n)
    a = min(int(attack * sr), n // 2)
    r = min(int(release * sr), n // 2)
    if a > 0:
        env[:a] = np.linspace(0.0, 1.0, a)
    if r > 0:
        env[-r:] *= np.linspace(1.0, 0.0, r)
    return env


def render_voice(pitch, dur_s, timbre, sr=SR):
    n = max(int(dur_s * sr), 1)
    t = np.arange(n) / sr
    f = midi_to_hz(pitch)
    if timbre == "melody":
        wave = (
            1.00 * np.sin(2 * np.pi * f * t)
            + 0.35 * np.sin(2 * np.pi * 2 * f * t)
            + 0.15 * np.sin(2 * np.pi * 3 * f * t)
        )
        wave *= np.exp(-t * 3.0)
    else:
        # bell-ish companion voice (vibraphone-adjacent): mostly the
        # fundamental plus a slightly-detuned partner, slow decay
        wave = (
            1.00 * np.sin(2 * np.pi * f * t)
            + 0.4 * np.sin(2 * np.pi * 2.01 * f * t)
        )
        wave *= np.exp(-t * 1.2)
    wave *= _adsr(n, sr)
    return wave


def render(events, total_len_s, path, sr=SR):
    """events: list of (onset_s, dur_s, role, pitch), role in {'melody','companion'}"""
    n_total = int((total_len_s + 2.0) * sr)
    buf = np.zeros(n_total, dtype=np.float64)
    for onset_s, dur_s, role, pitch in events:
        voice = render_voice(pitch, max(dur_s, 0.05), role, sr=sr)
        start = int(onset_s * sr)
        end = min(start + len(voice), n_total)
        if end > start:
            buf[start:end] += voice[: end - start] * (0.5 if role == "melody" else 0.4)

    peak = np.max(np.abs(buf)) if buf.size else 0.0
    if peak > 1e-6:
        buf = buf / peak * 0.9

    import soundfile as sf

    sf.write(path, buf.astype(np.float32), sr)
