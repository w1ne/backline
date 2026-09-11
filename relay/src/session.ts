// Pure, side-effect-free helpers for signing/verifying the session cookie
// and the OAuth `state` parameter. Uses Web Crypto (available in Workers
// and in Node's test runner via the global `crypto`).

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

async function hmacVerify(secret: string, message: string, signature: string): Promise<boolean> {
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(message));
}

export interface SessionPayload {
  login: string;
  exp: number; // unix seconds
}

// Cookie value format: base64url(login|exp) + "." + hmac-sha256(payload)
export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const raw = `${payload.login}|${payload.exp}`;
  const encoded = toBase64Url(new TextEncoder().encode(raw));
  const sig = await hmacSign(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifySession(secret: string, token: string): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ok = await hmacVerify(secret, encoded, sig);
  if (!ok) return null;
  let raw: string;
  try {
    raw = new TextDecoder().decode(fromBase64Url(encoded));
  } catch {
    return null;
  }
  const bar = raw.lastIndexOf("|");
  if (bar === -1) return null;
  const login = raw.slice(0, bar);
  const exp = Number(raw.slice(bar + 1));
  if (!login || !Number.isFinite(exp)) return null;
  if (Date.now() / 1000 > exp) return null;
  return { login, exp };
}

// OAuth state format: base64url(redirect|nonce) + "." + hmac-sha256(payload)
export async function signState(secret: string, redirect: string, nonce: string): Promise<string> {
  const raw = `${redirect}|${nonce}`;
  const encoded = toBase64Url(new TextEncoder().encode(raw));
  const sig = await hmacSign(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifyState(secret: string, state: string): Promise<{ redirect: string; nonce: string } | null> {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const ok = await hmacVerify(secret, encoded, sig);
  if (!ok) return null;
  let raw: string;
  try {
    raw = new TextDecoder().decode(fromBase64Url(encoded));
  } catch {
    return null;
  }
  const bar = raw.lastIndexOf("|");
  if (bar === -1) return null;
  return { redirect: raw.slice(0, bar), nonce: raw.slice(bar + 1) };
}
