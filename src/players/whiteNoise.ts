import * as Tone from 'tone';

/** Independent white-noise source, silent until its volume control is moved. */
export class WhiteNoise {
  private noise?: Tone.Noise;
  private gain?: Tone.Gain;
  private level = 0;
  private enabled = true;

  setLevel(value: number) {
    this.level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.apply();
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.apply(); }
  private apply() {
    const value = this.enabled ? this.level * this.level * 0.1 : 0;
    if (!this.noise && value > 0) {
      this.gain = new Tone.Gain(0).toDestination();
      this.noise = new Tone.Noise('white').connect(this.gain).start();
    }
    this.gain?.gain.rampTo(value, .03);
  }
  dispose() { this.noise?.dispose(); this.gain?.dispose(); this.noise = undefined; this.gain = undefined; }
}
