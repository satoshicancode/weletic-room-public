import { prisma } from "@/lib/prisma";
import {
  reviewCouponAwardSchema,
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
} from "@/lib/weletic/reviews/incentive-policy";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { hasShopifyCustomerPrivacyTombstone } from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { ShopperRewardProvisionPayloadSchema } from "./outbox";
import {
  assertExpectedLoyaltyDiscountNode,
  assertLoyaltyDiscountLookupMissIsTerminal,
  clearLoyaltyDiscountRemoteProvisionAttempt,
  getPersistedLoyaltyDiscountProvisioningIdentity,
  markLoyaltyDiscountRemoteProvisionAttempt,
} from "./redemption-discount-identity";
import {
  assertProvisioningReplayMatchesSnapshot,
  createLoyaltyRedemptionProvisioningSnapshot,
  getRewardDefinitionFromProvisioningSnapshot,
  readLoyaltyRedemptionProvisioningSnapshot,
} from "./redemption-provisioning-snapshot";
import { DIRECT_REVIEW_REWARD_SOURCE } from "./reward-ownership";
import {
  lookupDiscountByCode,
  matchesLoyaltyRewardDiscountConfiguration,
  provisionLoyaltyRewardDiscount,
  resolveShopifyOfflineCredentials,
} from "./shopify-discounts";

const metadataSchema = z
  .object({
    directFulfillment: z
      .object({
        version: z.literal(1),
        claimId: z.string(),
        installationGeneration: z.string(),
      })
      .strict(),
    remoteProvisionAttemptedAt: z.string().datetime().optional(),
    remoteProvisionPreparationId: z.string().optional(),
  })
  .passthrough();

/** Durable prepare -> fenced Shopify I/O -> local finalize. No points
 * compensation or replacement code is permitted after an uncertain create.
 */
export async function provisionShopperReviewCoupon({
  storeId,
  payload: input,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  payload: unknown;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const payload = ShopperRewardProvisionPayloadSchema.parse(input);
  const identity = await prisma.weleticRewardRedemption.findFirst({
    where: {
      id: payload.redemptionId,
      storeId,
      accountId: null,
      fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
      fulfillmentReference: payload.claimId,
    },
    include: { shopper: true, store: { select: { projectId: true } } },
  });
  if (!identity?.shopper || identity.shopper.storeId !== storeId)
    throw new Error("Shopper coupon owner is unavailable");

  async function locked<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    // Do not wrap remote I/O in a retrying transaction helper. An automatic
    // callback retry could create value again after an ambiguous commit.
    return prisma.$transaction(
      async (tx) => {
        await assertShopifyStoreAcceptsOperationalWrites({
          tx,
          storeId,
          action: "shopper_coupon_provision",
          requireVerifiedCurrency: true,
          expectedInstallationGeneration: payload.installationGeneration,
          loyaltyMaintenancePermit,
        });
        return operation(tx);
      },
      {
        maxWait: 10_000,
        timeout: 120_000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  async function read(tx: Prisma.TransactionClient) {
    const redemption = await tx.weleticRewardRedemption.findFirst({
      where: { id: payload.redemptionId, storeId },
      include: { shopper: { include: { privacyTombstones: true } } },
    });
    const claim = await tx.weleticReviewIncentiveClaim.findFirst({
      where: { id: payload.claimId, storeId },
      include: { policy: true, order: true },
    });
    const settings = await tx.weleticReviewSettings.findUnique({
      where: { storeId },
    });
    const store = await tx.weleticShopifyStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    if (
      !redemption?.shopper ||
      !claim ||
      !settings?.enabled ||
      claim.subjectType !== "product" ||
      claim.order.storeId !== storeId ||
      claim.order.shopperId !== claim.shopperId ||
      redemption.accountId !== null ||
      redemption.shopperId !== claim.shopperId ||
      redemption.shopper.storeId !== storeId ||
      redemption.shopper.id !== identity?.shopper?.id ||
      redemption.shopper.shopifyCustomerId !==
        identity?.shopper?.shopifyCustomerId ||
      redemption.shopper.privacyTombstones.length ||
      redemption.settlementQuarantinedAt ||
      redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
      redemption.fulfillmentReference !== claim.id ||
      redemption.pointsSpent !== BigInt(0) ||
      redemption.ledgerEntryId !== null ||
      redemption.artifactKind !== "discount_code" ||
      (redemption.status === "provisioning"
        ? claim.status !== "reserved"
        : claim.status !== "fulfilled") ||
      !["provisioning", "issued", "active"].includes(redemption.status)
    )
      throw new Error("Shopper coupon is not eligible for provisioning");
    if (
      await hasShopifyCustomerPrivacyTombstone({
        tx,
        storeId,
        shopifyCustomerId: redemption.shopper.shopifyCustomerId,
        email: redemption.shopper.email,
      })
    )
      throw new Error("Shopper coupon owner is privacy suppressed");
    const review = await tx.weleticProductReview.findFirst({
      where: {
        id: claim.sourceReviewId,
        storeId,
        shopperId: claim.shopperId,
        redactedAt: null,
        status: { not: "redacted" },
        participationStatus: { not: "invalid" },
        request: {
          storeId,
          orderId: claim.orderId,
          incentivePolicyId: claim.policyId,
        },
      },
      select: { id: true },
    });
    if (!review)
      throw new Error("Review participation requires reconciliation");
    const metadata = metadataSchema.parse(redemption.metadata);
    if (
      metadata.directFulfillment.claimId !== claim.id ||
      metadata.directFulfillment.installationGeneration !==
        payload.installationGeneration
    )
      throw new Error(
        "Shopper coupon belongs to another claim or installation",
      );
    const award = reviewCouponAwardSchema.parse(claim.awardSnapshot);
    const promised = reviewIncentivePolicySnapshotSchema.parse(
      claim.policy.snapshot,
    );
    if (
      claim.policy.storeId !== storeId ||
      claim.policy.contentDigest !== reviewIncentivePolicyDigest(promised) ||
      JSON.stringify(promised.award) !== JSON.stringify(award)
    )
      throw new Error("Shopper coupon policy requires reconciliation");
    const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
      redemption.metadata,
    );
    if (
      !snapshot ||
      !store.currencyVerifiedAt ||
      snapshot.shopCurrency !== store.shopCurrency ||
      snapshot.currencyVerifiedAt !== store.currencyVerifiedAt.toISOString() ||
      snapshot.rewardDefinitionId !== redemption.rewardDefinitionId ||
      snapshot.pointsCost !== "0" ||
      snapshot.expiresAt !== (redemption.expiresAt?.toISOString() ?? null)
    )
      throw new Error("Shopper coupon provisioning snapshot changed");
    const expectedSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward: { ...award.terms, id: award.terms.rewardDefinitionId },
      pointsCost: BigInt(0),
      discountValue: award.terms.discountValue,
      expiresInDays: award.terms.expiresInDays,
      shopCurrency: award.terms.shopCurrency,
      currencyVerifiedAt: store.currencyVerifiedAt,
      customerSelectionDigest: snapshot.customerSelectionDigest,
      startsAt: new Date(snapshot.startsAt),
      expiresAt: redemption.expiresAt,
    });
    if (snapshot.contentDigest !== expectedSnapshot.contentDigest)
      throw new Error("Shopper coupon differs from its immutable promise");
    if (
      !["amount_off", "percentage_off", "free_shipping"].includes(
        snapshot.rewardType,
      )
    )
      throw new Error(
        "This coupon type lacks exact remote configuration verification",
      );
    assertProvisioningReplayMatchesSnapshot({
      snapshot,
      pointsCostOverride: BigInt(0),
      storeId,
      shopifyCustomerId: redemption.shopper.shopifyCustomerId,
    });
    const ownershipIdentity = {
      storeId,
      redemptionId: redemption.id,
      ownerKind: "shopper" as const,
      shopperId: claim.shopperId,
      fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
      fulfillmentReference: claim.id,
      rewardDefinitionId: redemption.rewardDefinitionId,
      discountCode: redemption.shopifyDiscountCode,
    };
    const ownership = getPersistedLoyaltyDiscountProvisioningIdentity({
      identity: ownershipIdentity,
      metadata: redemption.metadata,
    });
    if (!ownership || ownership.version !== 2)
      throw new Error("Shopper coupon ownership is unverifiable");
    return {
      shopper: redemption.shopper,
      redemption,
      claim,
      metadata,
      snapshot,
      ownershipIdentity,
      ownership,
    };
  }

  return withShopifyCustomerSettlementLocks({
    storeId,
    workspaceId: identity.store.projectId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn: async () => {
      const initial = await locked(read);
      if (initial.redemption.status !== "provisioning")
        return { status: "already_issued" as const };
      // Credential resolution can fail before dispatch. Do not leave an
      // ambiguous-create marker for a request that was never prepared.
      const credentials = await resolveShopifyOfflineCredentials({ storeId });
      const prepared = await locked(async (tx) => {
        const current = await read(tx);
        if (current.redemption.status !== "provisioning")
          return { ...current, preparationId: null, priorAttempt: true };
        const priorAttempt =
          current.metadata.remoteProvisionAttemptedAt !== undefined;
        const preparationId = priorAttempt ? null : randomUUID();
        if (!priorAttempt)
          await tx.weleticRewardRedemption.update({
            where: { id: current.redemption.id },
            data: {
              metadata: markLoyaltyDiscountRemoteProvisionAttempt({
                metadata: current.redemption.metadata,
                preparationId: preparationId!,
              }),
            },
          });
        return { ...current, preparationId, priorAttempt };
      });
      if (prepared.redemption.status !== "provisioning")
        return { status: "already_issued" as const };
      // Credentials are already resolved: no second DB connection is borrowed
      // while holding the store row during Shopify I/O.
      let remoteCreateStarted = false;
      try {
        return await locked(async (tx) => {
          const current = await read(tx);
          if (current.redemption.status !== "provisioning")
            return { status: "already_issued" as const };
          if (
            current.redemption.expiresAt &&
            current.redemption.expiresAt <= new Date()
          )
            throw new Error(
              "Shopper coupon expired before provisioning completed",
            );
          if (
            !prepared.priorAttempt &&
            current.metadata.remoteProvisionPreparationId !==
              prepared.preparationId
          )
            throw new Error("Shopper coupon preparation was superseded");
          if (
            prepared.priorAttempt &&
            (!current.metadata.remoteProvisionAttemptedAt ||
              current.metadata.remoteProvisionAttemptedAt !==
                prepared.metadata.remoteProvisionAttemptedAt ||
              current.metadata.remoteProvisionPreparationId !==
                prepared.metadata.remoteProvisionPreparationId)
          )
            throw new Error(
              "Shopper coupon preparation changed; retry from durable state",
            );
          const rewardDefinition = getRewardDefinitionFromProvisioningSnapshot({
            snapshot: current.snapshot,
            provisioningName: current.ownership.provisioningName,
          });
          let remote = await lookupDiscountByCode(
            credentials.shopDomain,
            credentials.accessToken,
            current.redemption.shopifyDiscountCode,
          );
          if (!remote) {
            if (prepared.priorAttempt) {
              assertLoyaltyDiscountLookupMissIsTerminal({
                redemptionId: current.redemption.id,
                discountCode: current.redemption.shopifyDiscountCode,
                metadata: current.redemption.metadata,
              });
              // Even malformed or cleared attempt evidence must never turn a
              // recovery invocation into a create invocation.
              throw new Error(
                "Prior shopper coupon attempt requires reconciliation",
              );
            }
            remoteCreateStarted = true;
            const created = await provisionLoyaltyRewardDiscount({
              storeId,
              resolvedCredentials: credentials,
              rewardDefinition,
              discountCode: current.redemption.shopifyDiscountCode,
              startsAt: new Date(current.snapshot.startsAt),
              expiresAt: current.redemption.expiresAt,
              expectedShopCurrency: current.snapshot.shopCurrency,
              currentShopCurrency: current.snapshot.shopCurrency,
              shopifyCustomerId: current.shopper.shopifyCustomerId,
            });
            remote = await lookupDiscountByCode(
              credentials.shopDomain,
              credentials.accessToken,
              current.redemption.shopifyDiscountCode,
            );
            if (!remote || remote.id !== created.id)
              throw new Error(
                "Created shopper coupon requires remote reconciliation",
              );
          }
          assertExpectedLoyaltyDiscountNode({
            identity: current.ownershipIdentity,
            metadata: current.redemption.metadata,
            remote,
            requireActive: true,
          });
          if (
            !matchesLoyaltyRewardDiscountConfiguration({
              remote,
              rewardDefinition,
              startsAt: new Date(current.snapshot.startsAt),
              expiresAt: current.redemption.expiresAt,
              expectedShopCurrency: current.snapshot.shopCurrency,
              shopifyCustomerId: current.shopper.shopifyCustomerId,
            })
          )
            throw new Error(
              "Shopper coupon remote configuration does not match its promise",
            );
          if (
            current.redemption.shopifyDiscountId &&
            current.redemption.shopifyDiscountId !== remote.id
          )
            throw new Error("Shopper coupon remote identity changed");
          await tx.weleticRewardRedemption.update({
            where: { id: current.redemption.id },
            data: { status: "issued", shopifyDiscountId: remote.id },
          });
          await tx.weleticReviewIncentiveClaim.update({
            where: { id: current.claim.id },
            data: { status: "fulfilled" },
          });
          const reviewed = await tx.weleticProductReview.updateMany({
            where: {
              id: current.claim.sourceReviewId,
              storeId,
              shopperId: current.claim.shopperId,
              redactedAt: null,
              status: { not: "redacted" },
            },
            data: {
              incentivized: true,
              rewardStatus: "awarded",
              rewardReason: "review_coupon_fulfilled",
            },
          });
          if (reviewed.count !== 1)
            throw new Error(
              "Review participation record requires reconciliation",
            );
          return { status: "issued" as const };
        });
      } catch (error) {
        if (
          !remoteCreateStarted &&
          !prepared.priorAttempt &&
          prepared.preparationId
        ) {
          // A lookup/fence failure before create dispatch is known not to have
          // issued value. Clear only this worker's preparation, never a newer
          // worker's marker or an attempt that may have reached Shopify.
          await locked(async (tx) => {
            const row = await tx.weleticRewardRedemption.findFirst({
              where: {
                id: payload.redemptionId,
                storeId,
                status: "provisioning",
              },
            });
            if (!row) return;
            const cleared = clearLoyaltyDiscountRemoteProvisionAttempt({
              metadata: row.metadata,
              preparationId: prepared.preparationId!,
            });
            if (cleared)
              await tx.weleticRewardRedemption.update({
                where: { id: row.id },
                data: { metadata: cleared },
              });
          });
        }
        throw error;
      }
    },
  });
}
