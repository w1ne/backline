/**
 * Offline vocal-like test signal generator, 48 kHz mono, no dependencies.
 *
 * A voice is modeled as a harmonic series (10 partials, 1/n amplitude) run
 * through two fixed resonant "formant" peaks, with vibrato on the fundamental
 * (and its harmonics, since they are integer multiples of it), a bit of
 * breath noise, and a plain attack/release envelope per note. This is not a
 * vocal-synthesis attempt at realism — it exists to give the pitch/onset
 * pipeline something harmonically messier than a sine, with the specific
 * knobs (vibrato depth, portamento, noise) the pipeline is supposed to cope
 * with.
 */

export const SR = 48000;

export interface Note {
  midi: number;
  /** seconds, from clip start */
  start: number;
  /** seconds, from clip start */
  end: number;
}

export interface ClipTruth {
  name: string;
  notes: Note[];
  key?: { root: number; mode: 'major' | 'minor' };
  bpm?: number;
  /** the chord each bar implies, when the melody was written to outline one */
  chords?: { root: number; quality: 'maj' | 'min' }[];
  /** total clip length in seconds */
  durationSec: number;
}

export interface Clip {
  truth: ClipTruth;
  audio: Float32Array;
}

export interface SynthOptions {
  /** vibrato depth in cents, peak deviation. 5.5 Hz rate is fixed. */
  vibratoCents?: number;
  /** portamento glide time in ms, applied at the start of a note that follows another with no gap */
  portamentoMs?: number;
  /** breath noise level in dB relative to the harmonic signal's RMS */
  breathDb?: number;
}

const VIBRATO_HZ = 5.5;
const ATTACK_SEC = 0.03;
const RELEASE_SEC = 0.08;
const N_PARTIALS = 10;

// Loosely an open central vowel ("ah"-ish); good enough to give the harmonics
// a non-flat spectral tilt without claiming to be any particular phoneme.
const FORMANTS = [
  { freq: 800, bw: 100 },
  { freq: 1150, bw: 140 },
];

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function formantGain(freqHz: number): number {
  let peak = 0;
  for (const f of FORMANTS) {
    const l = 1 / (1 + ((freqHz - f.freq) / (f.bw / 2)) ** 2);
    if (l > peak) peak = l;
  }
  return 0.25 + 0.75 * peak;
}

/**
 * Builds a per-sample fundamental-frequency contour for a monophonic note
 * list. Silence between notes holds the previous frequency (irrelevant,
 * amplitude is zero there); a note that starts exactly where the previous one
 * ends glides from the previous pitch to the new one over `portamentoMs`.
 */
function buildPitchContour(notes: Note[], nSamples: number, sr: number, portamentoMs: number): Float32Array {
  const hz = new Float32Array(nSamples);
  let prevMidi: number | null = null;
  let prevEnd = -Infinity;
  for (const note of notes) {
    const startS = Math.round(note.start * sr);
    const endS = Math.round(note.end * sr);
    const targetHz = midiToHz(note.midi);
    const legato = portamentoMs > 0 && Math.abs(note.start - prevEnd) < 1e-6 && prevMidi !== null;
    const glideSamples = legato ? Math.min(Math.round((portamentoMs / 1000) * sr), endS - startS) : 0;
    const fromHz = legato ? midiToHz(prevMidi!) : targetHz;
    for (let i = startS; i < endS && i < nSamples; i++) {
      if (glideSamples > 0 && i - startS < glideSamples) {
        const frac = (i - startS) / glideSamples;
        // glide in log-frequency space so the sweep sounds like a pitch slide, not a linear-Hz ramp
        hz[i] = fromHz * (targetHz / fromHz) ** frac;
      } else {
        hz[i] = targetHz;
      }
    }
    prevMidi = note.midi;
    prevEnd = note.end;
  }
  return hz;
}

/** Trapezoid attack/release envelope, one segment per note, silence elsewhere. */
function buildEnvelope(notes: Note[], nSamples: number, sr: number): Float32Array {
  const env = new Float32Array(nSamples);
  for (const note of notes) {
    const startS = Math.round(note.start * sr);
    const endS = Math.min(Math.round(note.end * sr), nSamples);
    const attackS = Math.min(Math.round(ATTACK_SEC * sr), endS - startS);
    const releaseS = Math.min(Math.round(RELEASE_SEC * sr), endS - startS);
    for (let i = startS; i < endS; i++) {
      let g = 1;
      if (i - startS < attackS) g = (i - startS) / attackS;
      if (endS - i < releaseS) g = Math.min(g, (endS - i) / releaseS);
      env[i] = Math.max(env[i], g);
    }
  }
  return env;
}

/** Simple deterministic PRNG (mulberry32) so clips are reproducible without a dependency. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthVoice(notes: Note[], durationSec: number, opts: SynthOptions = {}, seed = 1): Float32Array {
  const sr = SR;
  const nSamples = Math.round(durationSec * sr);
  const vibratoCents = opts.vibratoCents ?? 0;
  const portamentoMs = opts.portamentoMs ?? 0;
  const breathDb = opts.breathDb ?? -30;

  const f0 = buildPitchContour(notes, nSamples, sr, portamentoMs);
  const env = buildEnvelope(notes, nSamples, sr);
  const out = new Float32Array(nSamples);

  // per-harmonic phase accumulators, since f0 varies sample to sample
  const phase = new Float32Array(N_PARTIALS);
  for (let i = 0; i < nSamples; i++) {
    if (f0[i] === 0) continue;
    const vibrato = vibratoCents > 0 ? 2 ** ((vibratoCents * Math.sin(2 * Math.PI * VIBRATO_HZ * (i / sr))) / 1200) : 1;
    const f = f0[i] * vibrato;
    let s = 0;
    for (let h = 1; h <= N_PARTIALS; h++) {
      const hf = f * h;
      if (hf >= sr / 2) break;
      phase[h - 1] += (2 * Math.PI * hf) / sr;
      const amp = (1 / h) * formantGain(hf);
      s += amp * Math.sin(phase[h - 1]);
    }
    out[i] = s * env[i];
  }

  // normalize harmonic signal to a sane peak before adding breath noise
  let peak = 0;
  for (let i = 0; i < nSamples; i++) peak = Math.max(peak, Math.abs(out[i]));
  const norm = peak > 0 ? 0.6 / peak : 1;
  for (let i = 0; i < nSamples; i++) out[i] *= norm;

  // breath noise: white noise shaped by the same envelope, level relative to the
  // harmonic signal's RMS while a note is sounding
  let sumSq = 0, voiced = 0;
  for (let i = 0; i < nSamples; i++) if (env[i] > 0) { sumSq += out[i] * out[i]; voiced++; }
  const rms = voiced > 0 ? Math.sqrt(sumSq / voiced) : 0;
  const noiseAmp = rms * 10 ** (breathDb / 20);
  const rand = mulberry32(seed);
  for (let i = 0; i < nSamples; i++) {
    if (env[i] > 0) out[i] += (rand() * 2 - 1) * noiseAmp * env[i];
  }

  return out;
}

/** Synthesizes random pitch drift with no stable notes: for the false-positive ("spoken") clip. */
export function synthDrift(durationSec: number, seed = 7): Float32Array {
  const sr = SR;
  const nSamples = Math.round(durationSec * sr);
  const segSec = 0.2;
  const rand = mulberry32(seed);
  const baseMidi = 55; // around G3, typical speaking range
  const nSegs = Math.ceil(durationSec / segSec);
  const segMidi: number[] = [];
  let cur = baseMidi;
  for (let s = 0; s < nSegs + 1; s++) {
    cur += (rand() * 2 - 1) * 3; // up to +-300 cents = +-3 semitones drift step
    segMidi.push(cur);
  }
  const f0 = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    const segIdx = Math.floor(i / sr / segSec);
    const fracInSeg = (i / sr - segIdx * segSec) / segSec;
    const a = midiToHz(segMidi[segIdx]);
    const b = midiToHz(segMidi[segIdx + 1] ?? segMidi[segIdx]);
    f0[i] = a * (b / a) ** fracInSeg;
  }
  const env = new Float32Array(nSamples).fill(1);
  // envelope with an overall fade to avoid a click at the very start/end
  const fadeS = Math.round(0.02 * sr);
  for (let i = 0; i < fadeS; i++) { env[i] = i / fadeS; env[nSamples - 1 - i] = i / fadeS; }

  const out = new Float32Array(nSamples);
  const phase = new Float32Array(N_PARTIALS);
  for (let i = 0; i < nSamples; i++) {
    const f = f0[i];
    let s = 0;
    for (let h = 1; h <= N_PARTIALS; h++) {
      const hf = f * h;
      if (hf >= sr / 2) break;
      phase[h - 1] += (2 * Math.PI * hf) / sr;
      s += (1 / h) * formantGain(hf) * Math.sin(phase[h - 1]);
    }
    out[i] = s * env[i];
  }
  let peak = 0;
  for (let i = 0; i < nSamples; i++) peak = Math.max(peak, Math.abs(out[i]));
  const norm = peak > 0 ? 0.6 / peak : 1;
  for (let i = 0; i < nSamples; i++) out[i] *= norm;

  const noiseAmp = 0.6 * 10 ** (-30 / 20);
  for (let i = 0; i < nSamples; i++) out[i] += (rand() * 2 - 1) * noiseAmp * env[i];

  return out;
}

// ---------------------------------------------------------------------------
// Fixed clip set
// ---------------------------------------------------------------------------

function scaleNotes(startMidi: number, bpm: number, gap = 0): Note[] {
  const beatSec = 60 / bpm;
  const degrees = [0, 2, 4, 5, 7, 9, 11, 12];
  const notes: Note[] = [];
  let t = 0.2;
  for (const d of degrees) {
    notes.push({ midi: startMidi + d, start: t, end: t + beatSec - gap });
    t += beatSec;
  }
  return notes;
}

/** 8 bars in A minor at 90 bpm, quarter notes, fixed melody (scale degrees of A natural minor). */
const A_MINOR_MELODY_DEGREES = [
  0, 2, 3, 5, 7, 5, 3, 2, // bar 1-2
  0, 3, 7, 5, 3, 2, 0, 0, // bar 3-4
  2, 3, 5, 7, 9, 7, 5, 3, // bar 5-6
  2, 0, 3, 2, 0, -2, 0, 0, // bar 7-8
];

function hummedMelodyNotes(rootMidi: number, bpm: number): Note[] {
  const beatSec = 60 / bpm;
  const notes: Note[] = [];
  let t = 0.2;
  for (const d of A_MINOR_MELODY_DEGREES) {
    notes.push({ midi: rootMidi + d, start: t, end: t + beatSec });
    t += beatSec;
  }
  return notes;
}

/** Am F C G Am Dm Em Am in A minor: one bar each, sung as root-third-fifth-third arpeggios. */
export const ARPEGGIO_CHORDS: { root: number; quality: 'maj' | 'min' }[] = [
  { root: 9, quality: 'min' }, { root: 5, quality: 'maj' }, { root: 0, quality: 'maj' }, { root: 7, quality: 'maj' },
  { root: 9, quality: 'min' }, { root: 2, quality: 'min' }, { root: 4, quality: 'min' }, { root: 9, quality: 'min' },
];

function arpeggioNotes(bpm: number, lowMidi = 55): Note[] {
  const beatSec = 60 / bpm;
  const notes: Note[] = [];
  let t = 0.2;
  for (const c of ARPEGGIO_CHORDS) {
    const third = c.quality === 'maj' ? 4 : 3;
    // keep every note in one octave above lowMidi so the line stays singable
    const root = lowMidi + (((c.root - lowMidi) % 12) + 12) % 12;
    for (const off of [0, third, 7, third]) {
      notes.push({ midi: root + off, start: t, end: t + beatSec });
      t += beatSec;
    }
  }
  return notes;
}

function clipDuration(notes: Note[], tailSec = 0.5): number {
  return notes[notes.length - 1].end + tailSec;
}

export interface ClipSpec {
  truth: ClipTruth;
  opts: SynthOptions;
}

export function buildClips(): ClipSpec[] {
  const specs: ClipSpec[] = [];

  // 1. Sustained single notes
  for (const [name, midi] of [['C3', 48], ['A3', 57], ['E4', 64], ['A4', 69]] as [string, number][]) {
    const notes: Note[] = [{ midi, start: 0.2, end: 2.2 }];
    specs.push({
      truth: { name: `sustained-${name}`, notes, durationSec: 2.7 },
      opts: { vibratoCents: 30, portamentoMs: 0, breathDb: -30 },
    });
  }

  // 2. Major scale C4..C5, 100 bpm quarter notes, vibrato x portamento grid
  for (const vibratoCents of [0, 40, 100]) {
    for (const portamentoMs of [0, 60]) {
      const notes = scaleNotes(60, 100, 0);
      specs.push({
        truth: {
          name: `scale-vib${vibratoCents}-port${portamentoMs}`,
          notes,
          bpm: 100,
          durationSec: clipDuration(notes),
        },
        opts: { vibratoCents, portamentoMs, breathDb: -30 },
      });
    }
  }

  // 3. Hummed melody, 8 bars, A minor, 90 bpm, vibrato 50, portamento 40ms
  const melodyMid = hummedMelodyNotes(57, 90); // A3 root
  specs.push({
    truth: {
      name: 'melody-A3-root',
      notes: melodyMid,
      key: { root: 9, mode: 'minor' },
      bpm: 90,
      durationSec: clipDuration(melodyMid),
    },
    opts: { vibratoCents: 50, portamentoMs: 40, breathDb: -30 },
  });

  // 3b. Chord-outlining melody: arpeggios of Am F C G Am Dm Em Am, one bar each
  const arp = arpeggioNotes(90);
  specs.push({
    truth: { name: 'arpeggio-Am-progression', notes: arp, key: { root: 9, mode: 'minor' }, bpm: 90, chords: ARPEGGIO_CHORDS, durationSec: clipDuration(arp) },
    opts: { vibratoCents: 50, portamentoMs: 40, breathDb: -30 },
  });

  // 4. Same melody, one octave lower (male range, down to A2) and one higher
  const melodyLow = hummedMelodyNotes(45, 90); // A2 root
  specs.push({
    truth: {
      name: 'melody-A2-root-low',
      notes: melodyLow,
      key: { root: 9, mode: 'minor' },
      bpm: 90,
      durationSec: clipDuration(melodyLow),
    },
    opts: { vibratoCents: 50, portamentoMs: 40, breathDb: -30 },
  });

  const melodyHigh = hummedMelodyNotes(69, 90); // A4 root
  specs.push({
    truth: {
      name: 'melody-A4-root-high',
      notes: melodyHigh,
      key: { root: 9, mode: 'minor' },
      bpm: 90,
      durationSec: clipDuration(melodyHigh),
    },
    opts: { vibratoCents: 50, portamentoMs: 40, breathDb: -30 },
  });

  return specs;
}

export function buildClipAudio(spec: ClipSpec): Clip {
  const audio = synthVoice(spec.truth.notes, spec.truth.durationSec, spec.opts);
  return { truth: spec.truth, audio };
}

export function buildSpokenClip(): Clip {
  const durationSec = 6;
  const audio = synthDrift(durationSec);
  return { truth: { name: 'spoken-drift', notes: [], durationSec }, audio };
}
