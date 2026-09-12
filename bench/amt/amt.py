"""
Thin interface to the Anticipatory Music Transformer for two-voice duet
generation: event <-> token encoding, instrument masking, and constrained
autoregressive sampling. Nothing here knows about real time or scheduling --
that's the scheduler's job.
"""

import time

import torch
import torch.nn.functional as F

from anticipation import ops
from anticipation.sample import safe_logits, future_logits, nucleus
from anticipation.config import TIME_RESOLUTION
from anticipation.vocab import TIME_OFFSET, DUR_OFFSET, NOTE_OFFSET, MAX_NOTE, AUTOREGRESS

MELODY_INSTR = 0     # GM acoustic grand piano -- stands in for the live performer
ACCOMP_INSTR = 40    # GM violin -- the AI duet partner (empirically the model's
                      # favorite accompaniment voice for a solo piano prompt)

# Even restricted to these two instruments, the model is free to spend an
# entire window "predicting" more piano (the ReaLJam-style trick of jointly
# imagining the human's continuation) and write zero violin notes. Since we
# discard every piano-instrument note past the live playhead anyway, there's
# no coherence cost to biasing sampling toward the instrument we keep.
ACCOMP_BIAS = 2.0


def make_event(time_s, dur_s, instr, pitch):
    t = TIME_OFFSET + max(0, round(time_s * TIME_RESOLUTION))
    d = DUR_OFFSET + max(1, round(dur_s * TIME_RESOLUTION))
    n = NOTE_OFFSET + instr * 128 + pitch
    return [t, d, n]


def parse_events(tokens):
    """Yield (time_s, dur_s, instr, pitch) for a flat list of ordinary event triples."""
    for t, d, n in zip(tokens[0::3], tokens[1::3], tokens[2::3]):
        yield (
            (t - TIME_OFFSET) / TIME_RESOLUTION,
            (d - DUR_OFFSET) / TIME_RESOLUTION,
            (n - NOTE_OFFSET) // 128,
            (n - NOTE_OFFSET) % 128,
        )


def _instr_mask_logits(logits, accomp_bias, accomp_only=True):
    # Lakh MIDI is full of multi-track songs, so a base AMT checkpoint given
    # only a sparse two-instrument prompt tends to free-associate across
    # dozens of unrelated GM instruments instead of staying in character as a
    # duet partner. Mask note logits down to just the voices in play.
    #
    # `accomp_bias` alone is not enough. Measured on the pod with a plain
    # C-major quarter-note melody, a +2.0 logit nudge still left the model
    # writing *only* melody-instrument notes: over four 4-beat windows it
    # produced 16 events and zero accompaniment ones, so the caller -- which
    # keeps nothing but accompaniment -- got an empty plan. Since every
    # melody-instrument note the model invents past the playhead is discarded
    # anyway (the real performer supplies that part), drop the instrument from
    # the vocabulary outright and spend the whole window on the voice we keep.
    # REST stays available, so the model can still choose silence.
    keep = torch.full((MAX_NOTE,), float("-inf"), device=logits.device, dtype=logits.dtype)
    if not accomp_only:
        keep[MELODY_INSTR * 128:(MELODY_INSTR + 1) * 128] = 0.0
    keep[ACCOMP_INSTR * 128:(ACCOMP_INSTR + 1) * 128] = accomp_bias
    logits[NOTE_OFFSET:NOTE_OFFSET + MAX_NOTE] += keep
    return logits


def _add_token(model, tokens, top_p, current_time, accomp_bias, accomp_only=True):
    """anticipation.sample.add_token, plus the instrument mask above."""
    history = tokens.copy()
    lookback = max(len(tokens) - 1017, 0)
    history = history[lookback:]
    offset = ops.min_time(history, seconds=False)
    history[::3] = [tok - offset for tok in history[::3]]

    new_token = []
    with torch.no_grad():
        for i in range(3):
            input_tokens = torch.tensor([AUTOREGRESS] + history + new_token).unsqueeze(0).to(model.device)
            logits = model(input_tokens).logits[0, -1]
            idx = input_tokens.shape[1] - 1
            logits = safe_logits(logits, idx)
            if i == 0:
                logits = future_logits(logits, current_time - offset)
            elif i == 2:
                logits = _instr_mask_logits(logits, accomp_bias, accomp_only)
            logits = nucleus(logits, top_p)
            probs = F.softmax(logits, dim=-1)
            token = torch.multinomial(probs, 1)
            new_token.append(int(token))

    new_token[0] += offset
    return new_token


def generate_duet(model, start_time, end_time, inputs, top_p=1.0, accomp_bias=ACCOMP_BIAS,
                  accomp_only=True, deadline_s=None, min_interval_ticks=1):
    """
    anticipation.sample.generate_ar, restricted to a two-instrument duet.

    Continues the accompaniment instrument from start_time to end_time given
    the prior events in `inputs` (both parts). With `accomp_only=False` it
    jointly continues the melody instrument too, in the model's own
    imagine-both-parts style -- which every caller then throws away, and which
    in practice crowds the accompaniment out of the window entirely.

    `deadline_s` bounds the sampling loop in wall-clock seconds. Only the time
    token is constrained during sampling (to be no earlier than the previous
    event), so the model is free to keep stacking notes on one tick and never
    advance to `end_time` -- observed live as a window that never returned.
    Past the deadline, generation stops and returns what it has, which is the
    same underrun the schedulers above it already know how to report.

    `min_interval_ticks` is how far the clock must advance between events.
    Callers commit a single voice and drop every note sharing an onset with
    the one before it, so simultaneity is sampling budget spent on notes that
    are thrown away -- and it is exactly how the loop stalls: with nothing
    forcing the clock forward, the model piles a whole window's budget onto
    the first tick and the deadline expires on a one-note "plan". A caller
    playing to a beat grid should pass its shortest note value rather than the
    1-tick default, which still admits 10ms flams.
    """
    start_time = int(TIME_RESOLUTION * start_time)
    end_time = int(TIME_RESOLUTION * end_time)

    inputs = ops.sort(inputs)
    tokens = ops.pad(ops.clip(inputs, 0, start_time, clip_duration=False, seconds=False), start_time)
    current_time = ops.max_time(tokens, seconds=False)

    began = time.monotonic()
    while True:
        if deadline_s is not None and time.monotonic() - began >= deadline_s:
            break
        new_token = _add_token(model, tokens, top_p, max(start_time, current_time), accomp_bias,
                               accomp_only)
        new_time = new_token[0] - TIME_OFFSET
        if new_time >= end_time:
            break
        tokens.extend(new_token)
        current_time = new_time + max(1, min_interval_ticks)

    return ops.sort(ops.unpad(tokens))
