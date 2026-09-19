import { createWeleticId } from "@/lib/weletic/ids";
import {
  DEFAULT_REWARD_PURCHASE_POLICY,
  readLoyaltyPurchasePolicy,
} from "@/lib/weletic/loyalty/purchase-policy";
import { LoyaltyRedemptionProvisioningSnapshotSchema } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewCouponDisclosure } from "./coupon-disclosure";
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
  .object({
    kind: z.literal("coupon"),
    terms: couponTerms,
    // Optional for historical compatibility. New targeted promises need labels
    // verified against the store catalog before activation; never look them up
    // from mutable current catalog data when displaying a saved invitation.
    displayTargets: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(
                /^gid:\/\/shopify\/(Product|ProductVariant|Collection)\/\d+$/,
              ),
            name: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(250)
      .optional(),
  })
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

export const reviewIncentivePolicyDraftSchema = z.discriminatedUnion("kind", [
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

/** Resolve the invitation's promise, never the currently active settings.
 * Only an explicit null denotes the historical policy path.
 */
export async function readReviewIncentivePolicySnapshot(
  tx: Prisma.TransactionClient,
  storeId: string,
  policyId: unknown,
) {
  if (policyId === null) return null;
  if (typeof policyId !== "string" || !/^[A-Za-z0-9_-]{1,191}$/.test(policyId))
    throw new ReviewError(
      "unavailable",
      "Review incentive policy is unavailable",
    );
  const policy = await tx.weleticReviewIncentivePolicy.findUnique({
    where: { storeId_id: { storeId, id: policyId } },
  });
  const parsed = reviewIncentivePolicySnapshotSchema.safeParse(
    policy?.snapshot,
  );
  if (
    !policy ||
    policy.storeId !== storeId ||
    policy.id !== policyId ||
    !parsed.success ||
    policy.contentDigest !== reviewIncentivePolicyDigest(parsed.data)
  )
    throw new ReviewError(
      "unavailable",
      "Review incentive policy is unavailable",
    );
  return parsed.data;
}

/** Internal draft writer only. Allocating a revision never activates it. */
export async function createReviewIncentivePolicyRevision(
  storeId: string,
  input: unknown,
  merchantFence?: {
    expectedRevision: number;
    expectedInstallationGeneration: string;
    authorize: (
      tx: Prisma.TransactionClient,
      phase: "preflight" | "commit",
    ) => Promise<void>;
  },
) {
  const draft = reviewIncentivePolicyDraftSchema.parse(input);
  const authorize = async (
    tx: Prisma.TransactionClient,
    phase: "preflight" | "commit",
  ) => {
    if (!merchantFence) return;
    await merchantFence.authorize(tx, phase);
    const settings = await tx.weleticReviewSettings.findUnique({
      where: { storeId },
    });
    if (
      (settings?.incentivePolicyRevision ?? 0) !==
      merchantFence.expectedRevision
    )
      throw new ReviewError(
        "conflict",
        "Review incentive policy changed; reload and retry",
      );
  };
  const readCandidate = async (tx: Prisma.TransactionClient) => {
    let award: z.infer<typeof reviewIncentivePolicySnapshotSchema>["award"];
    let catalogFence: string | null = null;
    let identity: {
      storeId: string;
      workspaceId: string;
      shop: string;
      installationGeneration: string | null;
    } | null = null;
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
      identity = {
        storeId,
        workspaceId: store.projectId,
        shop: store.shopDomain,
        installationGeneration: store.installationGeneration,
      };
      catalogFence = JSON.stringify({
        identity,
        rewardUpdatedAt: reward.updatedAt,
        currencyVerifiedAt: store.currencyVerifiedAt,
      });
      award = {
        kind: "coupon",
        terms: couponTerms.parse({
          rewardDefinitionId: reward.id,
          name: reward.name,
          description: reward.description,
          rewardType: reward.rewardType,
          salesChannel: reward.salesChannel,
          exchangeType: reward.exchangeType,
          purchasePolicy: readLoyaltyPurchasePolicy(
            reward.purchasePolicy,
            DEFAULT_REWARD_PURCHASE_POLICY,
          ),
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
    return { award, catalogFence, identity };
  };
  const save = async (
    tx: Prisma.TransactionClient,
    award: z.infer<typeof reviewIncentivePolicySnapshotSchema>["award"],
  ) => {
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
  };
  if (draft.kind !== "coupon")
    return withReviewMutation(
      storeId,
      async (tx) => {
        await authorize(tx, "commit");
        return save(tx, draft);
      },
      merchantFence?.expectedInstallationGeneration,
    );

  const prepared = await withReviewMutation(
    storeId,
    async (tx, generation) => {
      await authorize(tx, "preflight");
      const candidate = await readCandidate(tx);
      const settings = await tx.weleticReviewSettings.findUnique({
        where: { storeId },
      });
      return {
        ...candidate,
        generation,
        settingsFence: JSON.stringify(settings),
      };
    },
    merchantFence?.expectedInstallationGeneration,
  );
  if (prepared.award.kind !== "coupon" || !prepared.identity)
    throw new ReviewError(
      "unavailable",
      "Verified coupon catalog terms are unavailable",
    );
  const { captureReviewCouponCatalogLabels } = await import(
    "./coupon-catalog-labels"
  );
  const displayTargets = await captureReviewCouponCatalogLabels(
    prepared.identity,
    [
      ...prepared.award.terms.entitledProductIds,
      ...prepared.award.terms.entitledVariantIds,
      ...prepared.award.terms.entitledCollectionIds,
    ],
  );
  const award = reviewCouponAwardSchema.parse({
    ...prepared.award,
    displayTargets,
  });
  // The saved promise must be truthfully renderable before revision allocation.
  reviewCouponDisclosure(award);
  return withReviewMutation(
    storeId,
    async (tx) => {
      await authorize(tx, "commit");
      const current = await readCandidate(tx);
      const settings = await tx.weleticReviewSettings.findUnique({
        where: { storeId },
      });
      if (
        current.catalogFence !== prepared.catalogFence ||
        JSON.stringify(current.award) !== JSON.stringify(prepared.award) ||
        JSON.stringify(settings) !== prepared.settingsFence
      )
        throw new ReviewError(
          "conflict",
          "Coupon policy changed during catalog verification; reload and retry",
        );
      return save(tx, award);
    },
    prepared.generation,
  );
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
