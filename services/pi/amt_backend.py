"""Offline CPU AMT backend. Start with AMT_MODEL pointing to a local checkpoint.

Uses the shared AMT Session and arrangement rules. Only the sampler and CPU
loader differ. Model work is serialized; receiving notes never waits on inference.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import time

import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# musicpy is imported by the shared benchmark module; it must not open ALSA.
os.environ.setdefault('SDL_AUDIODRIVER', 'dummy')

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services' / 'amt'))
import server as shared
from amt import _instr_mask_logits
from anticipation import ops
from anticipation.config import TIME_RESOLUTION
from anticipation.vocab import AUTOREGRESS, TIME_OFFSET, DUR_OFFSET, NOTE_OFFSET, REST
from anticipation.sample import safe_logits, future_logits, nucleus


from cached import forward_last, prepare_context, cached_generate

def convert_conv1d(module):
    from transformers.pytorch_utils import Conv1D
    for name, child in list(module.named_children()):
        if isinstance(child, Conv1D):
            linear = torch.nn.Linear(child.weight.shape[0], child.weight.shape[1])
            linear.weight = torch.nn.Parameter(child.weight.T.contiguous())
            linear.bias = torch.nn.Parameter(child.bias.detach().clone())
            setattr(module, name, linear)
        else:
            convert_conv1d(child)



_model = None
MODEL_PATH = os.environ.get('AMT_MODEL', '/home/test/duet-ai-model/model')
THREADS = int(os.environ.get('AMT_THREADS', '4'))
QUANTIZE = os.environ.get('AMT_QUANTIZE', '0') == '1'
SAMPLER = os.environ.get('AMT_SAMPLER', 'cached')
BUDGET_FRACTION = float(os.environ.get('AMT_BUDGET_FRACTION', '0.8'))
if not 0.2 <= BUDGET_FRACTION <= 0.8:
    raise ValueError('AMT_BUDGET_FRACTION must be between 0.2 and 0.8')
shared.GENERATION_BUDGET = BUDGET_FRACTION


def load_model():
    global _model
    if _model is None:
        from transformers import AutoModelForCausalLM
        torch.set_num_threads(THREADS)
        torch.set_num_interop_threads(1)
        model = AutoModelForCausalLM.from_pretrained(MODEL_PATH,
                    local_files_only=True, attn_implementation='eager').eval()
        if QUANTIZE:
            torch.backends.quantized.engine = 'qnnpack'
            convert_conv1d(model)
            model = torch.ao.quantization.quantize_dynamic(
                model, {torch.nn.Linear}, dtype=torch.qint8).eval()
        _model = model
        if SAMPLER == 'cached':
            shared.generate_duet = cached_generate
    return _model


def generate_plan(session, bar):
    out = session.generate_next_bar_plan(bar)
    elapsed = out['status']['latencyMs'] / 1000
    # Shared token counts subtract padded history from an unpadded result.
    # Count actual sampled tokens in the cached sampler instead.
    if SAMPLER == 'cached' and elapsed:
        out['status']['tokensPerSec'] = getattr(session.model, 'amt_sampled_tokens', 0) / elapsed
    return out


app = FastAPI()
app.add_middleware(CORSMiddleware,
    allow_origins=['http://127.0.0.1:8088', 'http://localhost:8088'],
    allow_methods=['GET'], allow_headers=['*'])
inference_lock = asyncio.Lock()


@app.on_event('startup')
async def startup():
    await asyncio.to_thread(load_model)


@app.get('/health')
async def health():
    return {'status': 'ok' if _model is not None else 'loading', 'backend': 'local-amt',
            'device': 'cpu', 'model': 'stanford-crfm/music-small-800k',
            'sampler': SAMPLER, 'quantized': QUANTIZE, 'threads': THREADS,
            'budgetFraction': BUDGET_FRACTION}


@app.websocket('/amt')
@app.websocket('/ws')
async def endpoint(ws: WebSocket):
    await ws.accept()
    session = shared.Session(load_model())
    queue = asyncio.Queue(maxsize=128)

    async def worker():
        while True:
            msg = await queue.get()
            kind = msg.get('type')
            try:
                if kind == 'start':
                    bpm = float(msg.get('bpm', 100))
                    if not 30 <= bpm <= 300:
                        raise ValueError('bpm must be between 30 and 300')
                    session.reset(bpm, min(16, max(1, float(msg.get('lookaheadBeats', 4)))),
                                  min(4, max(1, float(msg.get('commitBeats', 2)))),
                                  min(32, max(0, float(msg.get('listenBeats', 8)))), .95)
                    session.plan_bars = 2 if bpm > 110 else 1
                    session.key = msg.get('key')
                elif kind == 'notes':
                    notes = msg.get('notes', [])[:256]
                    session.add_human_notes([n for n in notes
                        if 0 <= int(n['pitch']) <= 127 and 0 <= float(n['beat']) < 1e7
                        and 0 < float(n.get('dur', .5)) <= 32])
                elif kind == 'set':
                    session.key = msg.get('key', session.key)
                    session.chord = msg.get('chord', session.chord)
                    session.space = bool(msg.get('space', False))
                    session.top_p = .75 + min(1, max(0, float(msg.get('creativity', .3)))) * .2
                elif kind == 'bar':
                    if int(msg.get('bar', 0)) % session.plan_bars:
                        continue
                    if not session.human_notes:
                        continue  # Listen until actual performer notes arrive.
                    async with inference_lock:
                        out = await asyncio.to_thread(generate_plan, session, int(msg.get('bar', 0)))
                    await ws.send_json(out['plan'])
                    await ws.send_json(out['status'])
                elif kind == 'ping':
                    await ws.send_json({'type': 'pong'})
                else:
                    raise ValueError('unknown message type')
            except WebSocketDisconnect:
                return
            except Exception as exc:
                await ws.send_json({'type': 'error', 'message': str(exc)})

    task = asyncio.create_task(worker())
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                await ws.send_json({'type': 'error', 'message': 'expected object'})
                continue
            if queue.full():
                await ws.close(code=1013, reason='inference queue full; reconnect')
                break
            queue.put_nowait(msg)
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        # Do not release the model lock before a to_thread inference finishes.
        # The sentinel-free worker is stopped only after its current call finishes.
        while not queue.empty():
            queue.get_nowait()
        if task.done():
            task.result()
        else:
            async with inference_lock:
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)


if __name__ == '__main__':
    uvicorn.run(app, host=os.environ.get('AMT_HOST', '127.0.0.1'),
                port=int(os.environ.get('AMT_PORT', '18081')))
