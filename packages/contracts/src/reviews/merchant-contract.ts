import * as z from "zod/v4";
import { reviewDeliveryHistorySchema } from "./delivery-history";

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
const products = z
  .array(
    z
      .object({
        title: z.string().max(1000),
        externalId: z.string().max(191),
      })
      .strict(),
  )
  .max(100);
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
              source: z
                .enum(["verified_customer", "merchant"])
                .default("verified_customer"),
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
              videoCount: z.number().int().nonnegative().default(0),
              media: z
                .array(
                  z
                    .object({
                      id: z.string().min(1).max(191),
                      kind: z.enum(["photo", "video"]),
                    })
                    .strict(),
                )
                .max(6)
                .default([]),
            })
            .strict(),
        )
        .max(100),
      nextCursor,
      products,
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
              // Null denotes an older reader with no history projection.
              deliveryHistory: reviewDeliveryHistorySchema
                .nullable()
                .default(null),
            })
            .strict(),
        )
        .max(100),
      nextCursor,
      products,
    })
    .strict(),
]);
export type MerchantReviewListInput = z.input<
  typeof merchantReviewListInputSchema
>;
export type MerchantReviewListPage = z.infer<
  typeof merchantReviewListResponseSchema
>;

export const merchantReviewCreateInputSchema = z
  .object({
    productId: z.string().regex(/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(20).max(10_000),
    displayName: z.string().trim().min(1).max(80),
    status: z.enum(["pending", "published"]).default("published"),
  })
  .strict();
export const merchantReviewCreateResponseSchema = z
  .object({
    id: z.string().min(1).max(191),
    status: z.enum(["pending", "published"]),
  })
  .strict();
export type MerchantReviewCreateInput = z.input<
  typeof merchantReviewCreateInputSchema
>;

export const merchantReviewMediaInputSchema = z
  .object({ mediaId: z.string().regex(/^wrevmedia_[A-Za-z0-9_-]+$/) })
  .strict();
export const merchantReviewMediaResponseSchema = z
  .object({
    url: z.string().url(),
    kind: z.enum(["photo", "video"]),
    contentType: z.string().max(32),
  })
  .strict();
