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
from anticipation.vocab import TIME_OFFSET, DUR_OFFSET, NOTE_OFFSET, MAX_NOTE, MAX_DUR, AUTOREGRESS

MELODY_INSTR = 0     # GM acoustic grand piano -- stands in for the live performer

# Companion voice(s). A sweep of candidate GM instruments against a solo
# piano prompt found wildly different note yields (violin ~40+ notes per
# window, acoustic bass ~0) -- these are the ones actually confirmed to
# produce substantial output with this model and melody, not just an
# idiomatically plausible pairing. Verified as an ensemble too (all three
# masked in together, not just individually): violin/viola/cello each
# actually got used across repeated trials, combined density 7-80 notes per
# 4-beat window depending on sampling luck -- not one voice starving out
# the others. STRING_ENSEMBLE_ACCOMP_INSTRS is the default: a lone violin
# was consistently too sparse against a real, densely-played performance to
# be heard at all (see SETUP.md in the Music repo this was ported from).
SOLO_ACCOMP_INSTRS = (40,)                    # one violin
STRING_ENSEMBLE_ACCOMP_INSTRS = (40, 41, 42)  # violin, viola, cello -- the default

# A broader sweep (each candidate solo-masked, 3 trials, against the same
# 8-beat piano prompt): electric piano 69 notes/3 trials, nylon guitar 219(!),
# string-ensemble patch 43, trumpet 47, alto sax 109, flute 20, new-age pad
# 25, harp 20 -- all real, usable output, not guessed. Named so a caller
# doesn't need to know GM program numbers.
INSTRUMENT_PRESETS = {
    "strings": STRING_ENSEMBLE_ACCOMP_INSTRS,  # violin, viola, cello
    "violin": SOLO_ACCOMP_INSTRS,
    "guitar": (24,),        # nylon guitar -- the strongest single voice found
    "sax": (65,),           # alto sax
    "brass": (56,),         # trumpet
    "keys": (4,),           # electric piano
    "orchestral": (48, 46),  # string-ensemble patch + harp
    "ambient": (88, 73),    # new-age pad + flute
}

# Even restricted to a small instrument set, the model is free to spend an
# entire window "predicting" more piano (the ReaLJam-style trick of jointly
# imagining the human's continuation) and write zero accompaniment notes.
# Since we discard every piano-instrument note past the live playhead
# anyway, there's no coherence cost to biasing sampling toward the
# instruments we keep.
ACCOMP_BIAS = 2.0


def make_event(time_s, dur_s, instr, pitch):
    t = TIME_OFFSET + max(0, round(time_s * TIME_RESOLUTION))
    d = DUR_OFFSET + min(MAX_DUR - 1, max(1, round(dur_s * TIME_RESOLUTION)))
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


def _instr_mask_logits(logits, accomp_instrs, accomp_bias, accomp_only=True):
    # Lakh MIDI is full of multi-track songs, so a base AMT checkpoint given
    # only a sparse prompt tends to free-associate across dozens of unrelated
    # GM instruments instead of staying in character as a duet partner. Mask
    # note logits down to just the voices actually in play.
    #
    # `accomp_bias` alone is not enough. Measured on the pod with a plain
    # C-major quarter-note melody, a +2.0 logit nudge still left the model
    # writing *only* melody-instrument notes: over four 4-beat windows it
    # produced 16 events and zero accompaniment ones, so the caller -- which
    # keeps nothing but accompaniment -- got an empty plan. Since every
    # melody-instrument note the model invents past the playhead is discarded
    # anyway (the real performer supplies that part), `accomp_only` drops the
    # instrument from the vocabulary outright and spends the whole window on
    # the voices we keep. REST stays available, so the model can still choose silence.
    keep = torch.full((MAX_NOTE,), float("-inf"), device=logits.device, dtype=logits.dtype)
    if not accomp_only:
        keep[MELODY_INSTR * 128:(MELODY_INSTR + 1) * 128] = 0.0
    for instr in accomp_instrs:
        keep[instr * 128:(instr + 1) * 128] = accomp_bias
    logits[NOTE_OFFSET:NOTE_OFFSET + MAX_NOTE] += keep
    return logits


def _cached_logits(model, prefix, cache):
    """Reuse attention state only when every cached input token is unchanged."""
    previous = cache.get("prefix", [])
    reuse = previous and len(prefix) > len(previous) and prefix[:len(previous)] == previous
    suffix = prefix[len(previous):] if reuse else prefix
    input_tokens = torch.tensor([suffix], device=model.device)
    output = model(input_tokens, past_key_values=cache.get("past") if reuse else None,
                   use_cache=True)
    cache.update(prefix=prefix.copy(), past=output.past_key_values)
    return output.logits[0, -1]


def _add_token(model, tokens, top_p, temperature, current_time, accomp_instrs, accomp_bias,
               cache=None, accomp_only=True):
    """anticipation.sample.add_token, plus the instrument mask above."""
    history = tokens.copy()
    lookback = max(len(tokens) - 1017, 0)
    history = history[lookback:]
    offset = ops.min_time(history, seconds=False)
    history[::3] = [tok - offset for tok in history[::3]]

    new_token = []
    cache = {} if cache is None else cache
    with torch.inference_mode():
        for i in range(3):
            prefix = [AUTOREGRESS] + history + new_token
            # Sliding the context or rebasing timestamps resets cached attention.
            logits = _cached_logits(model, prefix, cache) / temperature
            idx = len(prefix) - 1
            logits = safe_logits(logits, idx)
            if i == 0:
                logits = future_logits(logits, current_time - offset)
            elif i == 2:
                logits = _instr_mask_logits(logits, accomp_instrs, accomp_bias, accomp_only)
            logits = nucleus(logits, top_p)
            probs = F.softmax(logits, dim=-1)
            token = torch.multinomial(probs, 1)
            new_token.append(int(token))

    new_token[0] += offset
    return new_token


def generate_duet(model, start_time, end_time, inputs, accomp_instrs=STRING_ENSEMBLE_ACCOMP_INSTRS,
                   top_p=1.0, accomp_bias=ACCOMP_BIAS, temperature=1.0, deadline_s=None,
                   min_interval_ticks=1, accomp_only=True):
    """
    anticipation.sample.generate_ar, restricted to melody + a chosen set of
    accompaniment instruments.

    Jointly continues both the melody instrument (discarded by the caller)
    and the accompaniment instrument(s) (kept) from start_time to end_time,
    given the prior events in `inputs`. `temperature` scales the raw logits
    before top_p truncation -- below 1.0 sharpens the distribution toward
    the model's most confident guesses (more conservative/predictable),
    above 1.0 flattens it (wilder, more surprising choices of pitch,
    duration, and timing alike, since all three are sampled through this
    same path). Distinct from top_p (nucleus truncation of the tail) and
    accomp_bias (a fixed preference for which instrument, not how sharply
    any of them is sampled).

    `deadline_s` bounds the sampling loop in wall-clock seconds. Only the time
    token is constrained during sampling (to be no earlier than the previous
    event), so the model is free to keep stacking notes on one tick and never
    advance to `end_time` -- observed live as a window that never returned.
    Past the deadline, generation stops and returns what it has, which is the
    same underrun a caller's own scheduler already knows how to report.

    `min_interval_ticks` is how far the clock must advance between events.
    A caller committing a single voice and dropping every note sharing an
    onset with the one before it has nothing to gain from the model spending
    its whole window piling notes onto one tick -- with nothing forcing the
    clock forward that's exactly how the loop stalls against `deadline_s`. A
    caller playing to a beat grid should pass its shortest note value rather
    than the 1-tick default, which still admits 10ms flams.
    """
    start_time = int(TIME_RESOLUTION * start_time)
    end_time = int(TIME_RESOLUTION * end_time)

    inputs = ops.sort(inputs)
    tokens = ops.pad(ops.clip(inputs, 0, start_time, clip_duration=False, seconds=False), start_time)
    current_time = ops.max_time(tokens, seconds=False)

    cache = {}
    began = time.monotonic()
    while True:
        if deadline_s is not None and time.monotonic() - began >= deadline_s:
            break
        new_token = _add_token(model, tokens, top_p, temperature, max(start_time, current_time),
                                accomp_instrs, accomp_bias, cache, accomp_only)
        new_time = new_token[0] - TIME_OFFSET
        if new_time >= end_time:
            break
        tokens.extend(new_token)
        current_time = new_time + max(1, min_interval_ticks)

    return ops.sort(ops.unpad(tokens))
