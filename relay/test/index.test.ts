import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { defaultRedirect, isAllowedOrigin, isAllowedRedirect, upstreamState } from "../src/index";
import type { Env } from "../src/index";

const env = { ALLOWED_ORIGINS: "https://soundofthe.world,https://shylenko.com" } as Env;

describe("isAllowedRedirect", () => {
  it("allows a redirect to either allowed origin", () => {
    expect(isAllowedRedirect("https://shylenko.com/backline/", env)).toBe(true);
    expect(isAllowedRedirect("https://soundofthe.world/", env)).toBe(true);
  });

  it("rejects a lookalike origin that merely starts with an allowed origin", () => {
    expect(isAllowedRedirect("https://shylenko.com.evil.example/", env)).toBe(false);
    expect(isAllowedRedirect("https://soundofthe.world.evil.example/", env)).toBe(false);
  });

  it("rejects a different origin entirely", () => {
    expect(isAllowedRedirect("https://evil.example/", env)).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isAllowedRedirect("not a url", env)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts each configured origin", () => {
    expect(isAllowedOrigin("https://soundofthe.world", env)).toBe(true);
    expect(isAllowedOrigin("https://shylenko.com", env)).toBe(true);
  });

  it("rejects a foreign origin and a missing one", () => {
    expect(isAllowedOrigin("https://evil.example", env)).toBe(false);
    expect(isAllowedOrigin(null, env)).toBe(false);
  });
});

describe("defaultRedirect", () => {
  it("sends api.<domain> callers to that domain's root", () => {
    const req = new Request("https://api.soundofthe.world/auth/login");
    expect(defaultRedirect(req, env)).toBe("https://soundofthe.world/");
  });

  it("keeps the /backline/ subpath when the canonical origin is shylenko.com", () => {
    const shylenkoOnly = { ALLOWED_ORIGINS: "https://shylenko.com" } as Env;
    const req = new Request("https://backline-relay.example.workers.dev/auth/login");
    expect(defaultRedirect(req, shylenkoOnly)).toBe("https://shylenko.com/backline/");
  });
});

describe("upstreamState", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubHealth(status: number) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
  }

  it("is ok on a 200", async () => {
    stubHealth(200);
    expect(await upstreamState("wss://example.runpod.net/ws")).toBe("ok");
  });

  it("is loading on a 503: the pod is up but its model is not ready", async () => {
    stubHealth(503);
    expect(await upstreamState("wss://example.runpod.net/ws")).toBe("loading");
  });

  it("is down on any other failure, a fetch error, or no upstream", async () => {
    stubHealth(500);
    expect(await upstreamState("wss://example.runpod.net/ws")).toBe("down");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("refused"); }));
    expect(await upstreamState("wss://example.runpod.net/ws")).toBe("down");
    expect(await upstreamState(undefined)).toBe("down");
  });
});
