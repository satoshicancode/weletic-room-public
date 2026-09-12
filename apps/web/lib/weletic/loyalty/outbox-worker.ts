import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  markFinancialRewardExpired,
  provisionFinancialRewardReservation,
} from "@/lib/weletic/loyalty/financial-reward-saga";
import { handleFlowTrigger } from "@/lib/weletic/loyalty/flow-trigger-worker";
import { ShopifyFlowDispatchError } from "@/lib/weletic/loyalty/flow-triggers";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  assertLoyaltyMaintenanceOwnerPermitAuthorization,
  assertLoyaltyMaintenanceWriteAllowed,
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { syncCustomerMetafields } from "@/lib/weletic/loyalty/metafield-sync";
import {
  awardBirthdayReward,
  getBirthdayRewardDateForYear,
  getNextBirthdayRewardSchedule,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import {
  BirthdayRewardPayload,
  enqueueOutboxJob,
  HoldingPeriodReleasePayload,
  InactivityExpiryPayload,
  isMaintenanceGatedOutboxJob,
  MetafieldSyncPayload,
  RedemptionRecoveryPayload,
  RedemptionRecoveryPayloadSchema,
  ReferralRewardProvisionPayload,
  ReferralRewardProvisionPayloadSchema,
  TierReviewPayload,
  VoucherPrivacyCleanupPayload,
} from "@/lib/weletic/loyalty/outbox";
import { sendPointsExpiryNotification } from "@/lib/weletic/loyalty/points-expiry-notifications";
import {
  getPointsExpiryDurationLabel,
  isPointsExpiryEnabled,
  pointsExpiryDatesMatch,
} from "@/lib/weletic/loyalty/points-expiry-policy";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import {
  assertExpectedLoyaltyDiscountNode,
  assertLoyaltyDiscountLookupMissIsTerminal,
  LoyaltyDiscountReconciliationPendingError,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import {
  assertProvisioningReplayMatchesSnapshot,
  getRewardDefinitionFromProvisioningSnapshot,
  readLoyaltyRedemptionProvisioningSnapshot,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  getReferralCouponIdempotencyKey,
  issueReferralRewardCoupon,
  recoverCompensatedReferralCouponDiscount,
  ReferralCouponReconciliationPendingError,
} from "@/lib/weletic/loyalty/referral-coupon";
import {
  deactivateShopifyGiftCard,
  lookupShopifyGiftCard,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  handleVoucherPrivacyCleanup,
  VoucherCleanupRetryableError,
} from "@/lib/weletic/loyalty/voucher-privacy-cleanup";
import { ShopperEmailPausedError } from "@/lib/weletic/merchant-settings/communications";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  isShopifyStoreOperationalWritesBlocked,
} from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticLoyaltyOutboxJob,
  WeleticLoyaltyOutboxJobStatus,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { CommunicationDeliveryReconciliationRequiredError } from "./communication-delivery-snapshot";
import {
  ExpiryDeliveryReconciliationRequiredError,
  type ExpiryDeliveryClaim,
} from "./expiry-delivery-snapshot";
import {
  HistoricalImportExecutionContainedError,
  HistoricalImportLeasePendingError,
} from "./historical-import-job-contract";
import type { HistoricalImportWorkerClaim } from "./historical-import-worker";
import { sendPointsEarnedNotification } from "./points-earned-notifications";
import {
  assertAccountBackedReward,
  assertRewardAccountRelation,
} from "./reward-ownership";

export interface OutboxWorkerOptions {
  batchSize?: number; // default: 50
  lockTimeoutMs?: number; // default: 300,000 (5 minutes)
  workerId?: string;
  /** Polling/reaper clock only. Business handlers continue to use wall time. */
  now?: Date;
  /**
   * Explicit business-time override for isolated validation jobs. A logical
   * clock is rejected unless both an exact store and non-empty job allowlist
   * are supplied, so time travel cannot advance unrelated tenant work.
   */
  logicalNow?: Date;
  storeId?: string;
  jobIds?: string[];
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}

export interface OutboxBatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  skipped: number;
  jobs: Array<{
    id: string;
    jobType: string;
    status: WeleticLoyaltyOutboxJobStatus;
    error?: string;
  }>;
}

type OutboxExecutionResult = {
  historicalImportOutcome?: "completed" | "continued";
  referralRewardOutcome?: "verified";
  redemptionRecoveryOutcome?:
    | "deactivated"
    | "verified_absent"
    | "healed"
    | "financial_expired"
    | "financial_issued"
    | "dedicated_referral_recovery";
  voucherPrivacyCleanupOutcome?:
    | "deactivated"
    | "verified_absent"
    | "used_preserved"
    | "manual_reconciliation";
};

type OutboxWorkerScope = Pick<OutboxWorkerOptions, "storeId" | "jobIds">;

type OutboxJobClaim = {
  candidate: WeleticLoyaltyOutboxJob;
  ownerToken: string;
  claimedAt: Date;
  attempt: number;
};

function createOutboxClaimOwner(workerId: string) {
  const workerLabel = workerId.trim().slice(0, 48) || "worker";
  return `${workerLabel}:${createWeleticId("wlease_")}`;
}

function getOutboxCandidateClaimWhere(
  candidate: WeleticLoyaltyOutboxJob,
): Prisma.WeleticLoyaltyOutboxJobWhereInput {
  return {
    id: candidate.id,
    storeId: candidate.storeId,
    jobType: candidate.jobType,
    status: candidate.status,
    payload: {
      equals: candidate.payload as Prisma.InputJsonValue,
    },
    idempotencyKey: candidate.idempotencyKey,
    scheduledFor: candidate.scheduledFor,
    priority: candidate.priority,
    attempts: candidate.attempts,
    maxAttempts: candidate.maxAttempts,
    lastError: candidate.lastError,
    lockedAt: candidate.lockedAt,
    lockedBy: candidate.lockedBy,
    nextRetryAt: candidate.nextRetryAt,
    processedAt: candidate.processedAt,
    completedAt: candidate.completedAt,
    updatedAt: candidate.updatedAt,
  };
}

function getOutboxClaimWhere({
  candidate,
  ownerToken,
  claimedAt,
  attempt,
}: OutboxJobClaim): Prisma.WeleticLoyaltyOutboxJobWhereInput {
  return {
    id: candidate.id,
    storeId: candidate.storeId,
    jobType: candidate.jobType,
    status: WeleticLoyaltyOutboxJobStatus.processing,
    payload: {
      equals: candidate.payload as Prisma.InputJsonValue,
    },
    lockedAt: claimedAt,
    lockedBy: ownerToken,
    attempts: attempt,
  };
}

function canExecuteAtomicOutboxSql(
  db: Prisma.TransactionClient | typeof prisma,
) {
  return typeof (db as { $executeRaw?: unknown }).$executeRaw === "function";
}

function assertAtomicOutboxSqlAvailable() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Atomic outbox SQL execution is unavailable.");
  }
}

async function acquireOutboxClaim({
  tx,
  claim,
}: {
  tx: Prisma.TransactionClient;
  claim: OutboxJobClaim;
}) {
  const { candidate } = claim;
  if (!canExecuteAtomicOutboxSql(tx)) {
    assertAtomicOutboxSqlAvailable();
    const fallback = await tx.weleticLoyaltyOutboxJob.updateMany({
      where: getOutboxCandidateClaimWhere(candidate),
      data: {
        status: WeleticLoyaltyOutboxJobStatus.processing,
        lockedAt: claim.claimedAt,
        lockedBy: claim.ownerToken,
        attempts: { increment: 1 },
      },
    });
    return fallback.count;
  }
  const updatedAt = new Date();
  return tx.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET
      \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing},
      \`lockedAt\` = ${claim.claimedAt},
      \`lockedBy\` = ${claim.ownerToken},
      \`attempts\` = \`attempts\` + 1,
      \`updatedAt\` = ${updatedAt}
    WHERE
      \`id\` = ${candidate.id}
      AND \`storeId\` = ${candidate.storeId}
      AND \`status\` = ${candidate.status}
      AND \`attempts\` = ${candidate.attempts}
      AND \`updatedAt\` = ${candidate.updatedAt}
      AND \`lockedAt\` <=> ${candidate.lockedAt}
      AND \`lockedBy\` <=> ${candidate.lockedBy}
  `;
}

async function completeOutboxClaim({
  tx,
  claim,
  currentUpdatedAt,
  completedAt,
}: {
  tx: Prisma.TransactionClient;
  claim: OutboxJobClaim;
  currentUpdatedAt: Date;
  completedAt: Date;
}) {
  if (!canExecuteAtomicOutboxSql(tx)) {
    assertAtomicOutboxSqlAvailable();
    const fallback = await tx.weleticLoyaltyOutboxJob.updateMany({
      where: {
        ...getOutboxClaimWhere(claim),
        updatedAt: currentUpdatedAt,
      },
      data: {
        status: WeleticLoyaltyOutboxJobStatus.completed,
        processedAt: completedAt,
        completedAt,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    return fallback.count;
  }
  return tx.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET
      \`status\` = ${WeleticLoyaltyOutboxJobStatus.completed},
      \`processedAt\` = ${completedAt},
      \`completedAt\` = ${completedAt},
      \`lockedAt\` = NULL,
      \`lockedBy\` = NULL,
      \`lastError\` = NULL,
      \`updatedAt\` = ${completedAt}
    WHERE
      \`id\` = ${claim.candidate.id}
      AND \`storeId\` = ${claim.candidate.storeId}
      AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
      AND \`lockedAt\` = ${claim.claimedAt}
      AND \`lockedBy\` = ${claim.ownerToken}
      AND \`attempts\` = ${claim.attempt}
      AND \`updatedAt\` = ${currentUpdatedAt}
  `;
}

async function deadLetterOutboxClaim({
  tx,
  claim,
  currentUpdatedAt,
  errorMessage,
  errorLog,
  transitionedAt,
}: {
  tx: Prisma.TransactionClient;
  claim: OutboxJobClaim;
  currentUpdatedAt: Date;
  errorMessage: string;
  errorLog: Array<unknown>;
  transitionedAt: Date;
}) {
  if (!canExecuteAtomicOutboxSql(tx)) {
    assertAtomicOutboxSqlAvailable();
    const fallback = await tx.weleticLoyaltyOutboxJob.updateMany({
      where: {
        ...getOutboxClaimWhere(claim),
        updatedAt: currentUpdatedAt,
      },
      data: {
        status: WeleticLoyaltyOutboxJobStatus.dead_letter,
        lockedAt: null,
        lockedBy: null,
        lastError: errorMessage,
        errorLog: errorLog as unknown as Prisma.InputJsonValue,
      },
    });
    return fallback.count;
  }
  const errorLogJson = JSON.stringify(errorLog);
  return tx.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET
      \`status\` = ${WeleticLoyaltyOutboxJobStatus.dead_letter},
      \`lockedAt\` = NULL,
      \`lockedBy\` = NULL,
      \`lastError\` = ${errorMessage},
      \`errorLog\` = ${errorLogJson},
      \`updatedAt\` = ${transitionedAt}
    WHERE
      \`id\` = ${claim.candidate.id}
      AND \`storeId\` = ${claim.candidate.storeId}
      AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
      AND \`lockedAt\` = ${claim.claimedAt}
      AND \`lockedBy\` = ${claim.ownerToken}
      AND \`attempts\` = ${claim.attempt}
      AND \`updatedAt\` = ${currentUpdatedAt}
  `;
}

async function failOutboxClaim({
  tx,
  claim,
  currentUpdatedAt,
  errorMessage,
  errorLog,
  nextRetryAt,
  failedAt,
  extendMaxAttempts,
}: {
  tx: Prisma.TransactionClient;
  claim: OutboxJobClaim;
  currentUpdatedAt: Date;
  errorMessage: string;
  errorLog: Array<unknown>;
  nextRetryAt: Date;
  failedAt: Date;
  extendMaxAttempts: boolean;
}) {
  if (!canExecuteAtomicOutboxSql(tx)) {
    assertAtomicOutboxSqlAvailable();
    return tx.weleticLoyaltyOutboxJob.updateMany({
      where: {
        ...getOutboxClaimWhere(claim),
        updatedAt: currentUpdatedAt,
      },
      data: {
        status: WeleticLoyaltyOutboxJobStatus.failed,
        lockedAt: null,
        lockedBy: null,
        lastError: errorMessage,
        errorLog: errorLog as unknown as Prisma.InputJsonValue,
        nextRetryAt,
        ...(extendMaxAttempts ? { maxAttempts: claim.attempt + 1 } : {}),
      },
    });
  }
  const errorLogJson = JSON.stringify(errorLog);
  if (extendMaxAttempts) {
    const count = await tx.$executeRaw`
      UPDATE \`WeleticLoyaltyOutboxJob\`
      SET
        \`status\` = ${WeleticLoyaltyOutboxJobStatus.failed},
        \`lockedAt\` = NULL,
        \`lockedBy\` = NULL,
        \`lastError\` = ${errorMessage},
        \`errorLog\` = ${errorLogJson},
        \`nextRetryAt\` = ${nextRetryAt},
        \`maxAttempts\` = ${claim.attempt + 1},
        \`updatedAt\` = ${failedAt}
      WHERE
        \`id\` = ${claim.candidate.id}
        AND \`storeId\` = ${claim.candidate.storeId}
        AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
        AND \`lockedAt\` = ${claim.claimedAt}
        AND \`lockedBy\` = ${claim.ownerToken}
        AND \`attempts\` = ${claim.attempt}
        AND \`updatedAt\` = ${currentUpdatedAt}
    `;
    return { count };
  }
  const count = await tx.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET
      \`status\` = ${WeleticLoyaltyOutboxJobStatus.failed},
      \`lockedAt\` = NULL,
      \`lockedBy\` = NULL,
      \`lastError\` = ${errorMessage},
      \`errorLog\` = ${errorLogJson},
      \`nextRetryAt\` = ${nextRetryAt},
      \`updatedAt\` = ${failedAt}
    WHERE
      \`id\` = ${claim.candidate.id}
      AND \`storeId\` = ${claim.candidate.storeId}
      AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
      AND \`lockedAt\` = ${claim.claimedAt}
      AND \`lockedBy\` = ${claim.ownerToken}
      AND \`attempts\` = ${claim.attempt}
      AND \`updatedAt\` = ${currentUpdatedAt}
  `;
  return { count };
}

async function restoreOutboxClaim({
  db,
  claim,
  restoredAt,
  retryAt,
}: {
  db: Prisma.TransactionClient | typeof prisma;
  claim: OutboxJobClaim;
  restoredAt: Date;
  retryAt?: Date;
}) {
  const { candidate } = claim;
  if (!canExecuteAtomicOutboxSql(db)) {
    assertAtomicOutboxSqlAvailable();
    const fallback = await db.weleticLoyaltyOutboxJob.updateMany({
      where: getOutboxClaimWhere(claim),
      data: {
        status: candidate.status,
        lockedAt: candidate.lockedAt,
        lockedBy: candidate.lockedBy,
        attempts: candidate.attempts,
        ...(retryAt ? { nextRetryAt: retryAt } : {}),
      },
    });
    return fallback.count;
  }
  if (retryAt)
    return db.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET \`status\` = ${candidate.status}, \`lockedAt\` = ${candidate.lockedAt},
      \`lockedBy\` = ${candidate.lockedBy}, \`attempts\` = ${candidate.attempts},
      \`nextRetryAt\` = ${retryAt}, \`updatedAt\` = ${restoredAt}
    WHERE \`id\` = ${candidate.id} AND \`storeId\` = ${candidate.storeId}
      AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
      AND \`lockedAt\` = ${claim.claimedAt} AND \`lockedBy\` = ${claim.ownerToken}
      AND \`attempts\` = ${claim.attempt}
  `;
  return db.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET
      \`status\` = ${candidate.status},
      \`lockedAt\` = ${candidate.lockedAt},
      \`lockedBy\` = ${candidate.lockedBy},
      \`attempts\` = ${candidate.attempts},
      \`updatedAt\` = ${restoredAt}
    WHERE
      \`id\` = ${candidate.id}
      AND \`storeId\` = ${candidate.storeId}
      AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
      AND \`lockedAt\` = ${claim.claimedAt}
      AND \`lockedBy\` = ${claim.ownerToken}
      AND \`attempts\` = ${claim.attempt}
  `;
}

async function reapStaleOutboxClaim({
  tx,
  staleJob,
  currentUpdatedAt,
  reapedAt,
}: {
  tx: Prisma.TransactionClient;
  staleJob: WeleticLoyaltyOutboxJob;
  currentUpdatedAt: Date;
  reapedAt: Date;
}) {
  if (!canExecuteAtomicOutboxSql(tx)) {
    assertAtomicOutboxSqlAvailable();
    const fallback = await tx.weleticLoyaltyOutboxJob.updateMany({
      where: {
        id: staleJob.id,
        status: WeleticLoyaltyOutboxJobStatus.processing,
        lockedAt: staleJob.lockedAt,
        lockedBy: staleJob.lockedBy,
        attempts: staleJob.attempts,
        payload: {
          equals: staleJob.payload as Prisma.InputJsonValue,
        },
        updatedAt: currentUpdatedAt,
      },
      data: {
        status: WeleticLoyaltyOutboxJobStatus.failed,
        lockedAt: null,
        lockedBy: null,
        lastError: "Lease lock expired / worker timeout reaped",
        nextRetryAt: reapedAt,
      },
    });
    return fallback.count;
  }
  const updatedAt = new Date();
  return tx.$executeRaw`
    UPDATE \`WeleticLoyaltyOutboxJob\`
    SET
      \`status\` = ${WeleticLoyaltyOutboxJobStatus.failed},
      \`lockedAt\` = NULL,
      \`lockedBy\` = NULL,
      \`lastError\` = ${"Lease lock expired / worker timeout reaped"},
      \`nextRetryAt\` = ${reapedAt},
      \`updatedAt\` = ${updatedAt}
    WHERE
      \`id\` = ${staleJob.id}
      AND \`storeId\` = ${staleJob.storeId}
      AND \`status\` = ${WeleticLoyaltyOutboxJobStatus.processing}
      AND \`lockedAt\` <=> ${staleJob.lockedAt}
      AND \`lockedBy\` <=> ${staleJob.lockedBy}
      AND \`attempts\` = ${staleJob.attempts}
      AND \`updatedAt\` = ${currentUpdatedAt}
  `;
}

async function readCurrentOutboxJobForFence({
  tx,
  where,
  testFallback,
}: {
  tx: Prisma.TransactionClient;
  where: Prisma.WeleticLoyaltyOutboxJobWhereInput;
  testFallback: WeleticLoyaltyOutboxJob;
}): Promise<WeleticLoyaltyOutboxJob | null> {
  const delegate =
    tx.weleticLoyaltyOutboxJob as typeof tx.weleticLoyaltyOutboxJob & {
      findFirst?: (args: {
        where: Prisma.WeleticLoyaltyOutboxJobWhereInput;
      }) => Promise<WeleticLoyaltyOutboxJob | null | undefined>;
    };
  if (typeof delegate.findFirst !== "function") {
    if (process.env.NODE_ENV === "test") return testFallback;
    throw new Error("Outbox claim fence cannot read the current job row.");
  }
  const current = await delegate.findFirst({ where });
  if (current === undefined) {
    if (process.env.NODE_ENV === "test") return testFallback;
    throw new Error("Outbox claim fence returned an invalid job row.");
  }
  return current;
}

async function readCurrentOutboxClaim({
  tx,
  claim,
}: {
  tx: Prisma.TransactionClient;
  claim: OutboxJobClaim;
}) {
  return readCurrentOutboxJobForFence({
    tx,
    where: getOutboxClaimWhere(claim),
    testFallback: claim.candidate,
  });
}

function hasExactOutboxWorkerScope({ storeId, jobIds }: OutboxWorkerScope) {
  return (
    typeof storeId === "string" &&
    storeId.length > 0 &&
    storeId.trim() === storeId &&
    Array.isArray(jobIds) &&
    jobIds.length > 0 &&
    new Set(jobIds).size === jobIds.length &&
    jobIds.every(
      (jobId) =>
        typeof jobId === "string" && jobId.length > 0 && jobId.trim() === jobId,
    )
  );
}

function assertMaintenancePermitScope({
  loyaltyMaintenancePermit,
  storeId,
  jobIds,
}: Pick<
  OutboxWorkerOptions,
  "loyaltyMaintenancePermit" | "storeId" | "jobIds"
>) {
  if (loyaltyMaintenancePermit !== undefined) {
    assertLoyaltyMaintenanceOwnerPermitAuthorization(loyaltyMaintenancePermit);
  }
  if (
    loyaltyMaintenancePermit !== undefined &&
    !hasExactOutboxWorkerScope({ storeId, jobIds })
  ) {
    throw new Error(
      "loyaltyMaintenancePermit requires an exact storeId and a non-empty unique jobIds allowlist.",
    );
  }
}

async function assertOutboxJobMaintenanceAllowed({
  tx,
  job,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  job: Pick<WeleticLoyaltyOutboxJob, "storeId" | "jobType" | "payload">;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!isMaintenanceGatedOutboxJob(job)) return;
  const program = await lockLoyaltyProgramRowIfPresent({
    tx,
    storeId: job.storeId,
  });
  if (!program) return;
  assertLoyaltyMaintenanceWriteAllowed({
    storeId: job.storeId,
    metadata: program.metadata,
    permit: loyaltyMaintenancePermit,
  });
}

function getOutboxWorkerScopeWhere({
  storeId,
  jobIds,
}: OutboxWorkerScope = {}): Prisma.WeleticLoyaltyOutboxJobWhereInput {
  return {
    ...(storeId !== undefined ? { storeId } : {}),
    ...(jobIds !== undefined ? { id: { in: [...jobIds] } } : {}),
  };
}

function assertLogicalClockScope({
  logicalNow,
  now,
  storeId,
  jobIds,
}: Pick<OutboxWorkerOptions, "logicalNow" | "now" | "storeId" | "jobIds">) {
  if (logicalNow === undefined) return;

  const hasExactStoreId =
    typeof storeId === "string" &&
    storeId.length > 0 &&
    storeId.trim() === storeId;
  const hasExplicitJobIds =
    Array.isArray(jobIds) &&
    jobIds.length > 0 &&
    jobIds.every(
      (jobId) =>
        typeof jobId === "string" && jobId.length > 0 && jobId.trim() === jobId,
    );

  if (
    !(logicalNow instanceof Date) ||
    !Number.isFinite(logicalNow.getTime()) ||
    now !== undefined ||
    !hasExactStoreId ||
    !hasExplicitJobIds
  ) {
    throw new Error(
      "logicalNow requires a valid Date, no caller-supplied now, an exact storeId, and a non-empty explicit jobIds allowlist.",
    );
  }
}

async function executeClosedAccountReferralCleanup(
  storeId: string,
  payload: ReferralRewardProvisionPayload,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<OutboxExecutionResult> {
  const idempotencyKey = getReferralCouponIdempotencyKey(payload);
  const redemption = await prisma.weleticRewardRedemption.findUnique({
    where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
  });
  if (!redemption) {
    // Referral coupon provisioning always creates the local redemption before
    // calling Shopify, so no local row means there is no remote coupon to
    // clean up after account closure.
    return { referralRewardOutcome: "verified" };
  }
  if (
    await recoverCompensatedReferralCouponDiscount({
      storeId,
      redemption,
      loyaltyMaintenancePermit,
    })
  ) {
    return { referralRewardOutcome: "verified" };
  }
  throw new Error(
    `Referral coupon ${redemption.id} belongs to a closed customer account and requires audited privacy cleanup before this job can complete.`,
  );
}

const REFERRAL_COUPON_DEAD_LETTER_ISSUE_KIND = "referral_coupon_dead_letter";
const REDEMPTION_RECOVERY_DEAD_LETTER_ISSUE_KIND =
  "redemption_recovery_dead_letter";

function getReferralCouponIssueIdentity(candidate: WeleticLoyaltyOutboxJob) {
  const referralPayload =
    candidate.jobType === "REFERRAL_REWARD_PROVISION"
      ? ReferralRewardProvisionPayloadSchema.safeParse(candidate.payload)
      : null;
  if (!referralPayload?.success) return null;

  const { referralId, qualificationOrderId, side } = referralPayload.data;
  return {
    payload: referralPayload.data,
    externalKey: `${referralId}:${qualificationOrderId}:${side}`,
  };
}

function getRedemptionRecoveryIssueIdentity(
  candidate: WeleticLoyaltyOutboxJob,
) {
  const recoveryPayload =
    candidate.jobType === "REDEMPTION_RECOVERY"
      ? RedemptionRecoveryPayloadSchema.safeParse(candidate.payload)
      : null;
  if (!recoveryPayload?.success) return null;

  const { redemptionId, sagaPhase } = recoveryPayload.data;
  return {
    payload: recoveryPayload.data,
    externalKey: `${redemptionId}:${sagaPhase}`,
  };
}

async function transitionOutboxJobToCompleted({
  claim,
  executionResult,
  completedAt,
  loyaltyMaintenancePermit,
}: {
  claim: OutboxJobClaim;
  executionResult: OutboxExecutionResult | undefined;
  completedAt: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<number> {
  const { candidate } = claim;
  return prisma.$transaction(async (tx) => {
    const currentClaim = await readCurrentOutboxClaim({ tx, claim });
    if (!currentClaim) return 0;
    await assertOutboxJobMaintenanceAllowed({
      tx,
      job: currentClaim,
      loyaltyMaintenancePermit,
    });
    const effectiveCompletedAt = new Date(completedAt);
    const completed = await completeOutboxClaim({
      tx,
      claim,
      currentUpdatedAt: currentClaim.updatedAt,
      completedAt: effectiveCompletedAt,
    });
    if (completed !== 1) return completed;

    const referralIssue = getReferralCouponIssueIdentity(candidate);
    if (referralIssue && executionResult?.referralRewardOutcome) {
      await tx.weleticReconciliationIssue.updateMany({
        where: {
          storeId: candidate.storeId,
          kind: REFERRAL_COUPON_DEAD_LETTER_ISSUE_KIND,
          externalKey: referralIssue.externalKey,
          status: "open",
        },
        data: {
          status: "resolved",
          resolvedAt: effectiveCompletedAt,
          details: {
            referralId: referralIssue.payload.referralId,
            qualificationOrderId: referralIssue.payload.qualificationOrderId,
            side: referralIssue.payload.side,
            accountId: referralIssue.payload.accountId,
            rewardDefinitionId: referralIssue.payload.rewardDefinitionId,
            outboxJobId: candidate.id,
            outboxIdempotencyKey: candidate.idempotencyKey,
            attempt: candidate.attempts + 1,
            maxAttempts: candidate.maxAttempts,
            remoteOutcome: executionResult.referralRewardOutcome,
            resolutionMarker: "audited_redrive_completed",
            resolutionMethod: "outbox_redrive",
            resolvedAt: effectiveCompletedAt.toISOString(),
          } satisfies Prisma.InputJsonObject,
        },
      });
    }

    const redemptionIssue = getRedemptionRecoveryIssueIdentity(candidate);
    if (redemptionIssue && executionResult?.redemptionRecoveryOutcome) {
      const currentRedemption = await tx.weleticRewardRedemption.findUnique({
        where: { id: redemptionIssue.payload.redemptionId },
        select: { storeId: true, shopifyDiscountCode: true },
      });
      const currentShopifyDiscountCode =
        currentRedemption?.storeId === candidate.storeId &&
        typeof currentRedemption.shopifyDiscountCode === "string"
          ? currentRedemption.shopifyDiscountCode
          : redemptionIssue.payload.shopifyDiscountCode;
      await tx.weleticReconciliationIssue.updateMany({
        where: {
          storeId: candidate.storeId,
          kind: REDEMPTION_RECOVERY_DEAD_LETTER_ISSUE_KIND,
          externalKey: redemptionIssue.externalKey,
          status: "open",
        },
        data: {
          status: "resolved",
          resolvedAt: effectiveCompletedAt,
          details: {
            redemptionId: redemptionIssue.payload.redemptionId,
            accountId: redemptionIssue.payload.accountId,
            rewardDefinitionId: redemptionIssue.payload.rewardDefinitionId,
            shopifyDiscountCode: currentShopifyDiscountCode,
            sagaPhase: redemptionIssue.payload.sagaPhase,
            outboxJobId: candidate.id,
            outboxIdempotencyKey: candidate.idempotencyKey,
            attempt: candidate.attempts + 1,
            maxAttempts: candidate.maxAttempts,
            remoteOutcome: executionResult.redemptionRecoveryOutcome,
            resolutionMarker: "audited_redrive_completed",
            resolutionMethod: "outbox_redrive",
            resolvedAt: effectiveCompletedAt.toISOString(),
          } satisfies Prisma.InputJsonObject,
        },
      });
    }

    return completed;
  });
}

async function transitionOutboxJobToDeadLetter({
  claim,
  currentAttempt,
  errorMessage,
  errorLog,
  deadLetteredAt,
  loyaltyMaintenancePermit,
}: {
  claim: OutboxJobClaim;
  currentAttempt: number;
  errorMessage: string;
  errorLog: Array<unknown>;
  deadLetteredAt: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<number> {
  const { candidate } = claim;
  return prisma.$transaction(async (tx) => {
    const currentClaim = await readCurrentOutboxClaim({ tx, claim });
    if (!currentClaim) return 0;
    await assertOutboxJobMaintenanceAllowed({
      tx,
      job: currentClaim,
      loyaltyMaintenancePermit,
    });
    const effectiveDeadLetteredAt = new Date(deadLetteredAt);
    const deadLettered = await deadLetterOutboxClaim({
      tx,
      claim,
      currentUpdatedAt: currentClaim.updatedAt,
      errorMessage,
      errorLog,
      transitionedAt: effectiveDeadLetteredAt,
    });

    if (deadLettered !== 1) return deadLettered;

    const referralIssue = getReferralCouponIssueIdentity(candidate);
    if (referralIssue) {
      const { referralId, qualificationOrderId, side } = referralIssue.payload;
      const details = {
        referralId,
        qualificationOrderId,
        side,
        accountId: referralIssue.payload.accountId,
        rewardDefinitionId: referralIssue.payload.rewardDefinitionId,
        outboxJobId: candidate.id,
        outboxIdempotencyKey: candidate.idempotencyKey,
        attempt: currentAttempt,
        maxAttempts: candidate.maxAttempts,
        lastError: errorMessage,
        remoteOutcome: "ambiguous",
        resolutionMarker: "redrive_or_manual_shopify_verification_required",
      } satisfies Prisma.InputJsonObject;

      await tx.weleticReconciliationIssue.upsert({
        where: {
          storeId_kind_externalKey: {
            storeId: candidate.storeId,
            kind: REFERRAL_COUPON_DEAD_LETTER_ISSUE_KIND,
            externalKey: referralIssue.externalKey,
          },
        },
        create: {
          id: createWeleticId("wrecon_"),
          storeId: candidate.storeId,
          externalKey: referralIssue.externalKey,
          kind: REFERRAL_COUPON_DEAD_LETTER_ISSUE_KIND,
          severity: "critical",
          status: "open",
          details,
          detectedAt: effectiveDeadLetteredAt,
        },
        update: {
          severity: "critical",
          status: "open",
          details,
          detectedAt: effectiveDeadLetteredAt,
          resolvedAt: null,
        },
      });

      return deadLettered;
    }

    const redemptionIssue = getRedemptionRecoveryIssueIdentity(candidate);
    if (!redemptionIssue) return deadLettered;

    const currentRedemption = await tx.weleticRewardRedemption.findUnique({
      where: { id: redemptionIssue.payload.redemptionId },
      select: { storeId: true, shopifyDiscountCode: true },
    });
    const currentShopifyDiscountCode =
      currentRedemption?.storeId === candidate.storeId &&
      typeof currentRedemption.shopifyDiscountCode === "string"
        ? currentRedemption.shopifyDiscountCode
        : redemptionIssue.payload.shopifyDiscountCode;

    const details = {
      redemptionId: redemptionIssue.payload.redemptionId,
      accountId: redemptionIssue.payload.accountId,
      rewardDefinitionId: redemptionIssue.payload.rewardDefinitionId,
      shopifyDiscountCode: currentShopifyDiscountCode,
      sagaPhase: redemptionIssue.payload.sagaPhase,
      outboxJobId: candidate.id,
      outboxIdempotencyKey: candidate.idempotencyKey,
      attempt: currentAttempt,
      maxAttempts: candidate.maxAttempts,
      lastError: errorMessage,
      remoteOutcome: "ambiguous",
      resolutionMarker: "redrive_or_manual_shopify_verification_required",
    } satisfies Prisma.InputJsonObject;

    await tx.weleticReconciliationIssue.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId: candidate.storeId,
          kind: REDEMPTION_RECOVERY_DEAD_LETTER_ISSUE_KIND,
          externalKey: redemptionIssue.externalKey,
        },
      },
      create: {
        id: createWeleticId("wrecon_"),
        storeId: candidate.storeId,
        externalKey: redemptionIssue.externalKey,
        kind: REDEMPTION_RECOVERY_DEAD_LETTER_ISSUE_KIND,
        severity: "critical",
        status: "open",
        details,
        detectedAt: effectiveDeadLetteredAt,
      },
      update: {
        severity: "critical",
        status: "open",
        details,
        detectedAt: effectiveDeadLetteredAt,
        resolvedAt: null,
      },
    });

    return deadLettered;
  });
}

/**
 * Calculates exponential backoff delay with full jitter.
 * Formula: min(maxDelay, baseDelay * 2^(attempts - 1)) + jitter(0 to 1000ms)
 */
export function calculateExponentialBackoff(
  attempts: number,
  baseDelayMs: number = 2000,
  maxDelayMs: number = 3600000, // 1 hour
): number {
  if (attempts <= 0) return baseDelayMs;
  const exponential = baseDelayMs * Math.pow(2, attempts - 1);
  const cappedDelay = Math.min(exponential, maxDelayMs);
  const jitter = Math.floor(Math.random() * 1000);
  return cappedDelay + jitter;
}

/**
 * Reaps stale locks where worker died or serverless invocation timed out.
 */
export async function reapStaleOutboxLocks(
  lockTimeoutMs: number = 300000,
  now: Date = new Date(),
  scope: OutboxWorkerScope = {},
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<number> {
  assertMaintenancePermitScope({ ...scope, loyaltyMaintenancePermit });
  const staleThreshold = new Date(now.getTime() - lockTimeoutMs);
  const scopeWhere = getOutboxWorkerScopeWhere(scope);

  const staleJobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      ...scopeWhere,
      status: WeleticLoyaltyOutboxJobStatus.processing,
      lockedAt: { lt: staleThreshold },
    },
    orderBy: { lockedAt: "asc" },
  });

  if (!Array.isArray(staleJobs)) {
    // Legacy focused worker mocks only implemented the former bulk update.
    // Runtime Prisma always returns an array; keep the compatibility path
    // test-only so production never bypasses the per-job maintenance fence.
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Outbox stale-lock query returned an invalid result.");
    }
    const legacyResult = await prisma.weleticLoyaltyOutboxJob.updateMany({
      where: {
        ...scopeWhere,
        status: WeleticLoyaltyOutboxJobStatus.processing,
        lockedAt: { lt: staleThreshold },
      },
      data: {
        status: WeleticLoyaltyOutboxJobStatus.failed,
        lockedAt: null,
        lockedBy: null,
        lastError: "Lease lock expired / worker timeout reaped",
        nextRetryAt: now,
      },
    });
    return legacyResult.count;
  }

  let reaped = 0;
  for (const staleJob of staleJobs) {
    try {
      reaped += await prisma.$transaction(async (tx) => {
        const currentStaleJob = await readCurrentOutboxJobForFence({
          tx,
          where: {
            id: staleJob.id,
            storeId: staleJob.storeId,
            jobType: staleJob.jobType,
            status: WeleticLoyaltyOutboxJobStatus.processing,
            payload: {
              equals: staleJob.payload as Prisma.InputJsonValue,
            },
            lockedAt: staleJob.lockedAt,
            lockedBy: staleJob.lockedBy,
            attempts: staleJob.attempts,
            updatedAt: staleJob.updatedAt,
          },
          testFallback: staleJob,
        });
        if (!currentStaleJob) return 0;
        await assertOutboxJobMaintenanceAllowed({
          tx,
          job: currentStaleJob,
          loyaltyMaintenancePermit,
        });
        return reapStaleOutboxClaim({
          tx,
          staleJob,
          currentUpdatedAt: currentStaleJob.updatedAt,
          reapedAt: now,
        });
      });
    } catch (error) {
      if (isLoyaltyMaintenanceBlockedError(error)) continue;
      throw error;
    }
  }

  return reaped;
}

async function restoreOutboxClaimAfterMaintenanceDeferral({
  claim,
}: {
  claim: OutboxJobClaim;
}) {
  return restoreOutboxClaim({
    db: prisma,
    claim,
    restoredAt: new Date(),
  });
}

/**
 * Main polling and execution loop for outbox jobs.
 */
export async function processOutboxJobsBatch(
  options: OutboxWorkerOptions = {},
): Promise<OutboxBatchResult> {
  const {
    batchSize = 50,
    lockTimeoutMs = 300000,
    logicalNow,
    storeId,
    jobIds,
    loyaltyMaintenancePermit,
  } = options;
  assertMaintenancePermitScope({
    loyaltyMaintenancePermit,
    storeId,
    jobIds,
  });
  assertLogicalClockScope({
    logicalNow,
    now: options.now,
    storeId,
    jobIds,
  });
  // Lease ownership and stale-lock recovery must always share a wall clock.
  // A scoped logical clock may only decide which fixture jobs are eligible and
  // how their business rules evaluate; it can never create a future lease or
  // reap an active wall-clock lease as stale.
  const leaseNow =
    options.now === undefined ? new Date() : new Date(options.now);
  const eligibilityNow =
    logicalNow === undefined ? leaseNow : new Date(logicalNow);
  const businessNow =
    logicalNow === undefined ? undefined : new Date(logicalNow);
  const workerId =
    options.workerId ?? `worker_${process.pid || "srv"}_${Date.now()}`;
  const scope = { storeId, jobIds };
  const scopeWhere = getOutboxWorkerScopeWhere(scope);

  // 1. Snapshot candidate jobs eligible for execution. No job is claimed or
  // mutated until stale-lock reaping has completed under the same maintenance
  // fence used below.
  const candidates = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      ...scopeWhere,
      status: {
        in: [
          WeleticLoyaltyOutboxJobStatus.pending,
          WeleticLoyaltyOutboxJobStatus.failed,
        ],
      },
      scheduledFor: { lte: eligibilityNow },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: eligibilityNow } }],
      // Paused email jobs must not fill the bounded candidate page and starve
      // financial/cleanup work. Final producer checks close pause-after-poll.
      NOT: {
        store: { merchantSettings: { is: { shopperEmailPaused: true } } },
        OR: [
          { jobType: "LOYALTY_COMMUNICATION" },
          { jobType: "REVIEW_REQUEST_EMAIL" },
          {
            jobType: "INACTIVITY_EXPIRY",
            OR: [
              { payload: { path: "$.stage", equals: "warning" } },
              { payload: { path: "$.stage", equals: "last_chance" } },
            ],
          },
        ],
      },
    },
    orderBy: [{ priority: "desc" }, { scheduledFor: "asc" }],
    take: batchSize,
  });

  // 2. Reap stale locks before claiming any candidate.
  await reapStaleOutboxLocks(
    lockTimeoutMs,
    leaseNow,
    scope,
    loyaltyMaintenancePermit,
  );

  const summary: OutboxBatchResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
    jobs: [],
  };

  for (const polledCandidate of candidates) {
    // 3. Atomically acquire lock using optimistic lease pattern
    let claim: OutboxJobClaim | null;
    try {
      claim = await prisma.$transaction(async (tx) => {
        const candidate = await readCurrentOutboxJobForFence({
          tx,
          where: {
            ...scopeWhere,
            id: polledCandidate.id,
            status: {
              in: [
                WeleticLoyaltyOutboxJobStatus.pending,
                WeleticLoyaltyOutboxJobStatus.failed,
              ],
            },
            scheduledFor: { lte: eligibilityNow },
            OR: [
              { nextRetryAt: null },
              { nextRetryAt: { lte: eligibilityNow } },
            ],
          },
          testFallback: polledCandidate,
        });
        if (!candidate) return null;
        await assertOutboxJobMaintenanceAllowed({
          tx,
          job: candidate,
          loyaltyMaintenancePermit,
        });
        const currentClaim: OutboxJobClaim = {
          candidate,
          ownerToken: createOutboxClaimOwner(workerId),
          claimedAt: new Date(leaseNow),
          attempt: candidate.attempts + 1,
        };
        const lockAcquired = await acquireOutboxClaim({
          tx,
          claim: currentClaim,
        });
        return lockAcquired === 1 ? currentClaim : null;
      });
    } catch (error) {
      if (isLoyaltyMaintenanceBlockedError(error)) {
        summary.skipped++;
        continue;
      }
      throw error;
    }

    if (!claim) {
      summary.skipped++;
      continue;
    }

    const { candidate } = claim;
    summary.processed++;
    const currentAttempt = claim.attempt;

    try {
      // 4. Dispatch job to domain handler
      const executionResult = await executeOutboxJob(
        candidate,
        businessNow === undefined ? new Date() : new Date(businessNow),
        loyaltyMaintenancePermit,
        claim,
      );

      if (executionResult?.historicalImportOutcome === "continued") {
        // The import transaction already relinquished source ownership and
        // requeued this job. Generic acknowledgement would be incorrect.
        summary.skipped++;
        summary.jobs.push({
          id: candidate.id,
          jobType: candidate.jobType,
          status: WeleticLoyaltyOutboxJobStatus.pending,
        });
        continue;
      }

      // 5. Success -> Mark completed and unlock
      const completedAt = new Date();
      const completed = await transitionOutboxJobToCompleted({
        claim,
        executionResult,
        completedAt,
        loyaltyMaintenancePermit,
      });

      if (completed === 0) {
        summary.skipped++;
        continue;
      }

      summary.succeeded++;
      summary.jobs.push({
        id: candidate.id,
        jobType: candidate.jobType,
        status: WeleticLoyaltyOutboxJobStatus.completed,
      });
    } catch (error: any) {
      if (
        (candidate.jobType === "HISTORICAL_IMPORT_COMMIT" ||
          candidate.jobType === "HISTORICAL_IMPORT_ROLLBACK") &&
        error instanceof HistoricalImportLeasePendingError
      ) {
        // Waiting for source ownership is not an execution failure. Restore
        // only this exact queue claim and defer to the verified DB expiry.
        await restoreOutboxClaim({
          db: prisma,
          claim,
          restoredAt: new Date(),
          retryAt: error.retryAt,
        });
        summary.processed--;
        summary.skipped++;
        continue;
      }
      if (
        isLoyaltyMaintenanceBlockedError(error) ||
        error instanceof ShopperEmailPausedError
      ) {
        // Pause is a deferral, not a delivery failure. Preserve attempt budget
        // and the exact winning-lease fence; resume can retry the same event.
        await restoreOutboxClaimAfterMaintenanceDeferral({
          claim,
        });
        summary.processed--;
        summary.skipped++;
        continue;
      }
      const errorMessage = error?.message || String(error);
      const failedAt = new Date();
      // Once reconciliation reports an indeterminate lookup, always preserve
      // one more execution. The deadline can pass between the remote lookup
      // and this catch block; the next lookup may find the remote voucher or
      // escalate the miss for manual reconciliation, never infer absence.
      const reconciliationStillPending =
        error instanceof ReferralCouponReconciliationPendingError ||
        error instanceof LoyaltyDiscountReconciliationPendingError ||
        error instanceof VoucherCleanupRetryableError;
      const terminalOutboxFailure =
        (error instanceof ShopifyFlowDispatchError && !error.retryable) ||
        error instanceof HistoricalImportExecutionContainedError ||
        error instanceof ExpiryDeliveryReconciliationRequiredError ||
        error instanceof CommunicationDeliveryReconciliationRequiredError;
      const isExhausted =
        terminalOutboxFailure ||
        (currentAttempt >= candidate.maxAttempts &&
          !reconciliationStillPending);

      const existingLog = (candidate.errorLog as Array<any>) || [];
      const updatedLog = [
        ...existingLog,
        {
          attempt: currentAttempt,
          error: errorMessage,
          at: failedAt.toISOString(),
        },
      ];

      if (isExhausted) {
        // 6. Max attempts reached -> Dead-Letter state. Referral coupon jobs
        // create a critical reconciliation marker in the same transaction so
        // a potentially-created remote Shopify discount cannot disappear into
        // an unaudited terminal queue state.
        let deadLettered: number;
        try {
          deadLettered = await transitionOutboxJobToDeadLetter({
            claim,
            currentAttempt,
            errorMessage,
            errorLog: updatedLog,
            deadLetteredAt: failedAt,
            loyaltyMaintenancePermit,
          });
        } catch (transitionError) {
          if (!isLoyaltyMaintenanceBlockedError(transitionError)) {
            throw transitionError;
          }
          await restoreOutboxClaimAfterMaintenanceDeferral({
            claim,
          });
          summary.processed--;
          summary.skipped++;
          continue;
        }

        if (deadLettered === 0) {
          summary.skipped++;
          continue;
        }

        summary.deadLettered++;
        summary.jobs.push({
          id: candidate.id,
          jobType: candidate.jobType,
          status: WeleticLoyaltyOutboxJobStatus.dead_letter,
          error: errorMessage,
        });
      } else {
        // 7. Transient failure -> Exponential backoff retry
        const delayMs = calculateExponentialBackoff(currentAttempt);
        const backoffRetryAt = new Date(failedAt.getTime() + delayMs);
        const nextRetryAt =
          error instanceof VoucherCleanupRetryableError &&
          error.retryAt &&
          error.retryAt > backoffRetryAt
            ? error.retryAt
            : backoffRetryAt;

        let failed: { count: number };
        try {
          failed = await prisma.$transaction(async (tx) => {
            const currentClaim = await readCurrentOutboxClaim({ tx, claim });
            if (!currentClaim) return { count: 0 };
            await assertOutboxJobMaintenanceAllowed({
              tx,
              job: currentClaim,
              loyaltyMaintenancePermit,
            });
            return failOutboxClaim({
              tx,
              claim,
              currentUpdatedAt: currentClaim.updatedAt,
              errorMessage,
              errorLog: updatedLog,
              nextRetryAt,
              failedAt,
              extendMaxAttempts:
                reconciliationStillPending &&
                currentAttempt >= candidate.maxAttempts,
            });
          });
        } catch (transitionError) {
          if (!isLoyaltyMaintenanceBlockedError(transitionError)) {
            throw transitionError;
          }
          await restoreOutboxClaimAfterMaintenanceDeferral({
            claim,
          });
          summary.processed--;
          summary.skipped++;
          continue;
        }

        if (failed.count === 0) {
          summary.skipped++;
          continue;
        }

        summary.failed++;
        summary.jobs.push({
          id: candidate.id,
          jobType: candidate.jobType,
          status: WeleticLoyaltyOutboxJobStatus.failed,
          error: errorMessage,
        });
      }
    }
  }

  return summary;
}

// ============================================================================
// 3. Domain Job Handlers
// ============================================================================

export async function executeOutboxJob(
  job: WeleticLoyaltyOutboxJob,
  now: Date = new Date(),
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
  queueClaim?: HistoricalImportWorkerClaim | ExpiryDeliveryClaim,
): Promise<OutboxExecutionResult | undefined> {
  const deliveryClaim =
    queueClaim && "candidate" in queueClaim ? queueClaim : undefined;
  const importClaim = queueClaim && {
    ownerToken: queueClaim.ownerToken,
    claimedAt: queueClaim.claimedAt,
    attempt: queueClaim.attempt,
  };
  if (loyaltyMaintenancePermit !== undefined) {
    assertLoyaltyMaintenanceOwnerPermitAuthorization(loyaltyMaintenancePermit);
  }
  if (job.jobType === "HISTORICAL_IMPORT_COMMIT") {
    const { executeHistoricalImportCommitJob } = await import(
      "./historical-import-worker"
    );
    // Import primitives always enforce the normal active-store/program fence.
    // Never use the legacy operational-job blocked-store no-op as completion.
    return executeHistoricalImportCommitJob({ job, queueClaim: importClaim });
  }
  if (job.jobType === "HISTORICAL_IMPORT_ROLLBACK") {
    const { executeHistoricalImportRollbackJob } = await import(
      "./historical-import-rollback-worker"
    );
    return executeHistoricalImportRollbackJob({ job, queueClaim: importClaim });
  }
  const payload =
    job.payload &&
    typeof job.payload === "object" &&
    !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : null;
  const accountId =
    typeof payload?.accountId === "string" ? payload.accountId : null;
  const operationalJob =
    [
      "LOYALTY_COMMUNICATION",
      "HOLDING_PERIOD_RELEASE",
      "INACTIVITY_EXPIRY",
      "TIER_REVIEW",
      "METAFIELD_SYNC",
      "BIRTHDAY_REWARD",
      "FLOW_TRIGGER",
      "REVIEW_REQUEST_EMAIL",
      "SHOPPER_REWARD_PROVISION",
      "HISTORICAL_IMPORT_COMMIT",
      "HISTORICAL_IMPORT_ROLLBACK",
    ].includes(job.jobType) ||
    (job.jobType === "REDEMPTION_RECOVERY" && payload?.sagaPhase === "expiry");
  let expectedInstallationGeneration: string | null | undefined;
  if (operationalJob) {
    const persistedGeneration = payload?.installationGeneration;
    if (
      persistedGeneration !== undefined &&
      persistedGeneration !== null &&
      (typeof persistedGeneration !== "string" ||
        persistedGeneration.length === 0 ||
        persistedGeneration.length > 64)
    ) {
      throw new Error(
        `Operational outbox job ${job.id} has an invalid installation generation.`,
      );
    }
    // A missing marker denotes the staged legacy/null generation. It must not
    // silently adopt whichever installation happens to be active at retry
    // time, otherwise g1 work can mutate g2 after reconnect.
    expectedInstallationGeneration =
      typeof persistedGeneration === "string" ? persistedGeneration : null;
    try {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: job.storeId,
        action: `loyalty_outbox:${job.jobType}`,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      });
    } catch (error) {
      if (isShopifyStoreOperationalWritesBlocked(error)) return;
      throw error;
    }
  }
  if (!accountId) {
    return executeOutboxJobUnlocked(
      job,
      expectedInstallationGeneration,
      now,
      loyaltyMaintenancePermit,
      deliveryClaim,
    );
  }

  const identity = await prisma.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId: job.storeId },
    select: {
      status: true,
      shopper: { select: { shopifyCustomerId: true } },
      store: { select: { projectId: true } },
    },
  });
  const requiredDiscountAudit =
    job.jobType === "REDEMPTION_RECOVERY" ||
    job.jobType === "VOUCHER_PRIVACY_CLEANUP";
  const referralPayload =
    job.jobType === "REFERRAL_REWARD_PROVISION"
      ? ReferralRewardProvisionPayloadSchema.safeParse(payload)
      : null;
  if (!identity) {
    if (requiredDiscountAudit) {
      return executeOutboxJobUnlocked(
        job,
        expectedInstallationGeneration,
        now,
        loyaltyMaintenancePermit,
        deliveryClaim,
      );
    }
    if (referralPayload?.success) {
      throw new Error(
        `Referral coupon account ${referralPayload.data.accountId} is missing and requires audited reconciliation.`,
      );
    }
    return;
  }

  return withShopifyCustomerSettlementLocks({
    workspaceId: identity.store.projectId,
    storeId: job.storeId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn: async () => {
      const current = await prisma.weleticLoyaltyAccount.findFirst({
        where: { id: accountId, storeId: job.storeId },
        select: { status: true },
      });
      if (!current || current.status === "closed") {
        if (requiredDiscountAudit) {
          return executeOutboxJobUnlocked(
            job,
            expectedInstallationGeneration,
            now,
            loyaltyMaintenancePermit,
            deliveryClaim,
          );
        }
        if (referralPayload?.success) {
          return executeClosedAccountReferralCleanup(
            job.storeId,
            referralPayload.data,
            loyaltyMaintenancePermit,
          );
        }
        return;
      }
      return executeOutboxJobUnlocked(
        job,
        expectedInstallationGeneration,
        now,
        loyaltyMaintenancePermit,
        deliveryClaim,
      );
    },
  });
}

async function executeOutboxJobUnlocked(
  job: WeleticLoyaltyOutboxJob,
  expectedInstallationGeneration?: string | null,
  now: Date = new Date(),
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
  deliveryClaim?: ExpiryDeliveryClaim,
): Promise<OutboxExecutionResult | undefined> {
  switch (job.jobType) {
    case "LOYALTY_COMMUNICATION": {
      if (!deliveryClaim || deliveryClaim.candidate !== job)
        throw new Error("Loyalty communication requires its worker claim");
      await sendPointsEarnedNotification({
        claim: deliveryClaim,
        loyaltyMaintenancePermit,
      });
      break;
    }
    case "SHOPPER_REWARD_PROVISION": {
      const { provisionShopperReviewCoupon } = await import(
        "./shopper-coupon-worker"
      );
      await provisionShopperReviewCoupon({
        storeId: job.storeId,
        payload: job.payload,
        loyaltyMaintenancePermit,
      });
      break;
    }
    case "REVIEW_REQUEST_EMAIL":
    case "REVIEW_SUMMARY_SYNC":
    case "REVIEW_MEDIA_CLEANUP": {
      const { executeNativeReviewJob } = await import(
        "@/lib/weletic/reviews/worker"
      );
      await executeNativeReviewJob(job);
      break;
    }
    case "HOLDING_PERIOD_RELEASE":
      await handleHoldingPeriodRelease(
        job.storeId,
        job.payload as unknown as HoldingPeriodReleasePayload,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      );
      break;
    case "INACTIVITY_EXPIRY":
      await handleInactivityExpiry(
        job.storeId,
        job.payload as unknown as InactivityExpiryPayload,
        expectedInstallationGeneration,
        now,
        loyaltyMaintenancePermit,
        deliveryClaim,
      );
      break;
    case "TIER_REVIEW":
      await handleTierReview(
        job.storeId,
        job.payload as unknown as TierReviewPayload,
        expectedInstallationGeneration,
        now,
        loyaltyMaintenancePermit,
      );
      break;
    case "METAFIELD_SYNC":
      await handleMetafieldSync(
        job.storeId,
        job.payload as unknown as MetafieldSyncPayload,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      );
      break;
    case "REDEMPTION_RECOVERY":
      return {
        redemptionRecoveryOutcome: await handleRedemptionRecovery(
          job.storeId,
          job.payload as unknown as RedemptionRecoveryPayload,
          expectedInstallationGeneration,
          now,
          loyaltyMaintenancePermit,
        ),
      };
    case "BIRTHDAY_REWARD":
      await handleBirthdayReward(
        job.storeId,
        job.payload as unknown as BirthdayRewardPayload,
        expectedInstallationGeneration,
        now,
        loyaltyMaintenancePermit,
      );
      break;
    case "REFERRAL_REWARD_PROVISION":
      await handleReferralRewardProvision(
        job.storeId,
        job.payload as unknown as ReferralRewardProvisionPayload,
        loyaltyMaintenancePermit,
      );
      return { referralRewardOutcome: "verified" };
    case "VOUCHER_PRIVACY_CLEANUP": {
      const payload = job.payload as unknown as VoucherPrivacyCleanupPayload;
      return {
        voucherPrivacyCleanupOutcome: await handleVoucherPrivacyCleanup({
          storeId: job.storeId,
          ...payload,
          outboxJobId: job.id,
        }),
      };
    }
    case "FLOW_TRIGGER":
      await handleFlowTrigger(
        job.storeId,
        job.payload,
        loyaltyMaintenancePermit,
      );
      break;
    default:
      throw new Error(`Unknown job type: ${job.jobType}`);
  }
}

/**
 * 1. Handler: HOLDING_PERIOD_RELEASE
 */
export async function handleHoldingPeriodRelease(
  storeId: string,
  payload: HoldingPeriodReleasePayload,
  expectedInstallationGeneration?: string | null,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<void> {
  await releaseHoldingPeriodGrant({
    payload,
    storeId,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });
}

/**
 * 2. Handler: INACTIVITY_EXPIRY
 */
export async function handleInactivityExpiry(
  storeId: string,
  payload: InactivityExpiryPayload,
  expectedInstallationGeneration?: string | null,
  now: Date = new Date(),
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
  deliveryClaim?: ExpiryDeliveryClaim,
): Promise<void> {
  // Earlier migrated payloads advertised a warning-only mode without a
  // notification implementation. Never let a stale warning job expire points.
  if (
    (payload as InactivityExpiryPayload & { warningOnly?: unknown })
      .warningOnly === true
  ) {
    return;
  }

  if (payload.stage === "warning" || payload.stage === "last_chance") {
    await sendPointsExpiryNotification({
      storeId,
      payload,
      expectedInstallationGeneration,
      now,
      deliveryClaim,
      loyaltyMaintenancePermit,
    });
    return;
  }

  // Legacy jobs do not carry an exact expiry date or policy version, so they
  // cannot prove that the account is still governed by the policy that created
  // them. The reconciliation scheduler replaces them with policy-bound jobs.
  const expiryAtPayload = payload.expiryAt;
  if (!expiryAtPayload) return;

  const { accountId, lastActivityAt, expiryMonths } = payload;

  await prisma.$transaction(
    async (tx) => {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId,
        action: "loyalty_inactivity_expiry",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      const account = await tx.weleticLoyaltyAccount.findUnique({
        where: { id: accountId },
        include: { program: true },
      });

      if (!account) {
        return; // Nothing to expire
      }
      if (account.storeId !== storeId) {
        throw new Error(
          `Loyalty account ${accountId} does not belong to ${storeId}`,
        );
      }

      const expiryAt = new Date(expiryAtPayload);
      const program = account.program;
      if (
        !program ||
        !isPointsExpiryEnabled(program) ||
        payload.policyVersion !== program.pointsExpiryPolicyVersion ||
        account.pointsExpiryPolicyVersion !==
          program.pointsExpiryPolicyVersion ||
        !pointsExpiryDatesMatch(account.nextExpiryDate, expiryAt)
      ) {
        return;
      }
      if (expiryAt.getTime() > now.getTime()) {
        throw new Error(
          `Points expiry job for ${accountId} ran before ${expiryAt.toISOString()}.`,
        );
      }
      if (account.cachedPointsBalance <= BigInt(0)) {
        await tx.weleticLoyaltyAccount.updateMany({
          where: {
            id: accountId,
            storeId,
            nextExpiryDate: expiryAt,
          },
          data: {
            nextExpiryDate: null,
            pointsExpiryJobsScheduledAt: null,
          },
        });
        return;
      }

      const pointsToExpire = account.cachedPointsBalance;
      const expiryIdentity = expiryAt.toISOString();
      await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.EXPIRATION,
        pointsDelta: -pointsToExpire,
        referenceType: "LOYALTY_INACTIVITY_EXPIRY",
        referenceId: accountId,
        idempotencyKey: `expire:${accountId}:${expiryIdentity}`,
        reason: `Points expired after ${getPointsExpiryDurationLabel(program)} of account inactivity`,
        metadata: {
          lastActivityAt,
          expiryAt: expiryIdentity,
          expiryDays: payload.expiryDays ?? 0,
          expiryMonths,
          policyVersion: payload.policyVersion,
        },
        tx,
      });
      await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: accountId,
          storeId,
          nextExpiryDate: expiryAt,
        },
        data: {
          nextExpiryDate: null,
          pointsExpiryJobsScheduledAt: null,
        },
      });
      await enqueueOutboxJob({
        storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId,
          triggerReason: "points_expiration",
        },
        idempotencyKey: `metafield_sync:expire:${accountId}:${expiryIdentity}`,
        loyaltyMaintenancePermit,
        tx,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function handleBirthdayReward(
  storeId: string,
  payload: BirthdayRewardPayload,
  expectedInstallationGeneration?: string | null,
  now: Date = new Date(),
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<void> {
  const scheduledBirthday = getBirthdayRewardDateForYear(
    payload.birthDate,
    payload.calendarYear,
  );
  if (scheduledBirthday.getTime() > now.getTime()) {
    throw new Error(
      `Birthday reward job for ${payload.accountId} ran before its scheduled date.`,
    );
  }
  await prisma.$transaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "loyalty_birthday_reward",
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      tx,
    });
    // Lock the active account before reading birthday metadata. Customer
    // redaction uses an updatedAt CAS on the same row, so either this entire
    // award-and-reschedule transaction commits first and redaction scrubs the
    // resulting job, or redaction closes the account and this claim loses.
    const activeAccountClaim = await tx.weleticLoyaltyAccount.updateMany({
      where: { id: payload.accountId, storeId, status: "active" },
      data: { updatedAt: now },
    });
    if (activeAccountClaim.count !== 1) return;

    const account = await tx.weleticLoyaltyAccount.findFirst({
      where: { id: payload.accountId, storeId, status: "active" },
      include: {
        program: {
          include: {
            earningRules: {
              where: {
                triggerCode: "birthday",
                ruleType: "fixed_points",
                isActive: true,
                deletedAt: null,
                OR: [
                  { startAt: null },
                  { startAt: { lte: scheduledBirthday } },
                ],
                AND: [
                  {
                    OR: [
                      { endAt: null },
                      { endAt: { gte: scheduledBirthday } },
                    ],
                  },
                ],
              },
              orderBy: [
                { priority: "desc" },
                { createdAt: "asc" },
                { id: "asc" },
              ],
              take: 1,
            },
          },
        },
      },
    });

    const birthdayMetadata =
      account?.metadata &&
      typeof account.metadata === "object" &&
      !Array.isArray(account.metadata)
        ? (account.metadata as Record<string, any>).birthday
        : null;
    if (
      !account ||
      birthdayMetadata?.birthDate !== payload.birthDate ||
      birthdayMetadata?.registeredAt !== payload.registeredAt
    ) {
      return;
    }

    const rule = account.program.earningRules[0];
    if (
      rule?.fixedPoints &&
      account.program.status === "active" &&
      !account.program.killSwitchActive
    ) {
      await awardBirthdayReward({
        storeId,
        accountId: account.id,
        birthDate: payload.birthDate,
        enrollmentDate: payload.registeredAt,
        rewardPoints: rule.fixedPoints,
        reason: rule.name,
        metadata: { earningRuleId: rule.id },
        now: scheduledBirthday,
        loyaltyMaintenancePermit,
        tx,
      });
    }

    const nextSchedule = getNextBirthdayRewardSchedule({
      birthDate: payload.birthDate,
      registeredAt: payload.registeredAt,
      now: new Date(scheduledBirthday.getTime() + 24 * 60 * 60 * 1000),
    });
    const accountMetadata = account.metadata as Record<string, any>;
    const advancedSchedule = await tx.weleticLoyaltyAccount.updateMany({
      where: { id: account.id, storeId, status: "active" },
      data: {
        metadata: {
          ...accountMetadata,
          birthday: {
            ...birthdayMetadata,
            nextEligibleYear: nextSchedule.calendarYear,
          },
        } as Prisma.InputJsonValue,
      },
    });
    if (advancedSchedule.count !== 1) {
      throw new Error(
        `Birthday schedule for ${account.id} changed during reward processing.`,
      );
    }
    await enqueueOutboxJob({
      storeId,
      jobType: "BIRTHDAY_REWARD",
      payload: {
        accountId: account.id,
        birthDate: payload.birthDate,
        registeredAt: payload.registeredAt,
        calendarYear: nextSchedule.calendarYear,
      },
      scheduledFor: nextSchedule.scheduledFor,
      idempotencyKey: `birthday_reward:${account.id}:${nextSchedule.calendarYear}`,
      loyaltyMaintenancePermit,
      tx,
    });
  });
}

export async function handleReferralRewardProvision(
  storeId: string,
  payload: ReferralRewardProvisionPayload,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<void> {
  await issueReferralRewardCoupon({
    storeId,
    ...payload,
    loyaltyMaintenancePermit,
  });
}

/**
 * 3. Handler: TIER_REVIEW
 */
export async function handleTierReview(
  storeId: string,
  payload: TierReviewPayload,
  expectedInstallationGeneration?: string | null,
  now: Date = new Date(),
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<void> {
  const { accountId, reviewPeriod, gracePeriodDays, cycleYear } = payload;
  await prisma.$transaction(
    async (tx) => {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId,
        action: "loyalty_tier_review",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod,
        gracePeriodDays,
        cycleYear,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        now,
        tx,
      });

      if (result.status === "IN_GRACE_PERIOD" && result.gracePeriodExpiresAt) {
        await enqueueOutboxJob({
          storeId,
          jobType: "TIER_REVIEW",
          payload: {
            accountId,
            reviewPeriod,
            gracePeriodDays,
            reason: "grace_period_expired",
          },
          scheduledFor: result.gracePeriodExpiresAt,
          idempotencyKey: `tier_review_grace_expiry:${accountId}:${result.gracePeriodExpiresAt.getTime()}`,
          loyaltyMaintenancePermit,
          tx,
        });
      }

      if (result.tierChanged || result.status === "IN_GRACE_PERIOD") {
        await enqueueOutboxJob({
          storeId,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId,
            triggerReason: `tier_${result.status.toLowerCase()}`,
          },
          idempotencyKey: `metafield_sync:tier:${accountId}:${now.getTime()}`,
          loyaltyMaintenancePermit,
          tx,
        });
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * 4. Handler: METAFIELD_SYNC
 *
 * Production dispatch must continue to enter through executeOutboxJob's
 * account-identity path. That path holds the same customer settlement locks
 * as the maintenance harness across this remote Shopify mutation, preventing
 * a maintenance lease from being installed between validation and sync.
 */
export async function handleMetafieldSync(
  storeId: string,
  payload: MetafieldSyncPayload,
  expectedInstallationGeneration?: string | null,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<void> {
  const { accountId, shopifyCustomerId } = payload;

  const syncResult = await syncCustomerMetafields({
    storeId,
    accountId,
    shopifyCustomerId: shopifyCustomerId || "",
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  if (!syncResult.success) {
    throw new Error(
      `Shopify Metafields sync failed: ${syncResult.error || "Unknown GraphQL error"}`,
    );
  }
}

import {
  compensateDiscountSaga,
  reconcileGenericProvisioningDiscount,
  sweepStuckSagaRedemptions,
} from "@/lib/weletic/loyalty/saga";
import {
  deactivateDiscount,
  formatShopifyGid,
  lookupDiscountByCode,
  matchesLoyaltyRewardDiscountConfiguration,
  resolveShopifyOfflineCredentials,
} from "@/lib/weletic/loyalty/shopify-discounts";

export { sweepStuckSagaRedemptions };

async function resolveVerifiedGenericDiscountForCleanup({
  storeId,
  redemption,
  shopDomain,
  accessToken,
}: {
  storeId: string;
  redemption: {
    id: string;
    accountId: string;
    rewardDefinitionId: string;
    shopifyDiscountCode: string;
    shopifyDiscountId: string | null;
    metadata: unknown;
  };
  shopDomain: string;
  accessToken: string;
}) {
  const remote = await lookupDiscountByCode(
    shopDomain,
    accessToken,
    redemption.shopifyDiscountCode,
  );
  if (!remote) {
    if (redemption.shopifyDiscountId) {
      throw new Error(
        `Cannot verify persisted Shopify discount ID ${redemption.shopifyDiscountId} for redemption ${redemption.id}: the expected code was not found.`,
      );
    }
    assertLoyaltyDiscountLookupMissIsTerminal({
      redemptionId: redemption.id,
      discountCode: redemption.shopifyDiscountCode,
      metadata: redemption.metadata,
    });
    return null;
  }

  assertExpectedLoyaltyDiscountNode({
    identity: {
      storeId,
      redemptionId: redemption.id,
      accountId: redemption.accountId,
      rewardDefinitionId: redemption.rewardDefinitionId,
      discountCode: redemption.shopifyDiscountCode,
    },
    metadata: redemption.metadata,
    remote,
  });
  if (
    redemption.shopifyDiscountId &&
    remote.id !==
      formatShopifyGid("DiscountCodeNode", redemption.shopifyDiscountId)
  ) {
    throw new Error(
      `Persisted Shopify discount ID does not match the verified code for redemption ${redemption.id}.`,
    );
  }
  return remote;
}

/**
 * 5. Handler: REDEMPTION_RECOVERY
 */
async function handleFinancialRedemptionRecovery({
  storeId,
  redemption,
  payload,
  now,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  redemption: Awaited<
    ReturnType<typeof prisma.weleticRewardRedemption.findUnique>
  > & {
    account: {
      cachedPointsBalance: bigint;
      shopper: { shopifyCustomerId: string };
    };
  };
  payload: RedemptionRecoveryPayload;
  now: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!redemption) return undefined;
  assertAccountBackedReward(redemption);

  if (payload.sagaPhase === "expiry") {
    if (
      !redemption.expiresAt ||
      redemption.expiresAt.getTime() > now.getTime()
    ) {
      throw new Error(
        `Financial redemption ${redemption.id} expiry job ran before expiresAt`,
      );
    }
    await markFinancialRewardExpired({
      storeId,
      redemptionId: redemption.id,
      now,
    });
    return "financial_expired" as const;
  }

  if (payload.sagaPhase === "compensating") {
    if (redemption.artifactKind === WeleticRewardArtifactKind.store_credit) {
      if (redemption.shopifyStoreCreditTransactionId) {
        throw new Error(
          `Issued Shopify store credit ${redemption.shopifyStoreCreditTransactionId} cannot be automatically reversed; manual reconciliation is required.`,
        );
      }
      return "verified_absent" as const;
    }

    const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
      redemption.metadata,
    );
    if (!snapshot || snapshot.rewardType !== "gift_card") {
      throw new Error(
        `Gift-card redemption ${redemption.id} is missing its immutable provisioning snapshot.`,
      );
    }
    if (!snapshot.discountValue) {
      throw new Error(
        `Gift-card redemption ${redemption.id} is missing its immutable amount.`,
      );
    }
    const credentials = await resolveShopifyOfflineCredentials({ storeId });
    const giftCard = redemption.shopifyGiftCardId
      ? { id: redemption.shopifyGiftCardId }
      : await lookupShopifyGiftCard({
          shopDomain: credentials.shopDomain,
          accessToken: credentials.accessToken,
          code: redemption.shopifyDiscountCode,
          customerId: redemption.account.shopper.shopifyCustomerId,
          amountMinor: BigInt(snapshot.discountValue),
          currencyCode: snapshot.shopCurrency,
          expiresAt: redemption.expiresAt,
          note: `Weletic loyalty redemption ${redemption.id}`,
        });
    if (!giftCard) return "verified_absent" as const;
    const deactivated = await deactivateShopifyGiftCard({
      credentials,
      giftCardId: giftCard.id,
    });
    if (!deactivated) {
      throw new Error(
        `Shopify did not confirm gift-card deactivation for ${redemption.id}.`,
      );
    }
    return "deactivated" as const;
  }

  if (redemption.status !== WeleticRedemptionStatus.provisioning) {
    return undefined;
  }
  const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
    redemption.metadata,
  );
  if (
    !snapshot ||
    (snapshot.rewardType !== "gift_card" &&
      snapshot.rewardType !== "store_credit")
  ) {
    throw new Error(
      `Financial redemption ${redemption.id} is missing its immutable provisioning snapshot.`,
    );
  }
  await provisionFinancialRewardReservation({
    storeId,
    accountId: redemption.accountId,
    rewardDefinitionId: redemption.rewardDefinitionId,
    reservation: {
      redemption: {
        id: redemption.id,
        status: redemption.status,
        artifactKind: redemption.artifactKind,
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        shopifyGiftCardId: redemption.shopifyGiftCardId,
        shopifyStoreCreditTransactionId:
          redemption.shopifyStoreCreditTransactionId,
        metadata: redemption.metadata,
      },
      account: {
        shopper: {
          shopifyCustomerId: redemption.account.shopper.shopifyCustomerId,
        },
      },
      effectivePointsCost: redemption.pointsSpent,
      balanceAfter: redemption.account.cachedPointsBalance,
      expiresAt: redemption.expiresAt,
      provisioningSnapshot: snapshot,
    },
    loyaltyMaintenancePermit,
  });
  return "financial_issued" as const;
}

export async function handleRedemptionRecovery(
  storeId: string,
  payload: RedemptionRecoveryPayload,
  expectedInstallationGeneration?: string | null,
  now: Date = new Date(),
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
) {
  const { redemptionId, accountId, shopifyDiscountCode } = payload;

  const redemption = await prisma.weleticRewardRedemption.findUnique({
    where: { id: redemptionId },
    include: {
      rewardDefinition: true,
      account: { include: { shopper: true } },
    },
  });

  if (!redemption) {
    return undefined; // Remote outcome cannot be audited without the record.
  }

  if (redemption.storeId !== storeId || redemption.accountId !== accountId) {
    throw new Error(`Redemption recovery tenant mismatch for ${redemptionId}`);
  }
  assertAccountBackedReward(redemption);

  if (
    redemption.artifactKind === WeleticRewardArtifactKind.gift_card ||
    redemption.artifactKind === WeleticRewardArtifactKind.store_credit
  ) {
    assertRewardAccountRelation(redemption);
    return handleFinancialRedemptionRecovery({
      storeId,
      redemption,
      payload,
      now,
      loyaltyMaintenancePermit,
    });
  }

  if (payload.sagaPhase === "compensating") {
    if (
      await recoverCompensatedReferralCouponDiscount({
        storeId,
        redemption,
        loyaltyMaintenancePermit,
      })
    ) {
      return "dedicated_referral_recovery" as const;
    }

    const creds = await resolveShopifyOfflineCredentials({ storeId });
    const discount = await resolveVerifiedGenericDiscountForCleanup({
      storeId,
      redemption,
      shopDomain: creds.shopDomain,
      accessToken: creds.accessToken,
    });
    if (!discount) {
      return "verified_absent" as const;
    }
    const deactivated = await deactivateDiscount(
      creds.shopDomain,
      creds.accessToken,
      discount.id,
    );
    if (!deactivated) {
      throw new Error(
        `Shopify did not confirm discount deactivation for ${redemptionId}`,
      );
    }
    return "deactivated" as const;
  }

  if (payload.sagaPhase === "expiry") {
    if (
      redemption.status === WeleticRedemptionStatus.used ||
      redemption.status === WeleticRedemptionStatus.cancelled ||
      redemption.status === WeleticRedemptionStatus.failed
    ) {
      return undefined;
    }
    if (!redemption.expiresAt) {
      return undefined;
    }
    if (redemption.expiresAt.getTime() > now.getTime()) {
      throw new Error(
        `Redemption ${redemptionId} expiry job ran before expiresAt`,
      );
    }

    if (redemption.status !== WeleticRedemptionStatus.expired) {
      await compensateDiscountSaga({
        redemptionId,
        reason: "Unused loyalty discount expired",
        targetStatus: WeleticRedemptionStatus.expired,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      });
    }

    const creds = await resolveShopifyOfflineCredentials({ storeId });
    const discount = await resolveVerifiedGenericDiscountForCleanup({
      storeId,
      redemption,
      shopDomain: creds.shopDomain,
      accessToken: creds.accessToken,
    });
    if (discount) {
      const deactivated = await deactivateDiscount(
        creds.shopDomain,
        creds.accessToken,
        discount.id,
      );
      if (!deactivated) {
        throw new Error(
          `Shopify did not confirm expired discount deactivation for ${redemptionId}`,
        );
      }
      return "deactivated" as const;
    } else {
      return "verified_absent" as const;
    }
  }

  // If already resolved, nothing to recover
  if (
    redemption.status === WeleticRedemptionStatus.used ||
    redemption.status === WeleticRedemptionStatus.cancelled ||
    redemption.status === WeleticRedemptionStatus.expired ||
    redemption.status === WeleticRedemptionStatus.failed
  ) {
    return undefined;
  }

  // If stuck in provisioning, check remote Shopify reality:
  if (redemption.status === WeleticRedemptionStatus.provisioning) {
    const redemptionMetadata =
      redemption.metadata &&
      typeof redemption.metadata === "object" &&
      !Array.isArray(redemption.metadata)
        ? (redemption.metadata as Record<string, unknown>)
        : {};
    const looksLikeReferralCoupon =
      redemption.shopifyDiscountCode.startsWith("WLR-") ||
      "referralId" in redemptionMetadata ||
      "qualificationOrderId" in redemptionMetadata ||
      "referralSide" in redemptionMetadata;
    if (looksLikeReferralCoupon) {
      if (
        typeof redemptionMetadata.referralId !== "string" ||
        typeof redemptionMetadata.qualificationOrderId !== "string" ||
        (redemptionMetadata.referralSide !== "advocate" &&
          redemptionMetadata.referralSide !== "referee")
      ) {
        throw new Error(
          `Referral coupon ${redemption.id} has invalid recovery metadata.`,
        );
      }
      const expectedIdempotencyKey = getReferralCouponIdempotencyKey({
        referralId: redemptionMetadata.referralId,
        qualificationOrderId: redemptionMetadata.qualificationOrderId,
        side: redemptionMetadata.referralSide,
      });
      if (redemption.idempotencyKey !== expectedIdempotencyKey) {
        throw new Error(
          `Referral coupon ${redemption.id} has a mismatched generation identity.`,
        );
      }
      // Referral coupons carry a stronger tenant/config ownership identity;
      // always resume through their domain workflow instead of adopting a
      // matching Shopify code through the generic saga path.
      await issueReferralRewardCoupon({
        storeId,
        referralId: redemptionMetadata.referralId,
        qualificationOrderId: redemptionMetadata.qualificationOrderId,
        accountId: redemption.accountId,
        rewardDefinitionId: redemption.rewardDefinitionId,
        side: redemptionMetadata.referralSide,
        loyaltyMaintenancePermit,
      });
      return "dedicated_referral_recovery" as const;
    }

    const creds = await resolveShopifyOfflineCredentials({ storeId });
    const remoteNode = await lookupDiscountByCode(
      creds.shopDomain,
      creds.accessToken,
      redemption.shopifyDiscountCode,
    );

    if (remoteNode?.id) {
      // Never restore points while an active remote voucher has unverifiable
      // ownership. Keep the reservation intact and let the durable recovery
      // job dead-letter into manual reconciliation instead.
      assertExpectedLoyaltyDiscountNode({
        identity: {
          storeId,
          redemptionId,
          accountId,
          rewardDefinitionId: redemption.rewardDefinitionId,
          discountCode: redemption.shopifyDiscountCode,
        },
        metadata: redemption.metadata,
        remote: remoteNode,
        requireActive: false,
      });

      assertRewardAccountRelation(redemption);
      const accountIsActive =
        redemption.account.status === "active" &&
        !hasShopifyCustomerRedactionTombstone(redemption.account.metadata);
      let configurationMatches = true;
      if (accountIsActive) {
        const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
          redemption.metadata,
        );
        if (!snapshot) {
          throw new Error(
            `Provisioning redemption ${redemptionId} is missing its immutable Shopify configuration snapshot.`,
          );
        }
        const snapshotExpiresAt = snapshot.expiresAt
          ? new Date(snapshot.expiresAt)
          : null;
        if (
          snapshot.expiresAt !== (redemption.expiresAt?.toISOString() ?? null)
        ) {
          throw new Error(
            `Provisioning redemption ${redemptionId} expiry does not match its immutable Shopify configuration snapshot.`,
          );
        }
        assertProvisioningReplayMatchesSnapshot({
          snapshot,
          storeId,
          shopifyCustomerId: redemption.account.shopper.shopifyCustomerId,
        });
        const rewardDefinition = getRewardDefinitionFromProvisioningSnapshot({
          snapshot,
          provisioningName: snapshot.name,
        });
        configurationMatches = matchesLoyaltyRewardDiscountConfiguration({
          remote: remoteNode,
          rewardDefinition,
          startsAt: new Date(snapshot.startsAt),
          expiresAt: snapshotExpiresAt,
          expectedShopCurrency: snapshot.shopCurrency,
          shopifyCustomerId: redemption.account.shopper.shopifyCustomerId,
        });
      }
      const outcome = await reconcileGenericProvisioningDiscount({
        redemption,
        remoteDiscount: remoteNode,
        accountIsActive,
        configurationMatches,
        shopDomain: creds.shopDomain,
        accessToken: creds.accessToken,
        loyaltyMaintenancePermit,
      });
      return outcome === "healed"
        ? ("healed" as const)
        : ("deactivated" as const);
    } else {
      assertLoyaltyDiscountLookupMissIsTerminal({
        redemptionId,
        discountCode: redemption.shopifyDiscountCode,
        metadata: redemption.metadata,
      });
      await compensateDiscountSaga({
        redemptionId,
        reason: `Recovery found no Shopify discount for ${shopifyDiscountCode}`,
        targetStatus: WeleticRedemptionStatus.cancelled,
        loyaltyMaintenancePermit,
      });
      return "verified_absent" as const;
    }
  }

  return undefined;
}
