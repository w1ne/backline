import * as Tone from 'tone';
import { routeTargets, type MorphRoute } from './routing';

/** Longest a single capture is allowed to run, so a missed release doesn't record forever. */
export const MAX_RECORD_SEC = 4;
/** Reverb send level into the shared plate bus, once connected. */
export const FOUND_SOUND_REVERB_SEND = 0.12;

/**
 * Turns a few seconds of whatever is in front of the mic — a clap, a tapped table, a found
 * object — into a playable instrument voice. Recording taps the same mic source node the
 * listener and vocal chain already use (no second permission, no touching their analysis
 * path); playback routes through the band's own main output and, when a MORPH device is
 * selected, the same second output `lead`/`keys` use — so an external LYDIA/Neutone box
 * timbre-transfers the found sound exactly like it does any other instrument.
 *
 * Not a full `Instrument`: this is one extra voice living outside `Players`' fixed
 * drums/bass/keys/lead set, wired directly to `Players.preLimiterInput()`/`onMorphChange()`
 * rather than through `busses`/`route()`.
 */
export class FoundSoundSampler {
  private recorder: Tone.Recorder;
  private gain: Tone.Gain;
  private reverbSend?: Tone.Gain;
  private player?: Tone.Player;
  private masterInput?: Tone.ToneAudioNode | AudioNode;
  private reverbBus?: Tone.ToneAudioNode | AudioNode;
  private morphNode?: AudioNode;
  private route: MorphRoute = 'main';
  private recording = false;
  private recordTimeout?: ReturnType<typeof setTimeout>;

  constructor(micSource: Tone.ToneAudioNode | AudioNode) {
    this.recorder = new Tone.Recorder();
    Tone.connect(micSource, this.recorder);
    this.gain = new Tone.Gain(1);
  }

  /** Call once the band's master chain exists. */
  connectMaster(masterInput: Tone.ToneAudioNode | AudioNode, reverbBus: Tone.ToneAudioNode | AudioNode): void {
    this.masterInput = masterInput;
    this.reverbBus = reverbBus;
    this.applyRoute();
  }

  /** A found sound is worth sending to the morph box whenever one is plugged in — that is
   *  the entire point of capturing it — so route follows morph availability automatically
   *  rather than needing its own M-key cycle. */
  setMorphNode(node: AudioNode | undefined): void {
    this.morphNode = node;
    this.route = node ? 'both' : 'main';
    this.applyRoute();
  }

  private applyRoute(): void {
    this.gain.disconnect();
    this.reverbSend?.disconnect();
    if (!this.masterInput) return;
    const to = routeTargets(this.route, !!this.morphNode);
    if (to.main) {
      Tone.connect(this.gain, this.masterInput);
      if (this.reverbBus) {
        this.reverbSend ??= new Tone.Gain(FOUND_SOUND_REVERB_SEND);
        this.gain.connect(this.reverbSend);
        Tone.connect(this.reverbSend, this.reverbBus);
      }
    }
    if (to.morph && this.morphNode) Tone.connect(this.gain, this.morphNode);
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get hasClip(): boolean {
    return !!this.player;
  }

  async startRecording(): Promise<void> {
    if (this.recording) return;
    this.recording = true;
    await this.recorder.start();
    this.recordTimeout = setTimeout(() => { void this.stopRecording(); }, MAX_RECORD_SEC * 1000);
  }

  /** Stops capture and decodes the clip; the sampler is ready to {@link trigger} once this
   *  resolves. A capture too short to be a deliberate sound (below ~150ms) is discarded. */
  async stopRecording(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    clearTimeout(this.recordTimeout);
    const blob = await this.recorder.stop();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await Tone.getContext().rawContext.decodeAudioData(arrayBuffer);
    if (audioBuffer.duration < 0.15) return;
    this.player?.dispose();
    this.player = new Tone.Player(audioBuffer).connect(this.gain);
  }

  /** Plays the captured clip at `time` (an AudioContext-domain time, e.g. from
   *  `Tone.getTransport().nextSubdivision(...)`), or immediately when omitted. */
  trigger(time?: number): void {
    this.player?.start(time);
  }

  dispose(): void {
    clearTimeout(this.recordTimeout);
    this.recorder.dispose();
    this.player?.dispose();
    this.gain.dispose();
    this.reverbSend?.dispose();
  }
}
