// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadDeviceId,
  mapDevices,
  resolveDeviceId,
  saveDeviceId,
  shortDeviceName,
  MORPH_SINK_KEY,
} from './devices';

function dev(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: 'g', toJSON: () => ({}) } as MediaDeviceInfo;
}

describe('mapDevices', () => {
  const devices = [
    dev('audioinput', 'mic1', 'Scarlett 2i2 Analogue 1 + 2'),
    dev('audiooutput', 'out1', 'Built-in Audio Analogue Stereo'),
    dev('audiooutput', 'out2', 'Scarlett 2i2 Analogue 3 + 4'),
    dev('videoinput', 'cam', 'Webcam'),
  ];

  it('keeps only the requested kind, in order', () => {
    expect(mapDevices(devices, 'audiooutput').map(o => o.id)).toEqual(['out1', 'out2']);
    expect(mapDevices(devices, 'audioinput').map(o => o.id)).toEqual(['mic1']);
  });

  it('names unlabelled devices, which is what enumerateDevices returns before permission', () => {
    const unnamed = mapDevices([dev('audiooutput', 'out1', ''), dev('audiooutput', 'out2', '  ')], 'audiooutput');
    expect(unnamed).toEqual([
      { id: 'out1', label: 'Output 1' },
      { id: 'out2', label: 'Output 2' },
    ]);
  });

  it('drops entries with no id and repeats of one already listed', () => {
    const dupes = [dev('audiooutput', 'out1', 'A'), dev('audiooutput', 'out1', 'A again'), dev('audiooutput', '', 'B')];
    expect(mapDevices(dupes, 'audiooutput')).toEqual([{ id: 'out1', label: 'A' }]);
  });
});

describe('shortDeviceName', () => {
  it('strips the usb id and default/communications prefixes', () => {
    expect(shortDeviceName('Default - Minilab3 MIDI')).toBe('Minilab3 MIDI');
    expect(shortDeviceName('Minilab3 MIDI (1c75:02cb)')).toBe('Minilab3 MIDI');
  });

  it('truncates a name too long for an LCD line', () => {
    expect(shortDeviceName('Built-in Audio Analogue Stereo').length).toBeLessThanOrEqual(22);
  });
});

describe('resolveDeviceId', () => {
  const options = [{ id: 'out1', label: 'A' }];

  it('keeps a remembered device that is still plugged in', () => {
    expect(resolveDeviceId('out1', options)).toBe('out1');
  });

  it('forgets one that is gone, rather than routing into nothing', () => {
    expect(resolveDeviceId('out9', options)).toBeNull();
    expect(resolveDeviceId(null, options)).toBeNull();
  });
});

describe('device persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a choice and clears it again', () => {
    expect(loadDeviceId(MORPH_SINK_KEY)).toBeNull();
    saveDeviceId(MORPH_SINK_KEY, 'out2');
    expect(loadDeviceId(MORPH_SINK_KEY)).toBe('out2');
    saveDeviceId(MORPH_SINK_KEY, null);
    expect(loadDeviceId(MORPH_SINK_KEY)).toBeNull();
  });
});
