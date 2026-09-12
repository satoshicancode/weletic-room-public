import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { provisionFinancialRewardReservation } from "@/lib/weletic/loyalty/financial-reward-saga";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  assertLoyaltyMaintenanceWriteAllowed,
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction,
} from "@/lib/weletic/loyalty/outbox";
import {
  assertLockedLoyaltyProgramActive,
  assertLockedLoyaltyProgramCurrencyGeneration,
  isLockedLoyaltyProgramActive,
  lockLoyaltyProgramRow,
  withLoyaltyProgramRowLock,
} from "@/lib/weletic/loyalty/program-write-fence";
import {
  assertExpectedLoyaltyDiscountNode,
  assertLoyaltyDiscountLookupMissIsTerminal,
  canonicalizeLoyaltyDiscountCode,
  clearLoyaltyDiscountRemoteProvisionAttempt,
  createLoyaltyDiscountProvisioningIdentity,
  getPersistedLoyaltyDiscountProvisioningIdentity,
  markLoyaltyDiscountRemoteProvisionAttempt,
  matchesExpectedLoyaltyDiscountNode,
  mergeLoyaltyDiscountOwnershipMetadata,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import { mergeRedemptionMetadataTimestamp } from "@/lib/weletic/loyalty/redemption-metadata";
import {
  assertProvisioningReplayMatchesSnapshot,
  createLoyaltyRedemptionProvisioningSnapshot,
  getRewardDefinitionFromProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
  readLoyaltyRedemptionProvisioningSnapshot,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  getReferralCouponIdempotencyKey,
  issueReferralRewardCoupon,
  recoverCompensatedReferralCouponDiscount,
} from "@/lib/weletic/loyalty/referral-coupon";
import {
  deactivateDiscount,
  isInactiveShopifyDiscountStatus,
  lookupDiscountByCode,
  matchesLoyaltyRewardDiscountConfiguration,
  provisionLoyaltyRewardDiscount,
  resolveShopifyOfflineCredentials,
  SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS,
  ShopifyDiscountError,
  ShopifyDiscountResult,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { ShopifyFinancialRewardError } from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { nanoid } from "@dub/utils";
import {
  Prisma,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
  WeleticRewardStatus,
} from "@prisma/client";
import { createRewardCommunicationOrigin } from "./reward-communication-origin";
import {
  assertRewardCommunicationOrigin,
  RewardCommunicationOriginBlockedError,
} from "./reward-communication-origin-fence";
import { assertAccountBackedReward } from "./reward-ownership";
import { enqueueRewardRedeemedCommunication } from "./reward-redeemed-communication-producer";

export interface ProvisionDiscountSagaParams {
  storeId: string;
  accountId: string;
  rewardDefinitionId: string;
  discountCode?: string;
  expiresInDays?: number | null;
  /** Test-only credential override; ignored outside NODE_ENV=test. */
  shopDomain?: string;
  /** Test-only credential override; ignored outside NODE_ENV=test. */
  accessToken?: string;
  customFetch?: typeof fetch;
  pointsCostOverride?: bigint | number;
  discountValueOverride?: number | string;
  /** Defaults to true. Operator validators can suppress Shopify email. */
  notifyStoreCreditOwner?: boolean;
  idempotencyKey: string;
  expiresAt?: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}

export interface SagaResult {
  success: boolean;
  redemptionId: string;
  discountCode: string;
  shopifyDiscountId?: string | null;
  status: WeleticRedemptionStatus;
  pointsSpent: bigint;
  balanceAfter?: bigint;
  error?: string;
  compensated?: boolean;
}

const GENERIC_DISCOUNT_PROGRAM_LOCK_TIMEOUT_MS = Math.max(
  120_000,
  SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS * 6,
);

export async function withLockedLoyaltyAccount<T>({
  storeId,
  accountId,
  fn,
}: {
  storeId: string;
  accountId: string;
  fn: (account: {
    status: string;
    metadata: Prisma.JsonValue | null;
    shopifyCustomerId: string;
  }) => Promise<T>;
}): Promise<T | null> {
  const identity = await prisma.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId },
    select: {
      shopper: { select: { shopifyCustomerId: true } },
      store: { select: { projectId: true } },
    },
  });
  if (!identity) return null;

  return withShopifyCustomerSettlementLocks({
    storeId,
    workspaceId: identity.store.projectId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn: async () => {
      const current = await prisma.weleticLoyaltyAccount.findFirst({
        where: { id: accountId, storeId },
        select: {
          status: true,
          metadata: true,
          shopper: { select: { shopifyCustomerId: true } },
        },
      });
      if (!current) return null;
      return fn({
        status: current.status,
        metadata: current.metadata,
        shopifyCustomerId: current.shopper.shopifyCustomerId,
      });
    },
  });
}

/**
 * 4-Phase Distributed Discount Provisioning Saga:
 * Phase 1: Reserve points and record redemption in 'provisioning' status + 2-min recovery outbox job.
 * Phase 2: Create deterministic discount code in Shopify Admin GraphQL API.
 * Phase 3: Finalize redemption to 'issued' status with remote Shopify GID + async Customer Metafield sync.
 * Phase 4: Compensating rollback on terminal failure (mark 'failed' + restore points via REDEMPTION_REFUND ledger entry).
 */
export async function provisionDiscountSaga(
  params: ProvisionDiscountSagaParams,
): Promise<SagaResult> {
  if (
    typeof params.idempotencyKey !== "string" ||
    params.idempotencyKey.length < 8 ||
    params.idempotencyKey.length > 200 ||
    params.idempotencyKey.trim() !== params.idempotencyKey
  ) {
    throw new Error(
      "Redemption idempotency key must contain 8 to 200 non-whitespace-delimited characters.",
    );
  }

  const identity = await prisma.weleticLoyaltyAccount.findFirst({
    where: { id: params.accountId, storeId: params.storeId },
    select: {
      id: true,
      shopper: { select: { shopifyCustomerId: true } },
      store: { select: { projectId: true } },
    },
  });
  if (!identity) {
    throw new Error(`Loyalty account ${params.accountId} not found.`);
  }

  return withShopifyCustomerSettlementLocks({
    storeId: params.storeId,
    workspaceId: identity.store.projectId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn: () => provisionDiscountSagaUnlocked(params),
  });
}

async function provisionDiscountSagaUnlocked(
  params: ProvisionDiscountSagaParams,
): Promise<SagaResult> {
  const {
    storeId,
    accountId,
    rewardDefinitionId,
    discountCode: requestedCode,
    expiresInDays,
    customFetch,
    pointsCostOverride,
    discountValueOverride,
    idempotencyKey,
    expiresAt: expiresAtOverride,
  } = params;

  // ==========================================================================
  // PHASE 1: Local Reservation & Points Debit
  // ==========================================================================
  let generatedCode =
    requestedCode?.trim().toUpperCase() || `WL-${nanoid(8).toUpperCase()}`;

  const redemptionId = createWeleticId("wredemp_");

  const reservation = await prisma.$transaction(async (tx) => {
    const operationalStore = await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "reward_redemption",
      requireVerifiedCurrency: true,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx,
    });
    if (!operationalStore) {
      throw new Error("Shopify store is unavailable for loyalty redemption.");
    }
    const lockedProgram = await lockLoyaltyProgramRow({
      tx,
      storeId,
      mode: "lock_only",
    });
    // 1. Validate Loyalty Account
    const account = await tx.weleticLoyaltyAccount.findUnique({
      where: { id: accountId },
      include: { program: true, shopper: true },
    });

    if (!account) {
      throw new Error(`Loyalty account ${accountId} not found.`);
    }

    if (account.storeId !== storeId) {
      throw new Error("Loyalty account does not belong to this Shopify store.");
    }

    // This check deliberately precedes idempotent-reservation continuation.
    // A retry of a pre-redaction `provisioning` row must not reach Shopify
    // after customer closure. Compensating/expiry cleanup uses separate paths
    // and remains allowed for closed accounts.
    if (
      account.status !== "active" ||
      hasShopifyCustomerRedactionTombstone(account.metadata)
    ) {
      throw new Error(
        `Loyalty account ${accountId} is not active (${account.status}).`,
      );
    }

    // Resolve retries before applying eligibility checks for a new debit.
    // Issued/live replays remain readable while disabled; a provisioning replay
    // must pass the active program fence again before any Shopify adoption or
    // mutation.
    const existing = await tx.weleticRewardRedemption.findUnique({
      where: {
        storeId_idempotencyKey: { storeId, idempotencyKey },
      },
    });
    if (existing) {
      if (existing.settlementQuarantinedAt) {
        throw new Error(
          `Redemption ${existing.id} is quarantined pending canonical discount reconciliation.`,
        );
      }
      if (
        existing.accountId !== accountId ||
        existing.rewardDefinitionId !== rewardDefinitionId ||
        (requestedCode !== undefined &&
          existing.shopifyDiscountCode !== generatedCode) ||
        (pointsCostOverride !== undefined &&
          existing.pointsSpent !== BigInt(pointsCostOverride)) ||
        (expiresAtOverride !== undefined &&
          (existing.expiresAt?.getTime() ?? null) !==
            expiresAtOverride.getTime())
      ) {
        throw new Error(
          "Redemption idempotency key was reused for another request.",
        );
      }
      if (
        existing.status !== WeleticRedemptionStatus.provisioning &&
        existing.status !== WeleticRedemptionStatus.issued &&
        existing.status !== WeleticRedemptionStatus.active
      ) {
        throw new Error(
          `Redemption request is already terminal (${existing.status}).`,
        );
      }
      const provisioningSnapshot = readLoyaltyRedemptionProvisioningSnapshot(
        existing.metadata,
      );
      const alreadyIssued =
        existing.status === WeleticRedemptionStatus.issued ||
        existing.status === WeleticRedemptionStatus.active;
      if (!alreadyIssued && !provisioningSnapshot) {
        throw new Error(
          `Provisioning redemption ${existing.id} is missing its immutable Shopify configuration snapshot.`,
        );
      }
      if (provisioningSnapshot) {
        if (
          provisioningSnapshot.rewardDefinitionId !== rewardDefinitionId ||
          provisioningSnapshot.pointsCost !== existing.pointsSpent.toString() ||
          provisioningSnapshot.expiresAt !==
            (existing.expiresAt?.toISOString() ?? null)
        ) {
          throw new Error(
            `Provisioning redemption ${existing.id} does not match its immutable Shopify configuration snapshot.`,
          );
        }
        assertProvisioningReplayMatchesSnapshot({
          snapshot: provisioningSnapshot,
          pointsCostOverride,
          discountValueOverride,
          expiresInDays,
          storeId,
          shopifyCustomerId: account.shopper.shopifyCustomerId,
        });
        if (
          !alreadyIssued &&
          provisioningSnapshot.currencyVerifiedAt !==
            operationalStore.currencyVerifiedAt?.toISOString()
        ) {
          throw new Error(
            `Provisioning redemption ${existing.id} belongs to a stale Shopify currency generation.`,
          );
        }
      }
      return {
        redemption: existing,
        account,
        effectivePointsCost: existing.pointsSpent,
        expiresAt: existing.expiresAt,
        balanceAfter: account.cachedPointsBalance,
        discountOwnership: getPersistedLoyaltyDiscountProvisioningIdentity({
          identity: {
            storeId,
            redemptionId: existing.id,
            accountId,
            rewardDefinitionId,
            discountCode: existing.shopifyDiscountCode,
          },
          metadata: existing.metadata,
        }),
        discountMetadata: existing.metadata,
        provisioningSnapshot,
        alreadyIssued,
      };
    }

    // 2. Validate Reward Definition only for a new reservation. A retry is
    // fully defined by its immutable provisioning snapshot and must remain
    // recoverable after the merchant edits, disables, or deletes the reward.
    const reward = await tx.weleticRewardDefinition.findUnique({
      where: { id: rewardDefinitionId },
    });

    if (!reward || reward.storeId !== storeId) {
      throw new Error("Reward definition not found for this Shopify store.");
    }

    if (!requestedCode && reward.rewardType === "gift_card") {
      generatedCode = `WLGC${nanoid(12).toUpperCase()}`;
    } else if (!requestedCode && reward.rewardType === "store_credit") {
      generatedCode = `WLSC${nanoid(12).toUpperCase()}`;
    }

    const effectivePointsCost =
      pointsCostOverride !== undefined
        ? BigInt(pointsCostOverride)
        : reward.pointsCost;

    assertLockedLoyaltyProgramActive(
      lockedProgram,
      params.loyaltyMaintenancePermit,
    );

    if (reward.status !== WeleticRewardStatus.active) {
      throw new Error("Reward definition not found or inactive.");
    }

    if (effectivePointsCost <= BigInt(0)) {
      throw new Error("Reward points cost must be greater than zero.");
    }

    if (pointsCostOverride !== undefined) {
      if (reward.exchangeType !== "incremental" || !reward.pointsStep) {
        throw new Error(
          "Points override is only allowed for incremental rewards.",
        );
      }
      const minPoints = reward.minPointsCost ?? reward.pointsCost;
      const maxPoints = reward.maxPointsCost;
      if (
        effectivePointsCost < minPoints ||
        (maxPoints !== null && effectivePointsCost > maxPoints) ||
        effectivePointsCost % reward.pointsStep !== BigInt(0)
      ) {
        throw new Error(
          "Requested points do not satisfy the reward step or limits.",
        );
      }
    }

    if (
      account.cachedPointsBalance < effectivePointsCost ||
      account.cachedPointsBalance <= BigInt(0)
    ) {
      throw new Error(
        `Insufficient points balance: required ${effectivePointsCost}, available ${account.cachedPointsBalance}.`,
      );
    }

    const effectiveExpiresInDays =
      expiresInDays !== undefined && expiresInDays !== null
        ? expiresInDays
        : reward.expiresInDays;

    const expiresAt =
      expiresAtOverride ??
      (effectiveExpiresInDays
        ? new Date(Date.now() + effectiveExpiresInDays * 86400000)
        : null);
    const startsAt = new Date();
    const discountOwnership = createLoyaltyDiscountProvisioningIdentity({
      identity: {
        storeId,
        redemptionId,
        accountId,
        rewardDefinitionId: reward.id,
        discountCode: generatedCode,
      },
      rewardName: reward.name,
    });
    const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward,
      pointsCost: effectivePointsCost,
      discountValue:
        discountValueOverride !== undefined
          ? discountValueOverride
          : reward.discountValue,
      expiresInDays: effectiveExpiresInDays ?? null,
      shopCurrency: operationalStore.shopCurrency,
      currencyVerifiedAt: operationalStore.currencyVerifiedAt!,
      customerSelectionDigest: getShopifyCustomerSelectionDigest({
        storeId,
        shopifyCustomerId: account.shopper.shopifyCustomerId,
      }),
      startsAt,
      expiresAt,
    });
    const discountMetadata = mergeLoyaltyDiscountOwnershipMetadata({
      metadata: {
        rewardSnapshot: {
          name: reward.name,
          rewardType: reward.rewardType,
          ...(reward.salesChannel ? { salesChannel: reward.salesChannel } : {}),
          ...(reward.description ? { description: reward.description } : {}),
        },
        provisioningSnapshot,
        ...(operationalStore.installationGeneration
          ? {
              rewardCommunicationOrigin: createRewardCommunicationOrigin({
                storeId,
                accountId,
                redemptionId,
                installationGeneration: operationalStore.installationGeneration,
                provisioningDigest: provisioningSnapshot.contentDigest,
              }),
            }
          : {}),
      },
      ownership: discountOwnership,
    });

    // 3. Create redemption record in 'provisioning' status
    const redemption = await tx.weleticRewardRedemption.create({
      data: {
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId: reward.id,
        pointsSpent: effectivePointsCost,
        shopifyDiscountCode: generatedCode,
        shopifyDiscountCodeCanonical:
          canonicalizeLoyaltyDiscountCode(generatedCode),
        artifactKind:
          reward.rewardType === "gift_card"
            ? WeleticRewardArtifactKind.gift_card
            : reward.rewardType === "store_credit"
              ? WeleticRewardArtifactKind.store_credit
              : WeleticRewardArtifactKind.discount_code,
        status: WeleticRedemptionStatus.provisioning,
        expiresAt,
        idempotencyKey,
        metadata: discountMetadata,
      },
    });

    // 4. Append immutable debit ledger entry
    const ledgerEntry = await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
      pointsDelta: -effectivePointsCost,
      referenceType: "REWARD_REDEMPTION",
      referenceId: redemption.id,
      idempotencyKey: `redeem_debit:${redemption.id}`,
      reason: `Redeemed ${reward.name} voucher`,
      metadata: {
        rewardId: reward.id,
        rewardName: reward.name,
        rewardDescription: reward.description,
        rewardType: reward.rewardType,
        discountCode: generatedCode,
      },
      tx,
    });

    // 5. Link ledgerEntryId
    await tx.weleticRewardRedemption.update({
      where: { id: redemption.id },
      data: { ledgerEntryId: ledgerEntry.id },
    });

    // 6. Enqueue durable 2-minute recovery outbox job
    await enqueueOutboxJobFromProgramTransaction({
      storeId,
      jobType: "REDEMPTION_RECOVERY",
      payload: {
        redemptionId: redemption.id,
        accountId,
        rewardDefinitionId: reward.id,
        pointsCost: effectivePointsCost.toString(),
        shopifyDiscountCode: generatedCode,
        artifactKind:
          reward.rewardType === "gift_card"
            ? WeleticRewardArtifactKind.gift_card
            : reward.rewardType === "store_credit"
              ? WeleticRewardArtifactKind.store_credit
              : WeleticRewardArtifactKind.discount_code,
        attemptCount: 0,
        sagaPhase: "provisioning",
      },
      scheduledFor: new Date(Date.now() + 120_000), // 2 minutes
      idempotencyKey: `recovery:${redemption.id}`,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx,
    });

    return {
      redemption,
      account,
      effectivePointsCost,
      expiresAt,
      balanceAfter:
        ledgerEntry.balanceAfter ??
        account.cachedPointsBalance - effectivePointsCost,
      alreadyIssued: false,
      discountOwnership,
      discountMetadata,
      provisioningSnapshot,
    };
  });

  const effectiveRedemptionId = reservation.redemption.id;
  if (reservation.alreadyIssued) {
    return {
      success: true,
      redemptionId: effectiveRedemptionId,
      discountCode: reservation.redemption.shopifyDiscountCode,
      shopifyDiscountId: reservation.redemption.shopifyDiscountId,
      status: reservation.redemption.status,
      pointsSpent: reservation.redemption.pointsSpent,
      balanceAfter: reservation.balanceAfter,
    };
  }
  if (!reservation.discountOwnership || !reservation.provisioningSnapshot) {
    throw new Error(
      `Provisioning redemption ${effectiveRedemptionId} is missing immutable Shopify configuration.`,
    );
  }
  const provisioningSnapshot = reservation.provisioningSnapshot;

  if (
    provisioningSnapshot.rewardType === "gift_card" ||
    provisioningSnapshot.rewardType === "store_credit"
  ) {
    try {
      return await provisionFinancialRewardReservation({
        storeId,
        accountId,
        rewardDefinitionId: provisioningSnapshot.rewardDefinitionId,
        reservation: { ...reservation, provisioningSnapshot },
        customFetch,
        shopDomain: params.shopDomain,
        accessToken: params.accessToken,
        notifyStoreCreditOwner: params.notifyStoreCreditOwner,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      });
    } catch (error) {
      if (
        isLoyaltyMaintenanceBlockedError(error) ||
        error instanceof RewardCommunicationOriginBlockedError
      )
        throw error;
      const failureReason =
        error instanceof Error ? error.message : String(error);
      const definitelyNoFinancialValueIssued =
        error instanceof ShopifyFinancialRewardError &&
        ["MISSING_SCOPE", "INVALID_REQUEST", "GRAPHQL_USER_ERROR"].includes(
          error.code,
        );
      if (!definitelyNoFinancialValueIssued) {
        return {
          success: false,
          redemptionId: effectiveRedemptionId,
          discountCode: reservation.redemption.shopifyDiscountCode,
          status: WeleticRedemptionStatus.provisioning,
          pointsSpent: reservation.effectivePointsCost,
          error: failureReason,
          compensated: false,
        };
      }
      await compensateDiscountSaga({
        redemptionId: effectiveRedemptionId,
        reason: `Shopify financial reward provisioning failed: ${failureReason}`,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      });
      return {
        success: false,
        redemptionId: effectiveRedemptionId,
        discountCode: reservation.redemption.shopifyDiscountCode,
        status: WeleticRedemptionStatus.failed,
        pointsSpent: reservation.effectivePointsCost,
        error: failureReason,
        compensated: true,
      };
    }
  }

  // ==========================================================================
  // PHASE 2: Shopify GraphQL Admin API Provisioning
  // ==========================================================================
  let effectiveCode = reservation.redemption.shopifyDiscountCode;
  let effectiveDiscountOwnership = reservation.discountOwnership;
  let effectiveDiscountMetadata = reservation.discountMetadata;
  let hadPriorRemoteProvisionAttempt = Boolean(
    effectiveDiscountMetadata &&
      typeof effectiveDiscountMetadata === "object" &&
      !Array.isArray(effectiveDiscountMetadata) &&
      typeof (effectiveDiscountMetadata as Record<string, unknown>)
        .remoteProvisionAttemptedAt === "string",
  );
  let remoteProvisionPreparationId: string | null = null;
  let shopifyResult: ShopifyDiscountResult | null = null;
  let remoteCreateStarted = false;
  let finalStatus: WeleticRedemptionStatus = WeleticRedemptionStatus.issued;
  let terminalStatus: WeleticRedemptionStatus | null = null;

  try {
    // Resolve credentials before opening the interactive program transaction.
    // The transaction must not borrow a second Prisma connection while it
    // holds the program row lock across Shopify I/O.
    const allowTestCredentialOverride = process.env.NODE_ENV === "test";
    let domain = allowTestCredentialOverride ? params.shopDomain : undefined;
    let token = allowTestCredentialOverride ? params.accessToken : undefined;
    let resolvedCredentials:
      | Awaited<ReturnType<typeof resolveShopifyOfflineCredentials>>
      | undefined;

    if (allowTestCredentialOverride && customFetch && (!domain || !token)) {
      domain = domain || "test-store.myshopify.com";
      token = token || "test-offline-token";
    }
    if (!domain || !token) {
      resolvedCredentials = await resolveShopifyOfflineCredentials({ storeId });
      domain = resolvedCredentials.shopDomain;
      token = resolvedCredentials.accessToken;
    }

    let rewardToProvision = getRewardDefinitionFromProvisioningSnapshot({
      snapshot: reservation.provisioningSnapshot,
      provisioningName: effectiveDiscountOwnership.provisioningName,
    });

    // Persist the ambiguity window before Shopify receives the create. If the
    // request commits remotely but the response is lost, a lookup miss must
    // remain retryable during this bounded visibility horizon. A miss after
    // the horizon requires manual reconciliation; it never proves absence.
    if (!hadPriorRemoteProvisionAttempt) {
      remoteProvisionPreparationId = `rp_${nanoid(16)}`;
    }
    effectiveDiscountMetadata = markLoyaltyDiscountRemoteProvisionAttempt({
      metadata: effectiveDiscountMetadata,
      preparationId: remoteProvisionPreparationId ?? undefined,
    });
    const markedForRemoteProvision = await withLoyaltyProgramRowLock({
      storeId,
      mode: "active",
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      timeoutMs: GENERIC_DISCOUNT_PROGRAM_LOCK_TIMEOUT_MS,
      operation: async (tx) => {
        await assertRewardCommunicationOrigin({
          tx,
          storeId,
          accountId,
          redemptionId: effectiveRedemptionId,
          metadata: effectiveDiscountMetadata,
          loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        });
        return tx.weleticRewardRedemption.updateMany({
          where: {
            id: effectiveRedemptionId,
            storeId,
            status: WeleticRedemptionStatus.provisioning,
            shopifyDiscountCode: effectiveCode,
            shopifyDiscountCodeCanonical:
              canonicalizeLoyaltyDiscountCode(effectiveCode),
            settlementQuarantinedAt: null,
          },
          data: {
            metadata: effectiveDiscountMetadata as Prisma.InputJsonValue,
          },
        });
      },
    });
    if (markedForRemoteProvision.count !== 1) {
      throw new Error(
        `Redemption ${effectiveRedemptionId} left provisioning before the Shopify request began.`,
      );
    }

    let retryAfterCollision = false;
    do {
      retryAfterCollision = false;
      remoteCreateStarted = false;
      shopifyResult = await withLoyaltyProgramRowLock({
        storeId,
        mode: "active",
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        timeoutMs: GENERIC_DISCOUNT_PROGRAM_LOCK_TIMEOUT_MS,
        operation: async (tx) => {
          let communicationOrigin: Awaited<
            ReturnType<typeof assertRewardCommunicationOrigin>
          > = null;
          try {
            communicationOrigin = await assertRewardCommunicationOrigin({
              tx,
              storeId,
              accountId,
              redemptionId: effectiveRedemptionId,
              metadata: effectiveDiscountMetadata,
              loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
            });
            const currentShopCurrency =
              await assertLockedLoyaltyProgramCurrencyGeneration({
                tx,
                storeId,
                expectedCurrency: provisioningSnapshot.shopCurrency,
                expectedCurrencyVerifiedAt:
                  provisioningSnapshot.currencyVerifiedAt,
              });
            remoteCreateStarted = true;
            shopifyResult = await provisionLoyaltyRewardDiscount({
              storeId,
              shopDomain: domain,
              accessToken: token,
              resolvedCredentials,
              rewardDefinition: rewardToProvision,
              discountCode: effectiveCode,
              expiresAt: reservation.expiresAt,
              startsAt: new Date(provisioningSnapshot.startsAt),
              expectedShopCurrency: provisioningSnapshot.shopCurrency,
              currentShopCurrency,
              shopifyCustomerId: reservation.account.shopper?.shopifyCustomerId,
              customFetch,
            });
          } catch (provisionErr: any) {
            // Collision handling: Check if error is TAKEN / DUPLICATE
            const isTaken =
              provisionErr?.userErrors?.some(
                (e: any) =>
                  e.code === "TAKEN" ||
                  e.code === "DUPLICATE" ||
                  e.message?.toLowerCase().includes("taken") ||
                  e.message?.toLowerCase().includes("already exists"),
              ) ||
              provisionErr?.message?.toLowerCase().includes("taken") ||
              provisionErr?.message?.toLowerCase().includes("already exists");

            if (isTaken) {
              // Query remote Shopify state to see if it's our own deterministic retry
              const existingNode = await lookupDiscountByCode(
                domain,
                token,
                effectiveCode,
                customFetch,
              );

              if (!existingNode) {
                assertLoyaltyDiscountLookupMissIsTerminal({
                  redemptionId: effectiveRedemptionId,
                  discountCode: effectiveCode,
                  metadata: effectiveDiscountMetadata,
                });
                throw new ShopifyDiscountError(
                  "INVALID_REQUEST",
                  `Shopify reported ${effectiveCode} as taken, but no verifiable owner appeared during the reconciliation horizon.`,
                );
              }

              const ownedByThisRedemption =
                effectiveDiscountOwnership &&
                matchesExpectedLoyaltyDiscountNode({
                  identity: {
                    storeId,
                    redemptionId: effectiveRedemptionId,
                    accountId,
                    rewardDefinitionId: provisioningSnapshot.rewardDefinitionId,
                    discountCode: effectiveCode,
                  },
                  expected: effectiveDiscountOwnership,
                  remote: existingNode,
                  requireActive: false,
                });
              if (ownedByThisRedemption) {
                if (isInactiveShopifyDiscountStatus(existingNode.status)) {
                  const persistedRemote =
                    await tx.weleticRewardRedemption.updateMany({
                      where: {
                        id: effectiveRedemptionId,
                        storeId,
                        accountId,
                        status: WeleticRedemptionStatus.provisioning,
                        shopifyDiscountCode: effectiveCode,
                        shopifyDiscountCodeCanonical:
                          canonicalizeLoyaltyDiscountCode(effectiveCode),
                        settlementQuarantinedAt: null,
                      },
                      data: { shopifyDiscountId: existingNode.id },
                    });
                  if (persistedRemote.count !== 1) {
                    throw new Error(
                      `Redemption ${effectiveRedemptionId} changed state before inactive Shopify cleanup could converge.`,
                    );
                  }
                  await compensateDiscountSagaFromProgramTransaction({
                    redemptionId: effectiveRedemptionId,
                    reason:
                      "Owned Shopify discount was already inactive during direct provisioning replay.",
                    loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
                    tx,
                  });
                  terminalStatus = WeleticRedemptionStatus.failed;
                  return existingNode;
                }
                if (
                  matchesLoyaltyRewardDiscountConfiguration({
                    remote: existingNode,
                    rewardDefinition: rewardToProvision,
                    startsAt: new Date(provisioningSnapshot.startsAt),
                    expiresAt: reservation.expiresAt,
                    expectedShopCurrency: provisioningSnapshot.shopCurrency,
                    shopifyCustomerId:
                      reservation.account.shopper?.shopifyCustomerId,
                  })
                ) {
                  shopifyResult = existingNode;
                } else {
                  // This is our marker but its economics or eligibility were edited
                  // in Shopify. Deactivate it before releasing the points debit so a
                  // customer can never receive both restored points and the altered
                  // live voucher.
                  const deactivated = await deactivateDiscount(
                    domain,
                    token,
                    existingNode.id,
                    customFetch,
                  );
                  if (!deactivated) {
                    throw new Error(
                      `Shopify did not confirm deactivation of altered loyalty discount ${existingNode.id}.`,
                    );
                  }
                  throw new ShopifyDiscountError(
                    "INVALID_REQUEST",
                    `Shopify discount ${effectiveCode} no longer matches its immutable Weletic configuration.`,
                  );
                }
              } else {
                // Collision with unrelated discount: generate unique suffix and retry
                // The lookup conclusively proved the old code belongs to another
                // owner, so it is no longer an unresolved remote attempt.
                hadPriorRemoteProvisionAttempt = false;
                const collidedCode = effectiveCode;
                effectiveCode = `WL-${nanoid(10).toUpperCase()}`;

                effectiveDiscountOwnership =
                  createLoyaltyDiscountProvisioningIdentity({
                    identity: {
                      storeId,
                      redemptionId: effectiveRedemptionId,
                      accountId,
                      rewardDefinitionId:
                        provisioningSnapshot.rewardDefinitionId,
                      discountCode: effectiveCode,
                    },
                    rewardName: provisioningSnapshot.name,
                  });
                effectiveDiscountMetadata =
                  mergeLoyaltyDiscountOwnershipMetadata({
                    metadata: effectiveDiscountMetadata,
                    ownership: effectiveDiscountOwnership,
                  });
                remoteProvisionPreparationId = `rp_${nanoid(16)}`;
                effectiveDiscountMetadata =
                  markLoyaltyDiscountRemoteProvisionAttempt({
                    metadata: effectiveDiscountMetadata,
                    reset: true,
                    preparationId: remoteProvisionPreparationId,
                  });
                rewardToProvision = {
                  ...rewardToProvision,
                  name: effectiveDiscountOwnership.provisioningName,
                };

                const replacementCodePersisted =
                  await tx.weleticRewardRedemption.updateMany({
                    where: {
                      id: effectiveRedemptionId,
                      storeId,
                      status: WeleticRedemptionStatus.provisioning,
                      shopifyDiscountCode: collidedCode,
                      shopifyDiscountCodeCanonical:
                        canonicalizeLoyaltyDiscountCode(collidedCode),
                      settlementQuarantinedAt: null,
                    },
                    data: {
                      shopifyDiscountCode: effectiveCode,
                      shopifyDiscountCodeCanonical:
                        canonicalizeLoyaltyDiscountCode(effectiveCode),
                      metadata: effectiveDiscountMetadata,
                    },
                  });
                if (replacementCodePersisted.count !== 1) {
                  throw new Error(
                    `Redemption ${effectiveRedemptionId} changed canonical identity during collision recovery.`,
                  );
                }
                // Commit the replacement canonical identity before another
                // Shopify create begins. A failed second create can then only be
                // reconciled against the durable replacement code, and this
                // interactive transaction never escapes through global Prisma.
                retryAfterCollision = true;
                return null;
              }
            } else {
              throw provisionErr;
            }
          }

          if (shopifyResult && shopifyResult.status !== "ACTIVE") {
            throw new Error(
              `Shopify returned a non-active discount for redemption ${effectiveRedemptionId}.`,
            );
          }

          // ====================================================================
          // PHASE 3: Finalization to "issued" Status
          // ====================================================================
          // The same program-row lock spans the remote create/adoption and this
          // local transition. A merchant disable therefore linearizes strictly
          // before both (and blocks them) or after both durable results.
          const transition = await tx.weleticRewardRedemption.updateMany({
            where: {
              id: effectiveRedemptionId,
              storeId,
              status: WeleticRedemptionStatus.provisioning,
              shopifyDiscountCode: effectiveCode,
              shopifyDiscountCodeCanonical:
                canonicalizeLoyaltyDiscountCode(effectiveCode),
              settlementQuarantinedAt: null,
            },
            data: {
              status: WeleticRedemptionStatus.issued,
              shopifyDiscountId: shopifyResult?.id || null,
              shopifyDiscountCode: effectiveCode,
              shopifyDiscountCodeCanonical:
                canonicalizeLoyaltyDiscountCode(effectiveCode),
            },
          });

          if (transition.count === 0) {
            const latest = await tx.weleticRewardRedemption.findUnique({
              where: { id: effectiveRedemptionId },
            });
            if (!latest || latest.storeId !== storeId) {
              throw new Error(
                `Redemption ${effectiveRedemptionId} disappeared before finalization`,
              );
            }

            if (
              latest.status === WeleticRedemptionStatus.issued ||
              latest.status === WeleticRedemptionStatus.active ||
              latest.status === WeleticRedemptionStatus.used
            ) {
              finalStatus = latest.status;
            } else {
              terminalStatus = latest.status;

              // Preserve the remote identity and queue cleanup without
              // resurrecting a redemption concurrently cancelled or compensated
              // by another worker.
              const remoteIdentityPersisted =
                await tx.weleticRewardRedemption.updateMany({
                  where: {
                    id: effectiveRedemptionId,
                    storeId,
                    status: latest.status,
                    shopifyDiscountCode: effectiveCode,
                    shopifyDiscountCodeCanonical:
                      canonicalizeLoyaltyDiscountCode(effectiveCode),
                    settlementQuarantinedAt: null,
                  },
                  data: {
                    shopifyDiscountId: shopifyResult?.id || null,
                  },
                });
              if (remoteIdentityPersisted.count !== 1) {
                if (!shopifyResult?.id) {
                  throw new Error(
                    `Redemption ${effectiveRedemptionId} changed canonical identity before cleanup could be recorded.`,
                  );
                }
                const deactivated = await deactivateDiscount(
                  domain,
                  token,
                  shopifyResult.id,
                  customFetch,
                );
                if (!deactivated) {
                  throw new Error(
                    `Shopify did not confirm deactivation after redemption ${effectiveRedemptionId} changed canonical identity.`,
                  );
                }
                return shopifyResult;
              }
              await enqueueOutboxJob({
                storeId,
                jobType: "REDEMPTION_RECOVERY",
                payload: {
                  redemptionId: effectiveRedemptionId,
                  accountId,
                  rewardDefinitionId: provisioningSnapshot.rewardDefinitionId,
                  pointsCost: reservation.effectivePointsCost.toString(),
                  shopifyDiscountCode: effectiveCode,
                  attemptCount: 0,
                  sagaPhase: "compensating",
                },
                idempotencyKey: `discount_deactivate:${effectiveRedemptionId}`,
                tx,
              });
              return shopifyResult;
            }
          }

          if (transition.count === 1 && communicationOrigin) {
            await enqueueRewardRedeemedCommunication({
              tx,
              storeId,
              accountId,
              expectedInstallationGeneration:
                communicationOrigin.installationGeneration,
              receipt: {
                transitioned: true,
                redemptionId: effectiveRedemptionId,
                occurredAt: new Date(),
              },
              loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
            });
          }
          await enqueueFlowTriggerJob({
            storeId,
            eventId: effectiveRedemptionId,
            payload: {
              accountId,
              handle: "weletic-reward-redeemed",
              rewardType: provisioningSnapshot.rewardType,
              discountCode: effectiveCode,
              pointsSpent: reservation.effectivePointsCost.toString(),
            },
            loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
            tx,
          });

          await enqueueOutboxJobFromProgramTransaction({
            storeId,
            jobType: "METAFIELD_SYNC",
            payload: {
              accountId,
              triggerReason: "reward_redemption_issued",
            },
            idempotencyKey: `metafield_sync:redeem:${effectiveRedemptionId}`,
            loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
            tx,
          });

          if (reservation.expiresAt) {
            await enqueueOutboxJobFromProgramTransaction({
              storeId,
              jobType: "REDEMPTION_RECOVERY",
              payload: {
                redemptionId: effectiveRedemptionId,
                accountId,
                rewardDefinitionId: provisioningSnapshot.rewardDefinitionId,
                pointsCost: reservation.effectivePointsCost.toString(),
                shopifyDiscountCode: effectiveCode,
                attemptCount: 0,
                sagaPhase: "expiry",
              },
              scheduledFor: reservation.expiresAt,
              idempotencyKey: `redemption_expiry:${effectiveRedemptionId}`,
              loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
              tx,
            });
          }

          return shopifyResult;
        },
      });
    } while (retryAfterCollision);
  } catch (phase2Error: any) {
    // ========================================================================
    // PHASE 4: Compensating Rollback on Terminal Failure
    // ========================================================================
    const failureReason = phase2Error?.message || String(phase2Error);

    if (
      isLoyaltyMaintenanceBlockedError(phase2Error) ||
      phase2Error instanceof RewardCommunicationOriginBlockedError
    ) {
      // Maintenance deferral is observationally read-only: preserve the exact
      // ambiguity metadata and reservation for the owner or a post-lease retry.
      throw phase2Error;
    }

    if (remoteProvisionPreparationId && !remoteCreateStarted) {
      const preparationId = remoteProvisionPreparationId;
      await withLoyaltyProgramRowLock({
        storeId,
        mode: "lock_only",
        timeoutMs: GENERIC_DISCOUNT_PROGRAM_LOCK_TIMEOUT_MS,
        operation: async (tx) => {
          const current = await tx.weleticRewardRedemption.findUnique({
            where: { id: effectiveRedemptionId },
            select: {
              storeId: true,
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
            current.status !== WeleticRedemptionStatus.provisioning ||
            current.shopifyDiscountCodeCanonical !==
              canonicalizeLoyaltyDiscountCode(effectiveCode) ||
            current.settlementQuarantinedAt ||
            !clearedMetadata
          ) {
            return;
          }
          const cleared = await tx.weleticRewardRedemption.updateMany({
            where: {
              id: effectiveRedemptionId,
              storeId,
              status: WeleticRedemptionStatus.provisioning,
              shopifyDiscountCodeCanonical:
                canonicalizeLoyaltyDiscountCode(effectiveCode),
              settlementQuarantinedAt: null,
            },
            data: { metadata: clearedMetadata },
          });
          if (cleared.count === 1) {
            effectiveDiscountMetadata = clearedMetadata;
          }
        },
      });
    }

    const definitelyTerminalShopifyFailure =
      phase2Error instanceof ShopifyDiscountError &&
      phase2Error.code !== "NETWORK_ERROR" &&
      phase2Error.code !== "REMOTE_OUTCOME_UNKNOWN";
    if (
      hadPriorRemoteProvisionAttempt ||
      (remoteCreateStarted && !definitelyTerminalShopifyFailure)
    ) {
      // The request may have committed in Shopify before the transport failed.
      // Keep the points debit reserved and let the durable recovery job decide
      // found-vs-absent after the bounded visibility horizon. Refunding here
      // could give the customer both restored points and a live voucher.
      return {
        success: false,
        redemptionId: effectiveRedemptionId,
        discountCode: effectiveCode,
        status: WeleticRedemptionStatus.provisioning,
        pointsSpent: reservation.effectivePointsCost,
        error: failureReason,
        compensated: false,
      };
    }

    await compensateDiscountSaga({
      redemptionId: effectiveRedemptionId,
      reason: `Shopify GraphQL provisioning failed: ${failureReason}`,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    });

    return {
      success: false,
      redemptionId: effectiveRedemptionId,
      discountCode: effectiveCode,
      status: WeleticRedemptionStatus.failed,
      pointsSpent: reservation.effectivePointsCost,
      error: failureReason,
      compensated: true,
    };
  }

  if (terminalStatus) {
    return {
      success: false,
      redemptionId: effectiveRedemptionId,
      discountCode: effectiveCode,
      shopifyDiscountId: shopifyResult?.id || null,
      status: terminalStatus,
      pointsSpent: reservation.effectivePointsCost,
      balanceAfter: reservation.balanceAfter,
      error: `Redemption became terminal (${terminalStatus}) before Shopify finalization`,
      compensated: true,
    };
  }

  return {
    success: true,
    redemptionId: effectiveRedemptionId,
    discountCode: effectiveCode,
    shopifyDiscountId: shopifyResult?.id || null,
    status: finalStatus,
    pointsSpent: reservation.effectivePointsCost,
    balanceAfter: reservation.balanceAfter,
  };
}

/**
 * Compensates a failed discount saga by restoring points to the customer ledger
 * and marking the redemption as 'failed'.
 *
 * The caller must hold the owning customer's settlement lock. Provisioning,
 * recovery/outbox handlers, and reverse discount sync all enter through that
 * lock before calling this transaction so customer redaction cannot interleave
 * between the account-state check and the compensating ledger append.
 */
type CompensateDiscountSagaParams = {
  redemptionId: string;
  reason: string;
  targetStatus?: WeleticRedemptionStatus;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
};

async function compensateDiscountSagaInternal(
  params: CompensateDiscountSagaParams,
  programTransaction: boolean,
): Promise<void> {
  const {
    redemptionId,
    reason,
    targetStatus = WeleticRedemptionStatus.failed,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    tx: transactionClient,
  } = params;

  const compensate = async (tx: Prisma.TransactionClient) => {
    const redemption = await tx.weleticRewardRedemption.findUnique({
      where: { id: redemptionId },
    });

    if (!redemption) {
      return;
    }
    if (expectedInstallationGeneration !== undefined) {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: redemption.storeId,
        action: "discount_webhook_compensation",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
    }
    const expectedCanonicalCode = canonicalizeLoyaltyDiscountCode(
      redemption.shopifyDiscountCode,
    );
    if (
      redemption.settlementQuarantinedAt != null ||
      (redemption.shopifyDiscountCodeCanonical != null &&
        redemption.shopifyDiscountCodeCanonical !== expectedCanonicalCode)
    ) {
      throw new Error(
        `Cannot automatically compensate quarantined redemption ${redemption.id}; exact Shopify identity reconciliation is required`,
      );
    }

    assertAccountBackedReward(redemption);
    const account = await tx.weleticLoyaltyAccount.findFirst({
      where: { id: redemption.accountId, storeId: redemption.storeId },
      select: { status: true, metadata: true },
    });
    if (!account) {
      throw new Error(
        `Cannot compensate redemption ${redemption.id}; owning loyalty account is unavailable`,
      );
    }
    const customerContextAvailable =
      account.status === "active" &&
      !hasShopifyCustomerRedactionTombstone(account.metadata);

    if (redemption.status === WeleticRedemptionStatus.used) {
      throw new Error(
        `Cannot compensate used redemption ${redemption.id}; investigate the linked order instead`,
      );
    }

    if (
      redemption.status === WeleticRedemptionStatus.cancelled ||
      redemption.status === WeleticRedemptionStatus.expired ||
      redemption.status === WeleticRedemptionStatus.failed
    ) {
      return;
    }

    // Claim the transition before refunding so an order-paid webhook cannot race
    // an expiry/cancellation into both `used` and compensated states.
    const transition = await tx.weleticRewardRedemption.updateMany({
      where: {
        id: redemptionId,
        storeId: redemption.storeId,
        accountId: redemption.accountId,
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        shopifyDiscountCodeCanonical: expectedCanonicalCode,
        settlementQuarantinedAt: null,
        status: {
          in: [
            WeleticRedemptionStatus.provisioning,
            WeleticRedemptionStatus.issued,
            WeleticRedemptionStatus.active,
          ],
        },
      },
      data: {
        status: targetStatus,
        compensationReason: reason,
        ...(targetStatus === WeleticRedemptionStatus.cancelled
          ? {
              metadata: mergeRedemptionMetadataTimestamp(
                redemption.metadata,
                "cancelledAt",
                new Date(),
              ),
            }
          : {}),
      },
    });

    if (transition.count === 0) {
      const latest = await tx.weleticRewardRedemption.findUnique({
        where: { id: redemptionId },
        select: { status: true },
      });
      if (latest?.status === WeleticRedemptionStatus.used) {
        throw new Error(
          `Cannot compensate used redemption ${redemption.id}; investigate the linked order instead`,
        );
      }
      return;
    }

    // 2. Refund points to customer ledger
    await appendPointsLedgerEntry({
      storeId: redemption.storeId,
      accountId: redemption.accountId,
      entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      pointsDelta: redemption.pointsSpent,
      referenceType: "REDEMPTION_REFUND",
      referenceId: redemption.id,
      idempotencyKey: `saga_compensate:${redemption.id}`,
      reason: customerContextAvailable
        ? `Compensating refund for failed discount voucher (${reason})`
        : "Loyalty redemption compensation after account closure.",
      metadata: customerContextAvailable
        ? {
            redemptionId: redemption.id,
            discountCode: redemption.shopifyDiscountCode,
            failedReason: reason,
          }
        : { redemptionId: redemption.id },
      tx,
    });

    // 3. Enqueue Customer Metafield sync to restore points balance in storefront
    if (customerContextAvailable) {
      const enqueueMetafieldSync = programTransaction
        ? enqueueOutboxJobFromProgramTransaction
        : enqueueOutboxJob;
      await enqueueMetafieldSync({
        storeId: redemption.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: redemption.accountId,
          triggerReason: "saga_compensation_refund",
        },
        idempotencyKey: `metafield_sync:compensate:${redemption.id}`,
        loyaltyMaintenancePermit,
        tx,
      });
    }

    // A transport failure can occur after Shopify created the discount but
    // before Weletic received the response. Always reconcile/deactivate by
    // deterministic code after a failed provisioning compensation.
    if (targetStatus === WeleticRedemptionStatus.failed) {
      await enqueueOutboxJob({
        storeId: redemption.storeId,
        jobType: "REDEMPTION_RECOVERY",
        payload: {
          redemptionId: redemption.id,
          accountId: redemption.accountId,
          rewardDefinitionId: redemption.rewardDefinitionId,
          pointsCost: redemption.pointsSpent.toString(),
          shopifyDiscountCode: redemption.shopifyDiscountCode,
          attemptCount: 0,
          sagaPhase: "compensating",
        },
        idempotencyKey: `discount_deactivate:${redemption.id}`,
        tx,
      });
    }
  };

  if (transactionClient) {
    await compensate(transactionClient);
    return;
  }
  const identity = await prisma.weleticRewardRedemption.findUnique({
    where: { id: redemptionId },
    select: { storeId: true },
  });
  if (!identity) return;
  await withActiveStoreLoyaltyMutation({
    storeId: identity.storeId,
    action: "discount_saga_compensation",
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    operation: compensate,
  });
}

export async function compensateDiscountSaga(
  params: CompensateDiscountSagaParams,
): Promise<void> {
  return compensateDiscountSagaInternal(params, false);
}

async function compensateDiscountSagaFromProgramTransaction(
  params: CompensateDiscountSagaParams & { tx: Prisma.TransactionClient },
): Promise<void> {
  return compensateDiscountSagaInternal(params, true);
}

type GenericProvisioningRecoveryRedemption = {
  id: string;
  storeId: string;
  accountId: string;
  rewardDefinitionId: string;
  status: WeleticRedemptionStatus;
  pointsSpent: bigint;
  shopifyDiscountCode: string;
  shopifyDiscountId: string | null;
  expiresAt: Date | null;
};

/**
 * Linearizes generic Shopify-discount adoption with the merchant's durable
 * program fence. Existing/live bookkeeping and cleanup only require the row
 * lock; provisioning -> issued requires the same locked row to remain active.
 */
export async function reconcileGenericProvisioningDiscount({
  redemption,
  remoteDiscount,
  accountIsActive,
  configurationMatches,
  shopDomain,
  accessToken,
  customFetch,
  expectedCurrencyVerifiedAt,
  loyaltyMaintenancePermit,
}: {
  redemption: GenericProvisioningRecoveryRedemption;
  remoteDiscount: ShopifyDiscountResult;
  accountIsActive: boolean;
  configurationMatches: boolean;
  shopDomain: string;
  accessToken: string;
  customFetch?: typeof fetch;
  expectedCurrencyVerifiedAt?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<"healed" | "compensated"> {
  return withLoyaltyProgramRowLock({
    storeId: redemption.storeId,
    mode: "lock_only",
    timeoutMs: GENERIC_DISCOUNT_PROGRAM_LOCK_TIMEOUT_MS,
    operation: async (tx, program) => {
      const latest = await tx.weleticRewardRedemption.findUnique({
        where: { id: redemption.id },
      });
      if (
        !latest ||
        latest.storeId !== redemption.storeId ||
        latest.accountId !== redemption.accountId ||
        latest.rewardDefinitionId !== redemption.rewardDefinitionId
      ) {
        throw new Error(
          `Redemption ${redemption.id} changed tenant or ownership during recovery.`,
        );
      }
      const expectedCanonicalCode = canonicalizeLoyaltyDiscountCode(
        redemption.shopifyDiscountCode,
      );
      if (
        latest.shopifyDiscountCode !== redemption.shopifyDiscountCode ||
        (latest.shopifyDiscountCodeCanonical != null &&
          latest.shopifyDiscountCodeCanonical !== expectedCanonicalCode) ||
        latest.settlementQuarantinedAt != null ||
        (latest.shopifyDiscountId != null &&
          latest.shopifyDiscountId !== remoteDiscount.id)
      ) {
        throw new Error(
          `Redemption ${redemption.id} changed or quarantined its canonical Shopify identity during recovery.`,
        );
      }
      const canonicalWriteFence = {
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        shopifyDiscountCodeCanonical: expectedCanonicalCode,
        settlementQuarantinedAt: null,
      } as const;
      const remoteAlreadyInactive = isInactiveShopifyDiscountStatus(
        remoteDiscount.status,
      );

      if (
        latest.status === WeleticRedemptionStatus.issued ||
        latest.status === WeleticRedemptionStatus.active ||
        latest.status === WeleticRedemptionStatus.used
      ) {
        if (remoteAlreadyInactive) {
          throw new Error(
            `Live redemption ${redemption.id} points to an inactive Shopify discount; manual reconciliation is required.`,
          );
        }
        if (!latest.shopifyDiscountId) {
          assertLoyaltyMaintenanceWriteAllowed({
            storeId: redemption.storeId,
            metadata: program.metadata,
            permit: loyaltyMaintenancePermit,
          });
          await tx.weleticRewardRedemption.updateMany({
            where: {
              id: redemption.id,
              storeId: redemption.storeId,
              accountId: redemption.accountId,
              status: latest.status,
              shopifyDiscountId: null,
              ...canonicalWriteFence,
            },
            data: { shopifyDiscountId: remoteDiscount.id },
          });
        }
        return "healed";
      }

      if (
        latest.status === WeleticRedemptionStatus.failed ||
        latest.status === WeleticRedemptionStatus.cancelled ||
        latest.status === WeleticRedemptionStatus.expired
      ) {
        await tx.weleticRewardRedemption.updateMany({
          where: {
            id: redemption.id,
            storeId: redemption.storeId,
            accountId: redemption.accountId,
            status: latest.status,
            shopifyDiscountId: null,
            ...canonicalWriteFence,
          },
          data: { shopifyDiscountId: remoteDiscount.id },
        });
        if (!remoteAlreadyInactive) {
          const deactivated = await deactivateDiscount(
            shopDomain,
            accessToken,
            remoteDiscount.id,
            customFetch,
          );
          if (!deactivated) {
            throw new Error(
              `Shopify did not confirm deactivation of terminal loyalty discount ${remoteDiscount.id}.`,
            );
          }
        }
        return "compensated";
      }

      if (latest.status !== WeleticRedemptionStatus.provisioning) {
        throw new Error(
          `Redemption ${redemption.id} entered unsupported recovery status ${latest.status}.`,
        );
      }

      let cleanupReason: string | null = null;
      const currentStore = await tx.weleticShopifyStore.findUnique({
        where: { id: redemption.storeId },
        select: { currencyVerifiedAt: true },
      });
      if (accountIsActive && !remoteAlreadyInactive && configurationMatches) {
        assertLoyaltyMaintenanceWriteAllowed({
          storeId: redemption.storeId,
          metadata: program.metadata,
          permit: loyaltyMaintenancePermit,
        });
      }
      if (!accountIsActive) {
        cleanupReason = "Recovery cancelled after loyalty account closure.";
      } else if (remoteAlreadyInactive) {
        cleanupReason =
          "Recovery cancelled because the owned Shopify discount is already inactive.";
      } else if (!configurationMatches) {
        cleanupReason =
          "Shopify discount no longer matched its immutable Weletic configuration.";
      } else if (
        !isLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit)
      ) {
        cleanupReason =
          "Recovery cancelled because the loyalty program was disabled before voucher adoption.";
      } else if (
        expectedCurrencyVerifiedAt === undefined ||
        currentStore?.currencyVerifiedAt?.toISOString() !==
          expectedCurrencyVerifiedAt
      ) {
        cleanupReason =
          "Recovery cancelled because the Shopify currency generation changed before voucher adoption.";
      }

      if (cleanupReason) {
        const persistedRemote = await tx.weleticRewardRedemption.updateMany({
          where: {
            id: redemption.id,
            storeId: redemption.storeId,
            accountId: redemption.accountId,
            status: WeleticRedemptionStatus.provisioning,
            ...canonicalWriteFence,
          },
          data: { shopifyDiscountId: remoteDiscount.id },
        });
        if (persistedRemote.count !== 1) {
          throw new Error(
            `Redemption ${redemption.id} changed state before remote cleanup.`,
          );
        }
        if (!remoteAlreadyInactive) {
          const deactivated = await deactivateDiscount(
            shopDomain,
            accessToken,
            remoteDiscount.id,
            customFetch,
          );
          if (!deactivated) {
            throw new Error(
              `Shopify did not confirm deactivation of loyalty discount ${remoteDiscount.id}.`,
            );
          }
        }
        await compensateDiscountSagaFromProgramTransaction({
          redemptionId: redemption.id,
          reason: cleanupReason,
          loyaltyMaintenancePermit,
          tx,
        });
        return "compensated";
      }

      // The lock-only mode above lets terminal/live idempotency and cleanup run
      // during a kill switch. Adoption itself still asserts the active
      // generation while holding that exact same program row.
      assertLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit);
      const communicationOrigin = await assertRewardCommunicationOrigin({
        tx,
        storeId: redemption.storeId,
        accountId: redemption.accountId,
        redemptionId: redemption.id,
        metadata: latest.metadata,
        loyaltyMaintenancePermit,
      });
      const healed = await tx.weleticRewardRedemption.updateMany({
        where: {
          id: redemption.id,
          storeId: redemption.storeId,
          accountId: redemption.accountId,
          status: WeleticRedemptionStatus.provisioning,
          ...canonicalWriteFence,
        },
        data: {
          status: WeleticRedemptionStatus.issued,
          shopifyDiscountId: remoteDiscount.id,
        },
      });
      if (healed.count !== 1) {
        throw new Error(
          `Redemption ${redemption.id} changed state before voucher adoption.`,
        );
      }

      const provisioningSnapshot = readLoyaltyRedemptionProvisioningSnapshot(
        latest.metadata,
      );
      if (!provisioningSnapshot) {
        throw new Error(
          `Redemption ${redemption.id} is missing its immutable reward snapshot.`,
        );
      }
      if (communicationOrigin) {
        await enqueueRewardRedeemedCommunication({
          tx,
          storeId: redemption.storeId,
          accountId: redemption.accountId,
          expectedInstallationGeneration:
            communicationOrigin.installationGeneration,
          receipt: {
            transitioned: true,
            redemptionId: redemption.id,
            occurredAt: new Date(),
          },
          loyaltyMaintenancePermit,
        });
      }
      await enqueueFlowTriggerJob({
        storeId: redemption.storeId,
        eventId: redemption.id,
        payload: {
          accountId: redemption.accountId,
          handle: "weletic-reward-redeemed",
          rewardType: provisioningSnapshot.rewardType,
          discountCode: redemption.shopifyDiscountCode,
          pointsSpent: redemption.pointsSpent.toString(),
        },
        loyaltyMaintenancePermit,
        tx,
      });

      await enqueueOutboxJobFromProgramTransaction({
        storeId: redemption.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: redemption.accountId,
          triggerReason: "recovery_finalized_issued",
        },
        idempotencyKey: `metafield_sync:heal:${redemption.id}`,
        loyaltyMaintenancePermit,
        tx,
      });
      if (redemption.expiresAt) {
        await enqueueOutboxJobFromProgramTransaction({
          storeId: redemption.storeId,
          jobType: "REDEMPTION_RECOVERY",
          payload: {
            redemptionId: redemption.id,
            accountId: redemption.accountId,
            rewardDefinitionId: redemption.rewardDefinitionId,
            pointsCost: redemption.pointsSpent.toString(),
            shopifyDiscountCode: redemption.shopifyDiscountCode,
            attemptCount: 0,
            sagaPhase: "expiry",
          },
          scheduledFor: redemption.expiresAt,
          idempotencyKey: `redemption_expiry:${redemption.id}`,
          loyaltyMaintenancePermit,
          tx,
        });
      }
      return "healed";
    },
  });
}

/**
 * Sweeps redemptions stuck in 'provisioning' status (> olderThanMinutes) and
 * reconciles against Shopify live GraphQL state (Healing to 'issued' or Compensating to 'failed').
 */
export async function sweepStuckSagaRedemptions(
  params: {
    olderThanMinutes?: number;
    storeId?: string;
    customFetch?: typeof fetch;
    loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  } = {},
): Promise<{
  checked: number;
  healed: number;
  compensated: number;
  errors: number;
}> {
  const {
    olderThanMinutes = 2,
    storeId,
    customFetch,
    loyaltyMaintenancePermit,
  } = params;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const stuckRedemptions = await prisma.weleticRewardRedemption.findMany({
    where: {
      accountId: { not: null },
      fulfillmentSource: null,
      status: WeleticRedemptionStatus.provisioning,
      createdAt: { lt: cutoff },
      ...(storeId ? { storeId } : {}),
    },
    take: 50,
  });

  let healed = 0;
  let compensated = 0;
  let errors = 0;

  for (const redemption of stuckRedemptions) {
    try {
      assertAccountBackedReward(redemption);
      const metadata =
        redemption.metadata &&
        typeof redemption.metadata === "object" &&
        !Array.isArray(redemption.metadata)
          ? (redemption.metadata as Record<string, unknown>)
          : {};
      const looksLikeReferralCoupon =
        redemption.shopifyDiscountCode.startsWith("WLR-") ||
        "referralId" in metadata ||
        "qualificationOrderId" in metadata ||
        "referralSide" in metadata;
      if (looksLikeReferralCoupon) {
        if (
          typeof metadata.referralId !== "string" ||
          typeof metadata.qualificationOrderId !== "string" ||
          (metadata.referralSide !== "advocate" &&
            metadata.referralSide !== "referee")
        ) {
          throw new Error(
            `Referral coupon ${redemption.id} has invalid recovery metadata.`,
          );
        }
        const expectedIdempotencyKey = getReferralCouponIdempotencyKey({
          referralId: metadata.referralId,
          qualificationOrderId: metadata.qualificationOrderId,
          side: metadata.referralSide,
        });
        if (redemption.idempotencyKey !== expectedIdempotencyKey) {
          throw new Error(
            `Referral coupon ${redemption.id} has a mismatched generation identity.`,
          );
        }

        // Never heal referral coupons through a code-only lookup. Their
        // dedicated workflow verifies store, account, reward configuration,
        // generation, side, code, and remote title ownership together. Keep
        // the active-account recheck and the complete remote workflow under
        // the same lock used by customer redaction.
        const recoveryAttempt = await withLockedLoyaltyAccount({
          storeId: redemption.storeId,
          accountId: redemption.accountId,
          fn: async (account) => {
            if (
              account.status !== "active" ||
              hasShopifyCustomerRedactionTombstone(account.metadata)
            ) {
              if (redemption.pointsSpent > BigInt(0)) {
                await compensateDiscountSaga({
                  redemptionId: redemption.id,
                  reason:
                    "Referral coupon recovery cancelled after loyalty account closure.",
                  loyaltyMaintenancePermit,
                });
              } else {
                await prisma.weleticRewardRedemption.updateMany({
                  where: {
                    id: redemption.id,
                    storeId: redemption.storeId,
                    accountId: redemption.accountId,
                    status: WeleticRedemptionStatus.provisioning,
                  },
                  data: { status: WeleticRedemptionStatus.cancelled },
                });
              }
              const compensatedRedemption =
                await prisma.weleticRewardRedemption.findUnique({
                  where: { id: redemption.id },
                });
              if (compensatedRedemption) {
                await recoverCompensatedReferralCouponDiscount({
                  storeId: redemption.storeId,
                  redemption: compensatedRedemption,
                });
              }
              return "cancelled" as const;
            }

            await issueReferralRewardCoupon({
              storeId: redemption.storeId,
              referralId: metadata.referralId as string,
              qualificationOrderId: metadata.qualificationOrderId as string,
              accountId: redemption.accountId,
              rewardDefinitionId: redemption.rewardDefinitionId,
              side: metadata.referralSide as "advocate" | "referee",
              loyaltyMaintenancePermit,
            });
            return "attempted" as const;
          },
        });
        if (recoveryAttempt === null) {
          throw new Error(
            `Referral coupon ${redemption.id} no longer has an owning loyalty account.`,
          );
        }
        if (recoveryAttempt === "cancelled") {
          compensated++;
          continue;
        }
        const latest = await prisma.weleticRewardRedemption.findUnique({
          where: { id: redemption.id },
        });
        if (
          !latest ||
          latest.storeId !== redemption.storeId ||
          latest.accountId !== redemption.accountId ||
          latest.rewardDefinitionId !== redemption.rewardDefinitionId
        ) {
          throw new Error(
            `Referral coupon ${redemption.id} changed ownership during recovery.`,
          );
        }
        if (
          latest.status === WeleticRedemptionStatus.issued ||
          latest.status === WeleticRedemptionStatus.active ||
          latest.status === WeleticRedemptionStatus.used
        ) {
          healed++;
          continue;
        }
        if (
          latest.status === WeleticRedemptionStatus.failed ||
          latest.status === WeleticRedemptionStatus.cancelled ||
          latest.status === WeleticRedemptionStatus.expired
        ) {
          compensated++;
          continue;
        }
        throw new Error(
          `Referral coupon ${redemption.id} remains pending after dedicated recovery.`,
        );
      }

      const genericRecovery = await withLockedLoyaltyAccount({
        storeId: redemption.storeId,
        accountId: redemption.accountId,
        fn: async (account) => {
          // A closed account may still need a code lookup and remote cleanup,
          // but it must never transition back to an available local coupon.
          const accountIsActive =
            account.status === "active" &&
            !hasShopifyCustomerRedactionTombstone(account.metadata);
          const creds = await resolveShopifyOfflineCredentials({
            storeId: redemption.storeId,
          });
          const remoteNode = await lookupDiscountByCode(
            creds.shopDomain,
            creds.accessToken,
            redemption.shopifyDiscountCode,
            customFetch,
          );

          if (!remoteNode) {
            assertLoyaltyDiscountLookupMissIsTerminal({
              redemptionId: redemption.id,
              discountCode: redemption.shopifyDiscountCode,
              metadata: redemption.metadata,
            });
          }

          if (remoteNode?.id) {
            // An unverifiable active voucher is a manual-reconciliation case,
            // not evidence that points are safe to restore.
            assertExpectedLoyaltyDiscountNode({
              identity: {
                storeId: redemption.storeId,
                redemptionId: redemption.id,
                accountId: redemption.accountId,
                rewardDefinitionId: redemption.rewardDefinitionId,
                discountCode: redemption.shopifyDiscountCode,
              },
              metadata: redemption.metadata,
              remote: remoteNode,
              requireActive: false,
            });
          }

          if (remoteNode?.id) {
            let configurationMatches = true;
            if (accountIsActive) {
              const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
                redemption.metadata,
              );
              if (!snapshot) {
                throw new Error(
                  `Provisioning redemption ${redemption.id} is missing its immutable Shopify configuration snapshot.`,
                );
              }
              const snapshotExpiresAt = snapshot.expiresAt
                ? new Date(snapshot.expiresAt)
                : null;
              if (
                snapshot.expiresAt !==
                (redemption.expiresAt?.toISOString() ?? null)
              ) {
                throw new Error(
                  `Provisioning redemption ${redemption.id} expiry does not match its immutable Shopify configuration snapshot.`,
                );
              }
              assertProvisioningReplayMatchesSnapshot({
                snapshot,
                storeId: redemption.storeId,
                shopifyCustomerId: account.shopifyCustomerId,
              });
              const rewardDefinition =
                getRewardDefinitionFromProvisioningSnapshot({
                  snapshot,
                  provisioningName: snapshot.name,
                });
              configurationMatches = matchesLoyaltyRewardDiscountConfiguration({
                remote: remoteNode,
                rewardDefinition,
                startsAt: new Date(snapshot.startsAt),
                expiresAt: snapshotExpiresAt,
                expectedShopCurrency: snapshot.shopCurrency,
                shopifyCustomerId: account.shopifyCustomerId,
              });
            }

            // The shared program-row lock makes adoption linearizable with a
            // merchant disable. Closed-account, altered-config, and disabled-
            // program cleanup deliberately remains available under lock-only.
            return reconcileGenericProvisioningDiscount({
              redemption,
              remoteDiscount: remoteNode,
              accountIsActive,
              configurationMatches,
              shopDomain: creds.shopDomain,
              accessToken: creds.accessToken,
              customFetch,
              expectedCurrencyVerifiedAt:
                readLoyaltyRedemptionProvisioningSnapshot(redemption.metadata)
                  ?.currencyVerifiedAt,
              loyaltyMaintenancePermit,
            });
          }

          // Case B: Discount node missing in Shopify -> compensate points.
          await compensateDiscountSaga({
            redemptionId: redemption.id,
            reason:
              "Recovery sweep: Discount code not found in Shopify after provisioning timeout",
            loyaltyMaintenancePermit,
          });
          return "compensated" as const;
        },
      });
      if (genericRecovery === null) {
        throw new Error(
          `Redemption ${redemption.id} no longer has an owning loyalty account.`,
        );
      }
      if (genericRecovery === "healed") healed++;
      else compensated++;
    } catch {
      // An indeterminate Shopify response must be retried. Refunding here could
      // leave both spendable points and a live discount in the shopper's hands.
      errors++;
    }
  }

  return {
    checked: stuckRedemptions.length,
    healed,
    compensated,
    errors,
  };
}
