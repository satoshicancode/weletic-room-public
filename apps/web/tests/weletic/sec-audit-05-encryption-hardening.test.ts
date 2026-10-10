import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decrypt,
  decryptOrPassthrough,
  encrypt,
} from "../../lib/encryption";

describe("SEC-AUDIT-05: Secret Decryption Hardening & Fail-Closed Validation", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  it("successfully round-trips valid plaintext through encrypt and decrypt", () => {
    const secret = "shpat_abc123secretTokenValue";
    const ciphertext = encrypt(secret);
    expect(decrypt(ciphertext)).toBe(secret);
    expect(decryptOrPassthrough(ciphertext)).toBe(secret);
  });

  it("strictly fails closed on tampered ciphertext in decrypt and decryptOrPassthrough", () => {
    const ciphertext = encrypt("valid-token");
    const rawBuffer = Buffer.from(ciphertext, "base64");
    // Tamper with the last byte of the encrypted payload
    rawBuffer[rawBuffer.length - 1] ^= 0xff;
    const tamperedCiphertext = rawBuffer.toString("base64");

    expect(() => decrypt(tamperedCiphertext)).toThrow();
    // decryptOrPassthrough MUST NOT return tamperedCiphertext as plaintext!
    expect(() => decryptOrPassthrough(tamperedCiphertext)).toThrow(
      /Security validation failed: ciphertext authentication error/,
    );
  });

  it("strictly fails closed on truncated ciphertext buffers (< 28 bytes)", () => {
    const shortBuffer = Buffer.from("tooshort"); // 8 bytes
    const shortBase64 = shortBuffer.toString("base64");

    expect(() => decrypt(shortBase64)).toThrow(/byte length 8 is less than minimum 28/);
    expect(() => decryptOrPassthrough(shortBase64)).toThrow();
  });

  it("strictly throws when ENCRYPTION_KEY is unset and never returns ciphertext as plaintext", () => {
    const ciphertext = encrypt("secret-token");
    delete process.env.ENCRYPTION_KEY;

    expect(() => decrypt(ciphertext)).toThrow(/ENCRYPTION_KEY is not set/);
    expect(() => decryptOrPassthrough(ciphertext)).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("allows recognized legacy plaintext tokens during deprecation window with warning", () => {
    const legacyShopifyToken = "shpat_legacy_test_token_shopify_example";
    const legacySlackToken = "xoxb-1234567890-abcdef";
    const legacyHubspotToken = "pat-na1-12345678-abcd";

    expect(decryptOrPassthrough(legacyShopifyToken)).toBe(legacyShopifyToken);
    expect(decryptOrPassthrough(legacySlackToken)).toBe(legacySlackToken);
    expect(decryptOrPassthrough(legacyHubspotToken)).toBe(legacyHubspotToken);
  });

  it("fails closed on random unauthenticated strings that are not recognized legacy tokens", () => {
    const randomString = "arbitrary-attacker-injected-value-12345678";
    expect(() => decryptOrPassthrough(randomString)).toThrow(/Invalid token/);
  });
});
