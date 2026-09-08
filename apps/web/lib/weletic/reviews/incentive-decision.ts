import { z } from "zod";
import { reviewCouponAwardSchema } from "./incentive-policy";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/);

/** An authorized adjudication caller supplies this evidence. Neither a rating,
 * publication choice nor an ordinary refund is a confirmed-invalidity reason.
 */
export const reviewIncentiveDecisionSchema = z
  .object({
    decisionId: identifier,
    actorUserId: identifier,
    reason: z.enum(["confirmed_fraud", "invalid_purchase_evidence"]),
  })
  .strict();

export const reviewInvalidationAwardSchema = z.union([
  reviewCouponAwardSchema,
  z
    .object({
      kind: z.literal("points"),
      points: z
        .string()
        .regex(/^[1-9]\d{0,18}$/)
        .refine(
          (value) =>
            /^[1-9]\d{0,18}$/.test(value) &&
            BigInt(value) <= BigInt("9223372036854775807"),
        ),
    })
    .strict(),
]);

export const reviewInvalidationSnapshotSchema = z
  .object({
    revision: z.literal("review_invalidation_v1"),
    policyId: identifier,
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceReviewId: identifier,
    originalStatus: z.enum(["reserved", "fulfilled"]),
    award: reviewInvalidationAwardSchema,
    redemptionId: identifier.nullable(),
  })
  .strict();
