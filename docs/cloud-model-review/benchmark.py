"""Isolated L4 AMT comparison. Run with /opt/amt-venv/bin/python benchmark.py.
No services are started or changed. Weights are loaded sequentially.
Cached sampler snapshots services/pi/amt_backend.py with ids on model.device.
"""
import gc, json, os, sys, time, statistics, argparse, inspect
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
import torch
from transformers import AutoModelForCausalLM
sys.path.insert(0, os.environ.get("AMT_BENCH_DIR", "/opt/backline/bench/amt"))
from amt import generate_duet, make_event, parse_events, _instr_mask_logits, ACCOMP_INSTR
from anticipation import ops
from anticipation.config import TIME_RESOLUTION
from anticipation.vocab import AUTOREGRESS, TIME_OFFSET, DUR_OFFSET, NOTE_OFFSET, REST
from anticipation.sample import safe_logits, future_logits, nucleus

def forward_last(model, ids, cache=None, slot=None):
    """Avoid projecting every prompt position through the 55k-token output head."""
    out = model.transformer(ids, past_key_values=cache, use_cache=True)
    hidden = out.last_hidden_state[:, -1, :]
    if slot is None or not isinstance(model.lm_head, torch.nn.Linear):
        logits = model.lm_head(hidden)[0]
    else:
        # safe_logits will discard every other event kind. Avoid reading their
        # output weights (and the entire unused anticipation-control vocabulary).
        start, end = [(TIME_OFFSET, DUR_OFFSET), (DUR_OFFSET, NOTE_OFFSET),
                      (NOTE_OFFSET, REST)][slot]
        logits = hidden.new_full((model.config.vocab_size,), -float('inf'))
        logits[start:end] = torch.nn.functional.linear(hidden, model.lm_head.weight[start:end])[0]
        logits[REST] = torch.nn.functional.linear(hidden, model.lm_head.weight[REST:REST+1])[0, 0]
    return logits, out.past_key_values

def prepare_context(inputs, start):
    """Pad only the retained musical window, without inventing silence from time zero."""
    clipped = ops.clip(ops.sort(inputs), 0, start, clip_duration=False, seconds=False)
    if not clipped:
        return [TIME_OFFSET + start, DUR_OFFSET, REST]
    base = ops.min_time(clipped, seconds=False)
    relative = clipped.copy()
    relative[::3] = [t - base for t in relative[::3]]
    padded = ops.pad(relative, start - base)
    padded[::3] = [t + base for t in padded[::3]]
    return padded

def cached_generate(model, start_time, end_time, inputs, top_p=1.0,
                    accomp_bias=2.0, accomp_only=True, deadline_s=None,
                    min_interval_ticks=1):
    start = int(TIME_RESOLUTION * start_time)
    end = int(TIME_RESOLUTION * end_time)
    tokens = prepare_context(inputs, start)
    current = ops.max_time(tokens, seconds=False)
    began = time.monotonic()
    cache = None
    ids = None
    position = 0
    offset = 0
    sampled_tokens = 0
    with torch.inference_mode():
        while deadline_s is None or time.monotonic() - began < deadline_s:
            # Preserve event boundaries when the GPT-2 position window fills.
            if cache is None or position + 3 >= 1024:
                history = tokens[-1017:]
                offset = ops.min_time(history, seconds=False)
                history = history.copy()
                history[::3] = [t - offset for t in history[::3]]
                ids = torch.tensor([[AUTOREGRESS] + history], dtype=torch.long, device=model.device)
                position = len(history)
                cache = None
            event = []
            for i in range(3):
                logits, cache = forward_last(model, ids, cache, i)
                logits = safe_logits(logits, position)
                if i == 0:
                    logits = future_logits(logits, max(start, current) - offset)
                elif i == 2:
                    logits = _instr_mask_logits(logits, accomp_bias, accomp_only)
                logits = nucleus(logits, top_p)
                token = int(torch.multinomial(torch.softmax(logits, -1), 1))
                event.append(token)
                ids = torch.tensor([[token]], dtype=torch.long, device=model.device)
                position += 1
                sampled_tokens += 1
                if i == 0 and token + offset - TIME_OFFSET >= end:
                    model.amt_sampled_tokens = sampled_tokens
                    return ops.sort(ops.unpad(tokens))
            event[0] += offset
            new_time = event[0] - TIME_OFFSET
            if new_time >= end:
                break
            tokens.extend(event)
            current = new_time + max(1, min_interval_ticks)
    model.amt_sampled_tokens = sampled_tokens
    return ops.sort(ops.unpad(tokens))


# Ablate padding separately from KV caching, using the original sampler source.
_original_source = inspect.getsource(generate_duet).replace('def generate_duet(', 'def original_contextfixed(')
_original_source = _original_source.replace(
    'tokens = ops.pad(ops.clip(inputs, 0, start_time, clip_duration=False, seconds=False), start_time)',
    'tokens = prepare_context(inputs, start_time)')
import amt as _amt
_ablation_globals = dict(vars(_amt), prepare_context=prepare_context)
exec(_original_source, _ablation_globals)
original_contextfixed = _ablation_globals['original_contextfixed']

def run():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', nargs='+', default=['small', 'medium'])
    ap.add_argument('--output', default='results.json')
    ap.add_argument('--samplers', nargs='+', default=['original', 'cached_gpu'])
    args = ap.parse_args()
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    report = {'gpu': torch.cuda.get_device_name(), 'torch': torch.__version__,
              'dtype': 'float32', 'top_p': .85, 'rows': [], 'models': {}}
    melody = [60,64,67,64, 62,65,69,65, 59,62,67,62, 60,64,67,72]
    for size in args.models:
        name = 'stanford-crfm/music-' + size + '-800k'
        t0 = time.monotonic()
        model = AutoModelForCausalLM.from_pretrained(name, attn_implementation='eager').eval().to('cuda')
        report['models'][size] = {'load_s': time.monotonic()-t0,
            'parameters': sum(p.numel() for p in model.parameters()),
            'revision': getattr(model.config, '_commit_hash', None)}
        for sampler_name in args.samplers:
            sampler = {'original':generate_duet,'cached_gpu':cached_generate,'original_contextfixed':original_contextfixed}[sampler_name]
            # Warm-up actual sampling, independently excluded for each configuration.
            torch.manual_seed(999)
            sampler(model, 2.4, 3., make_event(0, .6, 0, 60), .85, deadline_s=.3)
            for bpm in [100,150]:
                beat_s = 60/bpm
                for seed in [0,1,2]:
                    for bar in [2,4,6,8]:
                        start_beat = (bar+1)*4
                        # Identical fixed prompt in every model/sampler trial. Mimic
                        # next-bar planning: latest observed melody is prior bar.
                        prompt = []
                        for beat in range(max(0,start_beat-16),bar*4):
                            prompt += make_event(beat*beat_s,.8*beat_s,0,melody[beat%16])
                        start, end = start_beat*beat_s,(start_beat+4)*beat_s
                        torch.manual_seed(seed*100+bar)
                        torch.cuda.synchronize()
                        began = time.monotonic()
                        result = sampler(model,start,end,prompt,.85,deadline_s=.8*4*beat_s,
                            min_interval_ticks=max(1,round(beat_s/4*TIME_RESOLUTION)))
                        torch.cuda.synchronize()
                        elapsed = time.monotonic()-began
                        notes=[(t,d,p) for t,d,i,p in parse_events(result)
                               if i==ACCOMP_INSTR and start-1e-6<=t<end-1e-6]
                        occupied=set()
                        for t,d,p in notes:
                            occupied.update(range(max(0,round((t-start)*100)),min(round((end-start)*100),round((t+d-start)*100))))
                        row={'model':size,'sampler':sampler_name,'bpm':bpm,'seed':seed,'bar':bar,
                             'latency_ms':elapsed*1000,'budget_ms':.8*4*beat_s*1000,
                             'lead_ms':4*beat_s*1000,'notes':len(notes),'nonempty':bool(notes),
                             'deadline_met':elapsed<4*beat_s,'budget_met':elapsed<.8*4*beat_s,
                             'occupied_fraction':len(occupied)/round((end-start)*100),
                             'diatonic_count':sum(p%12 in [0,2,4,5,7,9,11] for _,_,p in notes),
                             'tonic_triad_count':sum(p%12 in [0,4,7] for _,_,p in notes),
                             'events':notes}
                        report['rows'].append(row)
                        print(json.dumps({k:v for k,v in row.items() if k!='events'}),flush=True)
        del model
        gc.collect()
        torch.cuda.empty_cache()
        with open(args.output,'w') as f: json.dump(report,f,indent=2)
    summaries=[]
    for size in args.models:
        for sampler in args.samplers:
            for bpm in [100,150]:
                rows=[r for r in report['rows'] if (r['model'],r['sampler'],r['bpm'])==(size,sampler,bpm)]
                latencies=sorted(r['latency_ms'] for r in rows)
                notes=sum(r['notes'] for r in rows)
                summaries.append({'model':size,'sampler':sampler,'bpm':bpm,'trials':len(rows),
                    'nonempty':sum(r['nonempty'] for r in rows),'deadline_met':sum(r['deadline_met'] for r in rows),
                    'budget_met':sum(r['budget_met'] for r in rows),
                    'median_ms':statistics.median(latencies),'max_ms':max(latencies),
                    'mean_notes':notes/len(rows),'mean_occupied_fraction':statistics.mean(r['occupied_fraction'] for r in rows),
                    'diatonic_fraction':sum(r['diatonic_count'] for r in rows)/max(1,notes),
                    'tonic_triad_fraction':sum(r['tonic_triad_count'] for r in rows)/max(1,notes)})
    report['summaries']=summaries
    with open(args.output,'w') as f: json.dump(report,f,indent=2)
    print(json.dumps(summaries,indent=2),flush=True)

if __name__=='__main__':
    run()
