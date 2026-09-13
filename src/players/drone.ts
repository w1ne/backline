import * as Tone from 'tone';

/** Reverb send level into the shared plate bus, once connected — a sustained tone benefits
 *  from sitting in the same room as the band more than the other utility voices do. */
export const DRONE_REVERB_SEND = 0.1;

/** A quiet sustained triangle tone, following the detected key's low tonic. Starts wired to
 *  the raw destination so it works before the band's master chain exists; {@link connectTo}
 *  re-routes it through the shared reverb bus and pre-limiter input once that chain is up, so
 *  it can't clip independently of the band and isn't left dry. */
export class Drone {
  private oscillator?: Tone.Oscillator;
  private gain: Tone.Gain;
  private reverbSend?: Tone.Gain;
  private level = 0;
  private enabled = true;
  private root = 0;
  private octave = 0;
  private frequency() { return 440 * 2 ** ((36 + 12 * this.octave + this.root - 69) / 12); }

  constructor() {
    this.gain = new Tone.Gain(0).toDestination();
  }

  /** Call once the band's master chain exists. Tone.js sets up its real AudioContext at that
   *  point (`Players.init()`'s `Tone.setContext(...)`), so any node built before this belongs
   *  to a different, throwaway context — rebuild rather than reconnect. */
  connectTo(reverbBus: Tone.ToneAudioNode | AudioNode, masterInput: Tone.ToneAudioNode | AudioNode) {
    const wasRunning = !!this.oscillator;
    this.oscillator?.dispose();
    this.gain.dispose();
    this.reverbSend?.dispose();
    this.oscillator = undefined;
    this.gain = new Tone.Gain(0);
    Tone.connect(this.gain, masterInput);
    this.reverbSend = new Tone.Gain(DRONE_REVERB_SEND);
    this.gain.connect(this.reverbSend);
    Tone.connect(this.reverbSend, reverbBus);
    if (wasRunning) this.apply();
  }

  setRoot(root: number) {
    if (!Number.isInteger(root) || root < 0 || root > 11 || root === this.root) return;
    this.root = root;
    this.oscillator?.frequency.rampTo(this.frequency(), .3);
  }
  /** Shifts the drone's whole register up or down, in octaves (clamped to ±2). */
  setOctave(octave: number) {
    const clamped = Number.isFinite(octave) ? Math.min(2, Math.max(-2, Math.round(octave))) : 0;
    if (clamped === this.octave) return;
    this.octave = clamped;
    this.oscillator?.frequency.rampTo(this.frequency(), .3);
  }
  setLevel(value: number) {
    this.level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.apply();
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.apply(); }
  private apply() {
    const value = this.enabled ? .18 * this.level * this.level : 0;
    if (!this.oscillator && value > 0) {
      this.oscillator = new Tone.Oscillator({frequency:this.frequency(), type:'triangle'}).connect(this.gain).start();
    }
    this.gain.gain.rampTo(value, .08);
  }
  dispose() {
    this.oscillator?.dispose();
    this.gain.dispose();
    this.reverbSend?.dispose();
    this.oscillator = undefined;
  }
}
