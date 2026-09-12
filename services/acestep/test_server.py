"""Block orchestration regressions; no GPU, network, or model weights required."""
import asyncio
import unittest
from unittest.mock import patch

import numpy as np
import server


class ContinuationTest(unittest.TestCase):
    def test_next_block_repaints_new_time_instead_of_layering_over_previous_mix(self):
        requests, sources, packets = [], [], []

        class Model:
            def generate(self, params):
                requests.append(params)
                audio = np.full((round(params.audio_duration * server.TARGET_SR), 2),
                                0.1 if len(requests) == 1 else 0.2, dtype=np.float32)
                if len(requests) == 2:
                    audio[:server.TARGET_SR * 2] = 0.1
                return audio

        def write(audio):
            sources.append(audio.copy())
            return '/tmp/backline-test-source.wav'

        async def send_binary(packet):
            packets.append(packet)

        async def send_json(_):
            pass

        async def run():
            session = server.Session(Model())
            for seq in (1, 2, 3):
                await session.handle_block(dict(seq=seq, bpm=120, bars=2, key='C major',
                                                instruments=['drums', 'bass']), send_binary, send_json)

        with patch.object(server, '_write_temp_wav', side_effect=write):
            asyncio.run(run())
        self.assertEqual([p.task_type for p in requests], ['text2music', 'repaint', 'repaint'])
        self.assertEqual(requests[1].repainting_start, 2)
        self.assertEqual(requests[1].repainting_end, 6)
        self.assertEqual(requests[1].audio_duration, 6)
        self.assertIsNone(requests[1].track_classes)
        self.assertEqual(sources[0].shape, (6 * server.TARGET_SR, 2))
        self.assertTrue(np.all(sources[0][2 * server.TARGET_SR:] == 0))
        for packet in packets:
            self.assertEqual(len(packet), 4 + 4 * server.TARGET_SR * 2 * 2)
        self.assertTrue(np.all(np.frombuffer(packets[1][4:], dtype='<i2') == int(0.2 * 32767)))

    def test_muted_lead_is_never_requested_by_fill_text(self):
        prompt = server.build_prompt('lofi', ['drums', 'bass'], fill=True, space=True)
        self.assertNotIn('guitar lead fill', prompt)
        self.assertNotIn('full band', prompt)


if __name__ == '__main__':
    unittest.main()
