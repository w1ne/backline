# backline-relay

Cloudflare Worker that lets the static Backline web app (https://shylenko.com/backline/)
use Google's Lyria RealTime music API without shipping the Gemini API key to the
browser, gated to GitHub users who are collaborators on `w1ne/backline`.

Deployed at https://backline-relay.shylenkoa.workers.dev.

## Endpoints

- `GET /health` — plaintext `ok`.
- `GET /auth/login?redirect=<url>` — starts GitHub OAuth, redirects to GitHub.
- `GET /auth/callback` — GitHub OAuth callback, sets the `bl_session` cookie and
  redirects back to `redirect`, or shows a 403 page if the user is not a
  collaborator.
- `GET /auth/me` — `{ "login": "..." }` if the session cookie is valid, else 401.
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

  Auth: the `bl_session` cookie only. The cookie is `SameSite=None; Secure`,
  so browsers send it on the cross-site WebSocket upgrade without any extra
  wiring from the app.

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
npx wrangler deploy
```

`GITHUB_TOKEN` must be a personal access token with read access to
`w1ne/backline` (classic PAT with `repo` scope, or a fine-grained PAT with
"Collaborators" read permission on the repo) — it is used server-side to call
the GitHub collaborators API and is never exposed to clients.

`SESSION_SECRET` should be a long random string (e.g. `openssl rand -hex 32`);
it signs both the session cookie and the OAuth `state` parameter.

### GitHub OAuth App setup

Create a GitHub OAuth App (https://github.com/settings/developers) with:

- Homepage URL: `https://shylenko.com/backline/`
- Authorization callback URL: `https://backline-relay.<account>.workers.dev/auth/callback`

Use its Client ID / Client Secret for `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

## How the app uses it

This is implemented in `src/auth.ts`, `src/config.ts`, and
`src/engines/lyriaEngine.ts`. No Gemini key is ever entered or stored in the
browser; the setup screen (`src/ui/setup.ts`) just shows a "Sign in with
GitHub" button when signed out.

```js
// src/auth.ts: kick off login if not already authenticated
location.href = RELAY_URL + '/auth/login?redirect=' + encodeURIComponent(location.href);

// src/engines/lyriaEngine.ts: once authenticated (cookie set on this origin
// via SameSite=None), point the official SDK at the Worker instead of Google
// directly. The SDK will open wss://<worker host>/ws/.../BidiGenerateMusic?key=relay
// itself; the Worker authenticates the request via the bl_session cookie sent
// along with the WebSocket upgrade (browsers send SameSite=None cookies on
// cross-site WS upgrades) and ignores the placeholder "relay" key.
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({
  apiKey: 'relay', // placeholder; the Worker supplies the real key
  httpOptions: { baseUrl: RELAY_URL, apiVersion: 'v1alpha' },
});
```

Where `RELAY_URL` (`src/config.ts`) defaults to
`https://backline-relay.shylenkoa.workers.dev`, overridable via
`VITE_RELAY_URL`.

## Browser support

Sign-in currently works in Chrome. Safari and Firefox block the third-party
`bl_session` cookie because `workers.dev` is on the Public Suffix List, which
makes the relay and the app look like unrelated sites to those browsers'
cross-site cookie rules. The fix is to move the relay to a `shylenko.com`
subdomain (e.g. `relay.shylenko.com`) so the cookie is same-site with the app.

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
