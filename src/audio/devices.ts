/** A device as the pickers show it: a stable id and something readable next to it. */
export interface DeviceOption {
  id: string;
  label: string;
}

export const MORPH_SINK_KEY = 'backline.morph.sink';
export const MIC_DEVICE_KEY = 'backline.mic.device';
export const MIDI_INPUT_KEY = 'backline.midi.input';
export const MIC_MUTE_KEY = 'backline.mic.muted';

/**
 * enumerateDevices() output → picker options.
 *
 * Labels are empty strings until the page has been granted a media permission, so a
 * device with no label still gets a usable name rather than an empty <option>.
 */
export function mapDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind): DeviceOption[] {
  const out: DeviceOption[] = [];
  for (const d of devices) {
    if (d.kind !== kind || !d.deviceId) continue;
    if (out.some(o => o.id === d.deviceId)) continue;
    const fallback = kind === 'audiooutput' ? 'Output' : 'Input';
    out.push({ id: d.deviceId, label: d.label?.trim() || `${fallback} ${out.length + 1}` });
  }
  return out;
}

/** Trims the vendor noise Chrome and ALSA add, so an LCD line stays readable. */
export function shortDeviceName(label: string): string {
  const stripped = label
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .replace(/^(Default|Communications)\s*-\s*/i, '')
    .trim();
  return stripped.length > 22 ? `${stripped.slice(0, 21)}…` : stripped;
}

/** A remembered id is only usable if that device is still present. */
export function resolveDeviceId(saved: string | null, options: DeviceOption[]): string | null {
  if (!saved) return null;
  return options.some(o => o.id === saved) ? saved : null;
}

export function loadDeviceId(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / storage blocked
  }
}

export function saveDeviceId(key: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    // nothing to do: the choice just will not survive a reload
  }
}

export function loadBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false; // private mode / storage blocked
  }
}

export function saveBool(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // nothing to do: the choice just will not survive a reload
  }
}

async function enumerate(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

export async function listOutputs(): Promise<DeviceOption[]> {
  return mapDevices(await enumerate(), 'audiooutput');
}

export async function listInputs(): Promise<DeviceOption[]> {
  return mapDevices(await enumerate(), 'audioinput');
}

/** Calls back whenever a device is plugged in or removed; returns a disposer. */
export function onDeviceChange(cb: () => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return () => {};
  navigator.mediaDevices.addEventListener('devicechange', cb);
  return () => navigator.mediaDevices.removeEventListener('devicechange', cb);
}
