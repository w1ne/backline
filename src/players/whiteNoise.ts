import * as Tone from 'tone';

/** Reverb send level into the shared plate bus, once connected — enough to sit in the same
 *  room as the band rather than hissing in dead silence on top of it. */
export const NOISE_REVERB_SEND = 0.06;

/** Independent white-noise source, silent until its volume control is moved. Starts wired to
 *  the raw destination so it works before the band's master chain exists; {@link connectTo}
 *  re-routes it through the shared reverb bus and pre-limiter input once that chain is up, so
 *  it can't clip independently of the band and isn't left dry. */
export class WhiteNoise {
  private noise?: Tone.Noise;
  private gain: Tone.Gain;
  private reverbSend?: Tone.Gain;
  private level = 0;
  private enabled = true;

  constructor() {
    this.gain = new Tone.Gain(0).toDestination();
  }

  /** Call once the band's master chain exists. Tone.js sets up its real AudioContext at that
   *  point (`Players.init()`'s `Tone.setContext(...)`), so any node built before this belongs
   *  to a different, throwaway context — rebuild rather than reconnect. */
  connectTo(reverbBus: Tone.ToneAudioNode | AudioNode, masterInput: Tone.ToneAudioNode | AudioNode) {
    const wasRunning = !!this.noise;
    this.noise?.dispose();
    this.gain.dispose();
    this.reverbSend?.dispose();
    this.noise = undefined;
    this.gain = new Tone.Gain(0);
    Tone.connect(this.gain, masterInput);
    this.reverbSend = new Tone.Gain(NOISE_REVERB_SEND);
    this.gain.connect(this.reverbSend);
    Tone.connect(this.reverbSend, reverbBus);
    if (wasRunning) this.apply();
  }

  setLevel(value: number) {
    this.level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.apply();
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.apply(); }
  private apply() {
    const value = this.enabled ? this.level * this.level * 0.1 : 0;
    if (!this.noise && value > 0) this.noise = new Tone.Noise('white').connect(this.gain).start();
    this.gain.gain.rampTo(value, .03);
  }
  dispose() {
    this.noise?.dispose();
    this.gain.dispose();
    this.reverbSend?.dispose();
    this.noise = undefined;
  }
}
