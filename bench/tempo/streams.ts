/**
 * Turns a solo-voice recording into the streams the Listener has at run time, using the
 * listener's own components: OnsetDetector over the 512-hop flux (onset times and strengths),
 * the flux and rms envelopes themselves (rebinned to 20 ms), and the pitch tracker's stable
 * notes as segments (a note starts when the stable midi changes, ends when it changes again or
 * the tracker lets go).
 */
import { OnsetDetector } from '../../src/listener/onset';
import { VOICE_PROFILE } from '../../src/listener/pitchTracker';
import { HOP_SIZE } from '../../src/listener/fft';
import { SR } from '../voice/synth';
import { analyse, runClip, type Analysis } from '../voice/driver';
import { rebin } from './truth';
import type { NoteSeg, Onset, VoiceStreams } from './methods';

export const STREAM_HOP_SEC = 0.02;

export function onsetsFromAnalysis(pre: Analysis): Onset[] {
  const det = new OnsetDetector({ sampleRate: SR });
  const out: Onset[] = [];
  for (let h = 0; h < pre.hops.length; h++) {
    const t = (h * HOP_SIZE) / SR;
    const at = det.pushFlux(pre.hops[h].flux, t);
    if (at !== null) out.push({ t: at, strength: pre.hops[Math.round((at * SR) / HOP_SIZE)]?.flux ?? pre.hops[h].flux });
  }
  return out;
}

/** Stable-pitch frames (50 ms polls, midi or null) into note segments. */
export function notesFromPitchFrames(frames: { t: number; midi: number | null }[], pollSec = 0.05): NoteSeg[] {
  const notes: NoteSeg[] = [];
  let cur: NoteSeg | null = null;
  for (const f of frames) {
    if (f.midi === null) { if (cur) { cur.end = f.t; notes.push(cur); cur = null; } continue; }
    if (cur && cur.midi === f.midi) continue;
    if (cur) { cur.end = f.t; notes.push(cur); }
    cur = { start: f.t, end: f.t + pollSec, midi: f.midi };
  }
  if (cur) { cur.end = frames.length ? frames[frames.length - 1].t + pollSec : cur.end; notes.push(cur); }
  return notes;
}

export function extractStreams(audio: Float32Array): VoiceStreams {
  const pre = analyse(audio);
  const r = runClip(audio, VOICE_PROFILE, undefined, undefined, pre);
  const hop = HOP_SIZE / SR;
  const flux = rebin(Float32Array.from(pre.hops.map(h => h.flux)), hop, STREAM_HOP_SEC);
  const level = rebin(Float32Array.from(pre.hops.map(h => h.rms)), hop, STREAM_HOP_SEC);
  return { onsets: onsetsFromAnalysis(pre), notes: notesFromPitchFrames(r.pitchFrames), flux, level, hopSec: STREAM_HOP_SEC };
}
