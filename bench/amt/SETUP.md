# Playing live with a physical MIDI keyboard

`live_duet.py` plays against a synthetic melody for benchmarking. `live_midi.py`
is the same scheduler (`LiveDuet`) wired to a real MIDI keyboard input and a
real MIDI output instead -- this is how you actually try it live.

## 1. Install

```bash
pip install torch transformers musicpy mido python-rtmidi
pip install git+https://github.com/jthickstun/anticipation.git
```

`python-rtmidi` is the part that actually talks to hardware -- `mido` alone
can only read/write `.mid` files.

## 2. Plug in your keyboard

Any class-compliant USB-MIDI keyboard just works over USB. If yours only has
5-pin DIN MIDI ports, you need a USB-MIDI interface between it and the Mac.

Check the machine sees it:

```bash
python live_midi.py --list-ports
```

You should see your keyboard's name under `inputs`. If it's not there,
check the cable/interface before going further -- nothing past this point
will work without it.

## 3. Set up somewhere to actually hear the companion

The companion's notes go out as real MIDI on `--midi-out`; something has to
turn that into sound. Two options:

**A hardware synth or module** -- if you have one, plug it in via
USB-MIDI or a DIN interface, and use its port name directly for
`--midi-out`. Simplest option, skip to step 4.

**Route into GarageBand (or any DAW) via a virtual MIDI bus** -- macOS's
built-in IAC Driver does this for free:

1. Open **Audio MIDI Setup** (Spotlight it). **Window > Show MIDI Studio**.
2. Double-click the **IAC Driver** icon.
3. Check **"Device is online"**. Leave the default port ("Bus 1").
4. In GarageBand: **Track > New Track > Software Instrument**. Click the
   track's instrument slot and pick something with an actual loaded sound
   (Strings/Violin is the obvious choice, but anything works) -- per the
   GarageBand MIDI-import gotcha noted in the main README, a track can look
   fine but have no instrument actually loaded; check it plays a note if
   you're not sure.
5. In that track's input settings (or GarageBand's own MIDI input routing,
   depending on version), select **IAC Driver, Bus 1** as the input source.

Your keyboard should keep going straight into its own sound (or your amp,
or a separate GarageBand track set to your keyboard's own port) -- this
tool doesn't echo your own notes back out anywhere, only the companion's.

## 4. Run it

```bash
python live_midi.py --midi-in "Your Keyboard" --midi-out "IAC Driver Bus 1"
```

Add `--ensemble` for violin + steel guitar instead of solo violin, and/or
`--multi-voice` to let a given instrument overlap itself (a section instead
of a soloist) -- same two independent flags as `live_duet.py`.

It loads the model, does a brief silent soundcheck, then prints something
like:

```
companion voice(s): violin -- monophonic (one violin)
listening on 'Your Keyboard', playing to 'IAC Driver Bus 1'
quiet for the first 8.0 beats while it listens -- play now. Ctrl+C to stop.
```

Play. **Press Ctrl+C when you're done** -- this ends the session cleanly and
writes a MIDI file of the whole thing (your part and the companion's) to
`--outdir` (`output/live_midi_session.mid` by default), same as the
synthetic demo.

## What to actually expect

- **Silence for the first few bars.** This is deliberate (the "listen
  first" window from `proposal.md` -- see the main README) -- it's
  gathering context before it plays its first note, not broken.
- **A reaction delay equal to how long you hold each note.** The scheduler
  works with (onset, duration) pairs, so a note you're playing only becomes
  visible to the model once you release it (`midi_io.py`'s
  `MidiKeyboardInput` only completes a note on `note_off`). Short notes
  barely matter; a long held note delays the model's reaction to it by
  exactly how long you hold it.
- **`--bpm` is a scheduling assumption, not a detector.** It sets how many
  real seconds the lookahead/commit/listen-first windows are (in beats);
  it doesn't listen to your actual tempo. Play along to a metronome at
  that BPM for the timing to line up with what the model expects; per
  `proposal.md`, beat-tracking free tempo in real time is a much harder,
  separate problem this doesn't attempt to solve.
- **A long pause you take mid-session doesn't stop it from planning
  ahead.** Unlike the synthetic demo (which has a known melody length and
  stops generating a fixed tail past the end), a live session has no known
  end, so the model just keeps writing plausible continuations even through
  silence -- it'll have plenty ready the moment you start again.
- **The console log is the same live feed as the synthetic demo** --
  `YOU`/`AI(instrument)` lines with timestamps, generation wall-times, and
  underrun warnings if the model falls behind the buffer on your machine.

## Troubleshooting

- **My keyboard doesn't show up in `--list-ports`.** Check it works in
  another app first (GarageBand's own MIDI input, or Audio MIDI Setup's
  MIDI Studio window, which shows connected devices). USB-MIDI should be
  plug-and-play on macOS; if it's not appearing, it's a cable/driver
  problem, not this script.
- **I hear nothing from the companion.** Check, in order: the output
  port name is exactly right (copy-paste from `--list-ports`, don't
  retype it); the GarageBand track's input is actually set to that IAC bus;
  the track actually has an instrument loaded (see step 3); the track
  isn't muted and no other track has Solo engaged.
- **It feels unresponsive / laggy.** Check the console log for `UNDERRUN`
  lines -- that means the model isn't keeping up with the buffer on your
  hardware. Try `--lookahead-beats 2 --commit-beats 1.5` (smaller windows,
  less to compute per cycle) or a slower `--bpm`.
