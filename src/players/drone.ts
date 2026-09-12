import * as Tone from 'tone';

/** A quiet sustained triangle tone, following the detected key's low tonic. */
export class Drone {
  private oscillator?: Tone.Oscillator;
  private gain?: Tone.Gain;
  private level = 0;
  private enabled = true;
  private root = 0;
  private frequency() { return 440 * 2 ** ((36 + this.root - 69) / 12); }
  setRoot(root: number) {
    if (!Number.isInteger(root) || root < 0 || root > 11 || root === this.root) return;
    this.root = root;
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
      this.gain = new Tone.Gain(0).toDestination();
      this.oscillator = new Tone.Oscillator({frequency:this.frequency(), type:'triangle'}).connect(this.gain).start();
    }
    this.gain?.gain.rampTo(value, .08);
  }
  dispose() { this.oscillator?.dispose(); this.gain?.dispose(); this.oscillator = undefined; this.gain = undefined; }
}
