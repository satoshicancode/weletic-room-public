import crypto from "crypto";

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
}) {
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
      crypto.timingSafeEqual(expected, received);
    verified = matches || verified;
  }
  return verified;
}
