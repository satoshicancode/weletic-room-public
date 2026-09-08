import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { SHOPIFY_FLOW_TRIGGER_HANDLES } from "@/lib/weletic/loyalty/flow-triggers";
import {
  assertLoyaltyMaintenanceWriteAllowed,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import { ReferralCouponRewardSnapshotSchema } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  ShopifyStoreOperationalWritesBlockedError,
} from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticLoyaltyOutboxJob,
  WeleticLoyaltyOutboxJobStatus,
  WeleticLoyaltyOutboxJobType,
} from "@prisma/client";
import { z } from "zod";

export type EnqueueOutboxJobResult = {
  job: WeleticLoyaltyOutboxJob;
  created: boolean;
};

// ============================================================================
// 1. Zod Schemas and TypeScript Payload Types
// ============================================================================

/**
 * 1. HOLDING_PERIOD_RELEASE: Points maturity release after return window
 */
export const HoldingPeriodReleasePayloadSchema = z.object({
  orderId: z.string(),
  accountId: z.string(),
  shopperId: z.string(),
  pendingPoints: z.string(), // BigInt serialized as decimal string
  holdingPeriodDays: z.number().int().nonnegative(),
  availableAt: z.string(), // ISO timestamp
  grantId: z.string().optional(),
  sourceOrderExternalId: z.string().optional(),
  installationGeneration: z.string().min(1).max(64).nullable().optional(),
});
export type HoldingPeriodReleasePayload = z.infer<
  typeof HoldingPeriodReleasePayloadSchema
>;

/**
 * 2. INACTIVITY_EXPIRY: Inactivity points expiration
 */
export const InactivityExpiryPayloadSchema = z.object({
  accountId: z.string(),
  lastActivityAt: z.string(), // ISO timestamp
  expiryMonths: z.number().int().nonnegative(),
  expiryDays: z.number().int().nonnegative().optional(),
  expiryAt: z.string().datetime().optional(),
  stage: z.enum(["warning", "last_chance", "expire"]).optional(),
  policyVersion: z.number().int().nonnegative().optional(),
  pointsToExpire: z.string().optional(), // BigInt string
  installationGeneration: z.string().min(1).max(64).nullable().optional(),
});
export type InactivityExpiryPayload = z.infer<
  typeof InactivityExpiryPayloadSchema
>;

/**
 * 3. TIER_REVIEW: VIP tier maintenance, upgrade, and downgrade evaluation
 */
export const TierReviewPayloadSchema = z.object({
  accountId: z.string(),
  reviewPeriod: z
    .enum([
      "ROLLING_12M",
      "CALENDAR_YEAR",
      "LIFETIME",
      "rolling_12m",
      "calendar_year",
      "lifetime",
    ])
    .optional(),
  cycleYear: z.number().int().optional(),
  gracePeriodDays: z.number().int().positive().optional(),
  reason: z.string().optional(),
  installationGeneration: z.string().min(1).max(64).nullable().optional(),
});
export type TierReviewPayload = z.infer<typeof TierReviewPayloadSchema>;

/**
 * 4. METAFIELD_SYNC: Shopify Customer Metafield synchronization
 */
export const MetafieldSyncPayloadSchema = z.object({
  accountId: z.string(),
  shopifyCustomerId: z.string().optional(),
  triggerReason: z.string(),
  installationGeneration: z.string().min(1).max(64).nullable().optional(),
});
export type MetafieldSyncPayload = z.infer<typeof MetafieldSyncPayloadSchema>;

/**
 * 5. REDEMPTION_RECOVERY: Distributed 4-phase discount provisioning saga recovery
 */
export const RedemptionRecoveryPayloadSchema = z.object({
  redemptionId: z.string(),
  accountId: z.string(),
  rewardDefinitionId: z.string(),
  pointsCost: z.string(), // BigInt string
  shopifyDiscountCode: z.string(),
  artifactKind: z
    .enum(["discount_code", "gift_card", "store_credit"])
    .optional(),
  attemptCount: z.number().int().nonnegative().default(0),
  sagaPhase: z
    .enum(["provisioning", "compensating", "expiry"])
    .default("provisioning"),
  installationGeneration: z.string().min(1).max(64).nullable().optional(),
});
export type RedemptionRecoveryPayload = z.infer<
  typeof RedemptionRecoveryPayloadSchema
>;

/**
 * 6. BIRTHDAY_REWARD: Annual signed-customer birthday award
 */
export const BirthdayRewardPayloadSchema = z.object({
  accountId: z.string(),
  birthDate: z.string(),
  registeredAt: z.string(),
  calendarYear: z.number().int(),
  installationGeneration: z.string().min(1).max(64).nullable().optional(),
});
export type BirthdayRewardPayload = z.infer<typeof BirthdayRewardPayloadSchema>;

/**
 * 7. REFERRAL_REWARD_PROVISION: Issue a no-points-cost referral coupon
 */
export const ReferralRewardProvisionPayloadSchema = z.object({
  referralId: z.string(),
  qualificationOrderId: z.string(),
  accountId: z.string(),
  rewardDefinitionId: z.string(),
  side: z.enum(["advocate", "referee"]),
  // Optional only so jobs created before the immutable-snapshot rollout remain
  // recoverable. Every new referral qualification persists this snapshot.
  rewardSnapshot: ReferralCouponRewardSnapshotSchema.optional(),
});
export type ReferralRewardProvisionPayload = z.infer<
  typeof ReferralRewardProvisionPayloadSchema
>;

export const ShopperRewardProvisionPayloadSchema = z
  .object({
    redemptionId: z.string().min(1).max(191),
    claimId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();

/**
 * 8. VOUCHER_PRIVACY_CLEANUP: exact, audited remote voucher deactivation
 * after customer redaction, uninstall, or shop erasure. The durable cleanup
 * row owns the Shopify identity snapshot; the outbox carries only internal IDs.
 */
export const VoucherPrivacyCleanupPayloadSchema = z.union([
  z
    .object({
      cleanupId: z.string().min(1),
      redemptionId: z.string().min(1),
      accountId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      cleanupId: z.string().min(1),
      redemptionId: z.string().min(1),
      ownerKind: z.literal("shopper"),
      shopperId: z.string().min(1),
    })
    .strict(),
]);
export type VoucherPrivacyCleanupPayload = z.infer<
  typeof VoucherPrivacyCleanupPayloadSchema
>;

const FlowInstallationGenerationSchema = z
  .string()
  .min(1)
  .max(64)
  .nullable()
  .optional();
const FlowIntegerStringSchema = z.string().regex(/^-?\d+$/);
const FlowPositiveIntegerStringSchema = z.string().regex(/^[1-9]\d*$/);
const FlowPositiveDecimalStringSchema = z
  .string()
  .regex(/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/);

/** 9. FLOW_TRIGGER: durable native Shopify Flow event delivery. */
export const FlowTriggerPayloadSchema = z.discriminatedUnion("handle", [
  z
    .object({
      accountId: z.string().min(1),
      handle: z.literal(SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED),
      pointsDelta: FlowPositiveIntegerStringSchema,
      pointsBalance: FlowIntegerStringSchema,
      reason: z.string().trim().min(1).max(255),
      orderId: z.string().max(255).nullable().optional(),
      installationGeneration: FlowInstallationGenerationSchema,
    })
    .strict(),
  z
    .object({
      accountId: z.string().min(1),
      handle: z.literal(SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED),
      previousTier: z.string().max(255),
      newTier: z.string().trim().min(1).max(255),
      multiplier: FlowPositiveDecimalStringSchema,
      installationGeneration: FlowInstallationGenerationSchema,
    })
    .strict(),
  z
    .object({
      accountId: z.string().min(1),
      handle: z.literal(SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED),
      rewardType: z.string().trim().min(1).max(255),
      discountCode: z.string().trim().min(1).max(255),
      pointsSpent: z.string().regex(/^\d+$/),
      installationGeneration: FlowInstallationGenerationSchema,
    })
    .strict(),
  z
    .object({
      accountId: z.string().min(1),
      handle: z.literal(SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON),
      pointsExpiring: FlowPositiveIntegerStringSchema,
      expiryDate: z.string().datetime({ offset: true }),
      urgency: z.enum(["warning", "last_chance"]),
      policyVersion: z.number().int().nonnegative().optional(),
      installationGeneration: FlowInstallationGenerationSchema,
    })
    .strict(),
]);
export type FlowTriggerPayload = z.infer<typeof FlowTriggerPayloadSchema>;

/**
 * Union of all valid outbox payloads
 */
export type LoyaltyOutboxPayloadMap = {
  SHOPPER_REWARD_PROVISION: z.infer<typeof ShopperRewardProvisionPayloadSchema>;
  REVIEW_REQUEST_EMAIL: z.infer<typeof ReviewRequestEmailPayloadSchema>;
  REVIEW_SUMMARY_SYNC: z.infer<typeof ReviewSummarySyncPayloadSchema>;
  REVIEW_MEDIA_CLEANUP: z.infer<typeof ReviewMediaCleanupPayloadSchema>;
  HOLDING_PERIOD_RELEASE: HoldingPeriodReleasePayload;
  INACTIVITY_EXPIRY: InactivityExpiryPayload;
  TIER_REVIEW: TierReviewPayload;
  METAFIELD_SYNC: MetafieldSyncPayload;
  REDEMPTION_RECOVERY: RedemptionRecoveryPayload;
  BIRTHDAY_REWARD: BirthdayRewardPayload;
  REFERRAL_REWARD_PROVISION: ReferralRewardProvisionPayload;
  VOUCHER_PRIVACY_CLEANUP: VoucherPrivacyCleanupPayload;
  FLOW_TRIGGER: FlowTriggerPayload;
};

// ============================================================================
// 2. Transactional Enqueueing Service
// ============================================================================

export const ReviewRequestEmailPayloadSchema = z
  .object({
    requestId: z.string().min(1),
    installationGeneration: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();
export const ReviewSummarySyncPayloadSchema = z
  .object({
    productId: z.string().min(1),
    afterProductId: z.string().max(191).optional(),
    revision: z.string().max(64).optional(),
    installationGeneration: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();
export const ReviewMediaCleanupPayloadSchema = z
  .object({ mediaId: z.string().min(1) })
  .strict();

export interface EnqueueOutboxJobParams<
  T extends WeleticLoyaltyOutboxJobType = WeleticLoyaltyOutboxJobType,
> {
  storeId: string;
  jobType: T;
  payload: LoyaltyOutboxPayloadMap[T] | Record<string, unknown>;
  idempotencyKey?: string;
  scheduledFor?: Date;
  priority?: number;
  maxAttempts?: number;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

const OUTBOX_PROGRAM_TRANSACTION_FENCE = Symbol(
  "outbox-program-transaction-fence",
);
type InternallyFencedEnqueueOutboxJobParams<
  T extends WeleticLoyaltyOutboxJobType = WeleticLoyaltyOutboxJobType,
> = EnqueueOutboxJobParams<T> & {
  [OUTBOX_PROGRAM_TRANSACTION_FENCE]?: true;
};

/**
 * Maintenance leases defer ordinary loyalty work, while cleanup that removes
 * customer data or deactivates a potentially-live voucher must keep running.
 */
export function isMaintenanceGatedOutboxJob({
  jobType,
  payload,
}: {
  jobType: WeleticLoyaltyOutboxJobType;
  payload: unknown;
}) {
  // Review summaries are non-financial projections and must reconcile privacy
  // removals even while a loyalty financial-maintenance lease is active.
  if (
    jobType === "VOUCHER_PRIVACY_CLEANUP" ||
    jobType === "REVIEW_MEDIA_CLEANUP" ||
    jobType === "REVIEW_SUMMARY_SYNC"
  )
    return false;
  if (
    jobType === "REDEMPTION_RECOVERY" &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).sagaPhase === "compensating"
  ) {
    return false;
  }
  return true;
}

async function assertOutboxEnqueueMaintenanceAllowed({
  tx,
  storeId,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  // Caller-supplied operational transactions already hold the store/program
  // fence by contract. Re-locking the same program row observes the exact lease
  // generation without adding a later store lock or inverting lock order.
  const program = await lockLoyaltyProgramRowIfPresent({ tx, storeId });
  if (program) {
    assertLoyaltyMaintenanceWriteAllowed({
      storeId,
      metadata: program.metadata,
      permit: loyaltyMaintenancePermit,
    });
  }
  // Program-held callers cannot safely acquire the store row afterward.
  // Compliance freeze itself locks store -> program, so this plain read
  // linearizes either before that freeze commits or after it and observes the
  // frozen state without introducing a reverse row-lock edge.
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: { id: true, complianceState: true },
  });
  const legacyActiveTestFixture =
    process.env.NODE_ENV === "test" &&
    store != null &&
    (store as { complianceState?: unknown }).complianceState === undefined;
  if (
    !store ||
    (!legacyActiveTestFixture && store.complianceState !== "active")
  ) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action: "loyalty_outbox_enqueue:program_transaction",
      storeId,
      complianceState: store?.complianceState,
    });
  }
}

/**
 * Enqueues from a transaction that already owns the loyalty-program row. The
 * private symbol prevents callers from forging a bypass: this wrapper always
 * rechecks the exact program lease and non-locking store compliance state
 * before invoking the shared persistence path.
 */
export async function enqueueOutboxJobFromProgramTransaction<
  T extends WeleticLoyaltyOutboxJobType = WeleticLoyaltyOutboxJobType,
>(
  params: EnqueueOutboxJobParams<T> & { tx: Prisma.TransactionClient },
): Promise<EnqueueOutboxJobResult> {
  if (isMaintenanceGatedOutboxJob(params)) {
    await assertOutboxEnqueueMaintenanceAllowed({
      tx: params.tx,
      storeId: params.storeId,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    });
  }
  return enqueueOutboxJob({
    ...params,
    [OUTBOX_PROGRAM_TRANSACTION_FENCE]: true,
  } as InternallyFencedEnqueueOutboxJobParams<T>);
}

function isInstallationBoundOperationalJob({
  jobType,
  payload,
}: {
  jobType: WeleticLoyaltyOutboxJobType;
  payload: unknown;
}) {
  if (
    [
      "HOLDING_PERIOD_RELEASE",
      "INACTIVITY_EXPIRY",
      "TIER_REVIEW",
      "METAFIELD_SYNC",
      "BIRTHDAY_REWARD",
      "FLOW_TRIGGER",
      "REVIEW_REQUEST_EMAIL",
      "SHOPPER_REWARD_PROVISION",
      "REVIEW_SUMMARY_SYNC",
    ].includes(jobType)
  ) {
    return true;
  }
  return (
    jobType === "REDEMPTION_RECOVERY" &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).sagaPhase === "expiry"
  );
}

async function bindOperationalJobToInstallationGeneration({
  db,
  storeId,
  jobType,
  payload,
}: {
  db: Prisma.TransactionClient | typeof prisma;
  storeId: string;
  jobType: WeleticLoyaltyOutboxJobType;
  payload:
    | LoyaltyOutboxPayloadMap[WeleticLoyaltyOutboxJobType]
    | Record<string, unknown>;
}) {
  if (!isInstallationBoundOperationalJob({ jobType, payload })) return payload;

  const storeDelegate = (db as typeof prisma).weleticShopifyStore;
  if (!storeDelegate?.findUnique) {
    if (process.env.NODE_ENV === "test") {
      return {
        ...payload,
        installationGeneration: null,
      };
    }
    throw new Error(
      `Cannot bind ${jobType} outbox work to Shopify store ${storeId}.`,
    );
  }
  const store = await storeDelegate.findUnique({
    where: { id: storeId },
    select: { installationGeneration: true },
  });
  if (!store) {
    throw new Error(
      `Cannot bind ${jobType} outbox work to missing Shopify store ${storeId}.`,
    );
  }
  return {
    ...payload,
    installationGeneration: store.installationGeneration ?? null,
  };
}

/**
 * Validates payload data against the appropriate schema for the given job type.
 */
export function validateOutboxPayload(
  jobType: WeleticLoyaltyOutboxJobType,
  payload: unknown,
): void {
  switch (jobType) {
    case "SHOPPER_REWARD_PROVISION":
      ShopperRewardProvisionPayloadSchema.parse(payload);
      break;
    case "REVIEW_REQUEST_EMAIL":
      ReviewRequestEmailPayloadSchema.parse(payload);
      break;
    case "REVIEW_SUMMARY_SYNC":
      ReviewSummarySyncPayloadSchema.parse(payload);
      break;
    case "REVIEW_MEDIA_CLEANUP":
      ReviewMediaCleanupPayloadSchema.parse(payload);
      break;
    case "HOLDING_PERIOD_RELEASE":
      HoldingPeriodReleasePayloadSchema.parse(payload);
      break;
    case "INACTIVITY_EXPIRY":
      InactivityExpiryPayloadSchema.parse(payload);
      break;
    case "TIER_REVIEW":
      TierReviewPayloadSchema.parse(payload);
      break;
    case "METAFIELD_SYNC":
      MetafieldSyncPayloadSchema.parse(payload);
      break;
    case "REDEMPTION_RECOVERY":
      RedemptionRecoveryPayloadSchema.parse(payload);
      break;
    case "BIRTHDAY_REWARD":
      BirthdayRewardPayloadSchema.parse(payload);
      break;
    case "REFERRAL_REWARD_PROVISION":
      ReferralRewardProvisionPayloadSchema.parse(payload);
      break;
    case "VOUCHER_PRIVACY_CLEANUP":
      VoucherPrivacyCleanupPayloadSchema.parse(payload);
      break;
    case "FLOW_TRIGGER":
      FlowTriggerPayloadSchema.parse(payload);
      break;
    default:
      throw new Error(`Unsupported job type: ${jobType}`);
  }
}

/**
 * Transactionally enqueues a durable outbox job.
 * If an existing job with the same compound [storeId, idempotencyKey] exists,
 * it returns the existing job without throwing duplicate key errors.
 */
export async function enqueueOutboxJob<
  T extends WeleticLoyaltyOutboxJobType = WeleticLoyaltyOutboxJobType,
>(params: EnqueueOutboxJobParams<T>): Promise<EnqueueOutboxJobResult> {
  const internallyProgramFenced =
    (params as InternallyFencedEnqueueOutboxJobParams<T>)[
      OUTBOX_PROGRAM_TRANSACTION_FENCE
    ] === true;
  const {
    storeId,
    jobType,
    payload,
    idempotencyKey,
    scheduledFor = new Date(),
    priority = 0,
    maxAttempts = 5,
    loyaltyMaintenancePermit,
    tx,
  } = params;

  // Validate payload matches schema
  validateOutboxPayload(jobType, payload);

  const maintenanceGated = isMaintenanceGatedOutboxJob({ jobType, payload });
  if (maintenanceGated && !tx) {
    return withActiveStoreLoyaltyMutation({
      storeId,
      action: `loyalty_outbox_enqueue:${jobType}`,
      loyaltyMaintenancePermit,
      operation: (transaction) =>
        enqueueOutboxJobFromProgramTransaction({
          ...params,
          loyaltyMaintenancePermit,
          tx: transaction,
        }),
    });
  }

  const db = tx ?? prisma;
  if (maintenanceGated && tx && !internallyProgramFenced) {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: `loyalty_outbox_enqueue:${jobType}`,
      loyaltyMaintenancePermit,
      tx,
    });
  }

  const jobId = createWeleticId("woutbox_");

  // Check idempotency if key provided
  if (idempotencyKey) {
    const existing = await db.weleticLoyaltyOutboxJob.findUnique({
      where: {
        storeId_idempotencyKey: {
          storeId,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      return { job: existing, created: false };
    }
  }

  const persistedPayload = await bindOperationalJobToInstallationGeneration({
    db,
    storeId,
    jobType,
    payload,
  });

  try {
    const job = await db.weleticLoyaltyOutboxJob.create({
      data: {
        id: jobId,
        storeId,
        jobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: persistedPayload as unknown as Prisma.InputJsonValue,
        idempotencyKey: idempotencyKey ?? null,
        scheduledFor,
        priority,
        maxAttempts,
        attempts: 0,
      },
    });
    return { job, created: true };
  } catch (error: any) {
    // Handle concurrent insertion with duplicate idempotency key
    if (
      idempotencyKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.weleticLoyaltyOutboxJob.findUnique({
        where: {
          storeId_idempotencyKey: {
            storeId,
            idempotencyKey,
          },
        },
      });
      if (existing) return { job: existing, created: false };
    }
    throw error;
  }
}

/**
 * Batch enqueues multiple outbox jobs within a transaction.
 */
export async function enqueueOutboxJobs(
  jobs: EnqueueOutboxJobParams[],
  tx?: Prisma.TransactionClient,
): Promise<number> {
  let count = 0;
  for (const job of jobs) {
    const result = await enqueueOutboxJob({ ...job, tx });
    if (result.created) count++;
  }
  return count;
}

// Re-export worker and handler helpers for convenience
export {
  calculateExponentialBackoff,
  executeOutboxJob,
  handleBirthdayReward,
  handleHoldingPeriodRelease,
  handleInactivityExpiry,
  handleMetafieldSync,
  handleRedemptionRecovery,
  handleReferralRewardProvision,
  handleTierReview,
  processOutboxJobsBatch,
  reapStaleOutboxLocks,
} from "@/lib/weletic/loyalty/outbox-worker";
