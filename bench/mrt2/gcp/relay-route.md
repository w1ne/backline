# Relay route: `GET /mrt2` → `env.MRT2_UPSTREAM`

Not applied — the relay is `relay/src/index.ts`, out of scope for this task
per the brief ("Do not edit the relay yourself"). This is the exact diff to
hand to whoever owns that file. It mirrors `handleLyria` (same file, lines
150–252) — same auth (cookie / `?t=` / `Sec-WebSocket-Protocol` "bl." prefix),
same origin check, same bidirectional `WebSocketPair` pump — pointed at the
MRT2 GPU host instead of Google's Lyria endpoint.

## 1. `Env` interface — add one binding

```ts
export interface Env {
  GEMINI_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  GITHUB_TOKEN: string;
  ALLOWED_ORIGIN: string;
  REPO: string;
  MRT2_UPSTREAM: string; // wss://... — RunPod proxy URL or GCE/Cloud Run URL
}
```

Set it as a Worker **secret**, not a plain var, since it will contain a
RunPod pod ID or a host address that shouldn't be casually visible in `wrangler
tail` logs or the dashboard's plaintext vars list:

```bash
cd relay
npx wrangler secret put MRT2_UPSTREAM
# paste: wss://<POD_ID>-8080.proxy.runpod.net   (see gcp/README.md §3)
```

## 2. New handler function (add near `handleLyria`)

```ts
async function handleMrt2(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (origin && origin !== env.ALLOWED_ORIGIN) {
    return new Response("forbidden origin", { status: 403 });
  }

  const url = new URL(req.url);

  // Same three-way auth fallback as handleLyria: cookie, then ?t=<token>,
  // then Sec-WebSocket-Protocol "bl.<token>" for SDK-driven clients.
  let token = readCookie(req, COOKIE_NAME);
  if (!token) token = url.searchParams.get("t");
  let matchedProtocol: string | null = null;
  if (!token) {
    const protoHeader = req.headers.get("Sec-WebSocket-Protocol");
    if (protoHeader) {
      for (const raw of protoHeader.split(",")) {
        const p = raw.trim();
        if (p.startsWith(SUBPROTOCOL_PREFIX)) {
          token = p.slice(SUBPROTOCOL_PREFIX.length);
          matchedProtocol = p;
          break;
        }
      }
    }
  }
  const session = token ? await verifySession(env.SESSION_SECRET, token) : null;
  if (!session) return new Response("unauthorized", { status: 401 });

  if (req.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  // MRT2's serve.py has no path routing of its own — it upgrades on "/".
  // env.MRT2_UPSTREAM is the full wss://host[:port] origin (RunPod proxy
  // domain, or GCE/Cloud Run host); no path or query is appended.
  const upstreamResp = await fetch(env.MRT2_UPSTREAM, { headers: { Upgrade: "websocket" } });
  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    return new Response("upstream did not upgrade", { status: 502 });
  }
  upstream.accept();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  server.addEventListener("message", (ev: MessageEvent) => {
    try {
      upstream.send(ev.data as string | ArrayBuffer);
    } catch {
      /* upstream already closed */
    }
  });
  upstream.addEventListener("message", (ev: MessageEvent) => {
    try {
      server.send(ev.data as string | ArrayBuffer);
    } catch {
      /* client already closed */
    }
  });

  server.addEventListener("close", (ev: CloseEvent) => {
    try {
      upstream.close(ev.code, ev.reason);
    } catch {
      /* already closed */
    }
  });
  upstream.addEventListener("close", (ev: CloseEvent) => {
    try {
      server.close(ev.code, ev.reason);
    } catch {
      /* already closed */
    }
  });
  server.addEventListener("error", () => {
    try {
      upstream.close();
    } catch {
      /* noop */
    }
  });
  upstream.addEventListener("error", () => {
    try {
      server.close();
    } catch {
      /* noop */
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(matchedProtocol ? { headers: { "Sec-WebSocket-Protocol": matchedProtocol } } : {}),
  });
}
```

## 3. Route it in `fetch`

```ts
    if (url.pathname === "/lyria" || isBidiGenerateMusicPath(url.pathname)) {
      return handleLyria(req, env);
    }
    if (url.pathname === "/mrt2") {
      return handleMrt2(req, env);
    }
    return new Response("not found", { status: 404 });
```

## Notes / verify before shipping

- **TLS**: `MRT2_UPSTREAM` must be `wss://`, not `ws://` — Workers' `fetch()`
  refuses to upgrade a plaintext WebSocket to an external host over the
  public internet in most configurations, and the browser app itself
  requires a secure context anyway. RunPod's `proxy.runpod.net` domain
  terminates TLS with a valid cert for you (see `gcp/README.md` §3) — this
  is exactly the "valid certificate" requirement in the brief, satisfied
  without provisioning anything yourself.
- **Idle timeout**: RunPod's HTTP/WS proxy path (`Cloudflare → RunPod LB →
  pod`) enforces a **100-second** timeout per Runpod's own docs
  (`docs.runpod.io/pods/configuration/expose-ports`). MRT2 emits an audio
  chunk roughly every ~2s of wall-clock time once RTF ≤ 1, which is well
  under that — but if the *client* goes idle (e.g. paused, no control
  messages, and `serve.py`'s generation loop is also paused) for over 100s,
  Cloudflare will drop the connection. `serve.py`'s Session loop currently
  keeps generating (and thus sending frames) continuously whenever
  `playing=True`; if you add a genuine "pause and hold the socket open"
  feature, add a periodic WS ping from the relay or from `serve.py` to keep
  the proxy's idle timer from firing during a pause. `UNVERIFIED`: whether
  Cloudflare Workers' own `fetch()`-based WebSocket proxying imposes its own
  separate idle timeout on top of RunPod's — check `wrangler tail` behavior
  once an upstream exists.
- **Path**: `serve.py` (both `../serve.py` and `gcp/serve.py`) upgrades on
  any path (`websockets.serve` doesn't route by path), so `MRT2_UPSTREAM`
  should be the bare origin, not `.../mrt2`.
