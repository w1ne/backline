"""
Live AI duet partner, real MIDI keyboard version -- driven by
`services/amt/server.py` over WebSocket instead of loading the model
locally. Port of Music/live_midi.py's hardware I/O onto the service's
bar-driven protocol (the same one `src/engines/amtEngine.ts` speaks through
the relay): the client sends the human's notes as they arrive and a `bar`
message each time a new bar starts, and the server replies with the
accompaniment plan for the *next* bar.

Unlike live_midi.py / live_duet.py in this directory, this script has no
torch/transformers/anticipation dependency at all -- it only needs `mido`
(+ `python-rtmidi`) for hardware I/O and `websockets` for the socket, so it
can run on a different, lighter machine than whatever is hosting the model.

Run the service first (from backline/services/amt): `python server.py`
(or point --url at wherever it's actually running). Then, from this
directory:

    python live_midi_client.py --list-ports
    python live_midi_client.py --midi-in "Your Keyboard" --midi-out "IAC Driver Bus 1"

Play along to a metronome at --bpm -- the server has no idea what tempo
you're actually playing at, it just trusts the `bpm` sent in `start` and the
beat positions on every message after that. Press Ctrl+C to stop; a MIDI
file of the session (your playing plus what the server sent back) is
written to --outdir, same as live_midi.py.
"""

import argparse
import asyncio
import json
import logging
import signal
import time
from pathlib import Path

import mido
import websockets

import midi_io

log = logging.getLogger("live_midi_client")

# GM programs for the two voices services/amt/server.py's plan notes name
# ("keys" / "bass") -- chosen to sit outside the player's own melody channel,
# not because the server cares what plays them back.
VOICE_PROGRAM = {"keys": 40, "bass": 32}  # violin, acoustic bass
MELODY_PROGRAM = 0  # acoustic grand piano, for the exported MIDI file only
BEATS_PER_BAR = 4.0
PPQ = 480


class MidiRecorder:
    """Collects (onset_s, dur_s, program, pitch) tuples from both sides of the
    duet so the session can be written out as a MIDI file on exit, independent
    of mido's hardware playback path."""

    def __init__(self):
        self.events = []

    def add(self, onset_s, dur_s, program, pitch):
        self.events.append((onset_s, dur_s, program, pitch))

    def save(self, path, beat_s):
        if not self.events:
            return False
        mid = mido.MidiFile(ticks_per_beat=PPQ)
        programs = sorted({program for (_, _, program, _) in self.events})
        channel_of = {program: i for i, program in enumerate(programs)}
        track = mido.MidiTrack()
        mid.tracks.append(track)
        for program in programs:
            track.append(mido.Message("program_change", channel=channel_of[program], program=program, time=0))

        def tick(seconds):
            return max(0, round(seconds / beat_s * PPQ))

        raw = []
        for onset_s, dur_s, program, pitch in self.events:
            channel = channel_of[program]
            raw.append((tick(onset_s), 1, mido.Message("note_on", note=pitch, velocity=80, channel=channel)))
            raw.append((tick(onset_s + dur_s), 0, mido.Message("note_off", note=pitch, channel=channel)))
        raw.sort(key=lambda e: (e[0], e[1]))  # note_off before note_on on a simultaneous tick

        last_tick = 0
        for tick_time, _, msg in raw:
            msg.time = tick_time - last_tick
            track.append(msg)
            last_tick = tick_time

        mid.save(str(path))
        return True


class ServiceClient:
    """Owns the WebSocket connection to services/amt/server.py and the
    wall-clock bar transport that drives it. Forwards real keyboard notes in,
    schedules returned plan notes to a real MIDI output."""

    def __init__(self, url, bpm, lookahead_beats, commit_beats, listen_beats,
                 midi_in_name, midi_out_name, program_change, outdir):
        self.url = url
        self.bpm = bpm
        self.beat_s = 60.0 / bpm
        self.bar_s = BEATS_PER_BAR * self.beat_s
        self.lookahead_beats = lookahead_beats
        self.commit_beats = commit_beats
        self.listen_beats = listen_beats
        self.program_change = program_change
        self.outdir = outdir

        self.t0 = time.monotonic()
        self.midi_in = midi_io.MidiKeyboardInput(midi_in_name, self.t0)
        channel_by_program = {program: i + 1 for i, program in enumerate(VOICE_PROGRAM.values())}
        self.midi_out = midi_io.MidiPlayer(midi_out_name, self.t0, channel_by_program, monophonic=True)

        self.recorder = MidiRecorder()
        self._sent_note_ids = set()
        self._scheduled = set()  # (voice, round(beat, 4), pitch) already handed to midi_out
        self._outgoing_notes = []
        self._stop_requested = False
        self._last_status = None

    def log(self, msg):
        t = time.monotonic() - self.t0
        print(f"[{t:6.2f}s] {msg}")

    def request_stop(self):
        self._stop_requested = True

    async def run(self):
        async with websockets.connect(self.url) as ws:
            await ws.send(json.dumps({
                "type": "start",
                "bpm": self.bpm,
                "lookaheadBeats": self.lookahead_beats,
                "commitBeats": self.commit_beats,
                "listenBeats": self.listen_beats,
            }))
            if self.program_change:
                for program in VOICE_PROGRAM.values():
                    self.midi_out.set_program(program, program)

            recv_task = asyncio.create_task(self._receive_loop(ws))
            try:
                await self._transport_loop(ws)
            finally:
                recv_task.cancel()
                try:
                    await recv_task
                except asyncio.CancelledError:
                    pass

    async def _transport_loop(self, ws):
        bar = -1
        while not self._stop_requested:
            now = time.monotonic() - self.t0
            cur_bar = int(now // self.bar_s)
            if cur_bar > bar:
                bar = cur_bar
                await ws.send(json.dumps({"type": "bar", "bar": bar}))

            self._forward_human_notes(ws, now)
            notes_to_send = self._drain_outgoing_notes()
            if notes_to_send:
                await ws.send(json.dumps({"type": "notes", "notes": notes_to_send}))

            await asyncio.sleep(0.02)

    def _forward_human_notes(self, ws, now):
        """Queue a fixed-duration note the moment a key goes down -- matching
        src/engines/amtEngine.ts, which doesn't wait for note-off either (the
        server has no way to revise a note already added to its history).
        Still record the keyboard's own note-on/off timing for the exported
        MIDI file, which cares about what was actually played, not what the
        server was told."""
        for event in self.midi_in.poll(now):
            note_id = event["id"]
            if note_id not in self._sent_note_ids:
                self._sent_note_ids.add(note_id)
                self._outgoing_notes.append({
                    "beat": event["onset"] / self.beat_s,
                    "pitch": event["pitch"],
                    "dur": 0.5,
                })
            if event["complete"]:
                self.recorder.add(event["onset"], event["duration"], MELODY_PROGRAM, event["pitch"])

    def _drain_outgoing_notes(self):
        notes, self._outgoing_notes = self._outgoing_notes, []
        return notes

    async def _receive_loop(self, ws):
        async for raw in ws:
            msg = json.loads(raw)
            mtype = msg.get("type")
            if mtype == "plan":
                self._handle_plan(msg)
            elif mtype == "status":
                self._last_status = msg
                self.log(f"server: latency={msg.get('latencyMs', 0):.0f}ms "
                         f"tokens/s={msg.get('tokensPerSec', 0):.1f}")
            elif mtype == "error":
                self.log(f"server error: {msg.get('message')}")

    def _handle_plan(self, msg):
        for note in msg.get("notes", []):
            voice = note["voice"]
            beat = float(note["beat"])
            pitch = int(note["pitch"])
            dur = float(note["dur"])
            key = (voice, round(beat, 4), pitch)
            if key in self._scheduled:
                continue
            self._scheduled.add(key)

            program = VOICE_PROGRAM.get(voice)
            if program is None:
                continue
            onset_s = beat * self.beat_s
            dur_s = dur * self.beat_s
            self.midi_out.schedule(onset_s, dur_s, program, pitch)
            self.recorder.add(onset_s, dur_s, program, pitch)
            self.log(f"AI({voice}) pitch={pitch:3d} dur={dur:4.2f} beats")

    def close(self):
        self.midi_in.close()
        self.midi_out.close()


async def _main_async(args):
    ports = midi_io.list_ports()
    midi_in_name = midi_io.resolve_port(args.midi_in, ports["inputs"], "input")
    midi_out_name = midi_io.resolve_port(args.midi_out, ports["outputs"], "output")

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    client = ServiceClient(
        url=args.url,
        bpm=args.bpm,
        lookahead_beats=args.lookahead_beats,
        commit_beats=args.commit_beats,
        listen_beats=args.listen_beats,
        midi_in_name=midi_in_name,
        midi_out_name=midi_out_name,
        program_change=not args.no_program_change,
        outdir=outdir,
    )

    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGINT, client.request_stop)
    except NotImplementedError:
        pass  # e.g. Windows; Ctrl+C still raises KeyboardInterrupt, just less gracefully

    print(f"connecting to {args.url} ...")
    print(f"listening on '{midi_in_name}', playing to '{midi_out_name}' at {args.bpm} bpm")
    print("quiet while it listens, then play -- Ctrl+C to stop.")

    try:
        await client.run()
    finally:
        client.close()

    midi_path = outdir / "live_midi_client_session.mid"
    if client.recorder.save(midi_path, client.beat_s):
        print(f"wrote {midi_path}")
    else:
        print("nothing was played -- no MIDI file written")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list-ports", action="store_true", help="print available MIDI ports and exit")
    ap.add_argument("--midi-in", help="MIDI input port name (your keyboard)")
    ap.add_argument("--midi-out", help="MIDI output port name (a synth, or a virtual bus into a DAW)")
    ap.add_argument("--no-program-change", action="store_true",
                     help="keep the sound already selected in your synth/DAW")
    ap.add_argument("--url", default="ws://localhost:8080/ws",
                     help="services/amt/server.py's WebSocket endpoint (default: %(default)s)")
    ap.add_argument("--bpm", type=float, default=100.0,
                     help="assumed tempo for scheduling math only -- play along to a metronome "
                          "at this tempo, same units the server's `bar`/beat math expects "
                          "(default: %(default)s, matching the server's own default)")
    ap.add_argument("--lookahead-beats", type=float, default=4.0)
    ap.add_argument("--commit-beats", type=float, default=2.0)
    ap.add_argument("--listen-beats", type=float, default=8.0,
                     help="beats of silence before the server commits its first note")
    ap.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent.parent / "output" / "bench" / "amt"))
    args = ap.parse_args()

    if args.list_ports:
        ports = midi_io.list_ports()
        print("inputs: ", ports["inputs"])
        print("outputs:", ports["outputs"])
        return

    if not args.midi_in or not args.midi_out:
        ap.error("--midi-in and --midi-out are required (use --list-ports to see choices)")

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    asyncio.run(_main_async(args))


if __name__ == "__main__":
    main()
