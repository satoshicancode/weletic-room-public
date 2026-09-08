import { z } from "zod";

// Explicit browser-safe projections. Reject unknown fields rather than passing
// newly added private data through an unvalidated JSON cast.
const id = z.string().min(1).max(191);
const text = z.string().max(65535);
const time = z.string().datetime();
const integer = z
  .string()
  .max(80)
  .regex(/^(0|-?[1-9]\d*)$/);
const accountStatus = z.enum(["active", "suspended", "closed"]);
const pagination = z
  .object({
    limit: z.number().int().min(1).max(50),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict()
  .refine((value) => value.hasMore === (value.nextCursor !== null));
const base = { id, createdAt: time };

export const merchantShopperDirectoryResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            ...base,
            shopifyCustomerId: id,
            firstName: text.nullable(),
            lastName: text.nullable(),
            email: text.nullable(),
            loyalty: z
              .object({ accountId: id, status: accountStatus })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(50),
    pagination,
  })
  .strict();

const overview = z
  .object({
    section: z.literal("overview"),
    shopper: z
      .object({
        ...base,
        shopifyCustomerId: id,
        firstName: text.nullable(),
        lastName: text.nullable(),
        email: text.nullable(),
        phone: text.nullable(),
        locale: text.nullable(),
        acceptsMarketing: z.boolean(),
        updatedAt: time,
      })
      .strict(),
    locale: z.object({ shopper: text.nullable(), merchant: text }).strict(),
    communicationPreferences: z
      .object({
        shopifyAcceptsMarketing: z.boolean(),
        consentEvidence: z.literal("unavailable"),
        consentSource: z.null(),
        consentRecordedAt: z.null(),
        suppressionStatus: z.literal("unavailable"),
      })
      .strict(),
    modules: z
      .object({
        loyalty: z
          .object({
            status: z.enum(["draft", "test", "active", "disabled"]),
            killSwitchActive: z.boolean(),
          })
          .strict()
          .nullable(),
        reviews: z
          .object({ enabled: z.boolean(), requestEmailEnabled: z.boolean() })
          .strict(),
      })
      .strict(),
    loyalty: z
      .object({
        id,
        status: accountStatus,
        tier: z.object({ id, name: text }).strict().nullable(),
        pointsBalance: integer,
        pendingPoints: integer,
        lifetimeEarned: integer,
        lifetimeRedeemed: integer,
        enrolledAt: time,
      })
      .strict()
      .nullable(),
    coverage: z
      .object({
        communications: z.literal("partial"),
        communicationSources: z
          .array(
            z
              .string()
              .refine((value) =>
                ["review_requests", "referral_friend_emailed_at"].includes(
                  value,
                ),
              ),
          )
          .max(2),
        reason: text,
        reviews: z.literal("native_product_reviews_only"),
        rewards: z.literal("account_and_direct_shopper_rewards"),
        purchases: z.literal("locally_projected_orders_only"),
      })
      .strict(),
  })
  .strict();

function page<S extends string, T extends z.ZodType>(section: S, row: T) {
  return z
    .object({
      section: z.literal(section),
      items: z.array(row).max(50),
      pagination,
    })
    .strict();
}
export const merchantShopperProfileResponseSchema = z.discriminatedUnion(
  "section",
  [
    overview,
    page(
      "purchases",
      z
        .object({
          ...base,
          occurredAt: time,
          orderName: text.nullable(),
          status: z.enum([
            "pending",
            "paid",
            "partially_refunded",
            "refunded",
            "voided",
          ]),
          accountingCurrency: z.string().regex(/^[A-Z]{3}$/),
          accountingNet: integer,
          accountingTotal: integer,
        })
        .strict(),
    ),
    page(
      "points",
      z
        .object({
          ...base,
          sequenceNumber: z.number().int().nonnegative(),
          entryType: z.enum([
            "EARN_ORDER",
            "EARN_REFERRAL",
            "EARN_BONUS",
            "REDEEM_REWARD",
            "REFUND_REVERSAL",
            "MANUAL_ADJUSTMENT",
            "EXPIRATION",
            "BACKFILL",
            "BACKFILL_CORRECTION",
            "TIER_BONUS",
          ]),
          pointsDelta: integer,
          pendingDelta: integer,
          balanceAfter: integer,
        })
        .strict(),
    ),
    page(
      "referrals",
      z
        .object({
          ...base,
          role: z.enum(["advocate", "friend"]),
          status: z.enum([
            "pending",
            "qualified",
            "rewarded",
            "cancelled",
            "fraud_blocked",
          ]),
          qualifyingOrderId: id.nullable(),
          pointsAwarded: integer,
          rewardedAt: time.nullable(),
          friendRewardEmailedAt: time.nullable(),
        })
        .strict(),
    ),
    page(
      "reviews",
      z
        .object({
          ...base,
          subject: z.literal("product"),
          productId: id,
          status: z
            .enum(["pending", "published", "hidden", "rejected", "redacted"])
            .refine((status) => status !== "redacted"),
          rating: z.number().int().min(1).max(5),
          title: text,
          verifiedPurchase: z.boolean(),
          incentivized: z.boolean(),
          rewardStatus: z.enum([
            "pending",
            "awarded",
            "ineligible",
            "reversed",
            "invalidated",
            "recovery_pending",
            "unrecoverable",
          ]),
        })
        .strict(),
    ),
    page(
      "rewards",
      z
        .object({
          ...base,
          rewardDefinitionId: id,
          status: z.enum([
            "active",
            "provisioning",
            "issued",
            "used",
            "failed",
            "cancelled",
            "expired",
          ]),
          artifactKind: z.enum(["discount_code", "gift_card", "store_credit"]),
          pointsSpent: integer,
          fulfillmentSource: text.nullable(),
          usedAt: time.nullable(),
          expiresAt: time.nullable(),
        })
        .strict(),
    ),
    page(
      "review_requests",
      z
        .object({
          ...base,
          productId: id,
          orderId: id,
          status: z.enum([
            "queued",
            "sending",
            "sent",
            "submitted",
            "expired",
            "cancelled",
            "failed",
          ]),
          sendAt: time,
          sentAt: time.nullable(),
          submittedAt: time.nullable(),
          expiresAt: time,
          cancelledAt: time.nullable(),
          deliveryAttempts: z.number().int().nonnegative(),
          deliveryEvidence: z.literal("application_send_record_only"),
        })
        .strict(),
    ),
  ],
);

export type MerchantShopperDirectory = z.infer<
  typeof merchantShopperDirectoryResponseSchema
>;
export type MerchantShopperProfile = z.infer<
  typeof merchantShopperProfileResponseSchema
>;
