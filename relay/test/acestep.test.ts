import { beforeEach, describe, expect, it } from "vitest";
import { handleAceStep, resetUpgradeLimit } from "../src/index";
import type { Env } from "../src/index";

const APP_ORIGIN = "https://soundofthe.world";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: "unused",
    GITHUB_CLIENT_ID: "unused",
    GITHUB_CLIENT_SECRET: "unused",
    SESSION_SECRET: "test-secret-value",
    GITHUB_TOKEN: "unused",
    ALLOWED_ORIGINS: "https://soundofthe.world,https://shylenko.com",
    REPO: "w1ne/duet.ai",
    ...overrides,
  } as Env;
}

function upgradeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.soundofthe.world/acestep", {
    headers: { Upgrade: "websocket", Origin: APP_ORIGIN, "cf-connecting-ip": "203.0.113.7", ...headers },
  });
}

beforeEach(() => resetUpgradeLimit());

describe("handleAceStep", () => {
  it("rejects a foreign Origin", async () => {
    const env = baseEnv({ ACESTEP_UPSTREAM: "wss://example.runpod.net/ws" });
    const resp = await handleAceStep(upgradeRequest({ Origin: "https://evil.example" }), env);
    expect(resp.status).toBe(403);
  });

  it("rejects a request with no Origin at all", async () => {
    const env = baseEnv({ ACESTEP_UPSTREAM: "wss://example.runpod.net/ws" });
    const req = new Request("https://api.soundofthe.world/acestep", {
      headers: { Upgrade: "websocket", "cf-connecting-ip": "203.0.113.7" },
    });
    const resp = await handleAceStep(req, env);
    expect(resp.status).toBe(403);
  });

  it("no longer requires a session cookie", async () => {
    const env = baseEnv(); // no ACESTEP_UPSTREAM — gets past the gate to the 503
    const resp = await handleAceStep(upgradeRequest(), env);
    expect(resp.status).toBe(503);
    expect(await resp.text()).toBe("acestep upstream not configured");
  });

  it("returns 429 on the twenty-first upgrade from one IP within a minute", async () => {
    const env = baseEnv(); // 503 means the request passed the gate
    for (let i = 0; i < 20; i++) {
      const resp = await handleAceStep(upgradeRequest(), env);
      expect(resp.status).toBe(503);
    }
    const over = await handleAceStep(upgradeRequest(), env);
    expect(over.status).toBe(429);
  });

  it("counts the cap per client IP, not globally", async () => {
    const env = baseEnv();
    for (let i = 0; i < 20; i++) await handleAceStep(upgradeRequest(), env);
    const other = await handleAceStep(upgradeRequest({ "cf-connecting-ip": "198.51.100.4" }), env);
    expect(other.status).toBe(503);
  });
});
