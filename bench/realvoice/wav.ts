/**
 * Minimal WAV reader/writer for the real-voice bench. Reads 16-bit PCM (what MIR-1K ships),
 * picks one channel, and resamples linearly to the listener's 48 kHz. No dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface Wav {
  sampleRate: number;
  channels: Float32Array[];
}

export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`not a WAV: ${path}`);
  let pos = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: { start: number; len: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const len = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      const format = dv.getUint16(body, true);
      if (format !== 1) throw new Error(`unsupported WAV format ${format} in ${path}`);
      fmt = { channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { start: body, len: Math.min(len, buf.length - body) };
    }
    pos = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error(`WAV missing fmt/data chunk: ${path}`);
  if (fmt.bits !== 16) throw new Error(`only 16-bit PCM supported, got ${fmt.bits} in ${path}`);
  const frameBytes = 2 * fmt.channels;
  const nFrames = Math.floor(data.len / frameBytes);
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(nFrames));
  for (let i = 0; i < nFrames; i++) {
    const base = data.start + i * frameBytes;
    for (let c = 0; c < fmt.channels; c++) channels[c][i] = dv.getInt16(base + 2 * c, true) / 32768;
  }
  return { sampleRate: fmt.sampleRate, channels };
}

/** Linear-interpolation resampler; good enough for a 16 kHz -> 48 kHz upsample of a voice. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    const a = x[j] ?? 0;
    const b = x[j + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

export function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Writes 16-bit PCM WAV from per-channel arrays (mono or interleaved stereo). */
export function writeWav(path: string, sampleRate: number, channels: Float32Array[]): void {
  const n = channels[0].length;
  const nCh = channels.length;
  const dataLen = n * nCh * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(nCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nCh * 2, 28);
  buf.writeUInt16LE(nCh * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
    const v = Math.max(-1, Math.min(1, channels[c][i]));
    buf.writeInt16LE(Math.round(v * 32767), o);
    o += 2;
  }
  writeFileSync(path, buf);
}
