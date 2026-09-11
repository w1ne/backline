import { describe, expect, it } from "vitest";
import { signSession, signState, verifySession, verifyState } from "../src/session";

const SECRET = "test-secret-value";

describe("session cookie", () => {
  it("signs and verifies a valid session", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(SECRET, { login: "w1ne", exp });
    const result = await verifySession(SECRET, token);
    expect(result).toEqual({ login: "w1ne", exp });
  });

  it("rejects a tampered payload", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(SECRET, { login: "w1ne", exp });
    const [encoded, sig] = token.split(".");
    const forged = await signSession(SECRET, { login: "eviluser", exp });
    const [forgedEncoded] = forged.split(".");
    // Swap in a different payload but keep the original (now-mismatched) signature.
    const tampered = `${forgedEncoded}.${sig}`;
    expect(encoded).not.toEqual(forgedEncoded);
    const result = await verifySession(SECRET, tampered);
    expect(result).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(SECRET, { login: "w1ne", exp });
    const result = await verifySession("wrong-secret", token);
    expect(result).toBeNull();
  });

  it("rejects an expired session", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const token = await signSession(SECRET, { login: "w1ne", exp });
    const result = await verifySession(SECRET, token);
    expect(result).toBeNull();
  });

  it("rejects a malformed token", async () => {
    const result = await verifySession(SECRET, "not-a-valid-token");
    expect(result).toBeNull();
  });
});

describe("oauth state", () => {
  it("signs and verifies state", async () => {
    const state = await signState(SECRET, "https://shylenko.com/backline/", "nonce123");
    const result = await verifyState(SECRET, state);
    expect(result).toEqual({ redirect: "https://shylenko.com/backline/", nonce: "nonce123" });
  });

  it("rejects tampered state", async () => {
    const state = await signState(SECRET, "https://shylenko.com/backline/", "nonce123");
    const [, sig] = state.split(".");
    const forged = await signState(SECRET, "https://evil.com/", "nonce123");
    const [forgedEncoded] = forged.split(".");
    const tampered = `${forgedEncoded}.${sig}`;
    const result = await verifyState(SECRET, tampered);
    expect(result).toBeNull();
  });

  it("rejects state signed with a different secret", async () => {
    const state = await signState(SECRET, "https://shylenko.com/backline/", "nonce123");
    const result = await verifyState("wrong-secret", state);
    expect(result).toBeNull();
  });
});
