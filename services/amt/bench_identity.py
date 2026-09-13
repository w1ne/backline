"""Paired real-model probe: same human input and seed, identity off versus on.

Run in the AMT Python environment: python bench_identity.py --out /tmp/identity.json.
This is a behavioral probe, not a subjective musical-quality score. Empty model
output is reported, never replaced. The first nonempty paired seed is retained
for audition, with its seed recorded. No production service configuration changes.
"""
import argparse
import json
import torch

parser = argparse.ArgumentParser()
parser.add_argument('--out', default='/tmp/duet-identity-gpu.json')
args = parser.parse_args()
from server import Session, load_model
from musical_identity import MusicalIdentity

class Bypass(MusicalIdentity):
    def shape(self, notes, *args, **kwargs):
        self.response_applied = False
        self.response_instrument = None
        return notes

model = load_model()
calls = ([60,64,67,64,60,64,67,64], [60,55,60,64,60,55,60,64])
results = []
for ci, pitches in enumerate(calls):
    found = False
    for seed in range(16):
        pair = []
        for enabled in (False, True):
            session = Session(model)
            session.reset(120, 2, 2, 0, .95, instrument_names=['guitar'], key='C major')
            session.set_controls({'amount':1, 'creativity':.3, 'phraseResponses': True})
            if not enabled: session.identity = Bypass()
            session.add_human_notes([{'id':str(i),'beat':i,'pitch':p,'dur':.5,'source':'midi'} for i,p in enumerate(pitches)])
            torch.manual_seed(seed)
            result = session.generate_tick_plan(10)
            plan = result['plan']
            assert all(plan['fromBeat'] <= n['beat'] < n['beat']+n['dur'] <= plan['toBeat'] for n in plan['notes'])
            pair.append({'call':ci,'seed':seed,'identity':enabled,'human':pitches,**result})
        print('SEED',ci,seed,[len(r['plan']['notes']) for r in pair],flush=True)
        if pair[0]['plan']['notes'] and pair[1]['plan'].get('phraseResponse'):
            results.extend(pair)
            found = True
            break
    assert found, 'no AMT-backed response in tested seeds'
assert [n['pitch'] for n in results[1]['plan']['notes']] != [n['pitch'] for n in results[3]['plan']['notes']]
with open(args.out,'w') as f: json.dump(results,f,indent=2)
print('GPU_IDENTITY_VERIFIED',flush=True)
