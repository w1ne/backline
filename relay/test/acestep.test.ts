import { describe, expect, it } from "vitest";
import { handleAceStep } from "../src/index";
import type { Env } from "../src/index";
import { signSession } from "../src/session";

const SECRET = "test-secret-value";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: "unused",
    GITHUB_CLIENT_ID: "unused",
    GITHUB_CLIENT_SECRET: "unused",
    SESSION_SECRET: SECRET,
    GITHUB_TOKEN: "unused",
    ALLOWED_ORIGIN: "https://shylenko.com",
    REPO: "w1ne/backline",
    ...overrides,
  } as Env;
}

async function cookieHeader(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await signSession(SECRET, { login: "w1ne", exp });
  return `bl_session=${token}`;
}

describe("handleAceStep", () => {
  it("rejects a request with no session cookie", async () => {
    const env = baseEnv({ ACESTEP_UPSTREAM: "wss://example.runpod.net/ws" });
    const req = new Request("https://backline-relay.example.workers.dev/acestep", {
      headers: { Upgrade: "websocket" },
    });
    const resp = await handleAceStep(req, env);
    expect(resp.status).toBe(401);
  });

  it("returns 503 when ACESTEP_UPSTREAM is not configured", async () => {
    const env = baseEnv(); // no ACESTEP_UPSTREAM
    const req = new Request("https://backline-relay.example.workers.dev/acestep", {
      headers: { Upgrade: "websocket", Cookie: await cookieHeader() },
    });
    const resp = await handleAceStep(req, env);
    expect(resp.status).toBe(503);
    expect(await resp.text()).toBe("acestep upstream not configured");
  });

  it("rejects a disallowed Origin even with a valid session", async () => {
    const env = baseEnv({ ACESTEP_UPSTREAM: "wss://example.runpod.net/ws" });
    const req = new Request("https://backline-relay.example.workers.dev/acestep", {
      headers: { Upgrade: "websocket", Cookie: await cookieHeader(), Origin: "https://evil.example" },
    });
    const resp = await handleAceStep(req, env);
    expect(resp.status).toBe(403);
  });
});
