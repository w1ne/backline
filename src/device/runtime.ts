import type { AccompPreset } from '../types';
import { soundDef } from '../players/soundCatalog';
import type { LiveActions } from '../ui/live';
import type { Store } from '../ui/state';
import { keyName } from '../music/scales';
import { chordName } from '../listener/chordDetector';

export interface DeviceCommand {
  id: number;
  type: 'set' | 'toggle' | 'transport' | 'mic' | 'bpm' | 'key' | 'accompPreset';
  preset?: AccompPreset;
  on?: boolean;
  field?: string;
  value?: unknown;
  instrument?: 'drums' | 'bass' | 'keys' | 'lead';
  playing?: boolean;
  muted?: boolean;
  bpm?: number | null;
  key?: {root:number;mode:'major'|'minor'} | null;
}

/** Local control plane for the Pi renderer. Never installed in the public web build. */
export function startDeviceRuntime(store: Store, actions: () => LiveActions,
  transport: (playing: boolean) => Promise<void>,
  performanceStatus: () => { performanceActive: boolean; performanceLastAt: number; bpmOverride?: number | null; keyOverride?: {root:number;mode:'major'|'minor'} | null } = () => ({ performanceActive: true, performanceLastAt: Date.now() })): () => void {
  let stopped = false;
  let ack = 0;
  let epoch = '';
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    try {
      const response = await fetch(`/api/commands?ack=${ack}&epoch=${epoch}`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error('Device control unavailable');
      const packet: { epoch: string; commands: DeviceCommand[] } = await response.json();
      if (packet.epoch !== epoch) { epoch = packet.epoch; ack = 0; }
      const commands = packet.commands;
      for (const c of commands) {
        if (c.id <= ack) continue;
        const a = actions();
        if (c.type === 'toggle' && c.instrument) a.toggle(c.instrument);
        else if (c.type === 'accompPreset' && c.preset && typeof c.on === 'boolean') {
          if (store.state.accompPresets.includes(c.preset) !== c.on) a.toggleAccompPreset?.(c.preset, c.on);
        }
        else if (c.type === 'transport') await transport(c.playing === true);
        else if (c.type === 'mic') a.setMicMuted?.(c.muted === true);
        else if (c.type === 'key') a.setKeyOverride?.(c.key ?? undefined);
        else if (c.type === 'bpm') a.setBpmOverride?.(c.bpm ?? undefined);
        else if (c.type === 'set') {
          if (c.field === 'sound') a.setSound?.(c.value as string);
          if (c.field === 'noiseVolume') a.setNoiseVolume?.(c.value as number);
          if (c.field === 'droneVolume') a.setDroneVolume?.(c.value as number);
          if (c.field === 'genre') a.setGenre(c.value as Parameters<LiveActions['setGenre']>[0]);
          if (c.field === 'engine') a.setEngine(c.value as Parameters<LiveActions['setEngine']>[0]);
          if (c.field === 'creativity') a.setCreativity(c.value as number);
          if (c.field === 'intensity') a.setIntensity?.(c.value as number);
        }
        ack = c.id;
      }
      const s = store.state;
      await fetch('/api/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(2000),
        body: JSON.stringify({ ...performanceStatus(), state: s, accompanimentStatus: s.accompanimentStatus, modelLatencyMs: s.modelLatencyMs, activeParts: s.activeParts, noiseVolume: s.noiseVolume, droneVolume: s.droneVolume, sound: s.sound, soundLabel: soundDef(s.sound).label, power: s.power, engine: s.engine, genre: s.genre,
          bpm: s.input.bpm, key: s.input.key ? keyName(s.input.key) : null,
          chord: s.input.chord ? chordName(s.input.chord) : null,
          inputLevel: s.input.inputLevel, locked: s.locked, bar: s.bar,
          barStartedAt: s.barStartedAt, beatsPerBar: 4, space: s.input.dynamics.space, fill: s.input.dynamics.fillDue,
          error: s.error, enabled: s.enabled, creativity: s.creativity, intensity: s.intensity,
          audioSuspended: s.audioSuspended, sources: s.sources, micMuted: s.micMuted,
        }),
      });
    } catch (error) {
      console.warn('Pi control:', error);
    } finally {
      if (!stopped) timer = setTimeout(run, 200);
    }
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
