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
from amt import _instr_mask_logits, STRING_ENSEMBLE_ACCOMP_INSTRS
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


def cached_generate(model, start_time, end_time, inputs, accomp_instrs=STRING_ENSEMBLE_ACCOMP_INSTRS,
                    top_p=1.0, accomp_bias=2.0, temperature=1.0, deadline_s=None,
                    min_interval_ticks=1, accomp_only=True):
    # Same positional signature as amt.generate_duet: server.Session calls it positionally.
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
                ids = torch.tensor([[AUTOREGRESS] + history], dtype=torch.long)
                position = len(history)
                cache = None
            event = []
            for i in range(3):
                logits, cache = forward_last(model, ids, cache, i)
                logits = safe_logits(logits, position)
                if i == 0:
                    logits = future_logits(logits, max(start, current) - offset)
                elif i == 2:
                    logits = _instr_mask_logits(logits, accomp_instrs, accomp_bias, accomp_only)
                logits = nucleus(logits, top_p)
                token = int(torch.multinomial(torch.softmax(logits, -1), 1))
                event.append(token)
                ids = torch.tensor([[token]], dtype=torch.long)
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
