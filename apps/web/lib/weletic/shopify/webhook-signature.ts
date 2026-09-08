import crypto from "crypto";

export function verifyShopifyWebhookSignature({
  body,
  signature,
  secret,
}: {
  body: string | Uint8Array;
  signature: string;
  secret: string;
}) {
  if (!signature || !secret) return false;
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  const expected = Buffer.from(hmac.digest("base64"));
  const received = Buffer.from(signature);
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}
