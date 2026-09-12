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
