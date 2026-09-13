"""
Reference tempo trackers on the same stitched songs, for the ceiling: librosa (beat_track and
the autocorrelation tempogram), madmom (TempoEstimationProcessor and DBNBeatTracker), and
Essentia's RhythmExtractor2013 when importable. Each runs on the first `--seconds` of the voice
channel and, as a sanity check that the library works on normal music, on the full backing
track. Reads the WAVs bench/tempo/run.ts writes under bench/tempo/out/wav/, writes
bench/tempo/out/libs.json. Run from the venv under bench/tempo/.venv.
"""
import argparse
import json
import os
import sys
import time
import warnings

import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
WAV_DIR = os.path.join(HERE, "out", "wav")
OUT = os.path.join(HERE, "out", "libs.json")


def load(path, seconds=None):
    y, sr = sf.read(path, dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y[:, 0]
    if seconds:
        y = y[: int(seconds * sr)]
    return y, sr


def librosa_methods(y, sr):
    import librosa
    out = {}
    t = time.time()
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr, start_bpm=100.0)
    out["librosa.beat_track"] = {"bpm": float(np.atleast_1d(tempo)[0]), "ms": (time.time() - t) * 1000}
    t = time.time()
    oenv = librosa.onset.onset_strength(y=y, sr=sr)
    tg = librosa.feature.tempogram(onset_envelope=oenv, sr=sr)
    ac_global = np.mean(tg, axis=1)
    bpms = librosa.tempo_frequencies(tg.shape[0], sr=sr)
    prior = np.exp(-0.5 * ((np.log2(np.maximum(bpms, 1e-9) / 100.0)) / 0.5) ** 2)
    mask = (bpms >= 60) & (bpms <= 180)
    best = np.argmax(np.where(mask, ac_global * prior, -1))
    out["librosa.tempogram"] = {"bpm": float(bpms[best]), "ms": (time.time() - t) * 1000}
    return out


def madmom_methods(path, seconds):
    try:
        import madmom
        from madmom.features.beats import RNNBeatProcessor, DBNBeatTrackingProcessor
        from madmom.features.tempo import TempoEstimationProcessor
    except Exception as e:  # noqa: BLE001
        return {"madmom": {"error": str(e)[:200]}}
    out = {}
    try:
        y, sr = load(path, seconds)
        sig = madmom.audio.signal.Signal(y, sample_rate=sr, num_channels=1)
        t = time.time()
        act = RNNBeatProcessor()(sig)
        tempi = TempoEstimationProcessor(fps=100, min_bpm=60, max_bpm=180)(act)
        out["madmom.TempoEstimation"] = {"bpm": float(tempi[0][0]), "ms": (time.time() - t) * 1000}
        t = time.time()
        beats = DBNBeatTrackingProcessor(fps=100, min_bpm=60, max_bpm=180)(act)
        if len(beats) >= 3:
            out["madmom.DBNBeatTracker"] = {"bpm": float(60.0 / np.median(np.diff(beats))), "ms": (time.time() - t) * 1000}
        else:
            out["madmom.DBNBeatTracker"] = {"error": "fewer than 3 beats"}
    except Exception as e:  # noqa: BLE001
        out["madmom"] = {"error": str(e)[:200]}
    return out


def essentia_methods(y, sr):
    try:
        import essentia.standard as es
    except Exception as e:  # noqa: BLE001
        return {"essentia.RhythmExtractor2013": {"error": str(e)[:200]}}
    try:
        t = time.time()
        y44 = es.Resample(inputSampleRate=sr, outputSampleRate=44100)(y) if sr != 44100 else y
        bpm, _beats, conf, _, _ = es.RhythmExtractor2013(method="multifeature", minTempo=60, maxTempo=180)(y44)
        return {"essentia.RhythmExtractor2013": {"bpm": float(bpm), "confidence": float(conf), "ms": (time.time() - t) * 1000}}
    except Exception as e:  # noqa: BLE001
        return {"essentia.RhythmExtractor2013": {"error": str(e)[:200]}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=12.0, help="voice decision window")
    args = ap.parse_args()
    names = sorted({f[:-10] for f in os.listdir(WAV_DIR) if f.endswith(".voice.wav")})
    results = {}
    for i, name in enumerate(names):
        row = {}
        for which, seconds in (("voice", args.seconds), ("backing", None)):
            path = os.path.join(WAV_DIR, f"{name}.{which}.wav")
            y, sr = load(path, seconds)
            r = {}
            r.update(librosa_methods(y, sr))
            r.update(madmom_methods(path, seconds))
            r.update(essentia_methods(y, sr))
            row[which] = r
        results[name] = row
        print(f"{i + 1}/{len(names)} {name}", {k: round(v.get('bpm', 0)) for k, v in row['voice'].items()}, file=sys.stderr)
    with open(OUT, "w") as f:
        json.dump({"seconds": args.seconds, "songs": results}, f, indent=1)


if __name__ == "__main__":
    main()
