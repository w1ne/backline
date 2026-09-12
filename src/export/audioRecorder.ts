/** Records everything audible (band synths, generated audio, your mic) to one file.
 *  Sources register themselves; they are only wired into the capture node while recording. */
export class AudioRecorder {
  private sources = new Set<AudioNode>();
  private dest?: MediaStreamAudioDestinationNode;
  private rec?: MediaRecorder;
  private chunks: Blob[] = [];

  /** Any node whose signal should end up in the recording. */
  addSource(node: AudioNode): void {
    this.sources.add(node);
    if (this.dest) node.connect(this.dest);
  }
  removeSource(node: AudioNode): void {
    this.sources.delete(node);
    if (this.dest) { try { node.disconnect(this.dest); } catch { /* not connected */ } }
  }

  get recording(): boolean { return !!this.rec; }

  static mimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') return null;
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) ?? null;
  }

  /** false when this browser cannot record audio (no MediaRecorder) */
  start(ctx: AudioContext): boolean {
    const mimeType = AudioRecorder.mimeType();
    if (!mimeType || this.rec) return false;
    this.dest = ctx.createMediaStreamDestination();
    for (const s of this.sources) s.connect(this.dest);
    this.chunks = [];
    this.rec = new MediaRecorder(this.dest.stream, { mimeType });
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    return true;
  }

  /** Resolves with the finished file, or null when nothing was recording. */
  stop(): Promise<{ blob: Blob; ext: string } | null> {
    const rec = this.rec, dest = this.dest;
    if (!rec || !dest) return Promise.resolve(null);
    this.rec = undefined; this.dest = undefined;
    for (const s of this.sources) { try { s.disconnect(dest); } catch { /* already gone */ } }
    const type = rec.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    return new Promise(resolve => {
      rec.onstop = () => resolve({ blob: new Blob(this.chunks, { type }), ext });
      rec.stop();
    });
  }
}

export const audioRecorder = new AudioRecorder();
