// The relay's own hostname. On soundofthe.world the relay answers on a
// sibling subdomain so the two are same-site; everywhere else (shylenko.com,
// pages.dev previews, localhost) it is reached at its workers.dev hostname.
function defaultRelayUrl(): string {
  if (typeof location !== 'undefined' && location.hostname === 'soundofthe.world') {
    return 'https://api.soundofthe.world';
  }
  return 'https://backline-relay.shylenkoa.workers.dev';
}

export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? defaultRelayUrl();
