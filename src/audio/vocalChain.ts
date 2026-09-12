import * as Tone from 'tone';

/** Trim on the vocal chain's own output, ahead of the master compressor — a mic monitor
 *  sits back in the mix, the way a record's vocal does, not on top of the band. */
export const VOCAL_TRIM_DB = -6;

/** High-pass corner: below this a monitored voice mostly adds rumble and proximity boom,
 *  not intelligibility. */
export const VOCAL_HPF_HZ = 90;

/** A gentle bus compressor, not a vocal-effects one: it keeps a monitored voice from
 *  jumping around under headphones without squashing the performance. */
export const VOCAL_COMPRESSOR = { threshold: -20, ratio: 2.5, attack: 0.005, release: 0.12 } as const;

/** Reverb send level into the shared plate bus — enough to sit in the room with the band,
 *  not enough to wash the voice out. */
export const VOCAL_REVERB_SEND = 0.12;

/**
 * Monitors the singer's own mic: source → high-pass → gentle compressor → trim, feeding
 * both the shared reverb bus (a send, not a second reverb) and the master chain ahead of
 * the limiter. Built around the mic's existing MediaStreamAudioSourceNode (or any node,
 * in tests) so the listener's own analysis path is untouched — this only taps it.
 *
 * Starts disabled: nothing reaches either destination until setEnabled(true), so the
 * chain cannot feed back until the caller has decided monitoring is safe.
 */
export class VocalChain {
  private hpf: Tone.Filter;
  private compressor: Tone.Compressor;
  private trim: Tone.Gain;
  private enabled = false;

  constructor(
    private micSource: Tone.ToneAudioNode | AudioNode,
    private reverbBus: Tone.ToneAudioNode | AudioNode,
    private masterInput: Tone.ToneAudioNode | AudioNode,
  ) {
    this.hpf = new Tone.Filter(VOCAL_HPF_HZ, 'highpass');
    this.compressor = new Tone.Compressor(VOCAL_COMPRESSOR);
    this.trim = new Tone.Gain(Tone.dbToGain(VOCAL_TRIM_DB));
    Tone.connect(this.micSource, this.hpf);
    this.hpf.connect(this.compressor);
    this.compressor.connect(this.trim);
    // Not connected onward yet — setEnabled(true) joins the trim to the reverb send and
    // the master chain; until then the chain is built but silent.
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      Tone.connect(this.trim, this.reverbBus);
      Tone.connect(this.trim, this.masterInput);
    } else {
      Tone.disconnect(this.trim, this.reverbBus);
      Tone.disconnect(this.trim, this.masterInput);
    }
  }

  dispose(): void {
    this.setEnabled(false);
    Tone.disconnect(this.micSource, this.hpf);
    this.hpf.dispose();
    this.compressor.dispose();
    this.trim.dispose();
  }
}
