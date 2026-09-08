import * as z from "zod/v4";

export const merchantReviewStatusSchema = z.enum([
  "pending",
  "published",
  "hidden",
  "rejected",
  "redacted",
]);
export const merchantReviewRequestStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "submitted",
  "expired",
  "cancelled",
  "failed",
]);
const pagination = {
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(4096).optional(),
};
export const merchantReviewListInputSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: z.literal("reviews"),
      status: merchantReviewStatusSchema.optional(),
      rating: z.number().int().min(1).max(5).optional(),
      ...pagination,
    })
    .strict(),
  z
    .object({
      view: z.literal("requests"),
      status: merchantReviewRequestStatusSchema.optional(),
      ...pagination,
    })
    .strict(),
]);
const common = {
  id: z.string().min(1).max(191),
  createdAt: z.string().datetime(),
  product: z
    .object({
      title: z.string().max(1000),
      externalId: z.string().max(191),
    })
    .strict(),
};
const nextCursor = z.string().min(1).max(4096).nullable();
export const merchantReviewListResponseSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: z.literal("reviews"),
      items: z
        .array(
          z
            .object({
              ...common,
              version: z.number().int().positive(),
              status: merchantReviewStatusSchema,
              rating: z.number().int().min(1).max(5),
              title: z.string().max(120),
              body: z.string().max(10000),
              displayName: z.string().max(80),
              merchantReply: z.string().max(5000).nullable(),
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
              photoCount: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(100),
      nextCursor,
    })
    .strict(),
  z
    .object({
      view: z.literal("requests"),
      items: z
        .array(
          z
            .object({
              ...common,
              status: merchantReviewRequestStatusSchema,
              sendAt: z.string().datetime(),
              expiresAt: z.string().datetime(),
              sentAt: z.string().datetime().nullable(),
              submittedAt: z.string().datetime().nullable(),
              deliveryAttempts: z.number().int().nonnegative(),
              hasDeliveryError: z.boolean(),
            })
            .strict(),
        )
        .max(100),
      nextCursor,
    })
    .strict(),
]);
export type MerchantReviewListInput = z.input<
  typeof merchantReviewListInputSchema
>;
export type MerchantReviewListPage = z.infer<
  typeof merchantReviewListResponseSchema
>;
