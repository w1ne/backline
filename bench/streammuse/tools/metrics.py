"""Compare accompaniment MIDIs: in-key share (A natural minor), chord-tone share per bar for the arpeggio,
note density, plus latency stats from the two engines' logs."""
import json, sys, statistics, glob, os, mido

A_MINOR = {9, 11, 0, 2, 4, 5, 7}
CHORDS = [(9, 'min'), (5, 'maj'), (0, 'maj'), (7, 'maj'), (9, 'min'), (2, 'min'), (4, 'min'), (9, 'min')]
def chord_pcs(i):
    r, q = CHORDS[i % 8]; return {r % 12, (r + (4 if q == 'maj' else 3)) % 12, (r + 7) % 12}

def acc_notes(path, acc_tracks):
    """-> list of (onset_beat, dur_beat, pitch) from tracks whose name is in acc_tracks."""
    mid = mido.MidiFile(path); ppq = mid.ticks_per_beat; out = []
    for tr in mid.tracks:
        name = next((m.name for m in tr if m.type == 'track_name'), '')
        if name not in acc_tracks: continue
        t = 0; on = {}
        for m in tr:
            t += m.time
            if m.type == 'note_on' and m.velocity > 0: on[(m.channel, m.note)] = t
            elif m.type in ('note_off', 'note_on') and (m.channel, m.note) in on:
                s = on.pop((m.channel, m.note)); out.append((s / ppq, (t - s) / ppq, m.note))
    return sorted(out)

def music_metrics(notes, is_arp, bars=8):
    notes = [n for n in notes if n[0] < bars * 4]
    if not notes: return {"notes": 0}
    in_key = sum(n[2] % 12 in A_MINOR for n in notes) / len(notes)
    m = {"notes": len(notes), "notes_per_bar": len(notes) / bars, "in_key": in_key,
         "pitch_range": (min(n[2] for n in notes), max(n[2] for n in notes)),
         "first_onset_beat": notes[0][0],
         "bars_with_notes": len({int(n[0] // 4) for n in notes})}
    if is_arp:
        per_bar = []
        for b in range(bars):
            bn = [n for n in notes if b * 4 <= n[0] < (b + 1) * 4]
            per_bar.append(None if not bn else sum(n[2] % 12 in chord_pcs(b) for n in bn) / len(bn))
        got = [x for x in per_bar if x is not None]
        m["chord_tone_per_bar"] = [None if x is None else round(x, 2) for x in per_bar]
        m["chord_tone_mean"] = sum(got) / len(got) if got else None
    return m

def q(xs, p): return sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
def lat(xs): return {"n": len(xs), "mean": statistics.mean(xs), "p50": q(xs, .5), "p95": q(xs, .95), "max": max(xs)}

res = {}
root = sys.argv[1]
for cfg in ["interval_2_gen_frame_5", "interval_1_gen_frame_3"]:
    for song in ["melody_am", "arpeggio_am"]:
        base = f"{root}/sm_out/experiments-AE5/realtime/baseline/{cfg}/prompt_0_gen_272"
        notes = acc_notes(f"{base}/generated/{song}.mid", {"Piano"})
        log = json.load(open(f"{base}/batch_run/{song}/inferences.json"))
        rtt = [e["response"]["timings"]["round_trip_time"] * 1000 for e in log]
        srv = [e["response"]["timings"]["server_processing_duration"] * 1000 for e in log]
        th = json.load(open(f"{base}/batch_run/{song}/tick_history.json"))
        hits = sum(t["is_hit"] for t in th)
        res[f"streammuse/{cfg}/{song}"] = {**music_metrics(notes, song == "arpeggio_am"),
            "requests": len(log), "rtt_ms": lat(rtt), "server_ms": lat(srv),
            "hit_rate": hits / len(th), "ticks": len(th)}
for song in ["melody_am", "arpeggio_am"]:
    notes = acc_notes(f"{root}/amt_out/{song}.mid", {"Piano", "Bass"})
    keys = acc_notes(f"{root}/amt_out/{song}.mid", {"Piano"})
    j = json.load(open(f"{root}/amt_out/{song}.json"))
    res[f"amt/{song}"] = {**music_metrics(notes, song == "arpeggio_am"),
        "keys_only": music_metrics(keys, song == "arpeggio_am"),
        "requests": len(j["plans"]), "rtt_ms": lat([p["_rtt_ms"] for p in j["plans"]]),
        "server_ms": lat([s["latencyMs"] for s in j["status"]])}
json.dump(res, open(f"{root}/metrics.json", "w"), indent=1)
for k, v in res.items():
    print(k); print(json.dumps(v, default=float)[:900]); print()
