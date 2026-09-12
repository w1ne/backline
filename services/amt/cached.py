"""Cached AMT event sampler shared by CUDA service and optional CPU runtime."""
import time
import torch
from amt import _instr_mask_logits
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

