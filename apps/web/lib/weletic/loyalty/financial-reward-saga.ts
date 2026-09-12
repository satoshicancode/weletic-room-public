import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import {
  assertLockedLoyaltyProgramCurrencyGeneration,
  withLoyaltyProgramRowLock,
} from "@/lib/weletic/loyalty/program-write-fence";
import {
  canonicalizeLoyaltyDiscountCode,
  clearLoyaltyDiscountRemoteProvisionAttempt,
  markLoyaltyDiscountRemoteProvisionAttempt,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import type { LoyaltyRedemptionProvisioningSnapshot } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  resolveShopifyOfflineCredentials,
  type ResolvedShopifyCredentials,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  assertFinancialRewardScope,
  createShopifyGiftCard,
  createShopifyStoreCredit,
  lookupShopifyGiftCard,
  ShopifyFinancialRewardError,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { nanoid } from "@dub/utils";
import {
  Prisma,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import {
  assertRewardCommunicationOrigin,
  RewardCommunicationOriginBlockedError,
} from "./reward-communication-origin-fence";
import { enqueueRewardRedeemedCommunication } from "./reward-redeemed-communication-producer";

const FINANCIAL_REWARD_PROGRAM_LOCK_TIMEOUT_MS = 120_000;

type FinancialRewardType = "gift_card" | "store_credit";

type FinancialReservation = {
  redemption: {
    id: string;
    status: WeleticRedemptionStatus;
    artifactKind: WeleticRewardArtifactKind;
    shopifyDiscountCode: string;
    shopifyGiftCardId: string | null;
    shopifyStoreCreditTransactionId: string | null;
    metadata: Prisma.JsonValue | null;
  };
  account: {
    shopper: { shopifyCustomerId: string };
  };
  effectivePointsCost: bigint;
  balanceAfter: bigint;
  expiresAt: Date | null;
  provisioningSnapshot: LoyaltyRedemptionProvisioningSnapshot;
};

export type FinancialSagaResult = {
  success: true;
  redemptionId: string;
  discountCode: string;
  shopifyDiscountId: string | null;
  status: WeleticRedemptionStatus;
  pointsSpent: bigint;
  balanceAfter: bigint;
};

function financialArtifactKind(rewardType: FinancialRewardType) {
  return rewardType === "gift_card"
    ? WeleticRewardArtifactKind.gift_card
    : WeleticRewardArtifactKind.store_credit;
}

function hasRemoteProvisionAttempt(metadata: unknown) {
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      typeof (metadata as Record<string, unknown>)
        .remoteProvisionAttemptedAt === "string",
  );
}

function testCredentials({
  shopDomain,
  accessToken,
  customFetch,
}: {
  shopDomain?: string;
  accessToken?: string;
  customFetch?: typeof fetch;
}): ResolvedShopifyCredentials | null {
  if (process.env.NODE_ENV !== "test") return null;
  if (!customFetch && (!shopDomain || !accessToken)) return null;
  return {
    shopDomain: shopDomain || "test-store.myshopify.com",
    accessToken: accessToken || "test-offline-token",
    scope:
      "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
    source: "env_override",
  };
}

async function clearUnsentFinancialAttempt({
  storeId,
  accountId,
  redemptionId,
  code,
  preparationId,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  accountId: string;
  redemptionId: string;
  code: string;
  preparationId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  await withLoyaltyProgramRowLock({
    storeId,
    mode: "lock_only",
    loyaltyMaintenancePermit,
    timeoutMs: FINANCIAL_REWARD_PROGRAM_LOCK_TIMEOUT_MS,
    operation: async (tx) => {
      const current = await tx.weleticRewardRedemption.findUnique({
        where: { id: redemptionId },
        select: {
          storeId: true,
          accountId: true,
          status: true,
          shopifyDiscountCodeCanonical: true,
          settlementQuarantinedAt: true,
          metadata: true,
        },
      });
      const clearedMetadata = clearLoyaltyDiscountRemoteProvisionAttempt({
        metadata: current?.metadata,
        preparationId,
      });
      if (
        !current ||
        current.storeId !== storeId ||
        current.accountId !== accountId ||
        current.status !== WeleticRedemptionStatus.provisioning ||
        current.shopifyDiscountCodeCanonical !==
          canonicalizeLoyaltyDiscountCode(code) ||
        current.settlementQuarantinedAt ||
        !clearedMetadata
      ) {
        return;
      }
      // Admission or currency validation may fail before dispatch checks run.
      // Cleanup must independently fence the persisted reservation's origin.
      await assertRewardCommunicationOrigin({
        tx,
        storeId,
        accountId,
        redemptionId,
        metadata: current.metadata,
        loyaltyMaintenancePermit,
      });
      await tx.weleticRewardRedemption.updateMany({
        where: {
          id: redemptionId,
          storeId,
          accountId,
          status: WeleticRedemptionStatus.provisioning,
          shopifyDiscountCodeCanonical: canonicalizeLoyaltyDiscountCode(code),
          settlementQuarantinedAt: null,
        },
        data: { metadata: clearedMetadata },
      });
    },
  });
}

/**
 * Issues Shopify financial value after the generic redemption saga has
 * atomically reserved points. Store-credit requests are intentionally never
 * replayed after the dispatch marker is durable because Shopify exposes no
 * caller-supplied idempotency key for this mutation.
 */
export async function provisionFinancialRewardReservation({
  storeId,
  accountId,
  rewardDefinitionId,
  reservation,
  customFetch,
  shopDomain,
  accessToken,
  notifyStoreCreditOwner = true,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  accountId: string;
  rewardDefinitionId: string;
  reservation: FinancialReservation;
  customFetch?: typeof fetch;
  shopDomain?: string;
  accessToken?: string;
  notifyStoreCreditOwner?: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<FinancialSagaResult> {
  const snapshot = reservation.provisioningSnapshot;
  if (
    snapshot.rewardType !== "gift_card" &&
    snapshot.rewardType !== "store_credit"
  ) {
    throw new ShopifyFinancialRewardError(
      "INVALID_REQUEST",
      `Unsupported financial reward type '${snapshot.rewardType}'.`,
    );
  }
  const rewardType: FinancialRewardType = snapshot.rewardType;
  const artifactKind = financialArtifactKind(rewardType);
  if (reservation.redemption.artifactKind !== artifactKind) {
    throw new ShopifyFinancialRewardError(
      "REMOTE_CONFIGURATION_MISMATCH",
      `Redemption ${reservation.redemption.id} has a mismatched financial artifact kind.`,
    );
  }
  if (!snapshot.discountValue || BigInt(snapshot.discountValue) <= BigInt(0)) {
    throw new ShopifyFinancialRewardError(
      "INVALID_REQUEST",
      "Financial rewards require a positive amount in minor currency units.",
    );
  }

  const code = reservation.redemption.shopifyDiscountCode;
  const amountMinor = BigInt(snapshot.discountValue);
  const customerId = reservation.account.shopper.shopifyCustomerId;
  const note = `Weletic loyalty redemption ${reservation.redemption.id}`;
  const priorAttempt = hasRemoteProvisionAttempt(
    reservation.redemption.metadata,
  );
  if (rewardType === "store_credit" && priorAttempt) {
    throw new ShopifyFinancialRewardError(
      "REMOTE_OUTCOME_UNKNOWN",
      `Store-credit redemption ${reservation.redemption.id} already crossed the remote dispatch boundary and requires manual reconciliation before any retry.`,
    );
  }

  const credentials =
    testCredentials({ shopDomain, accessToken, customFetch }) ??
    (await resolveShopifyOfflineCredentials({ storeId }));
  // Reject known pre-dispatch failures before recording an ambiguous attempt.
  // Existing attempts must retain their reconciliation/adoption semantics.
  if (!priorAttempt) assertFinancialRewardScope({ credentials, rewardType });
  const preparationId = priorAttempt ? null : `frp_${nanoid(16)}`;
  let effectiveMetadata = reservation.redemption
    .metadata as Prisma.InputJsonValue | null;
  if (preparationId) {
    effectiveMetadata = markLoyaltyDiscountRemoteProvisionAttempt({
      metadata: effectiveMetadata,
      preparationId,
    });
    const prepared = await withLoyaltyProgramRowLock({
      storeId,
      mode: "active",
      loyaltyMaintenancePermit,
      timeoutMs: FINANCIAL_REWARD_PROGRAM_LOCK_TIMEOUT_MS,
      operation: async (tx) => {
        await assertRewardCommunicationOrigin({
          tx,
          storeId,
          accountId,
          redemptionId: reservation.redemption.id,
          metadata: effectiveMetadata,
          loyaltyMaintenancePermit,
        });
        await assertLockedLoyaltyProgramCurrencyGeneration({
          tx,
          storeId,
          expectedCurrency: snapshot.shopCurrency,
          expectedCurrencyVerifiedAt: snapshot.currencyVerifiedAt,
        });
        return tx.weleticRewardRedemption.updateMany({
          where: {
            id: reservation.redemption.id,
            storeId,
            accountId,
            rewardDefinitionId,
            status: WeleticRedemptionStatus.provisioning,
            artifactKind,
            shopifyDiscountCodeCanonical: canonicalizeLoyaltyDiscountCode(code),
            settlementQuarantinedAt: null,
          },
          data: { metadata: effectiveMetadata as Prisma.InputJsonValue },
        });
      },
    });
    if (prepared.count !== 1) {
      throw new ShopifyFinancialRewardError(
        "REMOTE_CONFIGURATION_MISMATCH",
        `Redemption ${reservation.redemption.id} left provisioning before financial issuance began.`,
      );
    }
  }

  let remoteCallStarted = false;
  try {
    return await withLoyaltyProgramRowLock({
      storeId,
      mode: "active",
      loyaltyMaintenancePermit,
      timeoutMs: FINANCIAL_REWARD_PROGRAM_LOCK_TIMEOUT_MS,
      operation: async (tx) => {
        const communicationOrigin = await assertRewardCommunicationOrigin({
          tx,
          storeId,
          accountId,
          redemptionId: reservation.redemption.id,
          metadata: effectiveMetadata,
          loyaltyMaintenancePermit,
        });
        await assertLockedLoyaltyProgramCurrencyGeneration({
          tx,
          storeId,
          expectedCurrency: snapshot.shopCurrency,
          expectedCurrencyVerifiedAt: snapshot.currencyVerifiedAt,
        });
        let giftCardId: string | null = null;
        let storeCreditTransactionId: string | null = null;
        if (rewardType === "gift_card") {
          const existing = priorAttempt
            ? await lookupShopifyGiftCard({
                shopDomain: credentials.shopDomain,
                accessToken: credentials.accessToken,
                code,
                customerId,
                amountMinor,
                currencyCode: snapshot.shopCurrency,
                expiresAt: reservation.expiresAt,
                note,
                customFetch,
              })
            : null;
          if (existing) {
            giftCardId = existing.id;
          } else {
            remoteCallStarted = true;
            const created = await createShopifyGiftCard({
              credentials,
              code,
              customerId,
              amountMinor,
              currencyCode: snapshot.shopCurrency,
              expiresAt: reservation.expiresAt,
              note,
              customFetch,
            });
            giftCardId = created.id;
          }
        } else {
          remoteCallStarted = true;
          const created = await createShopifyStoreCredit({
            credentials,
            customerId,
            amountMinor,
            currencyCode: snapshot.shopCurrency,
            expiresAt: reservation.expiresAt,
            notify: notifyStoreCreditOwner,
            customFetch,
          });
          storeCreditTransactionId = created.transactionId;
        }

        const transition = await tx.weleticRewardRedemption.updateMany({
          where: {
            id: reservation.redemption.id,
            storeId,
            accountId,
            rewardDefinitionId,
            status: WeleticRedemptionStatus.provisioning,
            artifactKind,
            shopifyDiscountCodeCanonical: canonicalizeLoyaltyDiscountCode(code),
            settlementQuarantinedAt: null,
          },
          data: {
            status: WeleticRedemptionStatus.issued,
            shopifyGiftCardId: giftCardId,
            shopifyStoreCreditTransactionId: storeCreditTransactionId,
          },
        });
        if (transition.count !== 1) {
          throw new ShopifyFinancialRewardError(
            "REMOTE_CONFIGURATION_MISMATCH",
            `Financial value was issued but redemption ${reservation.redemption.id} could not be finalized; manual reconciliation is required.`,
          );
        }

        if (communicationOrigin) {
          await enqueueRewardRedeemedCommunication({
            tx,
            storeId,
            accountId,
            expectedInstallationGeneration:
              communicationOrigin.installationGeneration,
            receipt: {
              transitioned: true,
              redemptionId: reservation.redemption.id,
              occurredAt: new Date(),
            },
            loyaltyMaintenancePermit,
          });
        }
        await enqueueFlowTriggerJob({
          storeId,
          eventId: reservation.redemption.id,
          payload: {
            accountId,
            handle: "weletic-reward-redeemed",
            rewardType: snapshot.rewardType,
            discountCode: code,
            pointsSpent: reservation.effectivePointsCost.toString(),
          },
          loyaltyMaintenancePermit,
          tx,
        });

        await enqueueOutboxJobFromProgramTransaction({
          storeId,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId,
            triggerReason: "financial_reward_redemption_issued",
          },
          idempotencyKey: `metafield_sync:redeem:${reservation.redemption.id}`,
          loyaltyMaintenancePermit,
          tx,
        });
        if (reservation.expiresAt) {
          await enqueueOutboxJobFromProgramTransaction({
            storeId,
            jobType: "REDEMPTION_RECOVERY",
            payload: {
              redemptionId: reservation.redemption.id,
              accountId,
              rewardDefinitionId,
              pointsCost: reservation.effectivePointsCost.toString(),
              shopifyDiscountCode: code,
              artifactKind,
              attemptCount: 0,
              sagaPhase: "expiry",
            },
            scheduledFor: reservation.expiresAt,
            idempotencyKey: `redemption_expiry:${reservation.redemption.id}`,
            loyaltyMaintenancePermit,
            tx,
          });
        }

        return {
          success: true as const,
          redemptionId: reservation.redemption.id,
          discountCode: code,
          shopifyDiscountId: giftCardId,
          status: WeleticRedemptionStatus.issued,
          pointsSpent: reservation.effectivePointsCost,
          balanceAfter: reservation.balanceAfter,
        };
      },
    });
  } catch (error) {
    if (error instanceof RewardCommunicationOriginBlockedError) throw error;
    if (preparationId && !remoteCallStarted) {
      await clearUnsentFinancialAttempt({
        storeId,
        accountId,
        redemptionId: reservation.redemption.id,
        code,
        preparationId,
        loyaltyMaintenancePermit,
      });
    }
    throw error;
  }
}

export async function markFinancialRewardExpired({
  storeId,
  redemptionId,
  now,
}: {
  storeId: string;
  redemptionId: string;
  now: Date;
}) {
  return prisma.weleticRewardRedemption.updateMany({
    where: {
      id: redemptionId,
      storeId,
      artifactKind: {
        in: [
          WeleticRewardArtifactKind.gift_card,
          WeleticRewardArtifactKind.store_credit,
        ],
      },
      status: {
        in: [WeleticRedemptionStatus.issued, WeleticRedemptionStatus.active],
      },
      expiresAt: { lte: now },
    },
    data: { status: WeleticRedemptionStatus.expired },
  });
}
