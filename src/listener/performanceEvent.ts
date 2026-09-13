/** Capture times use performance.now()/1000, never the AudioContext clock. */
export interface PerformanceEvent {
  type: 'note_on' | 'note_off';
  id: string;
  source: 'midi' | 'mic';
  midi: number;
  velocity: number;
  confidence: number;
  timeSec: number;
  /** Present on release, including time held by the sustain pedal. */
  durationSec?: number;
}
let sequence = 0;
export function performanceNoteId(source: PerformanceEvent['source']): string {
  return `${source}-${++sequence}`;
}
