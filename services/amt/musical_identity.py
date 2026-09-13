"""Bounded human phrase memory and conservative, beat-aware call and response.

The session owns one instance and observes PerformanceHistory before pruning.
Only actual released human notes teach a hook. Model output supplies the voice
and register; arrangement/harmony policy must still run after ``shape``.
"""
import math
from statistics import median

from arrangement import role_for_instrument


class MusicalIdentity:
    MAX_PENDING = 256
    MAX_PHRASE = 64

    def __init__(self):
        self.reset()

    def reset(self):
        self.response_applied = False
        self.response_instrument = None
        self.pending = {}
        self.phrase = ()
        self.latest_release = None
        self.held = False
        self._captured_through = -math.inf
        self._last_answer = -math.inf
        self._observed_through = -math.inf
        self._shaped_through = -math.inf
        self._cached_key = None
        self._cached_answer = ()
        self._cached_region = None

    def observe(self, notes, records, now_beat):
        """Observe beat tuples and lifecycle records; repeated history is harmless.

        A phrase occupies two to four 4/4 bars, including a final rest. Require
        onsets in both bars, three notes, and a release gap. Dense/polyphonic calls
        are deliberately not collapsed into an invented top-note melody.
        """
        if now_beat < max(self._observed_through, self._shaped_through):
            return
        self._observed_through = now_beat
        by_index = {r.get('note_index'): r for r in records.values()}
        self.held = any(r.get('held', False) and r.get('beat', math.inf) <= now_beat
                        for r in records.values())
        for index, note in enumerate(notes):
            beat, duration, pitch = note
            if (not all(math.isfinite(v) for v in note) or duration <= 0
                    or beat < 0 or not 0 <= pitch <= 127 or beat > now_beat):
                continue
            record = by_index.get(index, {})
            if record.get('held', False) or beat + duration > now_beat:
                self.held = True
                continue
            release = beat + duration
            self.latest_release = max(self.latest_release or 0, release)
            if beat <= self._captured_through:
                continue
            try:
                confidence = float(record.get('confidence', 1))
            except (TypeError, ValueError, OverflowError):
                continue
            if not math.isfinite(confidence) or confidence < .5:
                continue
            self.pending[(beat, pitch)] = (beat, duration, pitch)
        self.pending = dict(sorted(((key, note) for key, note in self.pending.items()
                                   if note[0] >= now_beat - 32), key=lambda item: item[0])[-self.MAX_PENDING:])
        if self.held or self.latest_release is None or now_beat - self.latest_release < 1:
            return
        candidate = sorted(self.pending.values())
        if not candidate:
            return
        # Keep the most recent four bars if a long passage had no earlier gap.
        candidate = [n for n in candidate if n[0] >= candidate[-1][0] + candidate[-1][1] - 16]
        if not candidate:
            return
        first, last = candidate[0], candidate[-1]
        if (len(candidate) < 3 or len(candidate) > self.MAX_PHRASE
                or now_beat - first[0] < 8 or last[0] - first[0] < 4):
            return
        if any(b[0] < a[0] + a[1] - .125 or b[0] - a[0] < .125
               for a, b in zip(candidate, candidate[1:])):
            return
        self.phrase = tuple((beat - first[0], duration, pitch) for beat, duration, pitch in candidate)
        self._captured_through = last[0]
        self.pending = {key: note for key, note in self.pending.items() if note[0] > self._captured_through}

    def shape(self, notes, start_beat, end_beat, beat_seconds, now_beat, creativity, section):
        """Return seconds tuples, replacing one existing melodic voice for <=2 beats.

        Empty model output never creates music. A cached identical cue returns
        the same answer without consuming another cooldown. Future cues require
        an eight-beat cooldown, a real one-beat human release gap, and recent play.
        """
        self.response_applied = False
        self.response_instrument = None
        original = list(notes)
        if now_beat < max(self._observed_through, self._shaped_through):
            return original
        self._shaped_through = now_beat
        key = (hash(tuple(original)), start_beat, end_beat, beat_seconds, now_beat,
               creativity, section, self.phrase, self.latest_release, self.held)
        if key == self._cached_key:
            self.response_applied = True
            self.response_instrument = self._cached_region[0]
            return self._replace(original, self._cached_answer, *self._cached_region)
        if (not original or not self.phrase or self.held or beat_seconds <= 0
                or self.latest_release is None or not 1 <= now_beat - self.latest_release < 16
                or now_beat - self._last_answer < 8 or end_beat - start_beat < 1
                or section in ('intro', 'ending', 'ended')):
            return original
        start = max(start_beat, now_beat)
        length = min(2, end_beat - start)
        if length < 1:
            return original
        start_s, end_s = start * beat_seconds, (start + length) * beat_seconds
        melodic = [n for n in original if 0 <= n[2] < 128 and role_for_instrument(n[2]) != 'bass'
                   and start_s <= n[0] < end_s]
        if not melodic:
            return original
        guitars = [n for n in melodic if 24 <= n[2] <= 31]
        instrument = (guitars or melodic)[0][2]
        voice = [n for n in melodic if n[2] == instrument]
        # Quote the opening two beats at the original rhythm, never squeeze a
        # whole phrase into a burst that the final grid/density policy discards.
        excerpt = [(t, min(d, length - t), p) for t, d, p in self.phrase if t < length]
        if len(excerpt) < 2:
            return original
        # Interval expansion changes transformation, never density. Keep guitar
        # answers in a practical two-to-three-octave lead register.
        expansion = 1 + .35 * max(0, min(1, (creativity - .4) / .6))
        low, high = (48, 88) if 24 <= instrument <= 31 else (24, 108)
        pitch_span = max(p for _, _, p in excerpt) - min(p for _, _, p in excerpt)
        expansion = min(expansion, (high - low) / max(1, pitch_span))
        intervals = [round((p - excerpt[0][2]) * expansion) for _, _, p in excerpt]
        base = round(median(n[3] for n in voice) - median(intervals))
        base += {'lift': 12, 'breakdown': -12}.get(section, 0)
        base = max(low - min(intervals), min(high - max(intervals), base))
        answer = [((start + t) * beat_seconds, d * beat_seconds, instrument, base + offset)
                  for (t, d, _), offset in zip(excerpt, intervals)]
        self.response_applied = True
        self.response_instrument = instrument
        self._last_answer = now_beat
        self._cached_key, self._cached_answer = key, tuple(answer)
        self._cached_region = (instrument, start_s, end_s)
        return self._replace(original, answer, instrument, start_s, end_s)

    @staticmethod
    def _replace(original, answer, instrument, start_s, end_s):
        result = [n for n in original if not (n[2] == instrument and start_s <= n[0] < end_s)]
        result.extend(answer)
        result.sort(key=lambda n: n[0])
        return result
