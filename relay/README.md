# backline-relay

Cloudflare Worker that lets the static Backline web app (https://shylenko.com/backline/)
use Google's Lyria RealTime music API without shipping the Gemini API key to the
browser, gated to GitHub users who are collaborators on `w1ne/backline`.

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

  Auth (checked in this order): a `bl_session` cookie; a `?t=<token>` query
  param carrying the same signed token; or a `Sec-WebSocket-Protocol` value
  `bl.<token>` — used because the `@google/genai` SDK controls the WebSocket
  URL and offers no hook to add headers, cookies, or query params to the
  upgrade request it makes, but does let callers set a WebSocket subprotocol.
  The Worker echoes the matched subprotocol back on the 101 response, as
  required by the WebSocket protocol when a subprotocol was requested.

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

From the static Backline page:

```js
// kick off login if not already authenticated
location = relay + '/auth/login?redirect=' + encodeURIComponent(location.href);

// once authenticated (cookie set on this origin via SameSite=None), point the
// official SDK at the Worker instead of Google directly. The SDK will open
// wss://<worker host>/ws/.../BidiGenerateMusic?key=relay itself; the Worker
// authenticates the request via the bl_session cookie sent along with the
// WebSocket upgrade (browsers send SameSite=None cookies on cross-site WS
// upgrades) and ignores the placeholder "relay" key.
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({
  apiKey: 'relay', // placeholder; the Worker supplies the real key
  httpOptions: { baseUrl: relay }, // e.g. https://backline-relay.<account>.workers.dev
});
```

Where `relay` is `https://backline-relay.<account>.workers.dev`.

If the browser context doesn't send the session cookie on the WebSocket
upgrade (e.g. cookies blocked), fall back to a manual `new
WebSocket(relayWs + '/lyria')` with `?t=<token>` or a `bl.<token>`
subprotocol, using the session token returned by `/auth/me` or held from
the callback redirect.

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
  (https://developers.cloudflare.com/workers/examples/websockets/). Not
  independently verified against Google's Lyria endpoint since deploying is
  out of scope here.
