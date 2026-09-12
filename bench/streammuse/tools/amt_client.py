"""Stream a melody MIDI through the Backline AMT service the way the browser does:
start -> notes (as they happen, wall clock) -> bar each downbeat -> collect plans.
Writes melody+accompaniment MIDI and a JSON with per-bar latency."""
import asyncio, json, sys, time
import mido, websockets

URL = sys.argv[1]; MIDI_IN = sys.argv[2]; OUT = sys.argv[3]
BPM = 90; BEAT_S = 60 / BPM; KEY = "A minor"
SPEED = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0  # 1.0 = real time

def load_notes(path):
    mid = mido.MidiFile(path); ppq = mid.ticks_per_beat; notes = []; on = {}; t = 0
    for msg in mid.tracks[0]:
        t += msg.time
        if msg.type == 'note_on' and msg.velocity > 0: on[msg.note] = t
        elif msg.type in ('note_off', 'note_on') and msg.note in on:
            s = on.pop(msg.note); notes.append({"beat": s / ppq, "pitch": msg.note, "dur": (t - s) / ppq, "vel": 0.7})
    return sorted(notes, key=lambda n: n["beat"])

async def main():
    melody = load_notes(MIDI_IN)
    total_beats = max(n["beat"] + n["dur"] for n in melody)
    n_bars = int(total_beats // 4) + 1
    plans, stats, log = [], [], []
    async with websockets.connect(URL, max_size=None, open_timeout=60,
                                  additional_headers={"Origin": "https://duetai.art"}) as ws:
        await ws.send(json.dumps({"type": "start", "bpm": BPM, "key": KEY, "genre": "lofi",
                                  "lookaheadBeats": 4, "commitBeats": 2, "listenBeats": 4}))
        t0 = time.monotonic(); i = 0; pending = {}
        async def reader():
            async for raw in ws:
                m = json.loads(raw); now = time.monotonic()
                if m["type"] == "plan":
                    bar = pending.pop("bar", None); sent = pending.pop("t", now)
                    m["_rtt_ms"] = (now - sent) * 1000; m["_bar"] = bar; plans.append(m)
                elif m["type"] == "status": stats.append(m)
                else: log.append(m)
        rt = asyncio.create_task(reader())
        for bar in range(n_bars + 1):
            # send this bar's notes at their wall-clock onsets
            while i < len(melody) and melody[i]["beat"] < (bar + 1) * 4:
                n = melody[i]; due = t0 + n["beat"] * BEAT_S / SPEED
                await asyncio.sleep(max(0, due - time.monotonic()))
                await ws.send(json.dumps({"type": "notes", "notes": [n]})); i += 1
            due = t0 + (bar + 1) * 4 * BEAT_S / SPEED
            await asyncio.sleep(max(0, due - time.monotonic()))
            pending["bar"] = bar + 1; pending["t"] = time.monotonic()
            await ws.send(json.dumps({"type": "bar", "bar": bar + 1}))
        await asyncio.sleep(3); rt.cancel()
    # write MIDI: track0 melody, track1 accompaniment (keys ch1, bass ch2)
    ppq = 480; mid = mido.MidiFile(ticks_per_beat=ppq)
    def track(name, notes, ch, prog):
        tr = mido.MidiTrack(); mid.tracks.append(tr)
        tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(BPM), time=0))
        tr.append(mido.MetaMessage('track_name', name=name, time=0))
        tr.append(mido.Message('program_change', channel=ch, program=prog, time=0))
        ev = []
        for n in notes:
            ev.append((round(n["beat"] * ppq), 1, n["pitch"], int(n["vel"] * 127)))
            ev.append((round((n["beat"] + n["dur"]) * ppq), 0, n["pitch"], 0))
        ev.sort(key=lambda e: (e[0], e[1])); t = 0
        for tk, on, p, v in ev:
            tr.append(mido.Message('note_on' if on else 'note_off', channel=ch, note=p, velocity=v, time=tk - t)); t = tk
    acc = [n for p in plans for n in p["notes"]]
    track("Guitar", melody, 0, 0)
    track("Piano", [n for n in acc if n.get("voice") == "keys"], 1, 0)
    track("Bass", [n for n in acc if n.get("voice") == "bass"], 2, 32)
    mid.save(OUT + ".mid")
    json.dump({"plans": plans, "status": stats, "other": log}, open(OUT + ".json", "w"), indent=1)
    print(f"bars={n_bars} plans={len(plans)} acc_notes={len(acc)} "
          f"rtt_ms={[round(p['_rtt_ms']) for p in plans]} server_ms={[round(s['latencyMs']) for s in stats]} other={log[:3]}")

asyncio.run(main())
