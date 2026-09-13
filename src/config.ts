// The relay's own hostname. On soundofthe.world the relay answers on a
// sibling subdomain so the two are same-site; everywhere else (shylenko.com,
// pages.dev previews, localhost) it is reached at its workers.dev hostname.
// api.soundofthe.world was never given a DNS record (the Worker route stayed commented out
// after sign-in was removed), so the apex used to point at a hostname that does not resolve
// and every engine showed offline there. One relay hostname everywhere.
function defaultRelayUrl(): string {
  return 'https://backline-relay.shylenkoa.workers.dev';
}

export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? defaultRelayUrl();
