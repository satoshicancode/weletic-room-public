/** Shopify shop erasure is executed only by the durable compliance worker. */
export async function shopRedact(_input: {
  event: unknown;
  workspaceId: string;
}): Promise<never> {
  throw new Error(
    "Inline Shopify shop redaction is disabled; use durable compliance ingress.",
  );
}
