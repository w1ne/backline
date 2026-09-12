# backline-relay

Cloudflare Worker that lets the static Backline web app use Google's Lyria
RealTime music API, and the ACE-Step pod, without shipping either credential to
the browser.

There is no sign-in. The relay accepts requests only from the app's own origins
(`ALLOWED_ORIGINS`) and caps how many WebSocket upgrades a single client IP may
open per minute, which is what keeps the upstream keys from being a free API for
anyone who finds the hostname.

Deployed at https://backline-relay.shylenkoa.workers.dev, and (once the
soundofthe.world zone exists in the account) at https://api.soundofthe.world.

## Endpoints

- `GET /health` — plaintext `ok`.
- `GET /auth/*` — the old GitHub sign-in (`/auth/login`, `/auth/callback`,
  `/auth/me`). Still wired up and still working, but nothing calls it: the app
  no longer signs anyone in, so `/auth/me` just answers `401`. Kept so the
  routes can be revived without rebuilding them; delete them if a future
  change makes that decision permanent.
- `GET /ws/.../BidiGenerateMusic` (any `apiVersion` segment, e.g.
  `google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic`)
  — WebSocket upgrade. This is the path the official `@google/genai` SDK
  builds itself when pointed at this Worker (see "How the app uses it"
  below), so the Worker matches it structurally rather than requiring an
  exact string. Any `key=` query param the SDK attaches is ignored; the
  Worker proxies to the same path on `generativelanguage.googleapis.com`
  with the real `GEMINI_API_KEY` appended server-side.
  `GET /lyria` is kept as a plain alias to the same handler for callers that
  don't go through the SDK.

  Admission: `Origin` must be one of `ALLOWED_ORIGINS` — a missing `Origin`
  is refused too, since browsers always send one on a WebSocket upgrade — and
  the client IP (`cf-connecting-ip`) must be under the upgrade rate limit.
  Foreign or absent origin is `403`, over the limit is `429`.
- `GET /acestep` — WebSocket upgrade, same admission check as `/lyria`,
  proxying to the ACE-Step pod at
  `env.ACESTEP_UPSTREAM` (a full `wss://…/ws` URL, kept as a Worker secret
  so pod ids don't land in git). Returns `503` with body
  `acestep upstream not configured` if the secret isn't set. The Worker
  sends the upstream a `{"type":"ping"}` text frame every 30 s for the life
  of the connection, since RunPod's proxy in front of the pod drops
  connections idle for 100 s; the app-facing side has no keepalive.
- `GET /amt` — WebSocket upgrade, same admission check as `/lyria`,
  proxying to the AMT (Anticipatory Music Transformer) pod at
  `env.AMT_UPSTREAM` (a full `wss://…/ws` URL, kept as a Worker secret so
  pod ids don't land in git). Returns `503` with body
  `amt upstream not configured` if the secret isn't set. Same 30 s
  keepalive ping as `/acestep`.

## Deploy

```sh
cd relay
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ACESTEP_UPSTREAM   # wss://<pod>.../ws, only needed for /acestep
npx wrangler secret put AMT_UPSTREAM       # wss://<pod>.../ws, only needed for /amt
npx wrangler deploy
```

`GITHUB_TOKEN` must be a personal access token with read access to
`w1ne/backline` (classic PAT with `repo` scope, or a fine-grained PAT with
"Collaborators" read permission on the repo) — it is used server-side to call
the GitHub collaborators API and is never exposed to clients.

`SESSION_SECRET` should be a long random string (e.g. `openssl rand -hex 32`);
it signs both the session cookie and the OAuth `state` parameter.

### Origins

`ALLOWED_ORIGINS` in `wrangler.toml` is the comma-separated list of origins the
app is served from — currently `https://soundofthe.world,https://shylenko.com`.
It is the allowlist for the WebSocket routes, the value reflected in
`Access-Control-Allow-Origin`, and the set of redirects `/auth/login` accepts.
Add an origin here before serving the app from it.

The `GITHUB_*` secrets are only needed by the unused `/auth/*` routes; the
OAuth App's callback URL is still `https://backline-relay.<account>.workers.dev/auth/callback`.

## How the app uses it

This is implemented in `src/config.ts` and `src/engines/lyriaEngine.ts`. No
Gemini key is ever entered or stored in the browser, and the app does no
sign-in: picking the Lyria engine connects straight away.

```js
// src/engines/lyriaEngine.ts: point the official SDK at the Worker instead of
// Google directly. The SDK opens wss://<worker host>/ws/.../BidiGenerateMusic?key=relay
// itself; the Worker admits the upgrade on its Origin (which the browser sets
// and a page on another site cannot forge) and ignores the placeholder key.
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({
  apiKey: 'relay', // placeholder; the Worker supplies the real key
  httpOptions: { baseUrl: RELAY_URL, apiVersion: 'v1alpha' },
});
```

Where `RELAY_URL` (`src/config.ts`) is `https://api.soundofthe.world` when the
app is served from `soundofthe.world`, and
`https://backline-relay.shylenkoa.workers.dev` everywhere else
(shylenko.com/backline/, pages.dev previews, localhost). `VITE_RELAY_URL`
overrides both at build time.

## Browser support

All browsers, since nothing depends on a cross-site cookie any more. (While
sign-in existed, Safari and Firefox blocked the `bl_session` cookie because
`workers.dev` is on the Public Suffix List, which made the relay and the app
look like unrelated sites. Serving the relay from `api.soundofthe.world` makes
it same-site with the app, so the `/auth/*` routes would work there too.)

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run — cookie/state sign+verify unit tests
```

## Notes / unverified

- `fetch()`'s outbound URL, including the `?key=...` query string, is passed
  through unchanged to the upstream WebSocket handshake — this is standard
  Fetch API behavior (the URL is opaque to the runtime), not something specific
  to the WebSocket upgrade path, which Cloudflare's docs describe only in terms
  of the `Upgrade` header handling
  (https://developers.cloudflare.com/workers/examples/websockets/).
