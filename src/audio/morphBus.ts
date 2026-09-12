import { MORPH_SINK_KEY, saveDeviceId, listOutputs } from './devices';
import type { DeviceOption } from './devices';

export type { DeviceOption };
export { listOutputs };

/**
 * A second audio output, inside the same AudioContext the band already runs on.
 *
 * Web Audio itself has exactly one destination (the default device), so the only way
 * to reach a second one from a page is to render into a MediaStream and hand that
 * stream to a media element, which *can* be pointed at a device with setSinkId().
 *
 * Latency: that media-element path is not sample-synchronous with the main output —
 * it re-buffers, and in practice lands ~20–50 ms behind it (Chrome/Linux, 48 kHz).
 * That is on top of whatever the morph box itself adds. For a part that is going to
 * a separate amp through LYDIA this is inaudible as an offset; for a part sent to
 * 'both' it is a short, audible doubling, so use 'both' for checking a sound, not for
 * playing a gig.
 */
export class MorphBus {
  /** Connect anything that should reach the morph output here. */
  readonly input: GainNode;
  private dest: MediaStreamAudioDestinationNode;
  private el: HTMLAudioElement;
  private sinkId: string | null = null;

  constructor(ctx: AudioContext) {
    this.dest = ctx.createMediaStreamDestination();
    this.input = ctx.createGain();
    this.input.connect(this.dest);

    this.el = document.createElement('audio');
    this.el.autoplay = true;
    this.el.setAttribute('data-morph-out', '');
    this.el.srcObject = this.dest.stream;
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    // autoplay of a MediaStream is allowed after the user gesture that started audio;
    // if it is not, the next setSink() retries the play.
    this.resume();
  }

  /** The hidden element carrying the stream — the thing setSinkId() is called on. */
  get element(): HTMLAudioElement {
    return this.el;
  }

  get stream(): MediaStream {
    return this.dest.stream;
  }

  get deviceId(): string | null {
    return this.sinkId;
  }

  /** Points the morph output at `deviceId` (or back at the system default for null). */
  async setSink(deviceId: string | null): Promise<void> {
    if (!setSinkSupported()) throw new Error('Output device selection is not supported in this browser');
    await (this.el as SinkCapable).setSinkId(deviceId ?? '');
    this.sinkId = deviceId;
    saveDeviceId(MORPH_SINK_KEY, deviceId);
    this.resume();
  }

  /** play() rejects (or is missing entirely, outside a browser) more often than it fails
   *  to matter — a blocked play is retried by the next setSink(). */
  private resume(): void {
    try {
      const p = this.el.play?.();
      if (p) void p.catch(() => {});
    } catch {
      // no audio element playback available (jsdom, or autoplay blocked)
    }
  }

  dispose(): void {
    this.input.disconnect();
    this.el.pause();
    this.el.srcObject = null;
    this.el.remove();
  }
}

type SinkCapable = HTMLMediaElement & { setSinkId(id: string): Promise<void> };

/**
 * setSinkId() is Chrome/Edge (and Chromium derivatives) only — Firefox ships it behind
 * a pref and Safari not at all. Everything else in the morph path works regardless;
 * without this the user just cannot choose *which* device the bus lands on.
 */
export function setSinkSupported(): boolean {
  return (
    typeof HTMLMediaElement !== 'undefined' &&
    typeof (HTMLMediaElement.prototype as Partial<SinkCapable>).setSinkId === 'function'
  );
}
