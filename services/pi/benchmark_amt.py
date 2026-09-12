"""Measured CPU generation; no audio hardware needed. Prints JSON evidence.
Run separate processes for AMT_SAMPLER=baseline/cached and AMT_QUANTIZE=0/1.
"""
import argparse
import asyncio
import json
import platform
import resource
import statistics
import time
from pathlib import Path
import torch
import amt_backend as backend


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bars', type=int, default=8)
    ap.add_argument('--bpm', type=float, default=100)
    ap.add_argument('--output')
    ap.add_argument('--url', help='Benchmark an existing ws://.../amt service at real bar cadence')
    args = ap.parse_args()
    if args.bars < 2:
        ap.error('--bars must be at least 2')
    if args.url:
        asyncio.run(benchmark_socket(args))
        return
    began = time.monotonic()
    model = backend.load_model()
    load_seconds = time.monotonic() - began
    torch.manual_seed(42)
    session = backend.shared.Session(model)
    session.reset(args.bpm, 4, 2, 8, .81)
    session.key = 'C major'
    session.chord = 'C'
    rows = []
    for bar in range(args.bars):
        # Only reveal the preceding bar: real bar messages arrive at a downbeat.
        if bar:
            session.add_human_notes([{'beat': (bar - 1) * 4 + j, 'dur': .7,
                'pitch': [60, 64, 67, 65, 62, 64, 69, 67][((bar - 1) * 4 + j) % 8]}
                for j in range(4)])
        started = time.monotonic()
        out = backend.generate_plan(session, bar)
        seconds = time.monotonic() - started
        notes = [n for n in out['plan']['notes'] if n['voice'] == 'keys']
        row = {'bar': bar, 'seconds': seconds, 'notes': len(notes),
               'notes_per_second': len(notes) / seconds, 'context_tokens': len(session.history),
               'deadline_seconds': 240 / args.bpm, 'late': seconds >= 240 / args.bpm,
               'status': out['status'], 'plan': out['plan']}
        rows.append(row)
        print(json.dumps(row), flush=True)
    measured = rows[1:]  # first bar is listen-only; cold first inference remains included
    report = {'platform': platform.platform(), 'machine': platform.machine(),
              'torch': torch.__version__, 'sampler': backend.SAMPLER,
              'quantized': backend.QUANTIZE, 'threads': backend.THREADS,
              'budget_fraction': backend.BUDGET_FRACTION,
              'load_seconds': load_seconds,
              'max_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
              'bpm': args.bpm, 'rows': rows,
              'generation_seconds_median': statistics.median(r['seconds'] for r in measured),
              'generation_seconds_max': max(r['seconds'] for r in measured),
              'late_windows': sum(r['late'] for r in measured),
              'empty_windows': sum(r['notes'] == 0 for r in measured),
              'notes_per_second': sum(r['notes'] for r in measured) / sum(r['seconds'] for r in measured)}
    print(json.dumps(report), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n')


async def benchmark_socket(args):
    import websockets
    rows = []
    async with websockets.connect(args.url) as ws:
        await ws.send(json.dumps({'type': 'start', 'bpm': args.bpm, 'key': 'C major',
                                 'lookaheadBeats': 4, 'commitBeats': 2, 'listenBeats': 8}))
        await ws.send(json.dumps({'type': 'set', 'key': 'C major', 'chord': 'C', 'creativity': .3}))
        for bar in range(1, args.bars):
            await ws.send(json.dumps({'type': 'notes', 'notes': [
                {'beat': (bar - 1) * 4 + j, 'dur': .7,
                 'pitch': [60, 64, 67, 65, 62, 64, 69, 67][((bar - 1) * 4 + j) % 8]}
                for j in range(4)]}))
            started = time.monotonic()
            await ws.send(json.dumps({'type': 'bar', 'bar': bar}))
            plan = json.loads(await asyncio.wait_for(ws.recv(), 20))
            status = json.loads(await asyncio.wait_for(ws.recv(), 20))
            if plan.get('type') != 'plan' or status.get('type') != 'status':
                raise RuntimeError(f'unexpected service frames: {plan}, {status}')
            elapsed = time.monotonic() - started
            notes = sum(n['voice'] == 'keys' for n in plan['notes'])
            row = {'bar': bar, 'seconds': elapsed, 'notes': notes,
                   'notes_per_second': notes / elapsed, 'late': elapsed >= 240 / args.bpm,
                   'deadline_seconds': 240 / args.bpm, 'plan': plan, 'status': status}
            rows.append(row)
            print(json.dumps(row), flush=True)
            await asyncio.sleep(max(0, 240 / args.bpm - elapsed))
    report = {'measurement': 'websocket service round trip at real bar cadence',
              'url': args.url, 'bpm': args.bpm, 'rows': rows,
              'generation_seconds_median': statistics.median(r['seconds'] for r in rows),
              'generation_seconds_max': max(r['seconds'] for r in rows),
              'late_windows': sum(r['late'] for r in rows),
              'empty_windows': sum(r['notes'] == 0 for r in rows),
              'notes_per_second': sum(r['notes'] for r in rows) / sum(r['seconds'] for r in rows)}
    print(json.dumps(report), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
