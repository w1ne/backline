"""Pure mapping from the pedal's /api/status to the sketch's `beat` call. No I/O here."""
import math

MODE_OFFLINE = 0   # pedal unreachable or audio not running: dim static heart
MODE_LISTEN = 1    # pedal up, no tempo yet: slow breathing heart
MODE_PLAY = 2      # band locked: heart pulses on every beat

FLAG_FILL = 1      # last bar of a four-bar group: burst of small hearts
FLAG_ANSWER = 2    # the player left space and the lead answers: sparkles

# Input level is RMS-ish; ~0.002 is silence on LYDIA, ~0.15 is a firm strum.
LEVEL_FULL = 0.15


def clamp01(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(x):
        return 0.0
    return min(1.0, max(0.0, x))


def energy(status):
    """0..1 mix of what the band is told to do and what the player is actually putting in."""
    intensity = clamp01(status.get('intensity', 0.5))
    level = clamp01(float(status.get('inputLevel', 0) or 0) / LEVEL_FULL)
    parts = status.get('activeParts') or {}
    busy = clamp01(sum(1 for v in parts.values() if v) / 4)
    return clamp01(0.4 * intensity + 0.4 * level + 0.2 * busy)


def mode(status):
    if not status.get('online') or status.get('power') != 'on' or status.get('audioSuspended'):
        return MODE_OFFLINE
    if status.get('locked') and status.get('bpm'):
        return MODE_PLAY
    return MODE_LISTEN


def flags(status):
    f = 0
    if status.get('fill'):
        f |= FLAG_FILL
    if status.get('space') and (status.get('enabled') or {}).get('lead'):
        f |= FLAG_ANSWER
    return f


def beat_args(status, now_ms):
    """Arguments for Bridge.call('beat', ...): bpm, energy, mode, flags, ms since the bar started.

    `since_bar_ms` lets the MCU align its own beat clock to the pedal's bar without
    depending on how quickly we happen to poll."""
    m = mode(status)
    bpm = float(status.get('bpm') or 0) if m == MODE_PLAY else 0.0
    started = status.get('barStartedAt')
    since = int(max(0, now_ms - started)) if (started and m == MODE_PLAY) else -1
    return (round(bpm, 2), round(energy(status), 3), m, flags(status), since)


class Sender:
    """Decides when a fresh `beat` call is worth making: on any parameter change, and once per
    bar while playing so the MCU clock cannot drift. `call` is the Bridge function."""

    def __init__(self, call):
        self.call = call
        self.last = None
        self.last_bar = None

    def push(self, status, now_ms):
        args = beat_args(status, now_ms)
        key = args[:4]
        bar = status.get('bar') if args[2] == MODE_PLAY else None
        if key == self.last and bar == self.last_bar:
            return False
        self.call('beat', *args)
        self.last = key
        self.last_bar = bar
        return True
