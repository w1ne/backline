import type { EngineChoice } from '../ui/state';

/** Engines a player can point at their own GPU pod instead of the hosted relay. */
export type OwnEngine = 'acestep' | 'amt';
export const OWN_ENGINES: readonly OwnEngine[] = ['acestep', 'amt'];

/** RunPod proxies one HTTP port per pod as `<pod>-<port>.proxy.runpod.net`; these are the ports
 *  `services/pod-bootstrap.sh` publishes each service on. */
const RUNPOD_PORT: Record<OwnEngine, number> = { acestep: 8080, amt: 8081 };
const STORAGE_PREFIX = 'duet.upstream.';

/**
 * Normalises what a player typed into a websocket URL, or null for an empty field.
 * Accepts a bare RunPod pod id (`6r2srn274qynf1`), a host (`6r2…-8080.proxy.runpod.net`,
 * `localhost:8080`), or a full `ws(s)://` / `http(s)://` URL; `/ws` is appended when no path
 * was given, which is where both pod services listen.
 */
export function resolveUpstream(engine: OwnEngine, input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^[a-z0-9]{10,16}$/i.test(raw)) return `wss://${raw.toLowerCase()}-${RUNPOD_PORT[engine]}.proxy.runpod.net/ws`;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `wss://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  return url.toString();
}

/** The player's saved upstream for an engine (raw text), or '' when they use the hosted relay. */
export function ownUpstream(engine: OwnEngine): string {
  try {
    return localStorage.getItem(STORAGE_PREFIX + engine) ?? '';
  } catch {
    return '';
  }
}

export function saveOwnUpstream(engine: OwnEngine, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(STORAGE_PREFIX + engine, value.trim());
    else localStorage.removeItem(STORAGE_PREFIX + engine);
  } catch {
    /* private mode: the field still works for this page load via state */
  }
}

/** Where an engine's socket goes: the player's own pod when set, else the relay path. */
export function engineSocketUrl(engine: OwnEngine, relayUrl: string, relayPath: string): string {
  return resolveUpstream(engine, ownUpstream(engine)) ?? relayUrl.replace(/^http/, 'ws') + relayPath;
}

/** The relay's health says nothing about a pod the relay never talks to. */
export function withoutOwnUpstreams(offline: EngineChoice[]): EngineChoice[] {
  return offline.filter(e => !(OWN_ENGINES as readonly string[]).includes(e) || !resolveUpstream(e as OwnEngine, ownUpstream(e as OwnEngine)));
}
