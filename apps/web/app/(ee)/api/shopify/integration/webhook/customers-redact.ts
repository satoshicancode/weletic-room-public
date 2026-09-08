/**
 * Customer erasure is accepted only through the HMAC-verified durable
 * compliance ingress. Inline redaction cannot preserve the persistence-before-
 * acknowledgement, retry, cursor, and voucher-cleanup invariants.
 */
export async function customersRedact(_input: {
  event: unknown;
  workspaceId: string;
}): Promise<never> {
  throw new Error(
    "Inline Shopify customer redaction is disabled; use durable compliance ingress.",
  );
}
