import { signSession, signState, verifySession, verifyState } from "./session";

export interface Env {
  GEMINI_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  GITHUB_TOKEN: string;
  ALLOWED_ORIGIN: string;
  REPO: string;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const COOKIE_NAME = "bl_session";

function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
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

function isAllowedRedirect(url: string, env: Env): boolean {
  try {
    return url.startsWith(env.ALLOWED_ORIGIN);
  } catch {
    return false;
  }
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const redirect = url.searchParams.get("redirect") || `${env.ALLOWED_ORIGIN}/backline/`;
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
    return new Response("unauthorized", { status: 401, headers: corsHeaders(env) });
  }
  return new Response(JSON.stringify({ login: session.login }), {
    status: 200,
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

const SUBPROTOCOL_PREFIX = "bl.";

// True for any "/ws/.../BidiGenerateMusic" path, matching the URL shape the
// @google/genai SDK builds when pointed at this Worker via httpOptions.baseUrl
// (any apiVersion segment, e.g. v1alpha).
function isBidiGenerateMusicPath(pathname: string): boolean {
  return /^\/ws\/.*BidiGenerateMusic$/.test(pathname);
}

async function handleLyria(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (origin && origin !== env.ALLOWED_ORIGIN) {
    return new Response("forbidden origin", { status: 403 });
  }

  const url = new URL(req.url);

  // Auth: cookie, then ?t=<token> fallback, then Sec-WebSocket-Protocol
  // "bl.<token>" (used by SDK-driven clients that cannot set headers/cookies
  // or control the query string on the upgrade request).
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

  // Proxy to the same "/ws/.../BidiGenerateMusic" path on Google's API,
  // ignoring whatever `key` the client sent and using the real server-side
  // key instead.
  const upstreamUrl = new URL(`https://generativelanguage.googleapis.com${url.pathname}`);
  upstreamUrl.protocol = "wss:";
  upstreamUrl.searchParams.set("key", env.GEMINI_API_KEY);

  const upstreamResp = await fetch(upstreamUrl.toString(), { headers: { Upgrade: "websocket" } });
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
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
    return new Response("not found", { status: 404 });
  },
};
