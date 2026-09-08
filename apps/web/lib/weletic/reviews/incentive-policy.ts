import { createWeleticId } from "@/lib/weletic/ids";
import { LoyaltyRedemptionProvisioningSnapshotSchema } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { withReviewMutation } from "./transaction";

const points = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9]\d{0,18})$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
    "Points exceed the ledger range",
  );
const pointAward = z
  .object({
    kind: z.literal("points"),
    basePoints: points,
    photoBonusPoints: points,
    videoBonusPoints: points,
    maxPoints: points,
  })
  .strict();

// Reuse the catalog's provisioning terms, excluding recipient/time-specific
// fields. Those are bound later by the existing fulfillment snapshot service.
const couponTerms = LoyaltyRedemptionProvisioningSnapshotSchema.omit({
  version: true,
  pointsCost: true,
  customerSelectionDigest: true,
  startsAt: true,
  expiresAt: true,
  contentDigest: true,
  currencyVerifiedAt: true,
})
  .extend({
    rewardType: z.enum(["amount_off", "percentage_off", "free_shipping"]),
    salesChannel: z.literal("online_store"),
  })
  .strict();

export const reviewCouponAwardSchema = z
  .object({ kind: z.literal("coupon"), terms: couponTerms })
  .strict();

export const reviewIncentivePolicySnapshotSchema = z
  .object({
    version: z.literal(1),
    award: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      pointAward,
      reviewCouponAwardSchema,
    ]),
  })
  .strict();

const policyDraftSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  pointAward,
  z
    .object({
      kind: z.literal("coupon"),
      rewardDefinitionId: z.string().min(1).max(191),
    })
    .strict(),
]);

export function reviewIncentivePolicyDigest(input: unknown) {
  const snapshot = reviewIncentivePolicySnapshotSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** Internal draft writer only. Allocating a revision never activates it. */
export function createReviewIncentivePolicyRevision(
  storeId: string,
  input: unknown,
) {
  const draft = policyDraftSchema.parse(input);
  return withReviewMutation(storeId, async (tx) => {
    let award: z.infer<typeof reviewIncentivePolicySnapshotSchema>["award"];
    if (draft.kind === "coupon") {
      const reward = await tx.weleticRewardDefinition.findFirst({
        where: {
          id: draft.rewardDefinitionId,
          storeId,
          status: "active",
          exchangeType: "fixed",
          salesChannel: "online_store",
        },
      });
      const store = await tx.weleticShopifyStore.findUniqueOrThrow({
        where: { id: storeId },
      });
      if (!reward || !store.currencyVerifiedAt)
        throw new ReviewError(
          "unavailable",
          "Verified coupon catalog terms are unavailable",
        );
      award = {
        kind: "coupon",
        terms: couponTerms.parse({
          rewardDefinitionId: reward.id,
          name: reward.name,
          description: reward.description,
          rewardType: reward.rewardType,
          salesChannel: reward.salesChannel,
          discountValue: reward.discountValue?.toString() ?? null,
          maxDiscountValue: reward.maxDiscountValue?.toString() ?? null,
          minOrderAmount: reward.minOrderAmount?.toString() ?? null,
          appliesToResource: reward.appliesToResource,
          entitledCollectionIds: reward.entitledCollectionIds ?? [],
          entitledProductIds: reward.entitledProductIds ?? [],
          entitledVariantIds: reward.entitledVariantIds ?? [],
          combinesWithProductDiscounts: reward.combinesWithProductDiscounts,
          combinesWithOrderDiscounts: reward.combinesWithOrderDiscounts,
          combinesWithShippingDiscounts: reward.combinesWithShippingDiscounts,
          usageLimit: reward.usageLimit,
          usageLimitPerCustomer: reward.usageLimitPerCustomer,
          expiresInDays: reward.expiresInDays,
          shopCurrency: store.shopCurrency,
        }),
      };
    } else award = draft;
    const snapshot = reviewIncentivePolicySnapshotSchema.parse({
      version: 1,
      award,
    });
    const settings = await tx.weleticReviewSettings.upsert({
      where: { storeId },
      create: { storeId, incentivePolicyRevision: 1 },
      update: { incentivePolicyRevision: { increment: 1 } },
    });
    return tx.weleticReviewIncentivePolicy.create({
      data: {
        id: createWeleticId("wrevpolicy_"),
        storeId,
        revision: settings.incentivePolicyRevision,
        snapshot,
        contentDigest: reviewIncentivePolicyDigest(snapshot),
      },
    });
  });
}

export function selectReviewIncentiveAward(
  input: unknown,
  media: { hasPhoto: boolean; hasVideo: boolean },
) {
  const { award } = reviewIncentivePolicySnapshotSchema.parse(input);
  if (award.kind !== "points") return award;
  const photo = media.hasPhoto ? BigInt(award.photoBonusPoints) : BigInt(0);
  const video = media.hasVideo ? BigInt(award.videoBonusPoints) : BigInt(0);
  // Preserve the existing max-media-bonus rule; one total, not separate awards.
  const raw = BigInt(award.basePoints) + (photo > video ? photo : video);
  const cap = BigInt(award.maxPoints);
  return {
    kind: "points" as const,
    points: (raw > cap ? cap : raw).toString(),
  };
}
