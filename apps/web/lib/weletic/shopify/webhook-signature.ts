import crypto from "crypto";

/**
 * Constant-time byte equality check.
 * Prevents timing side-channel attacks across different byte lengths or values.
 */
export function timingSafeBufferEqual(
  a: Uint8Array | Buffer,
  b: Uint8Array | Buffer,
): boolean {
  if (a.length !== b.length) return false;
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.timingSafeEqual === "function"
  ) {
    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      // Fall through to manual constant-time comparison
    }
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function verifyShopifyWebhookSignature({
  body,
  signature,
  secret,
  rotationSecret,
}: {
  body: string | Uint8Array;
  signature: string;
  secret: string;
  rotationSecret?: string;
}): boolean {
  if (!signature || !secret) return false;
  // Optional, server-configured overlap only while Shopify rotates its secret.
  // A malformed configured key fails closed; an empty optional env is absent.
  if (rotationSecret && rotationSecret.length < 32) return false;
  const secrets = rotationSecret ? [secret, rotationSecret] : [secret];
  const received = Buffer.from(signature);
  let verified = false;
  for (const candidate of secrets) {
    const hmac = crypto.createHmac("sha256", candidate);
    if (typeof body === "string") hmac.update(body, "utf8");
    else hmac.update(body);
    const expected = Buffer.from(hmac.digest("base64"));
    const matches =
      expected.length === received.length &&
      timingSafeBufferEqual(expected, received);
    verified = matches || verified;
  }
  return verified;
}

/**
 * Constant-time Shopify HMAC verification (SEC-02).
 * Verifies x-shopify-hmac-sha256 in constant time against raw body bytes.
 */
export function verifyHmacConstantTime({
  rawBodyBytes,
  signature,
  secret,
  rotationSecret,
}: {
  rawBodyBytes: Uint8Array | string;
  signature: string;
  secret: string;
  rotationSecret?: string;
}): boolean {
  return verifyShopifyWebhookSignature({
    body: rawBodyBytes,
    signature,
    secret,
    rotationSecret,
  });
}

/**
 * Positional helper for constant-time HMAC verification on raw body bytes.
 */
export function verifyHmac(
  rawBytes: Uint8Array | string,
  signature: string,
  secret: string,
  rotationSecret?: string,
): boolean {
  return verifyShopifyWebhookSignature({
    body: rawBytes,
    signature,
    secret,
    rotationSecret,
  });
}
