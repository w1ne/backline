import asyncio
import threading
import unittest
from types import SimpleNamespace
from live_session import LatestPlanner, InputOverflow, clone_session

class LatestPlannerTest(unittest.IsolatedAsyncioTestCase):
    async def test_newest_cue_wins_and_obsolete_history_is_not_committed(self):
        began, release = threading.Event(), threading.Event()
        seen, output = [], []
        def generate(s, cue):
            seen.append((cue['beat'], list(s.history)))
            if cue['beat'] == 0:
                began.set(); release.wait(2)
            s.history.append('generated-'+str(cue['beat']))
            return {'plan':{'notes':[]},'status':{}}
        async def emit(result, commit):
            if commit(): output.append(result)
        def apply(s,msg):
            if msg['type']=='notes': s.history.extend(msg['notes'])
            elif msg['type']=='start': s.history=[]
        worker=LatestPlanner(SimpleNamespace(model=object(),history=[]),asyncio.Lock(),apply,generate,emit)
        worker.submit({'type':'tick','beat':0,'cueId':1})
        await asyncio.to_thread(began.wait,1)
        worker.submit({'type':'notes','notes':['fresh-note']})
        for beat in range(1,20): worker.submit({'type':'tick','beat':beat,'cueId':beat+1,'latestCaptureTimeSec':12.5})
        release.set()
        for _ in range(100):
            if output: break
            await asyncio.sleep(.01)
        await worker.close()
        self.assertEqual(seen,[(0,[]),(19,['fresh-note'])])
        self.assertEqual(worker.session.history,['fresh-note','generated-19'])
        self.assertEqual(output[0]['plan']['cueId'],20)
        self.assertEqual(output[0]['plan']['latestCaptureTimeSec'],12.5)

    async def test_reset_invalidates_running_plan_and_close_waits_for_gpu(self):
        began, release = threading.Event(), threading.Event()
        output=[]; lock=asyncio.Lock()
        def generate(s,c):
            began.set();release.wait(2)
            return {'plan':{'notes':[]},'status':{}}
        async def emit(x, commit):
            if commit(): output.append(x)
        worker=LatestPlanner(SimpleNamespace(model=None,history=[]),lock,lambda s,m:None,generate,emit)
        worker.submit({'type':'tick','beat':0})
        await asyncio.to_thread(began.wait,1)
        worker.submit({'type':'start'})
        closing=asyncio.create_task(worker.close())
        await asyncio.sleep(.01)
        self.assertTrue(lock.locked())
        self.assertFalse(closing.done())
        release.set();await closing
        self.assertEqual(output,[])
        self.assertFalse(lock.locked())

    async def test_input_backlog_is_bounded_but_cues_are_coalesced(self):
        lock=asyncio.Lock();await lock.acquire()
        async def emit(x, commit): pass
        worker=LatestPlanner(SimpleNamespace(model=None),lock,lambda s,m:None,lambda s,m:None,emit,max_events=2)
        for n in range(1000):worker.submit({'type':'tick','beat':n})
        self.assertEqual(worker.pending_cue[0]['beat'],999)
        worker.submit({'type':'notes','notes':[1,2]})
        with self.assertRaises(InputOverflow):worker.submit({'type':'notes','notes':[3]})
        worker.closed=True;lock.release();await worker.close()

    async def test_output_wait_does_not_promote_or_emit_superseded_candidate(self):
        for replacement in ('start', 'tick'):
            with self.subTest(replacement=replacement):
                send_lock = asyncio.Lock()
                await send_lock.acquire()
                attempting_send, sent_new = asyncio.Event(), asyncio.Event()
                output = []
                def generate(session, cue):
                    session.history.append(cue['cueId'])
                    return {'plan': {'notes': []}, 'status': {}}
                def apply(session, message):
                    if message['type'] == 'start': session.history.clear()
                async def emit(result, commit):
                    attempting_send.set()
                    async with send_lock:
                        if commit():
                            output.append(result['plan']['cueId'])
                            if result['plan']['cueId'] == 2: sent_new.set()
                worker = LatestPlanner(SimpleNamespace(model=None, history=[]),
                                       asyncio.Lock(), apply, generate, emit)
                worker.submit({'type': 'tick', 'beat': 0, 'cueId': 1})
                await asyncio.wait_for(attempting_send.wait(), 1)
                self.assertEqual(worker.session.history, [])
                if replacement == 'start': worker.submit({'type': 'start'})
                worker.submit({'type': 'tick', 'beat': 2, 'cueId': 2})
                send_lock.release()
                await asyncio.wait_for(sent_new.wait(), 1)
                await worker.close()
                self.assertEqual(output, [2])
                self.assertEqual(worker.session.history, [2])

    async def test_rejected_command_releases_capacity_and_remaining_commands_keep_running(self):
        errors, completed = [], asyncio.Event()
        def apply(session, message):
            if message.get('bad'): raise ValueError('invalid control')
            session.history.extend(message.get('notes', []))
        def generate(session, cue):
            return {'plan': {'notes': []}, 'status': {}}
        async def emit(result, commit):
            if commit():
                if 'error' in result: errors.append(result['error'])
                else: completed.set()
        lock = asyncio.Lock()
        await lock.acquire()
        worker = LatestPlanner(SimpleNamespace(model=None, history=[]), lock,
                               apply, generate, emit, max_events=2)
        worker.submit({'type': 'set', 'bad': True})
        worker.submit({'type': 'notes', 'notes': [1]})
        worker.submit({'type': 'tick', 'beat': 0})
        lock.release()
        await asyncio.wait_for(completed.wait(), 1)
        self.assertEqual(errors, ['invalid control'])
        self.assertEqual(worker.event_count, 0)
        self.assertEqual(worker.session.history, [1])
        worker.submit({'type': 'notes', 'notes': [2, 3]})
        await worker.close()

    async def test_phrase_answer_is_discarded_when_input_changes_before_send(self):
        for kind in ('notes', 'note_updates', 'set'):
            with self.subTest(kind=kind):
                send_lock = asyncio.Lock()
                await send_lock.acquire()
                waiting, finished = asyncio.Event(), asyncio.Event()
                output = []
                def generate(session, cue):
                    session.history.append('answer')
                    return {'plan': {'notes': [], 'phraseResponse': True}, 'status': {}}
                async def emit(result, commit):
                    waiting.set()
                    async with send_lock:
                        if commit(): output.append(result)
                    finished.set()
                worker = LatestPlanner(SimpleNamespace(model=None, history=[]), asyncio.Lock(),
                                       lambda s, m: None, generate, emit)
                worker.submit({'type': 'tick', 'beat': 10})
                await asyncio.wait_for(waiting.wait(), 1)
                worker.submit({'type': kind, 'notes': [1], 'amount': 0})
                send_lock.release()
                await asyncio.wait_for(finished.wait(), 1)
                await worker.close()
                self.assertEqual(output, [])
                self.assertEqual(worker.session.history, [])

    async def test_periodic_dynamics_and_unchanged_controls_do_not_starve_answers(self):
        send_lock = asyncio.Lock()
        await send_lock.acquire()
        waiting, finished = asyncio.Event(), asyncio.Event()
        output = []
        def generate(session, cue):
            return {'plan': {'notes': [], 'phraseResponse': True}, 'status': {}}
        async def emit(result, commit):
            waiting.set()
            async with send_lock:
                if commit(): output.append(result)
            finished.set()
        worker = LatestPlanner(SimpleNamespace(model=None), asyncio.Lock(),
                               lambda s, m: None, generate, emit)
        worker.submit({'type': 'set', 'amount': .5, 'enabledRoles': {'lead': True}})
        worker.submit({'type': 'tick', 'beat': 10})
        await asyncio.wait_for(waiting.wait(), 1)
        for silence in (1, 1.5, 2):
            worker.submit({'type': 'set', 'amount': .5, 'enabledRoles': {'lead': True},
                           'silenceBeats': silence, 'intensity': 0, 'space': True})
        send_lock.release()
        await asyncio.wait_for(finished.wait(), 1)
        await worker.close()
        self.assertEqual(len(output), 1)

    def test_snapshot_preserves_internal_aliases_but_shares_only_model(self):
        history=[1];model=object()
        source=SimpleNamespace(model=model,history=history,committer=SimpleNamespace(history=history))
        clone=clone_session(source)
        self.assertIs(clone.model,model)
        self.assertIs(clone.history,clone.committer.history)
        clone.history.append(2)
        self.assertEqual(source.history,[1])

if __name__=='__main__':unittest.main()
