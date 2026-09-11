import { describe, expect, it } from "vitest";
import { toSendable } from "../src/index";

const decode = (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b));

describe("toSendable", () => {
  // Regression test for the bug that broke every Lyria message. Binary frames
  // reach the Worker as a Blob under a recent compatibility_date, and the old
  // code cast `ev.data` to `string | ArrayBuffer` and passed it to send(),
  // which coerced it with String(). Every frame left the relay as the 13-byte
  // text "[object Blob]", so the browser SDK threw
  //   SyntaxError: Unexpected token 'o', "[object Blob]" is not valid JSON
  // inside its un-caught async message handler — one unhandled promise
  // rejection per incoming message, and no audio ever arrived.
  it("converts a Blob to its bytes rather than stringifying it", async () => {
    const payload = JSON.stringify({ serverContent: { audioChunks: [{ data: "AAAA" }] } });
    const out = await toSendable(new Blob([payload]));

    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(decode(out as ArrayBuffer)).toBe(payload);
    expect(decode(out as ArrayBuffer)).not.toContain("[object Blob]");
    expect(() => JSON.parse(decode(out as ArrayBuffer))).not.toThrow();
  });

  it("passes a text frame through untouched", async () => {
    await expect(toSendable('{"setupComplete":{}}')).resolves.toBe('{"setupComplete":{}}');
  });

  it("passes an ArrayBuffer through untouched", async () => {
    const buf = new TextEncoder().encode("hello").buffer;
    await expect(toSendable(buf)).resolves.toBe(buf);
  });

  it("copies a typed-array view's own bytes, not the whole backing buffer", async () => {
    const backing = new TextEncoder().encode("XXhelloXX");
    const view = backing.subarray(2, 7);
    const out = await toSendable(view);

    expect(decode(out as ArrayBuffer)).toBe("hello");
  });

  it("rejects a frame it cannot forward instead of silently stringifying it", async () => {
    await expect(toSendable({ not: "a frame" })).rejects.toThrow(/unforwardable/);
  });
});
