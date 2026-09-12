"""GM instrument presets the live AMT server exposes for accompaniment mixing.

Imports amt.INSTRUMENT_PRESETS -- server.py has already added bench/amt/ to
sys.path by the time this module loads.
"""
from amt import INSTRUMENT_PRESETS, STRING_ENSEMBLE_ACCOMP_INSTRS

DEFAULT_PRESETS = ("strings",)

# Every preset the client can toggle, including the default string ensemble.
TOGGLEABLE_PRESETS = tuple(INSTRUMENT_PRESETS)


def resolve(names):
    """GM program numbers for a set of preset names, falling back to the default ensemble."""
    names = [n for n in names if n in INSTRUMENT_PRESETS] or list(DEFAULT_PRESETS)
    programs = {p for name in names for p in INSTRUMENT_PRESETS[name]}
    return tuple(sorted(programs)) or STRING_ENSEMBLE_ACCOMP_INSTRS
