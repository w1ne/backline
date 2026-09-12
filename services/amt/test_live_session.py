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
        async def emit(result): output.append(result)
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
        async def emit(x): output.append(x)
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
        async def emit(x): pass
        worker=LatestPlanner(SimpleNamespace(model=None),lock,lambda s,m:None,lambda s,m:None,emit,max_events=2)
        for n in range(1000):worker.submit({'type':'tick','beat':n})
        self.assertEqual(worker.pending_cue[0]['beat'],999)
        worker.submit({'type':'notes','notes':[1,2]})
        with self.assertRaises(InputOverflow):worker.submit({'type':'notes','notes':[3]})
        worker.closed=True;lock.release();await worker.close()

    def test_snapshot_preserves_internal_aliases_but_shares_only_model(self):
        history=[1];model=object()
        source=SimpleNamespace(model=model,history=history,committer=SimpleNamespace(history=history))
        clone=clone_session(source)
        self.assertIs(clone.model,model)
        self.assertIs(clone.history,clone.committer.history)
        clone.history.append(2)
        self.assertEqual(source.history,[1])

if __name__=='__main__':unittest.main()
