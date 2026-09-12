import mido, os
BPM = 90; PPQ = 480
MEL = [0,2,3,5,7,5,3,2, 0,3,7,5,3,2,0,0, 2,3,5,7,9,7,5,3, 2,0,3,2,0,-2,0,0]
CHORDS = [(9,'min'),(5,'maj'),(0,'maj'),(7,'maj'),(9,'min'),(2,'min'),(4,'min'),(9,'min')]

def write(name, notes):
    mid = mido.MidiFile(ticks_per_beat=PPQ); tr = mido.MidiTrack(); mid.tracks.append(tr)
    tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(BPM), time=0))
    tr.append(mido.MetaMessage('track_name', name='Guitar', time=0))
    tr.append(mido.Message('program_change', program=0, time=0))
    ev = []
    for s, d, p in notes:
        ev.append((round(s*PPQ), 1, p)); ev.append((round((s+d)*PPQ), 0, p))
    ev.sort(key=lambda e: (e[0], e[1]))
    t = 0
    for tick, on, p in ev:
        tr.append(mido.Message('note_on' if on else 'note_off', note=p, velocity=90 if on else 0, time=tick-t)); t = tick
    mid.save(name); print(name, len(notes), 'notes')

os.makedirs('midi', exist_ok=True)
mel = [(i, 0.95, 57+d) for i, d in enumerate(MEL)]
write('midi/melody_am.mid', mel)
arp = []; low = 55; i = 0
for r, q in CHORDS:
    third = 4 if q == 'maj' else 3
    root = low + (((r-low) % 12) + 12) % 12
    for off in [0, third, 7, third]:
        arp.append((i, 0.95, root+off)); i += 1
write('midi/arpeggio_am.mid', arp)
