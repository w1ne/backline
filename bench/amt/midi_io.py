"""
Real MIDI hardware I/O: opening ports, listening for a physical keyboard,
scheduling companion notes to a real output. No music logic lives here --
just plumbing between mido/python-rtmidi and the scheduler's
(onset_s, dur_s, pitch) event shape, so live_duet.py's LiveDuet never has to
know whether it's talking to a real keyboard or the synthetic demo melody.

Requires the `python-rtmidi` backend (`pip install python-rtmidi`) --
mido alone can read/write .mid files but can't open a live hardware port.
"""

import queue
import threading
import time

import mido


def list_ports():
    return {"inputs": mido.get_input_names(), "outputs": mido.get_output_names()}


def resolve_port(name, available, kind):
    """Match `name` against `available` port names -- exact match first,
    then case-insensitive substring. Names with non-ASCII characters (e.g.
    GarageBand's German-localized "virtueller Eingang", which uses an en
    dash) don't reliably round-trip byte-for-byte through a terminal
    copy-paste -- the shell's encoding of what you typed doesn't always
    match what CoreMIDI actually registered, so an exact-match-only lookup
    fails on a port name that's right there in --list-ports' own output.
    Matching by an ASCII-safe substring (e.g. "GarageBand") sidesteps the
    problem instead of asking the user to type the exact character."""
    if name in available:
        return name
    matches = [p for p in available if name.lower() in p.lower()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise SystemExit(f"no {kind} port matches {name!r}. Available: {available}")
    raise SystemExit(f"{name!r} matches multiple {kind} ports, be more specific: {matches}")


class MidiKeyboardInput:
    """Publish note attacks immediately, then revise their provisional durations.

    Each physical note has a stable id, including repeated pitches and different
    MIDI channels. A held note is one updatable event, never a new note per poll.
    Velocity is retained for downstream use; AMT's token format omits velocity.
    Sustain CC is not modeled: final duration currently means key-down duration.
    """

    def __init__(self, port_name, t0):
        self.t0 = t0
        self._queue = queue.Queue()
        self._open_notes = {}
        self._lock = threading.Lock()
        self._next_id = 0
        self._port = mido.open_input(port_name, callback=self._on_message)

    def _on_message(self, msg):
        now = time.monotonic() - self.t0
        with self._lock:
            if msg.type == "note_on" and msg.velocity > 0:
                key = (msg.channel, msg.note)
                previous = self._open_notes.pop(key, None)
                if previous is not None:
                    self._finish(previous, now)
                event = dict(id=self._next_id, onset=now, duration=0.1,
                             pitch=msg.note, velocity=msg.velocity, complete=False)
                self._next_id += 1
                self._open_notes[key] = event
                self._queue.put(event.copy())
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                event = self._open_notes.pop((msg.channel, msg.note), None)
                if event is not None:
                    self._finish(event, now)

    def _finish(self, event, now):
        event = dict(event, duration=max(now - event["onset"], 0.02), complete=True)
        self._queue.put(event)

    def poll(self, playhead):
        updates = {}
        with self._lock:
            while True:
                try:
                    event = self._queue.get_nowait()
                    updates[event["id"]] = event
                except queue.Empty:
                    break
            for event in self._open_notes.values():
                updates[event["id"]] = dict(
                    event, duration=max(0.1, playhead - event["onset"] + 0.1))
        return list(updates.values())

    def exhausted(self):
        return False

    def close(self):
        self._port.close()


class MidiPlayer:
    """Play a bounded queue of notes; enforce monophony on the actual output.

    Expired notes are discarded. Slightly late notes keep their original end
    time. In monophonic mode, a new onset stops the previous channel voice,
    including notes queued by an earlier generation window.
    """

    def __init__(self, port_name, t0, channel_by_instr, poll_interval=0.005,
                 monophonic=True):
        self.t0 = t0
        self.channel_by_instr = channel_by_instr
        self.monophonic = monophonic
        self._port = mido.open_output(port_name)
        self._lock = threading.Lock()
        self._pending = []  # mutable [onset, duration, pitch, channel, fired]
        self._active_counts = {}
        self.dropped_expired = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(poll_interval,), daemon=True)
        self._thread.start()

    def set_program(self, instr, program):
        with self._lock:
            self._port.send(mido.Message("program_change", channel=self.channel_by_instr[instr], program=program))

    def schedule(self, onset_s, dur_s, instr, pitch):
        channel = self.channel_by_instr[instr]
        with self._lock:
            self._pending.append([onset_s, dur_s, pitch, channel, False])

    def _release(self, note):
        key = (note[3], note[2])
        remaining = self._active_counts.get(key, 1) - 1
        if remaining <= 0:
            self._active_counts.pop(key, None)
            self._port.send(mido.Message("note_off", note=note[2], channel=note[3]))
        else:
            self._active_counts[key] = remaining

    def _tick(self, now):
        # Caller owns _lock. Sorting handles late arrivals and unordered batches.
        ordered = sorted(self._pending, key=lambda n: n[0])
        sounding = []
        future = []
        for note in ordered:
            onset, duration, pitch, channel, fired = note
            if now >= onset + duration:
                if fired:
                    self._release(note)
                else:
                    self.dropped_expired += 1
            elif fired:
                sounding.append(note)
            else:
                future.append(note)
        waiting = []
        for note in future:
            onset, duration, pitch, channel, _ = note
            if onset > now:
                waiting.append(note)
                continue
            if self.monophonic:
                keep = []
                for previous in sounding:
                    if previous[3] == channel:
                        self._release(previous)
                    else:
                        keep.append(previous)
                sounding = keep
            self._port.send(mido.Message("note_on", note=pitch, velocity=80, channel=channel))
            key = (channel, pitch)
            self._active_counts[key] = self._active_counts.get(key, 0) + 1
            note[4] = True
            sounding.append(note)
        self._pending = sounding + waiting

    def _run(self, poll_interval):
        while not self._stop.is_set():
            with self._lock:
                self._tick(time.monotonic() - self.t0)
            self._stop.wait(poll_interval)

    def close(self):
        self._stop.set()
        self._thread.join(timeout=1.0)
        with self._lock:
            for channel, pitch in self._active_counts:
                self._port.send(mido.Message("note_off", note=pitch, channel=channel))
            self._active_counts.clear()
            self._pending.clear()
        self._port.close()
