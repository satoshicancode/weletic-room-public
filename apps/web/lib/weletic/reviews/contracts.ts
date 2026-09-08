import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const REVIEW_MAX_PHOTOS = 5;
export const REVIEW_MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const reviewSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sendAfterDays: z.number().int().min(0).max(60),
    expiresAfterDays: z.number().int().min(1).max(90),
    autoPublish: z.boolean(),
    photoUploadsEnabled: z.boolean(),
    requestEmailEnabled: z.boolean(),
  })
  .strict();
export const reviewSubmissionSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(20).max(10_000),
    displayName: z.string().trim().min(1).max(80),
    mediaIds: z
      .array(
        z
          .string()
          .max(191)
          .regex(/^wrevmedia_[A-Za-z0-9_-]+$/),
      )
      .max(REVIEW_MAX_PHOTOS)
      .default([]),
    publishConsent: z.literal(true),
  })
  .strict()
  .refine(
    (v) => new Set(v.mediaIds).size === v.mediaIds.length,
    "Duplicate photos",
  );

export const reviewModerationSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(["published", "hidden", "rejected"]).optional(),
    merchantReply: z.string().trim().max(5000).nullable().optional(),
    retryReward: z.boolean().optional(),
  })
  .strict();

export class ReviewError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "bad_request"
      | "disabled"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

// Ported from OpenClub's review request lifecycle: 256-bit opaque tokens and
// SHA-256 lookup only. Tokens are never included in logging or public responses.
export const generateReviewToken = () => randomBytes(32).toString("base64url");
export const hashReviewToken = (token: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ReviewError("not_found", "Review request unavailable");
  return createHash("sha256").update(token).digest("hex");
};

export function hasUnrefundedReviewQuantity(
  lines: Array<{
    purchasedQuantity: number;
    orderLine: {
      quantity: number;
      shopNet: bigint;
      refundLines: Array<{ quantity: number; shopAmount: bigint }>;
    };
  }>,
) {
  return lines.some(({ purchasedQuantity, orderLine }) => {
    const refunded = orderLine.refundLines.reduce(
      (sum, row) => sum + row.quantity,
      0,
    );
    const amount = orderLine.refundLines.reduce(
      (sum, row) => sum + row.shopAmount,
      BigInt(0),
    );
    return (
      Math.min(purchasedQuantity, orderLine.quantity) > refunded &&
      (orderLine.shopNet <= BigInt(0) || amount < orderLine.shopNet)
    );
  });
}
