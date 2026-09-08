/**
 * The integration webhook route used to build and send a full customer export
 * from this handler. That is intentionally prohibited: compliance webhooks
 * must be HMAC-verified, durably persisted, and acknowledged before any export
 * work begins. Export delivery is owned by the bounded compliance worker and
 * contains only a private, expiring reference.
 */
export async function customersDataRequest(_input: {
  event: unknown;
  workspaceId: string;
}): Promise<never> {
  throw new Error(
    "Inline Shopify customer data export is disabled; use durable compliance ingress.",
  );
}
