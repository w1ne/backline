"""GM instrument presets the live AMT server exposes for accompaniment mixing.

Imports amt.INSTRUMENT_PRESETS -- server.py has already added bench/amt/ to
sys.path by the time this module loads.
"""
from amt import INSTRUMENT_PRESETS

DEFAULT_PRESETS = ("strings",)

# Every preset the client can toggle, including the default string ensemble.
TOGGLEABLE_PRESETS = tuple(INSTRUMENT_PRESETS)


def resolve(names=None):
    """Resolve selected presets. Only an omitted selection uses the default ensemble."""
    names = DEFAULT_PRESETS if names is None else names
    names = [n for n in names if n in INSTRUMENT_PRESETS]
    programs = {p for name in names for p in INSTRUMENT_PRESETS[name]}
    return tuple(sorted(programs))


def resolve_groups(names=None):
    """One instrument tuple per selected preset, in selection order.

    The model is sampled once per group: the live history self-reinforces, so a single
    pass over the union of every selected instrument settles on whichever voice it wrote
    first and never brings in the others (a sax toggled on mid-song stayed silent for 40
    beats behind an established cello line). A pass masked to one preset at a time
    guarantees each tile a voice of its own.
    """
    names = DEFAULT_PRESETS if names is None else names
    seen = set()
    groups = []
    for name in names:
        if name in INSTRUMENT_PRESETS and name not in seen:
            seen.add(name)
            groups.append(tuple(sorted(INSTRUMENT_PRESETS[name])))
    return groups
