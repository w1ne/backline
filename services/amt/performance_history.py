"""Lifecycle-aware human note history, independent of the model runtime.

Token offsets identify notes, even when model events interleave with them. A release
rewrites the existing duration token; it never inserts another onset. The owner must
serialize mutations with generation (or generate against a private snapshot).
"""
import math


class PerformanceHistory:
    def __init__(self, tokens, encode, instrument, beat_seconds, on_note):
        self.tokens = tokens
        self.encode = encode
        self.instrument = instrument
        self.beat_seconds = beat_seconds
        self.on_note = on_note
        self.notes = []
        self.records = {}

    def add(self, notes):
        for note in notes:
            note_id = note.get('id')
            if note_id is not None and (not isinstance(note_id, str) or note_id in self.records):
                continue
            try:
                beat, duration, pitch = float(note['beat']), float(note.get('dur', .5)), int(note['pitch'])
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
            if not all(math.isfinite(v) for v in (beat, duration)) or beat < 0 or duration <= 0 or not 0 <= pitch <= 127:
                continue
            event = self.encode(beat * self.beat_seconds, duration * self.beat_seconds, self.instrument, pitch)
            if note_id is not None:
                self.records[note_id] = {**note, 'beat': beat, 'dur': duration, 'pitch': pitch,
                                         'token_index': len(self.tokens), 'note_index': len(self.notes), 'token_beat': beat,
                                         'held': bool(note.get('held', False))}
            self.tokens.extend(event)
            self.notes.append((beat, duration, pitch))
            self.on_note(pitch, beat)

    def _duration(self, record, duration):
        clipped_duration = max(.01, record['beat'] + duration - record['token_beat'])
        event = self.encode(record['token_beat'] * self.beat_seconds, clipped_duration * self.beat_seconds,
                            self.instrument, record['pitch'])
        self.tokens[record['token_index'] + 1] = event[1]
        self.notes[record['note_index']] = (record['beat'], duration, record['pitch'])
        record['dur'] = duration

    def update(self, updates):
        for update in updates:
            note_id = update.get('id')
            if not isinstance(note_id, str):
                continue
            record = self.records.get(note_id)
            if record is None:
                continue  # already pruned or from a reset session
            try:
                duration = float(update['dur'])
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
            if not math.isfinite(duration) or duration <= 0:
                continue
            self._duration(record, duration)
            record['held'] = False
            record['releaseCaptureTimeSec'] = update.get('captureTimeSec')

    def observe_through(self, beat):
        """A still-held note has sounded through the cue, without guessing its release."""
        for record in self.records.values():
            if record['held'] and beat > record['beat']:
                self._duration(record, max(.01, beat - record['beat']))

    def drop_prefix(self, token_count, cutoff_beat):
        """Called after removal; carry held notes forward as clipped context events.

        Original capture onset/duration stay in metadata. Only the model's context
        event is clipped, so a long sustained note neither disappears nor pins an
        unbounded history prefix. The reinserted event replaces the pruned one.
        """
        active_indices = {r['note_index'] for r in self.records.values() if r['held']}
        retained = [(i, note) for i, note in enumerate(self.notes)
                    if note[0] >= cutoff_beat or i in active_indices]
        note_indices = {old_index: new_index for new_index, (old_index, _) in enumerate(retained)}
        self.notes[:] = [note for _, note in retained]
        for note_id, record in list(self.records.items()):
            if record['token_index'] < token_count and record['held']:
                record['token_beat'] = cutoff_beat
                record['token_index'] = len(self.tokens)
                duration = max(.01, record['beat'] + record['dur'] - cutoff_beat)
                self.tokens.extend(self.encode(cutoff_beat * self.beat_seconds,
                                               duration * self.beat_seconds,
                                               self.instrument, record['pitch']))
            elif record['token_index'] < token_count or record['note_index'] not in note_indices:
                del self.records[note_id]
                continue
            else:
                record['token_index'] -= token_count
            record['note_index'] = note_indices[record['note_index']]
