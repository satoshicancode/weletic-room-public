import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@/lib/email/unsubscribe-token";
import * as crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Unsubscribe Token Cryptography & Verification (SEC-AUDIT-08)", () => {
  const secret = "synthetic-unsubscribe-secret-key-99";
  const email = "user@example.com";

  beforeEach(() => {
    vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", secret);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("generates a token with base64url email and 24-char signature", () => {
    const token = generateUnsubscribeToken(email);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);

    const [encodedEmail, signature] = parts;
    expect(signature).toHaveLength(24);
    expect(Buffer.from(encodedEmail, "base64url").toString("utf-8")).toBe(email);
  });

  it("successfully verifies authentic token and returns lowercase email", () => {
    const token = generateUnsubscribeToken("User.MixedCase@Example.COM");
    const verified = verifyUnsubscribeToken(token);
    expect(verified).toBe("user.mixedcase@example.com");
  });

  it("returns null when signature is corrupted (matching length of 24 chars)", () => {
    const token = generateUnsubscribeToken(email);
    const [encodedEmail, signature] = token.split(".");
    const corruptedSig = signature.slice(0, 23) + (signature[23] === "a" ? "b" : "a");
    const tamperedToken = `${encodedEmail}.${corruptedSig}`;

    expect(verifyUnsubscribeToken(tamperedToken)).toBeNull();
  });

  it("returns null without throwing RangeError when signature length is shorter (< 24 chars)", () => {
    const token = generateUnsubscribeToken(email);
    const [encodedEmail] = token.split(".");
    const shortToken = `${encodedEmail}.short`;

    expect(() => verifyUnsubscribeToken(shortToken)).not.toThrow();
    expect(verifyUnsubscribeToken(shortToken)).toBeNull();
  });

  it("returns null without throwing RangeError when signature length is longer (> 24 chars)", () => {
    const token = generateUnsubscribeToken(email);
    const [encodedEmail] = token.split(".");
    const longToken = `${encodedEmail}.${"a".repeat(64)}`;

    expect(() => verifyUnsubscribeToken(longToken)).not.toThrow();
    expect(verifyUnsubscribeToken(longToken)).toBeNull();
  });

  it("returns null for malformed tokens lacking separator or parts", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("nosignatureseparator")).toBeNull();
    expect(verifyUnsubscribeToken(".signatureonly")).toBeNull();
    expect(verifyUnsubscribeToken("emailonly.")).toBeNull();
  });

  it("rejects tokens with single-byte flips across various positions in signature", () => {
    const token = generateUnsubscribeToken(email);
    const [encodedEmail, signature] = token.split(".");

    for (const pos of [0, 5, 11, 17, 23]) {
      const corruptedSig =
        signature.slice(0, pos) +
        (signature[pos] === "a" ? "b" : "a") +
        signature.slice(pos + 1);
      const tamperedToken = `${encodedEmail}.${corruptedSig}`;

      expect(verifyUnsubscribeToken(tamperedToken)).toBeNull();
    }
  });
});
