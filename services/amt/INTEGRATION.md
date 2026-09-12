# Wiring the harmony brain into server.py

Step 2 of docs/superpowers/specs/2026-09-12-one-brain-design.md. `harmony.py` and `predict.py`
are self-contained; this is the change server.py needs once the half-bar `tick` handler from
Step 1 has landed. Nothing here touches the client protocol except two optional plan fields.

## Imports

```python
from harmony import MelodyHarmonizer, chord_name, parse_key
from predict import decide
```

## Session state (`Session.reset`)

```python
self.harmonizer = MelodyHarmonizer(window=2.0)   # two beats; time unit is beats, so no bpm scaling
self.recent_chords = []                          # one Chord per half-bar decision, last four kept
self.genre = msg.get("genre")                    # the start message already carries it (amtEngine.ts start)
```

`start` already stores `session.key` as the client's string ("A minor"); keep it and call
`parse_key(self.key)` where a `Key` is needed. `reset()` the harmonizer on `start`.

## Where notes arrive (`Session.add_human_notes`)

One line inside the loop, next to the `self.human_notes.append(...)`:

```python
self.harmonizer.add_note(pitch, onset_beat)
```

The `notes` message carries `beat` and `pitch` in beats already, so no conversion. Weight stays
the default 1.0 (the client sends no per-note confidence).

## Where the half-bar tick happens (the `tick` handler, formerly `bar`)

Before the model is asked for the window, decide the chord for it:

```python
key = parse_key(self.key)
self.harmonizer.tick(tick_beat, key)                       # tick_beat: the beat the tick message names
reading = self.harmonizer.reading
chord, source = decide(key, self.genre, reading, self.recent_chords,
                       reading.coverage if reading else 0.0,
                       downbeat=tick_beat % 4 == 0)
self.recent_chords = (self.recent_chords + [chord])[-4:]
self.chord = chord_name(chord)                             # what voice_chord/bass_pitch/fill_silent_window already read
```

`self.chord` is the string the arrangement helpers consume today, so voicing the model's window
against the decided chord needs no other change. Under AMT the client's `set.chord` must stop
overriding it: drop the `self.chord = msg.get("chord", self.chord)` line from `set_controls`
(the client keeps sending it for the display and the offline path).

`key is None` (no key yet): `tick` returns None and `reading` stays None, and `decide` needs a
key, so wrap the block in `if key is not None` and leave `self.chord` alone otherwise.

## Plan message

Two optional fields on the plan dict returned by the window generator (both the model path and
the listening / empty-window fallbacks):

```python
"chord": self.chord,            # chordName format: "C", "C#", "Am", ...
"chordFrom": start_beat,        # the beat the plan window starts; the chord is in force from there
```

`chordFrom` is the window's `fromBeat`: when the window starts ahead of the tick (LOOKAHEAD_BEATS
4 today) the chord applies from the window start, not from the tick. HARMONY_BENCH.md has the
accuracy at lookahead 0, 2 and 4; the decision above is taken at the tick, so with a lookahead
that crosses a downbeat the wiring should step the prediction forward as `bench_harmony.run`
does (one `predict_next` per downbeat between tick and window start).

## Client side (not part of this module)

Under AMT, `bandleader.set({ chord, chordBeat })` from `plan.chord` / `plan.chordFrom`; old
clients ignore the fields. The spec asks for a test that a plan chord overrides the local one
while AMT is live.

## Checks

- `cd services/amt && python3 -m pytest` (harmony, predict and arrangement tests).
- `python3 services/amt/bench_harmony.py` prints the accuracy table; `--md HARMONY_BENCH.md` rewrites the results file.
