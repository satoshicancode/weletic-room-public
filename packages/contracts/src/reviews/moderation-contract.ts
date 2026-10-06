import * as z from "zod/v4";
import { shopifyOnlineSessionBindingSchema } from "../shopify/session-online-binding";
import { shopifyStaffUserIdSchema } from "../shopify/staff-contract";

// Content decisions are not purchase/fraud validation or reward instructions.
// In particular, a low rating is not a moderation reason.
export const reviewModerationReasonSchema = z.enum([
  "approved",
  "spam",
  "personal_information",
  "abusive_content",
  "duplicate",
  "off_topic",
  "merchant_reply",
  "other",
]);

const identifier = z.string().trim().min(1).max(191);
export const auditedReviewModerationInputSchema = z
  .object({
    reviewId: identifier,
    // Prisma/MySQL Int, reserving room for the mutation's increment.
    version: z.number().int().min(1).max(2_147_483_646),
    status: z.enum(["published", "hidden", "rejected"]).optional(),
    merchantReply: z.string().trim().max(5000).nullable().optional(),
    reason: reviewModerationReasonSchema,
    reasonDetails: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.status === undefined && input.merchantReply === undefined)
      context.addIssue({
        code: "custom",
        message: "A moderation change is required",
      });
    if (input.reason === "other" && !input.reasonDetails)
      context.addIssue({
        code: "custom",
        path: ["reasonDetails"],
        message: "Explain the moderation reason",
      });
  });

// Internal provenance only. Never accept this object inside browser input.
// Shopify actor values come from authorizeShopifyMerchantInTransaction; the
// workspace variant comes from the existing authenticated workspace gateway.
export const reviewModerationActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), userId: identifier }).strict(),
  z
    .object({
      kind: z.literal("shopify"),
      userId: shopifyStaffUserIdSchema,
      appId: identifier,
      installationGeneration:
        shopifyOnlineSessionBindingSchema.shape.installationGeneration,
      merchantActionId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);

export const auditedReviewModerationResponseSchema = z
  .object({
    reviewId: identifier,
    auditId: identifier,
    version: z.number().int().min(2).max(2_147_483_647),
    status: z.enum(["pending", "published", "hidden", "rejected"]),
  })
  .strict();

export type AuditedReviewModerationInput = z.infer<
  typeof auditedReviewModerationInputSchema
>;
export type ReviewModerationActor = z.infer<typeof reviewModerationActorSchema>;
