import { RELAY_URL } from './config';

export interface Session {
  login: string;
}

/** Resolves the current relay session, or null if signed out / unreachable. */
export async function getSession(): Promise<Session | null> {
  try {
    const res = await fetch(`${RELAY_URL}/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as Session;
  } catch (err) {
    console.warn('backline: could not reach relay for session check', err);
    return null;
  }
}

/** Redirects to the relay's GitHub OAuth login, returning here afterwards. */
export function login(): void {
  location.href = `${RELAY_URL}/auth/login?redirect=${encodeURIComponent(location.href)}`;
}
