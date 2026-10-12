import { createHmac, timingSafeEqual } from "node:crypto";

export function getPosCustomerBindingSecret(): string {
  const secret =
    process.env.WELETIC_SHOPIFY_SERVICE_SECRET ||
    process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Missing POS customer binding secret in production environment.",
      );
    }
    return "weletic-pos-customer-binding-internal-secret";
  }
  return secret;
}

export function createPosCustomerBindingToken(
  shop: string,
  customerId: string,
  ttlMs = 15 * 60 * 1000,
): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${shop}:${customerId}:${expiresAt}`;
  const signature = createHmac("sha256", getPosCustomerBindingSecret())
    .update(payload)
    .digest("hex");
  return `${customerId}.${expiresAt}.${signature}`;
}

export function verifyPosCustomerBindingToken(
  token: unknown,
  expectedShop: string,
  expectedCustomerId: string,
  now = Date.now(),
): boolean {
  if (typeof token !== "string" || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [customerId, expStr, signature] = parts;
  if (customerId !== expectedCustomerId) return false;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;

  const payload = `${expectedShop}:${customerId}:${expiresAt}`;
  const expectedSignature = createHmac("sha256", getPosCustomerBindingSecret())
    .update(payload)
    .digest("hex");

  if (signature.length !== expectedSignature.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSignature, "hex"),
    );
  } catch {
    return false;
  }
}
