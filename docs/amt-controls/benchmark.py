"""Real GPU control comparison; run with AMT_ROOT pointing at the candidate checkout."""
import os, sys, json, statistics
from pathlib import Path
sys.path.insert(0, str(Path(os.environ['AMT_ROOT']) / 'services/amt'))
import torch
import server
model = server.load_model()
rows = []
for bpm in (100, 150):
    for seed in range(6):
        for creativity, amount in ((0, .15), (0, 1), (1, 1)):
            s = server.Session(model)
            s.reset(bpm, 4, 2, 8, .95)
            s.set_controls({'key':'C major', 'chord':'C', 'creativity':creativity, 'amount':amount})
            s.add_human_notes([{'beat':i,'dur':.8,'pitch':[60,64,67,62,65,69,67,64][i%8]} for i in range(8)])
            torch.manual_seed(seed)
            out = s.generate_next_bar_plan(2)
            notes = [n for n in out['plan']['notes'] if n['voice']=='keys']
            grid = 4 if creativity == 1 else 2
            assert all(abs(n['beat']*grid-round(n['beat']*grid)) < 1e-6 for n in notes)
            assert all(n['beat'] + n['dur'] <= 16 + 1e-6 for n in notes)
            assert out['status']['latencyMs'] < 4*60000/bpm
            rows.append({'bpm':bpm,'seed':seed,'creativity':creativity,'amount':amount,
                         'latencyMs':out['status']['latencyMs'], 'notes':notes})
summary = []
for c,a in ((0,.15),(0,1),(1,1)):
    subset = [r for r in rows if (r['creativity'],r['amount'])==(c,a)]
    summary.append({'creativity':c,'amount':a,'trials':len(subset),
      'nonempty':sum(bool(r['notes']) for r in subset),
      'meanNotes':statistics.mean(len(r['notes']) for r in subset),
      'medianMs':statistics.median(r['latencyMs'] for r in subset),
      'maxMs':max(r['latencyMs'] for r in subset),
      'passingNotes':sum(n['pitch']%12 not in (0,4,7) for r in subset for n in r['notes'])})
Path('/tmp/amt-controls-results.json').write_text(json.dumps({'summary':summary,'rows':rows},indent=2))
print(json.dumps(summary,indent=2))
