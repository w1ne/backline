import { MAIN_ROUTING } from '../audio/routing';
import type { Store } from '../ui/state';

export const PI_EDITION = import.meta.env.VITE_DEVICE === 'lydia';

export function applyDeviceProfile(store: Store, edition: string): void {
  if (edition !== 'lydia') return;
  store.update({
    engine: 'amt', sound: 'synth',
    enabled: { drums: true, bass: true, keys: true, lead: false },
    morphOut: null, routing: { ...MAIN_ROUTING },
    micIn: null, midiIn: null, micMuted: false,
    offlineEngines: ['acestep', 'lyria'],
  });
}
