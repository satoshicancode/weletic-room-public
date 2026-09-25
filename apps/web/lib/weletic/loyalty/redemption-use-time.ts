import { z } from "zod";

export type ShopifyOrderUseTimeBasis =
  | "shopify_order_created_at"
  | "webhook_observed_at";

export const REMOTE_CLEANUP_USE_TIME_BASIS =
  "remote_cleanup_observed_at" as const;
const shopifyOrderInstant = z.string().datetime({ offset: true });

/** An order's creation timestamp is event evidence; a missing or invalid
 * timestamp leaves only the local webhook observation time. */
export function getShopifyOrderUseTime(
  createdAt: unknown,
  observedAt: Date,
): { usedAt: Date; usedAtBasis: ShopifyOrderUseTimeBasis } {
  if (!Number.isFinite(observedAt.getTime()))
    throw new Error("A valid webhook observation time is required.");
  const parsed = shopifyOrderInstant.safeParse(createdAt);
  const eventTime = parsed.success ? Date.parse(parsed.data) : Number.NaN;
  return Number.isFinite(eventTime)
    ? {
        usedAt: new Date(eventTime),
        usedAtBasis: "shopify_order_created_at",
      }
    : { usedAt: observedAt, usedAtBasis: "webhook_observed_at" };
}
