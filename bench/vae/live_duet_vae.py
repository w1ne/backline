"""
Experimental companion #2: a phrase-level VAE instead of an autoregressive
transformer (bench/amt).

Where bench/amt's companion plays *simultaneously* with the human, hiding
inference latency behind a lookahead/commit buffer, this one plays
*call-and-response*: it listens to a phrase, then answers with a decoded
one. That's not a limitation worked around -- it's the natural shape of a
phrase-to-phrase VAE, which has no notion of "continue this token stream."

Because decoding is a single forward pass (no token-by-token loop), there is
no scheduling problem here at all: the response is ready enormously faster
than the phrase that triggered it took to play. The tradeoff is model
crudeness, not latency -- see phrase_vae.py's docstring and this bench's
README for what's actually lost (rhythm, harmony awareness, arbitrary-length
generation) to get that.

Output: a MIDI file (plain mido, no dependency on bench/amt's anticipation
package) and a WAV rendered with a simple synth so you can listen without a
MIDI player.
"""

import argparse
import random
import time
from pathlib import Path

import mido
import musicpy as mp
import torch

from phrase_vae import PhraseVAE, train, PHRASE_LEN, N_DEGREES
from synth import render as render_audio

MELODY_PROGRAM = 0    # GM acoustic grand piano -- the live performer
COMPANION_PROGRAM = 11  # GM vibraphone -- the VAE's voice
COMPANION_OCTAVE_SHIFT = 12  # put the response an octave above the melody


def make_synthetic_melody(key="C", mode="major", n_notes=32, beat_s=0.6, seed=0):
    """Same random-walk-with-cadence shape as bench/amt/melody.py, duplicated
    (not imported) so this bench stays self-contained. Returns
    (onset_s, dur_s, degree, pitch) so the degree is available for the VAE
    without re-deriving it from the MIDI pitch."""
    rng = random.Random(seed)
    scale_pitches = [n.degree for n in mp.scale(key, mode).notes]  # 8 notes, one octave

    durations_beats = [1.0, 1.0, 0.5, 0.5, 1.5]
    steps = [-2, -1, -1, 0, 1, 1, 1, 2]

    degree, t = 0, 0.0
    events = []
    for i in range(n_notes):
        degree = 0 if i % 8 == 7 else max(0, min(N_DEGREES - 1, degree + rng.choice(steps)))
        dur_s = rng.choice(durations_beats) * beat_s
        events.append((t, dur_s * 0.9, degree, scale_pitches[degree]))
        t += dur_s
    return events, t, scale_pitches


def run_live(model, melody, melody_len_s, scale_pitches, temperature, log):
    """Real wall-clock call-and-response loop. Returns `played`: a list of
    (onset_s, dur_s, role, pitch) covering everything actually decided,
    role in {'melody', 'companion'}."""
    t0 = time.monotonic()
    revealed = []          # (onset_s, dur_s, degree, pitch) melody notes seen so far
    melody_idx = 0
    consumed = 0            # revealed[:consumed] has already triggered a response
    companion_next_start = 0.0
    played = []

    while True:
        playhead = time.monotonic() - t0
        if melody_idx >= len(melody) and playhead > melody_len_s + 1.0:
            break

        while melody_idx < len(melody) and melody[melody_idx][0] <= playhead:
            onset_s, dur_s, degree, pitch = melody[melody_idx]
            revealed.append((onset_s, dur_s, degree, pitch))
            played.append((onset_s, dur_s, "melody", pitch))
            log(f"[{playhead:6.2f}s] YOU       pitch={pitch:3d} dur={dur_s:4.2f}s")
            melody_idx += 1

        if len(revealed) - consumed >= PHRASE_LEN:
            phrase = revealed[consumed:consumed + PHRASE_LEN]
            consumed += PHRASE_LEN

            degrees = torch.tensor([[d for _, _, d, _ in phrase]], dtype=torch.long)
            wall_start = time.monotonic()
            with torch.no_grad():
                mu, logvar = model.encode(degrees)
                z = model.reparameterize(mu, logvar, temperature=temperature)
                _, response = model.decode(z, sample=True)
            wall_dt = time.monotonic() - wall_start

            response_start = max(playhead, companion_next_start, phrase[-1][0] + phrase[-1][1])
            t = response_start
            for (_, dur_s, _, _), degree in zip(phrase, response[0].tolist()):
                pitch = scale_pitches[degree] + COMPANION_OCTAVE_SHIFT
                played.append((t, dur_s * 0.9, "companion", pitch))
                t += dur_s
            companion_next_start = t

            log(f"[{playhead:6.2f}s] VAE responds to phrase {consumed//PHRASE_LEN} "
                f"in {wall_dt*1000:.1f}ms: degrees {[d for _,_,d,_ in phrase]} -> {response[0].tolist()}")

        time.sleep(0.02)

    return played


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bpm", type=float, default=80.0)
    ap.add_argument("--key", default="C")
    ap.add_argument("--mode", default="major")
    ap.add_argument("--notes", type=int, default=32, help="length of the synthetic melody")
    ap.add_argument("--seed", type=int, default=0, help="melody seed")
    ap.add_argument("--train-seed", type=int, default=0, help="VAE training-data seed")
    ap.add_argument("--temperature", type=float, default=1.5,
                     help="latent sampling temperature: 1.0 is standard VAE sampling, "
                          "higher pushes further from a literal echo of the input phrase "
                          "into more of what the model has learned about phrase shapes "
                          "in general -- more \"experimental\", less call-and-response")
    ap.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent.parent / "output"))
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    print("training the phrase VAE (a few thousand synthetic phrases, ~20s on CPU) ...")
    train_start = time.monotonic()
    model = train(seed=args.train_seed, quiet=True)
    model.eval()
    print(f"trained in {time.monotonic() - train_start:.1f}s")

    beat_s = 60.0 / args.bpm
    melody, melody_len_s, scale_pitches = make_synthetic_melody(
        key=args.key, mode=args.mode, n_notes=args.notes, beat_s=beat_s, seed=args.seed,
    )
    print(f"synthetic melody: {len(melody)} notes, {melody_len_s:.1f}s @ {args.bpm} bpm "
          f"({args.key} {args.mode}, seed={args.seed})")
    print(f"companion: call-and-response every {PHRASE_LEN} notes, temperature={args.temperature}")
    print("--- live performance starts now (real wall-clock time) ---")

    played = run_live(model, melody, melody_len_s, scale_pitches, args.temperature, print)

    print("--- live performance ended ---")

    midi_path = outdir / "live_duet_vae.mid"
    _write_midi(played, args.bpm, midi_path)
    print(f"wrote {midi_path}")

    wav_path = outdir / "live_duet_vae.wav"
    render_audio(played, melody_len_s + 4.0, str(wav_path))
    print(f"wrote {wav_path}")


def _write_midi(played, bpm, path):
    mid = mido.MidiFile()
    tempo = mido.bpm2tempo(bpm)
    for channel, (role, program) in enumerate((("melody", MELODY_PROGRAM), ("companion", COMPANION_PROGRAM))):
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
        track.append(mido.Message("program_change", channel=channel, program=program, time=0))

        notes = sorted((onset_s, dur_s, pitch) for onset_s, dur_s, r, pitch in played if r == role)
        ticks_per_beat = mid.ticks_per_beat
        prev_tick = 0
        events = []  # (tick, type, pitch)
        for onset_s, dur_s, pitch in notes:
            beat = onset_s * bpm / 60.0
            on_tick = round(beat * ticks_per_beat)
            off_tick = round((beat + dur_s * bpm / 60.0) * ticks_per_beat)
            events.append((on_tick, "on", pitch))
            events.append((max(off_tick, on_tick + 1), "off", pitch))
        events.sort(key=lambda e: (e[0], e[1] == "on"))  # note-offs before note-ons at same tick

        for tick, kind, pitch in events:
            delta = max(0, tick - prev_tick)
            prev_tick = tick
            if kind == "on":
                track.append(mido.Message("note_on", channel=channel, note=pitch, velocity=80, time=delta))
            else:
                track.append(mido.Message("note_off", channel=channel, note=pitch, velocity=0, time=delta))

    mid.save(str(path))


if __name__ == "__main__":
    main()
