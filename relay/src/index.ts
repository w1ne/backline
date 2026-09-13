import { signSession, signState, verifySession, verifyState } from "./session";

export interface Env {
  GEMINI_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  GITHUB_TOKEN: string;
  /** Comma-separated list of origins the app is served from. */
  ALLOWED_ORIGINS: string;
  /** Comma-separated host suffixes (e.g. ".backline-88n.pages.dev") whose https origins are
   *  also allowed -- Cloudflare Pages branch previews get a new hostname per branch. */
  ALLOWED_ORIGIN_SUFFIXES?: string;
  REPO: string;
  ACESTEP_UPSTREAM?: string;
  AMT_UPSTREAM?: string;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const COOKIE_NAME = "bl_session";

/** The app's origins, in preference order (the first is the canonical one). */
export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  if (allowedOrigins(env).includes(origin)) return true;
  const suffixes = (env.ALLOWED_ORIGIN_SUFFIXES ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const host = origin.startsWith("https://") ? origin.slice("https://".length) : "";
  if (!host || host.includes("/") || host.includes(":")) return false;
  return suffixes.some(sfx => host.endsWith(sfx) && host.length > sfx.length);
}

/**
 * Normalizes one inbound WebSocket frame into something `send()` forwards
 * verbatim.
 *
 * A binary frame does not always arrive as an ArrayBuffer: depending on the
 * runtime's compatibility date it can be a Blob (the web-standard
 * `binaryType: "blob"` default). `send()` accepts only strings and buffers, so
 * handing it a Blob coerces it with String() and every frame becomes the
 * 13-byte text "[object Blob]" — which is what the browser then fails to
 * JSON.parse.
 */
export async function toSendable(data: unknown): Promise<string | ArrayBuffer> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (data && typeof (data as Blob).arrayBuffer === "function") return (data as Blob).arrayBuffer();
  throw new TypeError(`unforwardable WebSocket frame: ${Object.prototype.toString.call(data)}`);
}

/** Forwards every frame from one socket to the other, preserving frame order
 *  even when a frame needs an async conversion. */
function pipe(from: WebSocket, to: WebSocket): void {
  // Ask for ArrayBuffers where the runtime supports it, so the common path
  // needs no conversion at all.
  try {
    (from as { binaryType?: string }).binaryType = "arraybuffer";
  } catch {
    /* runtime pins binaryType; toSendable() still handles whatever arrives */
  }
  let tail: Promise<void> = Promise.resolve();
  from.addEventListener("message", (ev: MessageEvent) => {
    const converted = toSendable(ev.data);
    tail = tail.then(async () => {
      try {
        to.send(await converted);
      } catch {
        /* peer already closed, or an unforwardable frame */
      }
    });
  });
}

/** Reflects the caller's origin when it is one of ours, else the canonical one. */
function corsHeaders(req: Request, env: Env): HeadersInit {
  const origin = req.headers.get("Origin");
  const allowed = allowedOrigins(env);
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin, env) ? origin! : (allowed[0] ?? ""),
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

async function isCollaborator(env: Env, login: string): Promise<boolean> {
  const resp = await fetch(
    `https://api.github.com/repos/${env.REPO}/collaborators/${encodeURIComponent(login)}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "backline-relay",
        Accept: "application/vnd.github+json",
      },
    },
  );
  return resp.status === 204;
}

function forbiddenPage(login: string | null): Response {
  const who = login ? ` as ${login}` : "";
  return new Response(
    `<!doctype html><html><body><h1>403 Forbidden</h1><p>Signed in${who}, but you are not a collaborator on this repository.</p></body></html>`,
    { status: 403, headers: { "Content-Type": "text/html" } },
  );
}

export function isAllowedRedirect(url: string, env: Env): boolean {
  try {
    return allowedOrigins(env).includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Where `/auth/login` sends a caller that named no `redirect`. The app lives at
 * the site root on its own domain but under `/backline/` on shylenko.com, so the
 * default follows whichever origin the relay was reached through: requests to
 * `api.<domain>` default to `https://<domain>/`.
 */
export function defaultRedirect(req: Request, env: Env): string {
  const host = new URL(req.url).hostname;
  const origins = allowedOrigins(env);
  if (host.startsWith("api.")) {
    const sibling = `https://${host.slice("api.".length)}`;
    if (origins.includes(sibling)) return `${sibling}/`;
  }
  const first = origins[0] ?? "";
  return first === "https://shylenko.com" ? `${first}/backline/` : `${first}/`;
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const redirect = url.searchParams.get("redirect") || defaultRedirect(req, env);
  if (!isAllowedRedirect(redirect, env)) {
    return new Response("invalid redirect", { status: 400 });
  }
  const nonce = crypto.randomUUID();
  const state = await signState(env.SESSION_SECRET, redirect, nonce);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorizeUrl.searchParams.set("scope", "read:user");
  authorizeUrl.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: authorizeUrl.toString() } });
}

async function handleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("missing code/state", { status: 400 });

  const verified = await verifyState(env.SESSION_SECRET, state);
  if (!verified || !isAllowedRedirect(verified.redirect, env)) {
    return new Response("invalid state", { status: 400 });
  }

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenResp.ok) return new Response("github token exchange failed", { status: 502 });
  const tokenJson = (await tokenResp.json()) as { access_token?: string };
  if (!tokenJson.access_token) return new Response("no access token", { status: 502 });

  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "backline-relay",
      Accept: "application/vnd.github+json",
    },
  });
  if (!userResp.ok) return new Response("github user lookup failed", { status: 502 });
  const userJson = (await userResp.json()) as { login?: string };
  const login = userJson.login;
  if (!login) return new Response("no login in github response", { status: 502 });

  const allowed = await isCollaborator(env, login);
  if (!allowed) return forbiddenPage(login);

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const cookieValue = await signSession(env.SESSION_SECRET, { login, exp });
  const cookie = `${COOKIE_NAME}=${cookieValue}; Secure; HttpOnly; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;

  return new Response(null, {
    status: 302,
    headers: { Location: verified.redirect, "Set-Cookie": cookie },
  });
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req, COOKIE_NAME);
  const session = token ? await verifySession(env.SESSION_SECRET, token) : null;
  if (!session) {
    return new Response("unauthorized", { status: 401, headers: corsHeaders(req, env) });
  }
  return new Response(JSON.stringify({ login: session.login }), {
    status: 200,
    headers: { ...corsHeaders(req, env), "Content-Type": "application/json" },
  });
}

// --- Upgrade admission control -------------------------------------------
//
// The WebSocket routes are not behind a login: anyone loading the app can use
// them. What keeps the upstream keys from being a free API for the whole
// internet is (a) an Origin allowlist, which browsers set on every WebSocket
// upgrade and scripts cannot forge from another page, and (b) a per-IP cap on
// how many upgrades one caller may open per minute. Twenty: a client that
// reconnects with backoff after a blip, plus an old build that still reopens
// the socket on every tempo step, has to fit under it for a whole set.
//
// The counter lives in the isolate, so it is per-colo and resets on eviction.
// That is deliberate: it is a cheap brake on runaway clients, not a billing
// guarantee, and it costs no storage round-trip on the hot path.

// 120: a venue full of people behind one NAT reconnects together (each app re-polls and
// reopens on every engine switch); 20 refused the 21st person on shared Wi-Fi.
const UPGRADE_LIMIT = 120;
const UPGRADE_WINDOW_MS = 60_000;
const upgradeHits = new Map<string, number[]>();

/** True if this IP may open another upgrade now; records the attempt when so. */
export function allowUpgrade(ip: string, now: number = Date.now()): boolean {
  const recent = (upgradeHits.get(ip) ?? []).filter(t => now - t < UPGRADE_WINDOW_MS);
  if (recent.length >= UPGRADE_LIMIT) {
    upgradeHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  upgradeHits.set(ip, recent);
  // Keep the map from growing without bound in a long-lived isolate: whenever
  // it gets large, drop every entry whose window has fully expired.
  if (upgradeHits.size > 1000) {
    for (const [k, v] of upgradeHits) {
      if (v.every(t => now - t >= UPGRADE_WINDOW_MS)) upgradeHits.delete(k);
    }
  }
  return true;
}

/** Test-only: forget every recorded upgrade. */
export function resetUpgradeLimit(): void {
  upgradeHits.clear();
}

/**
 * Shared gate for the WebSocket routes. Returns a Response to send back when
 * the request should not proceed, or null when it may.
 */
export function guardUpgrade(req: Request, env: Env): Response | null {
  // A browser always sends Origin on a WebSocket upgrade, so a missing one is
  // a non-browser caller and is refused along with any foreign origin.
  if (!isAllowedOrigin(req.headers.get("Origin"), env)) {
    return new Response("forbidden origin", { status: 403 });
  }
  if (req.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!allowUpgrade(ip)) {
    return new Response(`too many requests: at most ${UPGRADE_LIMIT} websocket upgrades per minute per IP`, {
      status: 429, headers: { "Retry-After": "60" },
    });
  }
  return null;
}

// True for any "/ws/.../BidiGenerateMusic" path, matching the URL shape the
// @google/genai SDK builds when pointed at this Worker via httpOptions.baseUrl
// (any apiVersion segment, e.g. v1alpha).
function isBidiGenerateMusicPath(pathname: string): boolean {
  // The genai SDK joins baseUrl + path with a double slash; accept both.
  return /^\/+ws\/.*BidiGenerateMusic$/.test(pathname);
}

/**
 * Opens an outbound WebSocket to `upstreamUrl`, pairs it with a fresh
 * client-facing WebSocket, and wires the two together (bidirectional pipe,
 * plus close/error mirroring). Returns the 101 upgrade Response to hand back
 * to the original client, or an error Response if the upstream connection
 * or handshake failed.
 *
 * `keepaliveMs`, when set, sends a `{"type":"ping"}` text frame to the
 * upstream on that interval for as long as the connection is open, and
 * clears the timer once either side closes.
 */
async function proxyWebSocket(upstreamUrl: string, keepaliveMs?: number): Promise<Response> {
  let upstreamResp: Response;
  try {
    // Workers open outbound WebSockets with an https:// URL plus the
    // Upgrade header; a wss:// scheme throws inside fetch().
    upstreamResp = await fetch(upstreamUrl, { headers: { Upgrade: "websocket" } });
  } catch (e) {
    return new Response(`upstream connect failed: ${(e as Error).message}`, { status: 502 });
  }
  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    const body = await upstreamResp.text().catch(() => "");
    return new Response(`upstream did not upgrade: ${upstreamResp.status} ${body.slice(0, 200)}`, { status: 502 });
  }
  upstream.accept();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  pipe(server, upstream);
  pipe(upstream, server);

  let keepalive: ReturnType<typeof setInterval> | undefined;
  if (keepaliveMs) {
    keepalive = setInterval(() => {
      try {
        upstream.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* socket already closing */
      }
    }, keepaliveMs);
  }
  const stopKeepalive = () => {
    if (keepalive) clearInterval(keepalive);
  };

  server.addEventListener("close", (ev: CloseEvent) => {
    stopKeepalive();
    try {
      upstream.close(ev.code, ev.reason);
    } catch {
      /* already closed */
    }
  });
  upstream.addEventListener("close", (ev: CloseEvent) => {
    stopKeepalive();
    try {
      server.close(ev.code, ev.reason);
    } catch {
      /* already closed */
    }
  });
  server.addEventListener("error", () => {
    stopKeepalive();
    try {
      upstream.close();
    } catch {
      /* noop */
    }
  });
  upstream.addEventListener("error", () => {
    stopKeepalive();
    try {
      server.close();
    } catch {
      /* noop */
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

export async function handleLyria(req: Request, env: Env): Promise<Response> {
  const denied = guardUpgrade(req, env);
  if (denied) return denied;

  const url = new URL(req.url);

  // Proxy to the same "/ws/.../BidiGenerateMusic" path on Google's API,
  // ignoring whatever `key` the client sent and using the real server-side
  // key instead.
  const upstreamPath = url.pathname.replace(/^\/+/, "/");
  const upstreamUrl = new URL(`https://generativelanguage.googleapis.com${upstreamPath}`);
  upstreamUrl.searchParams.set("key", env.GEMINI_API_KEY);

  return proxyWebSocket(upstreamUrl.toString());
}

// True for a bare "/acestep" path.
export function isAceStepPath(pathname: string): boolean {
  return pathname === "/acestep";
}

// RunPod's HTTP-facing proxy in front of the ACE-Step pod drops connections
// that sit idle for 100 s, so we keep the upstream leg alive with a small
// JSON ping frame every 30 s. ACE-Step ignores frames it doesn't recognize.
const ACESTEP_KEEPALIVE_MS = 30_000;

export async function handleAceStep(req: Request, env: Env): Promise<Response> {
  const denied = guardUpgrade(req, env);
  if (denied) return denied;

  if (!env.ACESTEP_UPSTREAM) {
    return new Response("acestep upstream not configured", { status: 503 });
  }

  // ACESTEP_UPSTREAM is the full wss://.../ws URL of the RunPod-hosted pod,
  // kept as a Worker secret so pod ids never land in git. fetch() needs an
  // https:// scheme for the outbound WebSocket handshake.
  const upstreamUrl = env.ACESTEP_UPSTREAM.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

  return proxyWebSocket(upstreamUrl, ACESTEP_KEEPALIVE_MS);
}

// True for a bare "/amt" path, or "/amt2": the experimental AMT instance on the same pod,
// reached through the pod's nginx "/v2/" prefix so it needs no second public port or secret.
export function isAmtPath(pathname: string): boolean {
  return pathname === "/amt" || pathname === "/amt2";
}

export function amtUpstreamFor(pathname: string, upstream: string): string {
  return pathname === "/amt2" ? upstream.replace(/\/ws$/, "/v2/ws") : upstream;
}

// Same idle-drop concern as ACE-Step: keep the upstream leg alive with a
// small JSON ping frame while a session sits between bars.
const AMT_KEEPALIVE_MS = 30_000;

export async function handleAmt(req: Request, env: Env): Promise<Response> {
  const denied = guardUpgrade(req, env);
  if (denied) return denied;

  if (!env.AMT_UPSTREAM) {
    return new Response("amt upstream not configured", { status: 503 });
  }

  // AMT_UPSTREAM is the full wss://.../ws URL of the RunPod-hosted pod, kept
  // as a Worker secret so pod ids never land in git. fetch() needs an
  // https:// scheme for the outbound WebSocket handshake.
  const upstreamUrl = amtUpstreamFor(new URL(req.url).pathname, env.AMT_UPSTREAM)
    .replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

  return proxyWebSocket(upstreamUrl, AMT_KEEPALIVE_MS);
}

export type UpstreamState = "ok" | "loading" | "down";

/** GET <origin>/health on an upstream given as its ws(s):// URL. "ok" on a 2xx; "loading" on a
 *  503 (the service is up but its model is not ready yet, so wait rather than restart); "down"
 *  on anything else, an error, or after 3 s. */
export async function upstreamState(upstream: string | undefined): Promise<UpstreamState> {
  if (!upstream) return "down";
  try {
    const origin = new URL(upstream.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://")).origin;
    const res = await fetch(origin + "/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) return "ok";
    return res.status === 503 ? "loading" : "down";
  } catch {
    return "down";
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // The app probes this cross-origin to light the engine LEDs. The relay being up says
      // nothing about the GPU pod behind it, so each upstream is probed too (3 s budget);
      // a stopped pod must show as an offline engine, not as a band that silently went generic.
      const [amtState, acestepState] = await Promise.all([
        upstreamState(env.AMT_UPSTREAM),
        upstreamState(env.ACESTEP_UPSTREAM),
      ]);
      // `amt`/`acestep` stay booleans for the app; the states let the watchdog and smoke tell a
      // pod that is still loading its model from one that is gone.
      const amt = amtState === "ok", acestep = acestepState === "ok";
      return new Response(JSON.stringify({ relay: "ok", amt, acestep, amtState, acestepState, lyria: !!env.GEMINI_API_KEY }), {
        status: 200,
        headers: { ...corsHeaders(req, env), "content-type": "application/json" },
      });
    }
    if (url.pathname === "/auth/login") {
      return handleLogin(req, env);
    }
    if (url.pathname === "/auth/callback") {
      return handleCallback(req, env);
    }
    if (url.pathname === "/auth/me") {
      return handleMe(req, env);
    }
    if (url.pathname === "/lyria" || isBidiGenerateMusicPath(url.pathname)) {
      return handleLyria(req, env);
    }
    if (isAceStepPath(url.pathname)) {
      return handleAceStep(req, env);
    }
    if (isAmtPath(url.pathname)) {
      return handleAmt(req, env);
    }
    return new Response("not found", { status: 404 });
  },
};
