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


class MidiKeyboardInput:
    """Listens to a real MIDI input port on a background thread (mido's
    callback runs on its own thread) and exposes completed notes as
    (onset_s, dur_s, pitch), relative to a shared t0 -- the same shape and
    the same wall clock as SyntheticMelodySource's precomputed list, so
    LiveDuet can't tell the difference.

    A note only becomes visible once its note_off arrives, since its
    duration isn't known before that -- there is an inherent reaction delay
    equal to how long the player actually holds each note, before anything
    the scheduler itself adds on top. This is a real, honest limitation of
    modeling notes as (onset, duration) triples rather than separate
    note-on/note-off events; see SETUP.md.
    """

    def __init__(self, port_name, t0):
        self.t0 = t0
        self._queue = queue.Queue()
        self._open_notes = {}  # pitch -> onset_s
        self._port = mido.open_input(port_name, callback=self._on_message)

    def _on_message(self, msg):
        now = time.monotonic() - self.t0
        if msg.type == "note_on" and msg.velocity > 0:
            self._open_notes[msg.note] = now
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            onset_s = self._open_notes.pop(msg.note, None)
            if onset_s is not None:
                self._queue.put((onset_s, max(now - onset_s, 0.02), msg.note))

    def poll(self, playhead):
        """Return notes completed since the last call. `playhead` is
        accepted (unused) only to match SyntheticMelodySource's interface --
        completion, not a precomputed onset, is what gates visibility here."""
        notes = []
        while True:
            try:
                notes.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return notes

    def exhausted(self):
        """A live keyboard never runs out on its own; the session ends via
        LiveDuet.request_stop() (see live_midi.py's Ctrl+C handler)."""
        return False

    def close(self):
        self._port.close()


class MidiPlayer:
    """Schedules companion notes to a real MIDI output at the right
    wall-clock time, relative to the same shared t0. Runs its own polling
    thread so LiveDuet's main loop never blocks on hardware I/O.

    Because commits happen ahead of when they're due (that's the whole
    lookahead/commit buffer), most notes are scheduled here before their
    onset and simply wait; a note whose onset has already passed by the
    time it's scheduled (a genuine underrun) fires immediately instead of
    being dropped, matching how underrun notes are still kept in the MIDI
    export elsewhere in this bench.
    """

    def __init__(self, port_name, t0, channel_by_instr, poll_interval=0.005):
        self.t0 = t0
        self.channel_by_instr = channel_by_instr
        self._port = mido.open_output(port_name)
        self._lock = threading.Lock()
        self._pending = []  # [onset_s, dur_s, pitch, channel, fired]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(poll_interval,), daemon=True)
        self._thread.start()

    def set_program(self, instr, program):
        self._port.send(mido.Message("program_change", channel=self.channel_by_instr[instr], program=program))

    def schedule(self, onset_s, dur_s, instr, pitch):
        channel = self.channel_by_instr[instr]
        with self._lock:
            self._pending.append([onset_s, dur_s, pitch, channel, False])

    def _run(self, poll_interval):
        while not self._stop.is_set():
            now = time.monotonic() - self.t0
            with self._lock:
                still_pending = []
                for note in self._pending:
                    onset_s, dur_s, pitch, channel, fired = note
                    if not fired and now >= onset_s:
                        self._port.send(mido.Message("note_on", note=pitch, velocity=80, channel=channel))
                        note[4] = True
                    if note[4] and now >= onset_s + dur_s:
                        self._port.send(mido.Message("note_off", note=pitch, channel=channel))
                    else:
                        still_pending.append(note)
                self._pending = still_pending
            time.sleep(poll_interval)

    def close(self):
        self._stop.set()
        self._thread.join(timeout=1.0)
        # silence anything still ringing before closing the port
        with self._lock:
            for onset_s, dur_s, pitch, channel, fired in self._pending:
                if fired:
                    self._port.send(mido.Message("note_off", note=pitch, channel=channel))
        self._port.close()
