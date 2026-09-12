"""Benchmark merged cloud Session end to end without starting a service."""
import os,sys,json,time,gc,statistics,hashlib
from pathlib import Path
os.environ['SDL_AUDIODRIVER']='dummy'
os.environ['AMT_SAMPLER']='cached'
root=Path(os.environ.get('MERGED_ROOT','/tmp/duet-cloud-merged'))
sys.path.insert(0,str(root/'services/amt'))
import torch
from transformers import AutoModelForCausalLM
import server

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
report={'gpu':torch.cuda.get_device_name(),'torch':torch.__version__,'sampler':server.generate_duet.__name__,
        'source_sha256':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in ['services/amt/server.py','services/amt/cached.py','services/amt/arrangement.py','bench/amt/amt.py','bench/amt/live_duet.py']},
        'rows':[]}
melody=[60,64,67,64,62,65,69,65,59,62,67,62,60,64,67,72]
for size in ['small','medium']:
    model=AutoModelForCausalLM.from_pretrained('stanford-crfm/music-'+size+'-800k',local_files_only=True,attn_implementation='eager').eval().to('cuda')
    warm=server.Session(model)
    warm.add_human_notes([{'beat':beat,'dur':.8,'pitch':melody[beat]} for beat in range(8)])
    warm.generate_next_bar_plan(2)
    del warm
    for bpm in [100,150]:
        for seed in [0,1,2]:
            for bar in [2,4,6,8]:
                session=server.Session(model)
                session.reset(bpm,4,2,8,.85)
                session.key='C major'
                session.chord='C'
                session.space=bar in [4,8]
                start_beat=(bar+1)*4
                session.add_human_notes([{'beat':beat,'dur':.8,'pitch':melody[beat%16]}
                    for beat in range(max(0,start_beat-16),bar*4)])
                torch.manual_seed(seed*100+bar)
                torch.cuda.synchronize()
                began=time.monotonic()
                out=session.generate_next_bar_plan(bar)
                torch.cuda.synchronize()
                ms=(time.monotonic()-began)*1000
                keys=[n for n in out['plan']['notes'] if n['voice']=='keys']
                row={'model':size,'bpm':bpm,'seed':seed,'bar':bar,'mode':'answer' if session.space else 'support',
                    'latency_ms':ms,'deadline_met':ms<4*60/bpm*1000,'budget_met':ms<.8*4*60/bpm*1000,
                    'nonempty':bool(keys),'key_notes':len(keys),'diatonic_count':sum(n['pitch']%12 in [0,2,4,5,7,9,11] for n in keys),
                    'support_chord_ok':all(n['pitch']%12 in [0,4,7] for n in keys) if not session.space else None,
                    'answer_within_two_beats':all(n['beat']+n['dur']<=start_beat+2+1e-6 for n in keys) if session.space else None,
                    'plan':out['plan']}
                report['rows'].append(row)
                print(json.dumps({k:v for k,v in row.items() if k!='plan'}),flush=True)
                del session
    del model
    gc.collect();torch.cuda.empty_cache()
report['summaries']=[]
for size in ['small','medium']:
    for bpm in [100,150]:
        rows=[r for r in report['rows'] if (r['model'],r['bpm'])==(size,bpm)]
        report['summaries'].append({'model':size,'bpm':bpm,'trials':len(rows),'nonempty':sum(r['nonempty'] for r in rows),
            'deadline_met':sum(r['deadline_met'] for r in rows),'budget_met':sum(r['budget_met'] for r in rows),
            'median_ms':statistics.median(r['latency_ms'] for r in rows),'max_ms':max(r['latency_ms'] for r in rows),
            'mean_keys':statistics.mean(r['key_notes'] for r in rows),
            'support_chord_ok':all(r['support_chord_ok'] for r in rows if r['mode']=='support'),
            'answer_within_two_beats':all(r['answer_within_two_beats'] for r in rows if r['mode']=='answer')})
Path('/tmp/duet-merged-results.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report['summaries'],indent=2))
