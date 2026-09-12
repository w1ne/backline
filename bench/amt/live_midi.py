"""
Live AI duet partner, real MIDI keyboard version. Same scheduler as
live_duet.py (LiveDuet: lookahead/commit buffer, monophony, retry-on-silence,
solo/ensemble, mono/polyphonic) -- only the input and output are real
hardware instead of a synthetic melody and a MIDI file. See SETUP.md for
how to actually wire a keyboard and a synth up to this.

Run `python live_midi.py --list-ports` first to see what's available, then:

    python live_midi.py --midi-in "Your Keyboard" --midi-out "IAC Driver Bus 1"

Play. Press Ctrl+C to stop -- a MIDI file of the whole session (your
playing plus the companion's) is still written to --outdir on the way out,
same as live_duet.py.
"""

import argparse
import signal
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM

from anticipation import ops
from anticipation.convert import events_to_midi

from amt import MELODY_INSTR, SOLO_ACCOMP_INSTRS, ENSEMBLE_ACCOMP_INSTRS, ACCOMP_BIAS, generate_duet
from live_duet import LiveDuet, INSTR_NAMES
import midi_io


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list-ports", action="store_true", help="print available MIDI ports and exit")
    ap.add_argument("--midi-in", help="MIDI input port name (your keyboard)")
    ap.add_argument("--midi-out", help="MIDI output port name (a synth, or a virtual bus into a DAW)")
    ap.add_argument("--bpm", type=float, default=80.0,
                     help="assumed tempo for scheduling math only -- play along to a "
                          "metronome at this tempo for the lookahead/commit timing to "
                          "line up with what you're actually playing")
    ap.add_argument("--lookahead-beats", type=float, default=2.5)
    ap.add_argument("--commit-beats", type=float, default=1.75)
    ap.add_argument("--listen-first-beats", type=float, default=8.0)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--accomp-bias", type=float, default=ACCOMP_BIAS)
    ap.add_argument("--ensemble", action="store_true", help="violin + steel guitar instead of solo violin")
    ap.add_argument("--multi-voice", action="store_true", help="let each instrument overlap itself")
    ap.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent.parent / "output"))
    args = ap.parse_args()

    if args.list_ports:
        ports = midi_io.list_ports()
        print("inputs: ", ports["inputs"])
        print("outputs:", ports["outputs"])
        return

    if not args.midi_in or not args.midi_out:
        ap.error("--midi-in and --midi-out are required (use --list-ports to see choices)")

    accomp_instrs = ENSEMBLE_ACCOMP_INSTRS if args.ensemble else SOLO_ACCOMP_INSTRS
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"loading stanford-crfm/music-small-800k on {device} ...")
    model = AutoModelForCausalLM.from_pretrained("stanford-crfm/music-small-800k").to(device)
    model.eval()

    print("soundcheck: warming up the model (not part of the timed session) ...")
    warm_start = time.monotonic()
    generate_duet(model, 0.0, 60.0 / args.bpm, [], accomp_instrs, args.top_p, args.accomp_bias)
    print(f"soundcheck done in {time.monotonic() - warm_start:.2f}s")

    # Shared clock: opened before the blocking duet.run() call so the MIDI
    # input/output threads and the scheduler all agree on what "now" means.
    t0 = time.monotonic()
    midi_in = midi_io.MidiKeyboardInput(args.midi_in, t0)
    channel_by_instr = {MELODY_INSTR: 0, **{instr: i + 1 for i, instr in enumerate(accomp_instrs)}}
    midi_out = midi_io.MidiPlayer(args.midi_out, t0, channel_by_instr)
    for instr in accomp_instrs:
        midi_out.set_program(instr, instr)

    def on_played(onset_s, dur_s, role, pitch):
        # Only the companion's notes go to the output port -- you already
        # hear your own keyboard directly (through its own sound, or
        # whatever the DAW/amp is doing with it), no need to echo it back.
        if role != "melody":
            instr = int(role.split(":")[1])
            midi_out.schedule(onset_s, dur_s, instr, pitch)

    duet = LiveDuet(
        model=model,
        melody_source=midi_in,
        melody_len_s=None,  # unbounded: runs until Ctrl+C
        bpm=args.bpm,
        lookahead_beats=args.lookahead_beats,
        commit_beats=args.commit_beats,
        listen_first_beats=args.listen_first_beats,
        top_p=args.top_p,
        accomp_instrs=accomp_instrs,
        accomp_bias=args.accomp_bias,
        polyphonic=args.multi_voice,
        on_played=on_played,
        t0=t0,
    )

    def handle_sigint(signum, frame):
        print("\nstopping (Ctrl+C) ...")
        duet.request_stop()

    signal.signal(signal.SIGINT, handle_sigint)

    voices = ", ".join(INSTR_NAMES.get(i, str(i)) for i in accomp_instrs)
    voicing = "polyphonic (multiple violins)" if args.multi_voice else "monophonic (one violin)"
    print(f"companion voice(s): {voices} -- {voicing}")
    print(f"listening on '{args.midi_in}', playing to '{args.midi_out}'")
    print(f"quiet for the first {args.listen_first_beats} beats while it listens -- play now. Ctrl+C to stop.")

    try:
        duet.run()
    finally:
        midi_in.close()
        midi_out.close()

    print("--- session ended ---")
    total_music_s = sum(m for m, _ in duet.gen_stats)
    total_wall_s = sum(w for _, w in duet.gen_stats)
    rtf = total_music_s / total_wall_s if total_wall_s > 0 else float("inf")
    print(
        f"inference calls: {len(duet.gen_stats)}, "
        f"music generated: {total_music_s:.1f}s in {total_wall_s:.1f}s wall time "
        f"(realtime factor {rtf:.2f}x), underruns: {duet.underruns}"
    )

    midi_path = outdir / "live_midi_session.mid"
    events_to_midi(ops.sort(duet.history)).save(str(midi_path))
    print(f"wrote {midi_path}")


if __name__ == "__main__":
    main()
