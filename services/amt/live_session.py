"""Bounded session actor: receive continuously, generate only the newest pending cue.

Only the worker mutates session state. Inference gets an isolated candidate; obsolete
candidates never become model history. The model object itself is shared under one lock.
"""
import asyncio
import copy
import time
from collections import deque


class InputOverflow(ValueError):
    pass


def clone_session(session):
    clone = type(session).__new__(type(session))
    # Copy this mapping in one operation to preserve aliases (committer.history).
    clone.__dict__.update(copy.deepcopy({k:v for k,v in vars(session).items() if k != 'model'}))
    clone.model = session.model
    return clone


class LatestPlanner:
    def __init__(self, session, model_lock, apply, generate, emit, clone=clone_session, max_events=4096):
        self.session, self.lock = session, model_lock
        self.apply, self.generate, self.emit, self.clone = apply, generate, emit, clone
        self.max_events = max_events
        self.commands = deque()
        self.event_count = 0
        self.input_revision = 0
        self.material_controls = {}
        self.pending_cue = None
        self.revision = 0
        self.epoch = 0
        self.closed = False
        self.changed = asyncio.Event()
        self.task = asyncio.create_task(self._run())

    def submit(self, msg):
        if self.closed:
            return
        kind = msg.get('type')
        if kind == 'start':
            self.epoch += 1
            self.revision += 1
            self.commands.clear()
            self.event_count = 0
            self.pending_cue = None
        if kind in ('bar', 'tick'):
            self.revision += 1
            self.pending_cue = (dict(msg), self.revision, self.epoch, time.monotonic())
        else:
            # Normal quiet-gap telemetry arrives several times a second. Only
            # new performance or materially changed controls invalidate an answer.
            if kind in ('notes', 'note_updates', 'start'):
                self.input_revision += 1
            if kind in ('set', 'start'):
                if kind == 'start':
                    self.material_controls.clear()
                for name in ('amount', 'enabledRoles', 'accompInstruments', 'key',
                             'creativity', 'accompBias', 'genre', 'chord'):
                    if name in msg and msg[name] != self.material_controls.get(name):
                        self.input_revision += 1
                        self.material_controls[name] = copy.deepcopy(msg[name])
            count = max(1, len(msg.get('notes', [])))
            if self.event_count + count > self.max_events:
                raise InputOverflow('AMT input backlog exceeded; reconnect to reset the session')
            self.commands.append(msg)
            self.event_count += count
        self.changed.set()

    async def _run(self):
        while not self.closed:
            await self.changed.wait()
            self.changed.clear()
            if self.closed:
                break
            result = None
            revision, epoch = self.revision, self.epoch
            try:
                async with self.lock:
                    if self.closed:
                        break
                    # Drain after acquiring the model, so time spent waiting never freezes
                    # obsolete notes/controls/cues ahead of newer client input.
                    while self.commands:
                        command = self.commands.popleft()
                        # Account for removal even when validation/application raises.
                        self.event_count -= max(1, len(command.get('notes', [])))
                        self.apply(self.session, command)
                    cue = self.pending_cue
                    self.pending_cue = None
                    if cue is None:
                        continue
                    msg, revision, epoch, received = cue
                    queue_ms = (time.monotonic()-received)*1000
                    input_revision = self.input_revision
                    candidate = self.clone(self.session)
                    inference = asyncio.create_task(asyncio.to_thread(self.generate, candidate, msg))
                    try:
                        out = await asyncio.shield(inference)
                    except asyncio.CancelledError:
                        # A Python thread cannot be cancelled: retain exclusion until it exits.
                        await inference
                        raise
                    if not self.closed and revision == self.revision and epoch == self.epoch:
                        out['plan'].update({k:msg[k] for k in ('cueId','latestCaptureTimeSec') if k in msg})
                        out['status'].update({'queueLatencyMs':queue_ms, 'requestAgeMs':(time.monotonic()-received)*1000})
                        result = out
                if result is not None:
                    def commit_if_current():
                        # The emitter invokes this after acquiring its send lock, without
                        # another await before handing the plan to the socket. A candidate
                        # blocked on output must never enter the live model history early.
                        if self.closed or revision != self.revision or epoch != self.epoch:
                            return False
                        if result["plan"].get("phraseResponse") and input_revision != self.input_revision:
                            return False
                        self.session = candidate
                        result['status']['requestAgeMs'] = (time.monotonic()-received)*1000
                        return True
                    await self.emit(result, commit_if_current)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if self.commands or self.pending_cue is not None:
                    self.changed.set()
                if not self.closed:
                    await self.emit({'error':str(error)}, lambda: not self.closed and
                                    revision == self.revision and epoch == self.epoch)

    async def close(self):
        self.closed = True
        self.pending_cue = None
        self.commands.clear()
        self.event_count = 0
        self.changed.set()
        # Do not cancel live inference and accidentally release the global GPU lock early.
        await self.task
