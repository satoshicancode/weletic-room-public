import * as z from "zod/v4";
import { shopifyOnlineSessionBindingSchema } from "../shopify/session-online-binding";

const points = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9]\d{0,18})$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );
// Browser-safe input only; saved terms and catalog labels are server-derived.
export const merchantReviewIncentiveDraftInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    expectedInstallationGeneration:
      shopifyOnlineSessionBindingSchema.shape.installationGeneration,
    draft: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({
          kind: z.literal("points"),
          basePoints: points,
          photoBonusPoints: points,
          videoBonusPoints: points,
          maxPoints: points,
        })
        .strict(),
      z
        .object({
          kind: z.literal("coupon"),
          rewardDefinitionId: z.string().min(1).max(191),
        })
        .strict(),
    ]),
  })
  .strict();

export const merchantReviewIncentiveDraftResponseSchema = z
  .object({
    policyId: z.string().min(1).max(191),
    revision: z.number().int().positive().max(2_147_483_647),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    activated: z.literal(false),
  })
  .strict();

export const merchantReviewIncentiveReadInputSchema = z.object({}).strict();
export const merchantReviewIncentiveActivationInputSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(2_147_483_647),
    expectedInstallationGeneration:
      shopifyOnlineSessionBindingSchema.shape.installationGeneration,
    expectedActivePolicyId: z.string().min(1).max(191).nullable(),
    policyId: z.string().min(1).max(191),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const merchantReviewIncentiveActivationResponseSchema = z
  .object({
    activationId: z.string().min(1).max(191),
    policyId: z.string().min(1).max(191),
    revision: z.number().int().positive().max(2_147_483_647),
    effectiveAt: z.iso.datetime(),
  })
  .strict();
export type MerchantReviewIncentiveActivationInput = z.infer<
  typeof merchantReviewIncentiveActivationInputSchema
>;

export const merchantReviewCouponListInputSchema = z
  .object({
    query: z.string().trim().max(100).default(""),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(1024)
      .optional(),
  })
  .strict();
export const merchantReviewCouponListResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(191),
            name: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(1024)
      .nullable(),
  })
  .strict();
export type MerchantReviewCouponListInput = z.input<
  typeof merchantReviewCouponListInputSchema
>;
export type MerchantReviewIncentiveDraftInput = z.input<
  typeof merchantReviewIncentiveDraftInputSchema
>;
const disclosureParagraphs = z
  .array(z.string().min(1).max(2000))
  .min(1)
  .max(50);
const policyView = z
  .object({
    policyId: z.string().min(1).max(191),
    revision: z.number().int().positive().max(2_147_483_647),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    draft: merchantReviewIncentiveDraftInputSchema.shape.draft,
    disclosure: z
      .object({
        en: disclosureParagraphs,
        ja: disclosureParagraphs,
        vi: disclosureParagraphs,
      })
      .strict()
      .nullable(),
    disclosureState: z.enum(["available", "unavailable"]),
  })
  .strict()
  .refine(
    (value) =>
      (value.disclosure !== null) === (value.disclosureState === "available"),
  );

export const merchantReviewIncentiveReadResponseSchema = z
  .object({
    revision: z.number().int().min(0).max(2_147_483_647),
    installationGeneration:
      shopifyOnlineSessionBindingSchema.shape.installationGeneration,
    activePolicy: policyView.nullable(),
    latestPolicy: policyView.nullable(),
    // Null active policy means historical behavior, not a new explicit none promise.
    mode: z.enum(["legacy", "versioned"]),
  })
  .strict()
  .refine(
    (value) =>
      (value.activePolicy !== null) === (value.mode === "versioned") &&
      (value.revision === 0
        ? value.latestPolicy === null
        : value.latestPolicy?.revision === value.revision) &&
      (!value.activePolicy || value.activePolicy.revision <= value.revision),
  );
