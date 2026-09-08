import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  appendPointsLedgerEntry,
  OptimisticConcurrencyError,
} from "@/lib/weletic/loyalty/ledger";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { canonicalizeLoyaltyDiscountCode } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { getReferralCouponIdempotencyKey } from "@/lib/weletic/loyalty/referral-coupon";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { matchesShopifyCustomerPrivacyTombstoneOwner } from "@/lib/weletic/shopify/privacy-identity";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
} from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { assertAccountBackedReward } from "./reward-ownership";
import { settleShopperCouponUse } from "./shopper-coupon-settlement";

const COMPENSATED_STATUSES = new Set<WeleticRedemptionStatus>([
  WeleticRedemptionStatus.cancelled,
  WeleticRedemptionStatus.expired,
  WeleticRedemptionStatus.failed,
]);

const SETTLEMENT_SOURCE_STATUSES = new Set<WeleticRedemptionStatus>([
  WeleticRedemptionStatus.provisioning,
  WeleticRedemptionStatus.issued,
  WeleticRedemptionStatus.active,
  ...COMPENSATED_STATUSES,
]);
const SETTLEMENT_TRANSACTION_RETRIES = 5;
const REDEMPTION_SETTLEMENT_AMBIGUITY_ISSUE_KIND =
  "redemption_settlement_ambiguity";

class RedemptionSettlementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedemptionSettlementConflictError";
  }
}

type ClaimedSettlementAccount = {
  id: string;
  privacyRedacted: boolean;
};

async function claimAccountsForRedemptionSettlement({
  tx,
  storeId,
  accountIds,
  shopifyCustomerId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  accountIds: string[];
  shopifyCustomerId?: string | null;
}): Promise<Map<string, ClaimedSettlementAccount>> {
  const sortedAccountIds = [...new Set(accountIds)].sort();
  const accounts = await tx.weleticLoyaltyAccount.findMany({
    where: {
      id: { in: sortedAccountIds },
      storeId,
    },
    select: {
      id: true,
      status: true,
      metadata: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  if (accounts.length !== sortedAccountIds.length) {
    throw new RedemptionSettlementConflictError(
      "A loyalty account is unavailable during redemption settlement.",
    );
  }

  // Claim the rows in a deterministic order. A customer redaction either
  // loses its updatedAt CAS and retries after these effects are committed, or
  // wins first and makes this transaction retry against the tombstoned state.
  // Using database rows avoids nesting another customer lock inside the one
  // already held by orders-paid, which could deadlock opposite referral sides.
  const claimedAt = new Date();
  for (const account of accounts) {
    const claimed = await tx.weleticLoyaltyAccount.updateMany({
      where: {
        id: account.id,
        storeId,
        status: account.status,
        updatedAt: account.updatedAt,
      },
      data: { updatedAt: claimedAt },
    });
    if (claimed.count !== 1) {
      throw new RedemptionSettlementConflictError(
        `Loyalty account ${account.id} changed during redemption settlement.`,
      );
    }
  }

  const incomingCustomerId = normalizeShopifyCustomerId(
    shopifyCustomerId ?? null,
  );
  const classifiedAccounts = await Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      privacyRedacted:
        account.status === "closed" ||
        hasShopifyCustomerRedactionTombstone(account.metadata) ||
        Boolean(
          incomingCustomerId &&
            (await matchesShopifyCustomerPrivacyTombstoneOwner({
              storeId,
              shopifyCustomerId: incomingCustomerId,
              accountId: account.id,
              tx,
            })),
        ),
    })),
  );
  return new Map(classifiedAccounts.map((account) => [account.id, account]));
}

function getLateUseLedgerContext({
  privacyRedacted,
  referralId,
  redemptionId,
  qualificationOrderId,
}: {
  privacyRedacted: boolean;
  referralId: string;
  redemptionId: string;
  qualificationOrderId: string | null;
}) {
  return privacyRedacted
    ? {
        reason: "Referral reward financial correction after customer redaction",
        metadata: null,
      }
    : {
        reason:
          "Referral reward reversed after an older refunded coupon was used",
        metadata: {
          referralId,
          lateCouponRedemptionId: redemptionId,
          qualificationOrderId,
        },
      };
}

function isRetryableSettlementError(error: unknown): boolean {
  return (
    error instanceof OptimisticConcurrencyError ||
    error instanceof RedemptionSettlementConflictError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code))
  );
}

async function runSerializableSettlementTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= SETTLEMENT_TRANSACTION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        attempt === SETTLEMENT_TRANSACTION_RETRIES ||
        !isRetryableSettlementError(error)
      ) {
        throw error;
      }
    }
  }

  throw new Error("Redemption settlement retry budget exhausted.");
}

function mergeRedemptionMetadata(
  existing: Prisma.JsonValue,
  orderMetadata?: Record<string, unknown>,
): Prisma.InputJsonValue | undefined {
  if (!orderMetadata) return undefined;

  const existingRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};

  return {
    ...existingRecord,
    ...orderMetadata,
  } as Prisma.InputJsonObject;
}

function normalizeShopifyCustomerId(customerId: string | null) {
  const normalized = customerId?.trim() || "";
  return normalized.replace(/^gid:\/\/shopify\/Customer\//i, "");
}

async function retainSettlementReconciliationIssue({
  tx,
  storeId,
  orderId,
  discountCode,
  reason,
  candidateCount,
  candidateRedemptionIds,
  candidateAccountIds,
  orderCustomerIdPresent,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  orderId: string;
  discountCode: string;
  reason:
    | "redemption_code_cardinality_mismatch"
    | "missing_order_customer"
    | "redemption_customer_mismatch"
    | `shopper_coupon_${string}`;
  candidateCount: number;
  candidateRedemptionIds: string[];
  candidateAccountIds: string[];
  orderCustomerIdPresent: boolean;
}) {
  const detectedAt = new Date();
  const externalKey = `${orderId}:${discountCode}`;
  const details = {
    orderId,
    discountCode,
    reason,
    candidateCount,
    candidateRedemptionIds: [...candidateRedemptionIds].sort(),
    candidateAccountIds: [...new Set(candidateAccountIds)].sort(),
    orderCustomerIdPresent,
    resolutionMarker: "manual_redemption_settlement_required",
  } satisfies Prisma.InputJsonObject;

  await tx.weleticReconciliationIssue.upsert({
    where: {
      storeId_kind_externalKey: {
        storeId,
        kind: REDEMPTION_SETTLEMENT_AMBIGUITY_ISSUE_KIND,
        externalKey,
      },
    },
    create: {
      id: createWeleticId("wrecon_"),
      storeId,
      externalKey,
      kind: REDEMPTION_SETTLEMENT_AMBIGUITY_ISSUE_KIND,
      severity: "critical",
      status: "open",
      details,
      detectedAt,
    },
    update: {
      severity: "critical",
      status: "open",
      details,
      detectedAt,
      resolvedAt: null,
    },
  });
}

export async function settleRewardRedemptionsUsedByOrder(params: {
  storeId: string;
  discountCodes: string[];
  orderId: string;
  shopifyCustomerId: string | null;
  usedAt: Date;
  orderMetadata?: Record<string, unknown>;
  orderDiscountEvidence?: unknown;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const discountCodes = Array.from(
    new Set(
      params.discountCodes
        .map((code) => code.trim())
        .filter(Boolean)
        .map(canonicalizeLoyaltyDiscountCode),
    ),
  );
  if (discountCodes.length === 0) {
    return { matched: 0, markedUsed: 0, lateUseCorrections: 0 };
  }

  const redemptions = await prisma.weleticRewardRedemption.findMany({
    where: {
      storeId: params.storeId,
      shopifyDiscountCodeCanonical: { in: discountCodes },
      OR: [
        {
          accountId: { not: null },
          settlementQuarantinedAt: null,
          status: { not: WeleticRedemptionStatus.used },
        },
        { accountId: null },
      ],
      status: {
        in: [
          WeleticRedemptionStatus.provisioning,
          WeleticRedemptionStatus.issued,
          WeleticRedemptionStatus.active,
          WeleticRedemptionStatus.cancelled,
          WeleticRedemptionStatus.expired,
          WeleticRedemptionStatus.failed,
          WeleticRedemptionStatus.used,
        ],
      },
    },
  });

  let markedUsed = 0;
  let lateUseCorrections = 0;
  const redemptionGroups = new Map<string, typeof redemptions>();
  for (const redemption of redemptions) {
    const discountCode = canonicalizeLoyaltyDiscountCode(
      redemption.shopifyDiscountCode,
    );
    const group = redemptionGroups.get(discountCode) || [];
    group.push(redemption);
    redemptionGroups.set(discountCode, group);
  }

  for (const [discountCode, discoveredRedemptions] of redemptionGroups) {
    const quarantineScope = discoveredRedemptions.some(
      ({ accountId }) => accountId === null,
    )
      ? {}
      : { settlementQuarantinedAt: null };
    const corrected = await runSerializableSettlementTransaction(async (tx) => {
      const settlementStore =
        await assertShopifyStoreMatchesInstallationGeneration({
          storeId: params.storeId,
          action: "redemption_order_settlement",
          expectedInstallationGeneration: params.expectedInstallationGeneration,
          tx,
        });
      const allowsOperationalFollowups =
        settlementStore?.complianceState === "active";
      if (allowsOperationalFollowups) {
        await assertShopifyStoreAcceptsOperationalWrites({
          storeId: params.storeId,
          action: "redemption_order_settlement",
          expectedInstallationGeneration: params.expectedInstallationGeneration,
          loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
          tx,
        });
      }
      // The discovery read only avoids opening transactions for unrelated
      // merchant discount codes. Cardinality is rechecked under SERIALIZABLE
      // isolation before any financial mutation so migrated duplicates or a
      // concurrent insert can never settle more than one local redemption.
      const candidateCount = await tx.weleticRewardRedemption.count({
        where: {
          storeId: params.storeId,
          shopifyDiscountCodeCanonical: discountCode,
          ...quarantineScope,
        },
      });
      if (candidateCount !== 1) {
        await retainSettlementReconciliationIssue({
          tx,
          storeId: params.storeId,
          orderId: params.orderId,
          discountCode,
          reason: "redemption_code_cardinality_mismatch",
          candidateCount,
          candidateRedemptionIds: discoveredRedemptions.map(({ id }) => id),
          candidateAccountIds: discoveredRedemptions
            .map(({ accountId }) => accountId)
            .filter((id): id is string => id !== null),
          orderCustomerIdPresent: Boolean(
            normalizeShopifyCustomerId(params.shopifyCustomerId),
          ),
        });
        return { marked: false, corrected: false };
      }

      // Re-read the sole code owner inside the same transaction instead of
      // trusting the discovery snapshot. This preserves provisioner metadata
      // and makes refund/settlement interleavings retry from fresh state.
      const redemption = await tx.weleticRewardRedemption.findFirst({
        where: {
          storeId: params.storeId,
          shopifyDiscountCodeCanonical: discountCode,
          ...quarantineScope,
        },
      });
      if (!redemption) {
        throw new RedemptionSettlementConflictError(
          `Redemption code ${discountCode} changed during order settlement.`,
        );
      }
      if (redemption.accountId === null) {
        const result = await settleShopperCouponUse({
          tx,
          redemption,
          installationGeneration:
            settlementStore?.installationGeneration ?? null,
          orderId: params.orderId,
          shopifyCustomerId: params.shopifyCustomerId,
          usedAt: params.usedAt,
          orderDiscountEvidence: params.orderDiscountEvidence,
        });
        if (result.issue)
          await retainSettlementReconciliationIssue({
            tx,
            storeId: params.storeId,
            orderId: /^(?:gid:\/\/shopify\/Order\/)?[1-9]\d{0,29}$/.test(
              params.orderId,
            )
              ? params.orderId.replace("gid://shopify/Order/", "")
              : `unverified:${createHash("sha256").update(params.orderId).digest("hex")}`,
            discountCode,
            reason: result.issue,
            candidateCount,
            candidateRedemptionIds: [redemption.id],
            candidateAccountIds: [],
            orderCustomerIdPresent: Boolean(params.shopifyCustomerId),
          });
        return result;
      }
      if (
        redemption.settlementQuarantinedAt ||
        !SETTLEMENT_SOURCE_STATUSES.has(redemption.status)
      ) {
        return { marked: false, corrected: false };
      }
      assertAccountBackedReward(redemption);

      const orderShopifyCustomerId = normalizeShopifyCustomerId(
        params.shopifyCustomerId,
      );
      const redemptionOwner = await tx.weleticLoyaltyAccount.findFirst({
        where: { id: redemption.accountId, storeId: params.storeId },
        select: {
          id: true,
          shopper: { select: { id: true, shopifyCustomerId: true } },
        },
      });
      const redemptionShopifyCustomerId = normalizeShopifyCustomerId(
        redemptionOwner?.shopper.shopifyCustomerId || null,
      );
      const pseudonymousOwnerMatches =
        Boolean(orderShopifyCustomerId && redemptionOwner) &&
        orderShopifyCustomerId !== redemptionShopifyCustomerId
          ? await matchesShopifyCustomerPrivacyTombstoneOwner({
              storeId: params.storeId,
              shopifyCustomerId: orderShopifyCustomerId,
              shopperId: redemptionOwner?.shopper.id,
              accountId: redemptionOwner?.id,
              tx,
            })
          : false;
      if (
        !orderShopifyCustomerId ||
        !redemptionShopifyCustomerId ||
        (orderShopifyCustomerId !== redemptionShopifyCustomerId &&
          !pseudonymousOwnerMatches)
      ) {
        await retainSettlementReconciliationIssue({
          tx,
          storeId: params.storeId,
          orderId: params.orderId,
          discountCode,
          reason: orderShopifyCustomerId
            ? "redemption_customer_mismatch"
            : "missing_order_customer",
          candidateCount,
          candidateRedemptionIds: [redemption.id],
          candidateAccountIds: [redemption.accountId],
          orderCustomerIdPresent: Boolean(orderShopifyCustomerId),
        });
        return { marked: false, corrected: false };
      }

      const wasCompensated = COMPENSATED_STATUSES.has(redemption.status);
      const redemptionMetadata =
        redemption.metadata &&
        typeof redemption.metadata === "object" &&
        !Array.isArray(redemption.metadata)
          ? (redemption.metadata as Record<string, unknown>)
          : {};
      const referralIdentity =
        wasCompensated &&
        typeof redemptionMetadata.referralId === "string" &&
        typeof redemptionMetadata.qualificationOrderId === "string" &&
        (redemptionMetadata.referralSide === "advocate" ||
          redemptionMetadata.referralSide === "referee")
          ? {
              referralId: redemptionMetadata.referralId,
              qualificationOrderId: redemptionMetadata.qualificationOrderId,
              referralSide: redemptionMetadata.referralSide,
            }
          : null;
      const referral = referralIdentity
        ? await tx.weleticLoyaltyReferral.findFirst({
            where: {
              id: referralIdentity.referralId,
              storeId: params.storeId,
              status: {
                in: [
                  WeleticLoyaltyReferralStatus.pending,
                  WeleticLoyaltyReferralStatus.qualified,
                  WeleticLoyaltyReferralStatus.rewarded,
                ],
              },
            },
          })
        : null;
      const claimedAccounts = await claimAccountsForRedemptionSettlement({
        tx,
        storeId: params.storeId,
        shopifyCustomerId: params.shopifyCustomerId,
        accountIds: [
          redemption.accountId,
          ...(referral
            ? [referral.advocateAccountId, referral.refereeAccountId]
            : []),
        ].filter((accountId): accountId is string => Boolean(accountId)),
      });
      const privacyRedactedAccountIds = new Set(
        [...claimedAccounts.values()]
          .filter((account) => account.privacyRedacted)
          .map((account) => account.id),
      );
      const redemptionOwnerPrivacyRedacted = privacyRedactedAccountIds.has(
        redemption.accountId,
      );
      const transition = await tx.weleticRewardRedemption.updateMany({
        where: {
          id: redemption.id,
          storeId: params.storeId,
          status: redemption.status,
        },
        data: {
          status: WeleticRedemptionStatus.used,
          usedAt: params.usedAt,
          orderId: params.orderId,
          metadata: mergeRedemptionMetadata(
            redemption.metadata,
            redemptionOwnerPrivacyRedacted ? undefined : params.orderMetadata,
          ),
        },
      });
      if (transition.count !== 1) {
        throw new RedemptionSettlementConflictError(
          `Redemption ${redemption.id} changed during order settlement.`,
        );
      }

      if (wasCompensated && redemption.pointsSpent > BigInt(0)) {
        // The original REDEEM_REWARD debit already contributes to lifetime
        // redeemed. Re-debit the compensating credit as an adjustment so the
        // lifetime metric is not counted twice.
        await appendPointsLedgerEntry({
          storeId: params.storeId,
          accountId: redemption.accountId,
          entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
          pointsDelta: -redemption.pointsSpent,
          referenceType: "REDEMPTION_LATE_USE",
          referenceId: redemption.id,
          idempotencyKey: `redemption_late_use:${redemption.id}`,
          reason: redemptionOwnerPrivacyRedacted
            ? "Compensated reward financial correction after customer redaction"
            : `Shopify reported compensated voucher ${redemption.shopifyDiscountCode} as used`,
          metadata: redemptionOwnerPrivacyRedacted
            ? null
            : {
                redemptionId: redemption.id,
                orderId: params.orderId,
                priorStatus: redemption.status,
              },
          tx,
        });
      }

      if (referralIdentity && referral) {
        const hasPrivacyRedactedParticipant =
          privacyRedactedAccountIds.size > 0;
        const referralMetadata =
          referral.metadata &&
          typeof referral.metadata === "object" &&
          !Array.isArray(referral.metadata)
            ? (referral.metadata as Record<string, unknown>)
            : {};
        const currentQualificationOrderId =
          typeof referralMetadata.qualificationOrderId === "string"
            ? referralMetadata.qualificationOrderId
            : referral.qualifyingOrderId;
        const currentCouponSides = Array.isArray(
          referralMetadata.requiredCouponSides,
        )
          ? referralMetadata.requiredCouponSides.filter(
              (side: unknown): side is "advocate" | "referee" =>
                side === "advocate" || side === "referee",
            )
          : [];
        const hasCurrentReward =
          referral.status === WeleticLoyaltyReferralStatus.qualified ||
          referral.status === WeleticLoyaltyReferralStatus.rewarded;
        const terminalized = await tx.weleticLoyaltyReferral.updateMany({
          where: {
            id: referral.id,
            storeId: params.storeId,
            qualifyingOrderId: referral.qualifyingOrderId,
            status: referral.status,
          },
          data: {
            status: WeleticLoyaltyReferralStatus.cancelled,
            advocatePointsAwarded: BigInt(0),
            refereePointsAwarded: BigInt(0),
            // Redaction closes the account before it scrubs related rows. Do
            // not merge a referral snapshot read during that interval: doing
            // so could restore customer context after the scrub wins first.
            metadata: (hasPrivacyRedactedParticipant
              ? {
                  requalificationBlocked: true,
                  requalificationBlockedReason: "referral_coupon_used",
                  lateCouponUseDetectedAt: params.usedAt.toISOString(),
                  lateCouponUsePrivacyRedacted: true,
                }
              : {
                  ...referralMetadata,
                  requalificationBlocked: true,
                  requalificationBlockedReason: "referral_coupon_used",
                  lateCouponUseDetectedAt: params.usedAt.toISOString(),
                  lateCouponUseOrderId: params.orderId,
                  lateCouponUseRedemptionId: redemption.id,
                  lateCouponUseSide: referralIdentity.referralSide,
                  lateCouponUseOriginalQualificationOrderId:
                    referralIdentity.qualificationOrderId,
                  lateCouponUseSupersededQualificationOrderId:
                    currentQualificationOrderId,
                }) as Prisma.InputJsonValue,
          },
        });
        if (terminalized.count !== 1) {
          // Roll back the redemption transition too. The webhook retry can
          // then observe and compensate whichever generation won the race.
          throw new RedemptionSettlementConflictError(
            `Referral ${referral.id} changed during late coupon settlement.`,
          );
        }

        if (referral.status === WeleticLoyaltyReferralStatus.pending) {
          // A refund returned the referral to pending and released its cap
          // slot. If that compensated coupon is later used, the benefit is
          // irreversible, so restore the lifetime slot exactly once as part
          // of the same terminal-state transition.
          const restored = await tx.weleticLoyaltyAccount.updateMany({
            where: {
              id: referral.advocateAccountId,
              storeId: params.storeId,
            },
            data: { referralCount: { increment: 1 } },
          });
          if (restored.count !== 1) {
            throw new RedemptionSettlementConflictError(
              `Referral advocate ${referral.advocateAccountId} is unavailable during late coupon settlement.`,
            );
          }
        }

        if (hasCurrentReward) {
          // Query only after terminalizing the referral. Coupon workers
          // lock this referral before issuing, so any in-flight issuance
          // either finishes first and is visible here, or sees the
          // terminal state and deactivates its remote discount itself.
          const currentGenerationRedemptions =
            currentQualificationOrderId && currentCouponSides.length > 0
              ? await tx.weleticRewardRedemption.findMany({
                  where: {
                    storeId: params.storeId,
                    idempotencyKey: {
                      in: currentCouponSides.map((side) =>
                        getReferralCouponIdempotencyKey({
                          referralId: referral.id,
                          qualificationOrderId: currentQualificationOrderId,
                          side,
                        }),
                      ),
                    },
                    status: {
                      in: [
                        WeleticRedemptionStatus.provisioning,
                        WeleticRedemptionStatus.issued,
                        WeleticRedemptionStatus.active,
                        WeleticRedemptionStatus.used,
                      ],
                    },
                  },
                })
              : [];

          if (referral.advocatePointsAwarded > BigInt(0)) {
            const ledgerContext = getLateUseLedgerContext({
              privacyRedacted: hasPrivacyRedactedParticipant,
              referralId: referral.id,
              redemptionId: redemption.id,
              qualificationOrderId: currentQualificationOrderId,
            });
            await appendPointsLedgerEntry({
              storeId: params.storeId,
              accountId: referral.advocateAccountId,
              entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
              pointsDelta: -referral.advocatePointsAwarded,
              referenceType: "REFERRAL_LATE_COUPON_CORRECTION",
              referenceId: referral.id,
              idempotencyKey: `referral_late_coupon_advocate:${redemption.id}:${currentQualificationOrderId}`,
              ...ledgerContext,
              tx,
            });
          }
          if (
            referral.refereePointsAwarded > BigInt(0) &&
            referral.refereeAccountId
          ) {
            const ledgerContext = getLateUseLedgerContext({
              privacyRedacted: hasPrivacyRedactedParticipant,
              referralId: referral.id,
              redemptionId: redemption.id,
              qualificationOrderId: currentQualificationOrderId,
            });
            await appendPointsLedgerEntry({
              storeId: params.storeId,
              accountId: referral.refereeAccountId,
              entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
              pointsDelta: -referral.refereePointsAwarded,
              referenceType: "REFERRAL_LATE_COUPON_CORRECTION",
              referenceId: referral.id,
              idempotencyKey: `referral_late_coupon_referee:${redemption.id}:${currentQualificationOrderId}`,
              ...ledgerContext,
              tx,
            });
          }

          if (referral.advocatePointsAwarded > BigInt(0)) {
            await tx.weleticLoyaltyAccount.update({
              where: { id: referral.advocateAccountId },
              data: {
                referralPointsEarned: {
                  decrement: referral.advocatePointsAwarded,
                },
              },
            });
          }

          for (const currentRedemption of currentGenerationRedemptions) {
            if (currentRedemption.status === WeleticRedemptionStatus.used) {
              continue;
            }
            const cancelled = await tx.weleticRewardRedemption.updateMany({
              where: {
                id: currentRedemption.id,
                storeId: params.storeId,
                status: currentRedemption.status,
              },
              data: {
                status: WeleticRedemptionStatus.cancelled,
                compensationReason:
                  "Referral blocked after an older refunded coupon was used",
                // As above, replace stale metadata on the privacy branch so a
                // concurrent scrub cannot be undone by this cancellation.
                metadata: (hasPrivacyRedactedParticipant
                  ? {
                      cancelledAt: params.usedAt.toISOString(),
                      lateCouponUsePrivacyRedacted: true,
                    }
                  : {
                      ...((currentRedemption.metadata &&
                      typeof currentRedemption.metadata === "object" &&
                      !Array.isArray(currentRedemption.metadata)
                        ? currentRedemption.metadata
                        : {}) as Record<string, unknown>),
                      cancelledAt: params.usedAt.toISOString(),
                      lateCouponRedemptionId: redemption.id,
                    }) as Prisma.InputJsonValue,
              },
            });
            if (cancelled.count !== 1) {
              throw new RedemptionSettlementConflictError(
                `Current referral redemption ${currentRedemption.id} changed during late-use correction.`,
              );
            }
            await enqueueOutboxJob({
              storeId: params.storeId,
              jobType: "REDEMPTION_RECOVERY",
              payload: {
                redemptionId: currentRedemption.id,
                accountId: currentRedemption.accountId,
                rewardDefinitionId: currentRedemption.rewardDefinitionId,
                pointsCost: "0",
                shopifyDiscountCode: currentRedemption.shopifyDiscountCode,
                attemptCount: 0,
                sagaPhase: "compensating",
              },
              idempotencyKey: `discount_deactivate:${currentRedemption.id}`,
              loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
              tx,
            });
          }

          for (const accountId of [
            referral.advocateAccountId,
            referral.refereeAccountId,
          ].filter((value): value is string => Boolean(value))) {
            if (
              !allowsOperationalFollowups ||
              privacyRedactedAccountIds.has(accountId)
            ) {
              continue;
            }
            await enqueueOutboxJob({
              storeId: params.storeId,
              jobType: "METAFIELD_SYNC",
              payload: {
                accountId,
                triggerReason: "referral_late_coupon_correction",
              },
              idempotencyKey: `metafield_sync:referral_late_coupon:${redemption.id}:${accountId}`,
              loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
              tx,
            });
          }
        }
      }

      if (
        allowsOperationalFollowups &&
        !privacyRedactedAccountIds.has(redemption.accountId)
      ) {
        await enqueueOutboxJob({
          storeId: params.storeId,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId: redemption.accountId,
            triggerReason: wasCompensated
              ? "redemption_late_use_correction"
              : "redemption_used",
          },
          idempotencyKey: `metafield_sync:used:${redemption.id}`,
          loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
          tx,
        });
      }

      return { marked: true, corrected: wasCompensated };
    });

    if (corrected.marked) markedUsed++;
    if (corrected.corrected) lateUseCorrections++;
  }

  return {
    matched: redemptions.length,
    markedUsed,
    lateUseCorrections,
  };
}
