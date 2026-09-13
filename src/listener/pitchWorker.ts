import { detectPitch } from './pitch';
import { PitchTracker, VOICE_PROFILE } from './pitchTracker';
import type { PitchJob, PitchResult } from './pitchWorkerClient';
const tracker = new PitchTracker(VOICE_PROFILE);
self.onmessage = (event: MessageEvent<PitchJob>) => {
  const { samples, sampleRate, timeSec } = event.data;
  const estimate = detectPitch(samples, sampleRate);
  const pitch = tracker.push(estimate ? { hz: estimate.hz, clarity: estimate.clarity, t: timeSec } : null);
  const result: PitchResult = { timeSec, pitch: pitch ? { ...pitch, confidence: estimate?.clarity ?? 0, timeSec } : null };
  self.postMessage(result);
};
