import { describe, expect, it } from "vitest";
import { isAllowedRedirect } from "../src/index";
import type { Env } from "../src/index";

const env = { ALLOWED_ORIGIN: "https://shylenko.com" } as Env;

describe("isAllowedRedirect", () => {
  it("allows a redirect to the allowed origin", () => {
    expect(isAllowedRedirect("https://shylenko.com/backline/", env)).toBe(true);
  });

  it("rejects a lookalike origin that merely starts with the allowed origin", () => {
    expect(isAllowedRedirect("https://shylenko.com.evil.example/", env)).toBe(false);
  });

  it("rejects a different origin entirely", () => {
    expect(isAllowedRedirect("https://evil.example/", env)).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isAllowedRedirect("not a url", env)).toBe(false);
  });
});
