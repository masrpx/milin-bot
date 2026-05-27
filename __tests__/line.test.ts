import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyLineSignature } from "@/lib/line";

const SECRET = "test-channel-secret";
const BODY = '{"events":[{"type":"message"}]}';

function makeSignature(body: string, secret: string): string {
  return crypto.createHmac("SHA256", secret).update(body).digest("base64");
}

describe("verifyLineSignature", () => {
  it("returns true for a valid HMAC-SHA256 signature", () => {
    const sig = makeSignature(BODY, SECRET);
    process.env.LINE_CHANNEL_SECRET = SECRET;
    expect(verifyLineSignature(BODY, sig)).toBe(true);
  });

  it("returns false when the body has been mutated", () => {
    const sig = makeSignature(BODY, SECRET);
    process.env.LINE_CHANNEL_SECRET = SECRET;
    expect(verifyLineSignature(BODY + " ", sig)).toBe(false);
  });

  it("returns false when the secret is wrong", () => {
    const sig = makeSignature(BODY, "wrong-secret");
    process.env.LINE_CHANNEL_SECRET = SECRET;
    expect(verifyLineSignature(BODY, sig)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    process.env.LINE_CHANNEL_SECRET = SECRET;
    expect(verifyLineSignature(BODY, "")).toBe(false);
  });
});
