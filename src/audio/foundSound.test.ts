import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  connections: [] as { from: string; to: unknown }[],
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  playerStart: vi.fn(),
  decodeAudioData: vi.fn(),
}));

vi.mock('tone', () => {
  class Gain {
    id = `gain-${Math.random()}`;
    connect(dest: unknown) { m.connections.push({ from: this.id, to: dest }); return this; }
    disconnect() { m.connections = m.connections.filter(c => c.from !== this.id); return this; }
    dispose() { return this; }
  }
  class Recorder {
    input = new Gain();
    start = m.recorderStart;
    stop = m.recorderStop;
    dispose() { return this; }
  }
  class Player {
    constructor(_buffer: unknown) {}
    connect(dest: unknown) { m.connections.push({ from: 'player', to: dest }); return this; }
    start = m.playerStart;
    dispose() { return this; }
  }
  return {
    Recorder,
    Player,
    Gain,
    connect: (src: { connect: (d: unknown) => unknown }, dst: unknown) => src.connect(dst),
    getContext: () => ({ rawContext: { decodeAudioData: m.decodeAudioData } }),
  };
});

import { FoundSoundSampler } from './foundSound';

const fakeMic = { connect: vi.fn() } as unknown as AudioNode;
const masterInput = { id: 'master' } as unknown as AudioNode;
const reverbBus = { id: 'reverb' } as unknown as AudioNode;
const morphNode = { id: 'morph' } as unknown as AudioNode;

beforeEach(() => {
  m.connections = [];
  m.recorderStart.mockReset().mockResolvedValue(undefined);
  m.recorderStop.mockReset().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  m.decodeAudioData.mockReset().mockResolvedValue({ duration: 1.5 });
  m.playerStart.mockReset();
});

describe('FoundSoundSampler', () => {
  it('starts with no clip and not recording', () => {
    const s = new FoundSoundSampler(fakeMic);
    expect(s.hasClip).toBe(false);
    expect(s.isRecording).toBe(false);
  });

  it('records and decodes a clip, then can trigger it', async () => {
    const s = new FoundSoundSampler(fakeMic);
    await s.startRecording();
    expect(s.isRecording).toBe(true);
    await s.stopRecording();
    expect(s.isRecording).toBe(false);
    expect(s.hasClip).toBe(true);
    s.trigger(5);
    expect(m.playerStart).toHaveBeenCalledWith(5);
  });

  it('discards a capture shorter than 150ms', async () => {
    m.decodeAudioData.mockResolvedValue({ duration: 0.05 });
    const s = new FoundSoundSampler(fakeMic);
    await s.startRecording();
    await s.stopRecording();
    expect(s.hasClip).toBe(false);
  });

  it('trigger before any clip exists is a silent no-op', () => {
    const s = new FoundSoundSampler(fakeMic);
    s.trigger();
    expect(m.playerStart).not.toHaveBeenCalled();
  });

  it('routes to main only when there is no MORPH device', () => {
    const s = new FoundSoundSampler(fakeMic);
    s.connectMaster(masterInput, reverbBus);
    s.setMorphNode(undefined);
    expect(m.connections.some(c => c.to === masterInput)).toBe(true);
    expect(m.connections.some(c => c.to === morphNode)).toBe(false);
  });

  it('automatically routes to both main and morph once a MORPH device is available -- ' +
     'the whole point of capturing a found sound is to send it through the timbre-transfer box', () => {
    const s = new FoundSoundSampler(fakeMic);
    s.connectMaster(masterInput, reverbBus);
    s.setMorphNode(morphNode);
    expect(m.connections.some(c => c.to === masterInput)).toBe(true);
    expect(m.connections.some(c => c.to === morphNode)).toBe(true);
  });

  it('drops back to main-only when the MORPH device goes away again', () => {
    const s = new FoundSoundSampler(fakeMic);
    s.connectMaster(masterInput, reverbBus);
    s.setMorphNode(morphNode);
    s.setMorphNode(undefined);
    expect(m.connections.some(c => c.to === morphNode)).toBe(false);
    expect(m.connections.some(c => c.to === masterInput)).toBe(true);
  });
});
