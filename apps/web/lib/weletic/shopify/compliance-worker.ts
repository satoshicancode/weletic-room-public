import { decrypt, encrypt } from "@/lib/encryption";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { generateRandomName } from "@/lib/names";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { deleteExpiredShopperCouponUsesBatch } from "@/lib/weletic/loyalty/coupon-use-retention";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import {
  redactReferralFriendClaimsForEmail,
  redactReferralFriendClaimsForShopBatch,
} from "@/lib/weletic/loyalty/referral-friend-claim";
import {
  prepareWeleticShopperRedaction,
  processWeleticLoyaltyAccountPrivacyScrubStep,
  scrubCustomerContextJsonValue,
  scrubWeleticShopperCustomerContext,
  SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY,
  type WeleticCustomerPrivacyScrubPhase,
} from "@/lib/weletic/loyalty/shopper-privacy";
import {
  getVoucherCleanupRequestTerminalCounts,
  processAccountVoucherEnumerationComplianceStep,
  processStoreVoucherCleanupComplianceStep,
} from "@/lib/weletic/loyalty/voucher-privacy-cleanup";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import {
  attachReviewIncentivePolicyExports,
  reviewIncentiveClaimExportSelect,
  reviewIncentiveInvalidationExportSelect,
  reviewIncentivePolicyExportSelect,
  reviewParticipationExportSelect,
} from "@/lib/weletic/reviews/incentive-export";
import {
  purgeNativeReviewsBatch,
  redactNativeReviewsBatch,
} from "@/lib/weletic/reviews/privacy";
import {
  addRetentionDays,
  getShopifyComplianceExportRetentionHours,
  getShopifyFinancialRetentionDays,
} from "@/lib/weletic/shopify/compliance-config";
import {
  SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
  withShopifyCustomerSettlementLocks,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  deleteShopifyCheckoutCache,
  purgeShopifyCustomerPrivacyCacheBatch,
  purgeShopifyLegacyCustomerPrivacyCache,
  purgeShopifyStorePrivacyCacheBatch,
  type ShopifyPrivacyCachePurgeCursor,
} from "@/lib/weletic/shopify/privacy-cache";
import {
  createAllShopifyDerivedPrivacyDigests,
  deriveAllShopifyCustomerPrivacyIdentities,
  deriveAllShopifyShopPrivacyIdentities,
  getShopifyCustomerPrivacyPseudonym,
  parseShopifyCustomerPrivacyPseudonym,
  ShopifyCustomerPrivacyOwnerConflictError,
  upsertShopifyCustomerPrivacyTombstones,
  upsertShopifyShopPrivacyTombstone,
} from "@/lib/weletic/shopify/privacy-identity";
import {
  invalidateShopifyStoreDomainCache,
  normalizeShopDomain,
} from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma, WeleticVoucherCleanupSource } from "@prisma/client";
import { processAppUninstalledComplianceStep } from "app/(ee)/api/shopify/integration/webhook/app-uninstalled";
import {
  deleteComplianceArtifactsForCustomerRedactionBatch,
  deleteComplianceArtifactsForStoreBatch,
  deleteExpiredComplianceArtifactsBatch,
  deliverComplianceExportReference,
  storeEncryptedComplianceArtifact,
} from "./compliance-artifacts";
import {
  dispatchDurableShopifyComplianceRequest,
  ShopifyComplianceDispatchUnavailableError,
} from "./compliance-dispatch";
import {
  enqueueShopifyComplianceWorker,
  freezeShopifyStoreForUninstall,
} from "./compliance-ingress";
import { deleteExpiredShopifyPrivacyTombstonesBatch } from "./compliance-retention";
import type { DurableComplianceSubject } from "./compliance-types";
import { SHOPIFY_SESSION_MISSING_ISSUE_KIND } from "./session-health-contract";
import { purgeShopifyStaffPrivacyBatch } from "./staff-privacy";

const PAGE_SIZE = 100;
const SHOP_REDACT_PAGE_SIZE = 20;
const LEASE_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_COMPLIANCE_RECOVERY_BATCH_SIZE = 3;
export const COMPLIANCE_RECOVERY_TIME_BUDGET_MS = 40_000;

export function boundedComplianceRecoveryBatchSize(
  value: number,
  fallback = MAX_COMPLIANCE_RECOVERY_BATCH_SIZE,
) {
  return Number.isInteger(value)
    ? Math.min(MAX_COMPLIANCE_RECOVERY_BATCH_SIZE, Math.max(1, value))
    : fallback;
}

interface StepState {
  completed: boolean;
  phase: string;
  cursor?: Prisma.InputJsonValue | typeof Prisma.DbNull;
  progress?: Prisma.InputJsonValue | typeof Prisma.DbNull;
  payloadCiphertext?: string | null;
  delaySeconds?: number;
}

interface ComplianceCursor {
  lastId?: string;
  sequence?: number;
}

interface ShopAccountPrivacyCursor {
  afterAccountId?: string;
  accountId?: string;
  accountPhase?: WeleticCustomerPrivacyScrubPhase;
  accountCursor?: Prisma.JsonValue | null;
  redactedAt?: string;
}

interface ComplianceProgress {
  chunks?: number;
  records?: number;
  ownerShopperId?: string;
  ownerAccountId?: string;
  ownerLegacyCustomerId?: string;
  [key: string]: unknown;
}

function complianceArtifactLease(request: any) {
  if (
    typeof request.lockedBy !== "string" ||
    !request.lockedBy ||
    !Number.isInteger(request.leaseVersion)
  ) {
    throw new Error("Compliance export worker lease is unavailable.");
  }
  return {
    workerId: request.lockedBy,
    leaseVersion: request.leaseVersion as number,
  };
}

function voucherEnumerationDelaySeconds(cursor: unknown) {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return 0;
  const value = cursor as Record<string, unknown>;
  if (typeof value.afterRedemptionId === "string") return 0;
  if (typeof value.drainUntil !== "string") return 0;
  const remainingMs = new Date(value.drainUntil).getTime() - Date.now();
  return remainingMs > 0
    ? Math.min(30, Math.max(1, Math.ceil(remainingMs / 1000)))
    : 0;
}

function withCustomerComplianceLock<T>({
  request,
  subject,
  fn,
}: {
  request: any;
  subject: DurableComplianceSubject;
  fn: () => Promise<T>;
}) {
  if (subject.customerId) {
    return withShopifyCustomerSettlementLocks({
      workspaceId: request.store.projectId,
      storeId: request.storeId,
      shopifyCustomerId: subject.customerId,
      fn,
    });
  }
  if (!request.subjectDigest) {
    throw new Error(
      "Email-only customer redaction is missing its durable subject digest.",
    );
  }
  return withDistributedLock({
    key: `shopify-customer-privacy-email:${request.storeId}:${request.subjectDigest}`,
    ttlSeconds: SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
    fn,
  });
}

export class ComplianceOperatorReviewError extends Error {}
class ComplianceLeaseLostError extends Error {}

function parseJsonObject<T>(value: Prisma.JsonValue | null): T {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as T)
    : ({} as T);
}

function readSubject(payloadCiphertext: string | null) {
  if (!payloadCiphertext) {
    throw new Error("Durable compliance request payload is unavailable.");
  }
  return JSON.parse(decrypt(payloadCiphertext)) as DurableComplianceSubject;
}

export async function resolveCustomerSubject({
  storeId,
  workspaceId,
  subject,
}: {
  storeId: string;
  workspaceId: string;
  subject: DurableComplianceSubject;
}) {
  const privacyIdentities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId: subject.customerId,
    email: subject.customerEmail,
  });
  const tombstones =
    privacyIdentities.length > 0
      ? await prisma.weleticShopifyCustomerPrivacyTombstone.findMany({
          where: {
            storeId,
            expiresAt: { gt: new Date() },
            OR: privacyIdentities.map((identity) => ({
              identityKind: identity.identityKind,
              identityKeyId: identity.identityKeyId,
              customerDigest: identity.customerDigest,
            })),
          },
          take: Math.min(50, privacyIdentities.length + 1),
          select: { shopperId: true, accountId: true },
        })
      : [];
  const tombstoneOwners = new Map(
    tombstones.map((row) => [
      `${row.shopperId ?? ""}:${row.accountId ?? ""}`,
      row,
    ]),
  );
  if (tombstoneOwners.size > 1) {
    throw new ComplianceOperatorReviewError(
      "Shopify compliance identity matched multiple retained privacy owners.",
    );
  }
  const tombstoneOwner = tombstoneOwners.values().next().value as
    | { shopperId: string | null; accountId: string | null }
    | undefined;

  if (subject.customerId) {
    const [legacy, shopper] = await Promise.all([
      prisma.customer.findUnique({
        where: {
          projectId_externalId: {
            projectId: workspaceId,
            externalId: subject.customerId,
          },
        },
        select: { id: true },
      }),
      prisma.weleticShopper.findUnique({
        where: {
          storeId_shopifyCustomerId: {
            storeId,
            shopifyCustomerId: subject.customerId,
          },
        },
        select: { id: true, loyaltyAccount: { select: { id: true } } },
      }),
    ]);
    if (
      shopper &&
      tombstoneOwner &&
      (tombstoneOwner.shopperId !== shopper.id ||
        tombstoneOwner.accountId !== (shopper.loyaltyAccount?.id ?? null))
    ) {
      throw new ComplianceOperatorReviewError(
        "Shopify compliance identity conflicts with its retained privacy owner.",
      );
    }
    return {
      customerId: subject.customerId,
      legacyCustomerId: legacy?.id ?? null,
      shopperId: shopper?.id ?? tombstoneOwner?.shopperId ?? null,
      accountId:
        shopper?.loyaltyAccount?.id ?? tombstoneOwner?.accountId ?? null,
      tombstoned: Boolean(tombstoneOwner),
    };
  }
  if (!subject.customerEmail) {
    return {
      customerId: null,
      legacyCustomerId: null,
      shopperId: tombstoneOwner?.shopperId ?? null,
      accountId: tombstoneOwner?.accountId ?? null,
      tombstoned: Boolean(tombstoneOwner),
    };
  }

  const [shoppers, customers] = await Promise.all([
    prisma.weleticShopper.findMany({
      where: { storeId, email: subject.customerEmail },
      take: 3,
      orderBy: { id: "asc" },
      select: {
        id: true,
        shopifyCustomerId: true,
        loyaltyAccount: { select: { id: true } },
      },
    }),
    prisma.customer.findMany({
      where: { projectId: workspaceId, email: subject.customerEmail },
      take: 3,
      orderBy: { id: "asc" },
      select: { id: true, externalId: true },
    }),
  ]);
  const customerIds = customers
    .map((row) => row.externalId)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .map(String);
  const candidates = new Set([
    ...shoppers.map((row) => String(row.shopifyCustomerId)),
    ...customerIds,
  ]);
  const unboundCustomers = customers.filter(
    (row) => row.externalId === null || row.externalId === "",
  );
  if (
    candidates.size > 1 ||
    unboundCustomers.length > 1 ||
    (candidates.size > 0 && unboundCustomers.length > 0)
  ) {
    throw new ComplianceOperatorReviewError(
      "Email-only Shopify compliance identity matched multiple customer subjects.",
    );
  }
  const customerId = candidates.values().next().value ?? null;
  const matchingLegacy = customerId
    ? customers.find((row) => String(row.externalId) === customerId)
    : unboundCustomers[0];
  const matchingShopper = customerId
    ? shoppers.find((row) => String(row.shopifyCustomerId) === customerId)
    : undefined;
  const liveOwner = matchingShopper
    ? {
        shopperId: matchingShopper.id,
        accountId: matchingShopper.loyaltyAccount?.id ?? null,
      }
    : null;
  if (
    liveOwner &&
    tombstoneOwner &&
    (liveOwner.shopperId !== tombstoneOwner.shopperId ||
      liveOwner.accountId !== tombstoneOwner.accountId)
  ) {
    throw new ComplianceOperatorReviewError(
      "Email-only Shopify compliance identity conflicts with its retained privacy owner.",
    );
  }
  return {
    customerId,
    legacyCustomerId: matchingLegacy?.id ?? null,
    shopperId: liveOwner?.shopperId ?? tombstoneOwner?.shopperId ?? null,
    accountId: liveOwner?.accountId ?? tombstoneOwner?.accountId ?? null,
    tombstoned: Boolean(tombstoneOwner),
  };
}

function exportExpiry() {
  return new Date(
    Date.now() + getShopifyComplianceExportRetentionHours() * 60 * 60 * 1000,
  );
}

async function accountContext(
  storeId: string,
  customerId: string | null,
  internal?: { shopperId?: string; accountId?: string },
) {
  if (internal?.shopperId || internal?.accountId) {
    return {
      shopperId: internal.shopperId ?? null,
      accountId: internal.accountId ?? null,
    };
  }
  if (!customerId) return { shopperId: null, accountId: null };
  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: { storeId, shopifyCustomerId: customerId },
    },
    select: { id: true, loyaltyAccount: { select: { id: true } } },
  });
  return {
    shopperId: shopper?.id ?? null,
    accountId: shopper?.loyaltyAccount?.id ?? null,
  };
}

const EXPORT_PHASES = [
  "export_identity",
  "export_ledger",
  "export_earn_grants",
  "export_order_line_earns",
  "export_backfill_order_credits",
  "export_backfill_order_snapshots",
  "export_backfill_preview",
  "export_redemptions",
  "export_tier_history",
  "export_advocate_referrals",
  "export_referee_referrals",
  "export_friend_referral_claims",
  "export_orders",
  "export_native_reviews",
  "export_review_requests",
  "export_review_media",
  "export_review_incentive_claims",
  "export_coupon_uses",
  "export_review_incentive_invalidations",
] as const;

type ExportPhase = (typeof EXPORT_PHASES)[number];

function nextExportPhase(phase: ExportPhase) {
  const index = EXPORT_PHASES.indexOf(phase);
  return EXPORT_PHASES[index + 1] ?? "export_manifest";
}

async function exportIdentityChunk({
  requestId,
  storeId,
  workspaceId,
  subject,
  lease,
}: {
  requestId: string;
  storeId: string;
  workspaceId: string;
  subject: DurableComplianceSubject;
  lease: { workerId: string; leaseVersion: number };
}) {
  const customerId = subject.customerId ?? null;
  const [shopper, customer] = await Promise.all([
    subject.shopperId
      ? prisma.weleticShopper.findUnique({
          where: { id: subject.shopperId },
          include: { loyaltyAccount: true },
        })
      : customerId
        ? prisma.weleticShopper.findUnique({
            where: {
              storeId_shopifyCustomerId: {
                storeId,
                shopifyCustomerId: customerId,
              },
            },
            include: { loyaltyAccount: true },
          })
        : null,
    subject.legacyCustomerId
      ? prisma.customer.findUnique({
          where: { id: subject.legacyCustomerId },
        })
      : customerId
        ? prisma.customer.findUnique({
            where: {
              projectId_externalId: {
                projectId: workspaceId,
                externalId: customerId,
              },
            },
          })
        : null,
  ]);
  await storeEncryptedComplianceArtifact({
    requestId,
    storeId,
    kind: "identity",
    sequence: 0,
    expiresAt: exportExpiry(),
    lease,
    value: {
      customerId: null,
      requestedOrderExternalIds: subject.orderExternalIds,
      shopper,
      legacyCustomer: customer,
    },
  });
}

async function fetchExportPage({
  phase,
  storeId,
  accountId,
  shopperId,
  referralEmailDigests,
  orderExternalIds,
  lastId,
}: {
  phase: Exclude<ExportPhase, "export_identity">;
  storeId: string;
  accountId: string | null;
  shopperId: string | null;
  referralEmailDigests: string[];
  orderExternalIds: string[];
  lastId?: string;
}) {
  const page = {
    take: PAGE_SIZE + 1,
    orderBy: { id: "asc" as const },
    ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
  };
  if (phase === "export_native_reviews") {
    return shopperId
      ? prisma.weleticProductReview.findMany({
          ...page,
          where: { storeId, shopperId },
          select: {
            ...reviewParticipationExportSelect,
            id: true,
            requestId: true,
            productId: true,
            status: true,
            rating: true,
            title: true,
            body: true,
            displayName: true,
            merchantReply: true,
            verifiedPurchase: true,
            incentivized: true,
            rewardStatus: true,
            rewardLedgerId: true,
            createdAt: true,
            publishedAt: true,
            redactedAt: true,
          },
        })
      : [];
  }
  if (phase === "export_review_requests") {
    // Explicit projection excludes bearer hashes, encrypted delivery tokens and
    // worker leases. An export must not grant submission authority.
    return shopperId
      ? prisma.weleticReviewRequest.findMany({
          ...page,
          where: { storeId, shopperId },
          select: {
            incentivePolicyId: true,
            incentivePolicy: { select: reviewIncentivePolicyExportSelect },
            id: true,
            orderId: true,
            productId: true,
            status: true,
            fulfilledAt: true,
            sendAt: true,
            expiresAt: true,
            sentAt: true,
            submittedAt: true,
            cancelledAt: true,
            cancellationReason: true,
            createdAt: true,
          },
        })
      : [];
  }
  if (phase === "export_review_incentive_claims") {
    return shopperId
      ? attachReviewIncentivePolicyExports({
          db: prisma,
          storeId,
          rows: await prisma.weleticReviewIncentiveClaim.findMany({
            ...page,
            where: { storeId, shopperId },
            select: reviewIncentiveClaimExportSelect,
          }),
        })
      : [];
  }
  if (phase === "export_review_incentive_invalidations") {
    return shopperId
      ? prisma.weleticReviewIncentiveInvalidation.findMany({
          ...page,
          where: { storeId, shopperId },
          select: reviewIncentiveInvalidationExportSelect,
        })
      : [];
  }
  if (phase === "export_review_media") {
    const records = shopperId
      ? await prisma.weleticReviewMedia.findMany({
          ...page,
          where: {
            storeId,
            request: { storeId, shopperId },
            status: "uploaded",
          },
          select: {
            id: true,
            requestId: true,
            reviewId: true,
            contentType: true,
            sizeBytes: true,
            objectKey: true,
            createdAt: true,
          },
        })
      : [];
    return Promise.all(
      records.map(async ({ objectKey, ...record }) => ({
        ...record,
        downloadUrl: await storage.getSignedDownloadUrl({
          key: objectKey,
          bucket: "private",
          expiresIn: Math.min(
            604800,
            getShopifyComplianceExportRetentionHours() * 3600,
          ),
        }),
      })),
    );
  }
  if (phase === "export_ledger") {
    return accountId
      ? prisma.weleticPointsLedgerEntry.findMany({
          ...page,
          where: { storeId, accountId },
        })
      : [];
  }
  if (phase === "export_earn_grants") {
    const owners = [
      ...(accountId ? [{ accountId }] : []),
      ...(shopperId ? [{ shopperId }] : []),
    ];
    return owners.length > 0
      ? prisma.weleticLoyaltyEarnGrant.findMany({
          ...page,
          where: { storeId, OR: owners },
        })
      : [];
  }
  if (phase === "export_backfill_preview") {
    const owners = [
      ...(accountId ? [{ accountId }] : []),
      ...(shopperId ? [{ shopperId }] : []),
    ];
    return owners.length > 0
      ? prisma.weleticLoyaltyBackfillPreviewItem.findMany({
          ...page,
          where: { job: { storeId }, OR: owners },
        })
      : [];
  }
  if (phase === "export_backfill_order_snapshots") {
    const owners = [
      ...(accountId ? [{ accountId }] : []),
      ...(shopperId ? [{ shopperId }] : []),
    ];
    return owners.length > 0
      ? prisma.weleticLoyaltyBackfillOrderSnapshot.findMany({
          ...page,
          where: { storeId, OR: owners },
        })
      : [];
  }
  if (phase === "export_backfill_order_credits") {
    return accountId
      ? prisma.weleticLoyaltyBackfillOrderCredit.findMany({
          ...page,
          where: { storeId, accountId },
        })
      : [];
  }
  if (phase === "export_order_line_earns") {
    const owners = [
      ...(accountId ? [{ accountId }] : []),
      ...(shopperId ? [{ shopperId }] : []),
    ];
    return owners.length > 0
      ? prisma.weleticLoyaltyOrderLineEarn.findMany({
          ...page,
          where: { storeId, grant: { storeId, OR: owners } },
        })
      : [];
  }
  if (phase === "export_coupon_uses") {
    return shopperId
      ? prisma.weleticRewardCouponUse.findMany({
          ...page,
          where: { storeId, shopperId },
        })
      : [];
  }
  if (phase === "export_redemptions") {
    const owners = [
      ...(accountId ? [{ accountId }] : []),
      ...(shopperId ? [{ shopperId, accountId: null }] : []),
    ];
    return owners.length > 0
      ? prisma.weleticRewardRedemption.findMany({
          ...page,
          where: { storeId, OR: owners },
        })
      : [];
  }
  if (phase === "export_tier_history") {
    return accountId
      ? prisma.weleticLoyaltyTierHistory.findMany({
          ...page,
          where: { accountId },
        })
      : [];
  }
  if (phase === "export_advocate_referrals") {
    return accountId
      ? prisma.weleticLoyaltyReferral.findMany({
          ...page,
          where: { storeId, advocateAccountId: accountId },
        })
      : [];
  }
  if (phase === "export_referee_referrals") {
    return accountId
      ? prisma.weleticLoyaltyReferral.findMany({
          ...page,
          where: { storeId, refereeAccountId: accountId },
        })
      : [];
  }
  if (phase === "export_friend_referral_claims") {
    return referralEmailDigests.length > 0
      ? prisma.weleticLoyaltyReferral.findMany({
          ...page,
          where: {
            storeId,
            friendEmailDigest: { in: referralEmailDigests },
          },
          select: {
            id: true,
            status: true,
            qualifyingOrderId: true,
            friendRewardDefinitionId: true,
            friendShopifyDiscountCode: true,
            friendRewardProvisionedAt: true,
            friendRewardEmailedAt: true,
            friendRewardExpiresAt: true,
            fraudReason: true,
            fraudSignals: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : [];
  }

  const orderPredicates = [
    ...(shopperId ? [{ shopperId }] : []),
    ...(orderExternalIds.length > 0
      ? [{ externalId: { in: orderExternalIds } }]
      : []),
  ];
  return orderPredicates.length > 0
    ? prisma.weleticCommerceOrder.findMany({
        ...page,
        where: { storeId, OR: orderPredicates },
        include: { lines: { include: { calculations: true } }, refunds: true },
      })
    : [];
}

export async function processCustomerDataRequestStep(
  request: any,
): Promise<StepState> {
  let subject = readSubject(request.payloadCiphertext);
  const cursor = parseJsonObject<ComplianceCursor>(request.cursor);
  const progress = parseJsonObject<ComplianceProgress>(request.progress);
  const lease = complianceArtifactLease(request);

  if (request.phase === "received") {
    const referralEmailDigests = subject.customerEmail
      ? createAllShopifyDerivedPrivacyDigests({
          purpose: "referral_email",
          values: [request.storeId, subject.customerEmail],
        })
      : subject.referralEmailDigests;
    const resolved = await resolveCustomerSubject({
      storeId: request.storeId,
      workspaceId: request.store.projectId,
      subject,
    });
    subject = {
      ...subject,
      customerId: undefined,
      customerEmail: undefined,
      referralEmailDigests,
      legacyCustomerId: resolved.legacyCustomerId ?? undefined,
      shopperId: resolved.shopperId ?? undefined,
      accountId: resolved.accountId ?? undefined,
    };
    return {
      completed: false,
      phase: "export_identity",
      cursor: Prisma.DbNull,
      progress: {
        chunks: 0,
        records: 0,
        ...(resolved.shopperId ? { ownerShopperId: resolved.shopperId } : {}),
        ...(resolved.accountId ? { ownerAccountId: resolved.accountId } : {}),
        ...(resolved.legacyCustomerId
          ? { ownerLegacyCustomerId: resolved.legacyCustomerId }
          : {}),
      },
      payloadCiphertext: encrypt(JSON.stringify(subject)),
    };
  }

  if (request.phase === "export_identity") {
    await exportIdentityChunk({
      requestId: request.id,
      storeId: request.storeId,
      workspaceId: request.store.projectId,
      subject,
      lease,
    });
    return {
      completed: false,
      phase: "export_ledger",
      cursor: Prisma.DbNull,
      progress: {
        ...progress,
        chunks: Number(progress.chunks ?? 0) + 1,
      },
    };
  }

  if ((EXPORT_PHASES as readonly string[]).includes(request.phase)) {
    const phase = request.phase as Exclude<ExportPhase, "export_identity">;
    const context = await accountContext(
      request.storeId,
      subject.customerId ?? null,
      subject,
    );
    const records = await fetchExportPage({
      phase,
      storeId: request.storeId,
      accountId: context.accountId,
      shopperId: context.shopperId,
      referralEmailDigests: subject.referralEmailDigests ?? [],
      orderExternalIds: subject.orderExternalIds,
      lastId: cursor.lastId,
    });
    const hasMore = records.length > PAGE_SIZE;
    const boundedRecords = records.slice(0, PAGE_SIZE);
    const sequence = Number(cursor.sequence ?? 0);
    if (boundedRecords.length > 0) {
      await storeEncryptedComplianceArtifact({
        requestId: request.id,
        storeId: request.storeId,
        kind: phase.replace(/^export_/, ""),
        sequence,
        expiresAt: exportExpiry(),
        lease,
        value: boundedRecords,
      });
    }
    if (hasMore) {
      return {
        completed: false,
        phase,
        cursor: {
          lastId: boundedRecords[boundedRecords.length - 1].id,
          sequence: sequence + 1,
        },
        progress: {
          ...progress,
          chunks:
            Number(progress.chunks ?? 0) + (boundedRecords.length > 0 ? 1 : 0),
          records: Number(progress.records ?? 0) + boundedRecords.length,
        },
      };
    }
    return {
      completed: false,
      phase: nextExportPhase(phase),
      cursor: Prisma.DbNull,
      progress: {
        ...progress,
        chunks:
          Number(progress.chunks ?? 0) + (boundedRecords.length > 0 ? 1 : 0),
        records: Number(progress.records ?? 0) + boundedRecords.length,
      },
    };
  }

  if (request.phase === "export_manifest") {
    return { completed: false, phase: "export_notify" };
  }

  if (request.phase === "export_notify") {
    await deliverComplianceExportReference({
      requestId: request.id,
      storeId: request.storeId,
      workspaceId: request.store.projectId,
      shopDomain: request.shopDomain,
      lease,
    });
    return { completed: true, phase: "completed" };
  }

  throw new Error(`Unsupported customer data request phase: ${request.phase}`);
}

function customerOwnerProgress(
  resolved: {
    shopperId?: string | null;
    accountId?: string | null;
    legacyCustomerId?: string | null;
  },
  current: ComplianceProgress = {},
): Prisma.InputJsonObject {
  return {
    ...current,
    ...(resolved.shopperId ? { ownerShopperId: resolved.shopperId } : {}),
    ...(resolved.accountId ? { ownerAccountId: resolved.accountId } : {}),
    ...(resolved.legacyCustomerId
      ? { ownerLegacyCustomerId: resolved.legacyCustomerId }
      : {}),
  } as Prisma.InputJsonObject;
}

function mergeComplianceProgress(
  current: ComplianceProgress,
  next: unknown,
): Prisma.InputJsonObject {
  return {
    ...current,
    ...parseJsonObject<Record<string, Prisma.InputJsonValue>>(next as any),
  } as Prisma.InputJsonObject;
}

function customerExportMatchFilters(request: any) {
  const progress = parseJsonObject<ComplianceProgress>(request.progress);
  const subject = readSubject(request.payloadCiphertext);
  const rotationAwareIdentities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId: request.storeId,
    shopifyCustomerId: subject.customerId,
    email: subject.customerEmail,
  });
  const ownerKeys = [
    "ownerShopperId",
    "ownerAccountId",
    "ownerLegacyCustomerId",
  ] as const;
  const redactionOwnerKeys = ownerKeys.filter(
    (key) => typeof progress[key] === "string" && Boolean(progress[key]),
  );
  // A scrubbed export is indeterminate when it has no owner key in common
  // with the redaction. Match that bounded set conservatively so projection
  // changes (legacy Customer -> Shopper/Account) cannot resurrect a bearer.
  // If the redaction itself has no resolved owner, no scrubbed owner-bearing
  // export has a comparable identity channel. In that case availability yields
  // to permanent privacy revocation and every scrubbed export in the store is
  // superseded. Once at least one owner is resolved, only exports lacking every
  // shared owner key remain indeterminate.
  const indeterminateOwnerKeys = redactionOwnerKeys;
  return [
    ...rotationAwareIdentities.map((identity) => ({
      subjectKind: identity.identityKind,
      subjectKeyId: identity.identityKeyId,
      subjectDigest: identity.customerDigest,
    })),
    ...(progress.ownerShopperId
      ? [
          {
            progress: {
              path: "$.ownerShopperId",
              equals: progress.ownerShopperId,
            },
          },
        ]
      : []),
    ...(progress.ownerAccountId
      ? [
          {
            progress: {
              path: "$.ownerAccountId",
              equals: progress.ownerAccountId,
            },
          },
        ]
      : []),
    ...(progress.ownerLegacyCustomerId
      ? [
          {
            progress: {
              path: "$.ownerLegacyCustomerId",
              equals: progress.ownerLegacyCustomerId,
            },
          },
        ]
      : []),
    // Completed exports intentionally scrub their subject HMACs. Permanently
    // supersede every row that has no owner key comparable with this redaction
    // so a bearer never becomes usable again after the redaction completes.
    {
      AND: [
        {
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
        },
        ...indeterminateOwnerKeys.map((key) => ({
          progress: {
            path: `$.${key}`,
            equals: Prisma.AnyNull,
          },
        })),
      ],
    },
  ];
}

function customerExportSupersededPhase(redactionRequestId: string) {
  return `superseded_by_customer_redact:${redactionRequestId}`;
}

async function withComplianceMutationLease<T>({
  request,
  allowRedactedStore = false,
  fn,
}: {
  request: any;
  allowRedactedStore?: boolean;
  fn: (
    tx: Prisma.TransactionClient,
    store: { id: string; complianceState: string },
  ) => Promise<T>;
}) {
  if (
    typeof request.lockedBy !== "string" ||
    !request.lockedBy ||
    !Number.isInteger(request.leaseVersion)
  ) {
    throw new ComplianceLeaseLostError(
      "Compliance request lease no longer authorizes privacy mutation.",
    );
  }
  return prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<
      Array<{ id: string; complianceState: string }>
    >(Prisma.sql`
      SELECT id, complianceState
      FROM WeleticShopifyStore
      WHERE id = ${request.storeId}
      LIMIT 1
      FOR UPDATE
    `);
    if (
      !stores[0] ||
      (!allowRedactedStore && stores[0].complianceState === "redacted")
    ) {
      throw new ComplianceLeaseLostError(
        "Compliance request lease no longer authorizes privacy mutation.",
      );
    }
    const requests = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        lockedBy: string | null;
        leaseVersion: number;
      }>
    >(Prisma.sql`
      SELECT id, status, lockedBy, leaseVersion
      FROM WeleticShopifyComplianceRequest
      WHERE id = ${request.id}
        AND storeId = ${request.storeId}
      LIMIT 1
      FOR UPDATE
    `);
    const current = requests[0];
    if (
      !current ||
      current.status !== "processing" ||
      current.lockedBy !== request.lockedBy ||
      current.leaseVersion !== request.leaseVersion
    ) {
      throw new ComplianceLeaseLostError(
        "Compliance request lease no longer authorizes privacy mutation.",
      );
    }
    return fn(tx, stores[0]);
  });
}

async function revokeCustomerDataExports(request: any) {
  const filters = customerExportMatchFilters(request);
  if (filters.length === 0) return { count: 0 };
  const phase = customerExportSupersededPhase(request.id);
  return withComplianceMutationLease({
    request,
    fn: (tx) =>
      tx.weleticShopifyComplianceRequest.updateMany({
        where: {
          storeId: request.storeId,
          id: { not: request.id },
          requestType: "customer_data_request",
          AND: [
            { phase: { not: phase } },
            {
              NOT: {
                phase: { startsWith: "superseded_by_shop_redact:" },
              },
            },
            {
              NOT: {
                phase: { startsWith: "superseded_by_customer_redact:" },
              },
            },
          ],
          OR: filters,
        },
        data: {
          status: "completed",
          phase,
          leaseVersion: { increment: 1 },
          payloadCiphertext: null,
          cursor: Prisma.DbNull,
          progress: { redactedByRequestId: request.id },
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          lockedAt: null,
          lockedBy: null,
          nextRetryAt: null,
          lastError: null,
          completedAt: new Date(),
        },
      }),
  });
}

async function purgeCustomerDataExports(request: any) {
  await revokeCustomerDataExports(request);
  const result = await deleteComplianceArtifactsForCustomerRedactionBatch({
    storeId: request.storeId,
    supersededPhase: customerExportSupersededPhase(request.id),
    batchSize: SHOP_REDACT_PAGE_SIZE,
  });
  if (result.failed > 0) {
    throw new Error(
      "One or more private customer export artifacts could not be erased.",
    );
  }
  return result;
}

export async function processCustomerRedactStep(
  request: any,
): Promise<StepState> {
  let subject = readSubject(request.payloadCiphertext);
  const cursor = parseJsonObject<ComplianceCursor>(request.cursor);
  const progress = parseJsonObject<ComplianceProgress>(request.progress);
  if (request.phase === "received") {
    const resolved = await resolveCustomerSubject({
      storeId: request.storeId,
      workspaceId: request.store.projectId,
      subject,
    });
    subject = {
      ...subject,
      customerId: resolved.customerId ?? undefined,
      legacyCustomerId: resolved.legacyCustomerId ?? undefined,
    };
    return {
      completed: false,
      phase: "freeze_customer",
      progress: customerOwnerProgress(resolved, progress),
      payloadCiphertext: encrypt(JSON.stringify(subject)),
    };
  }

  if (request.phase === "freeze_customer") {
    const prepared = await withCustomerComplianceLock({
      request,
      subject,
      fn: async () => {
        const result = subject.customerId
          ? await prepareWeleticShopperRedaction({
              storeId: request.storeId,
              shopifyCustomerId: subject.customerId,
            })
          : {
              found: false as const,
              shopperId: null,
              accountId: null,
              redactedAt: new Date(),
            };
        await upsertShopifyCustomerPrivacyTombstones({
          storeId: request.storeId,
          shopifyCustomerId: subject.customerId,
          email: subject.customerEmail,
          shopperId: result.shopperId ?? undefined,
          accountId: result.accountId ?? undefined,
          sourceRequestId: request.id,
          redactedAt: result.redactedAt,
        });
        return result;
      },
    });
    subject = {
      ...subject,
      shopperId: prepared.shopperId ?? undefined,
      accountId: prepared.accountId ?? undefined,
      redactedAt: prepared.redactedAt.toISOString(),
    };
    return {
      completed: false,
      phase: "revoke_customer_exports",
      cursor: Prisma.DbNull,
      progress: customerOwnerProgress(prepared, progress),
      payloadCiphertext: encrypt(JSON.stringify(subject)),
    };
  }

  if (request.phase === "revoke_customer_exports") {
    const result = await purgeCustomerDataExports(request);
    return result.selected > 0
      ? {
          completed: false,
          phase: "revoke_customer_exports",
          progress: {
            ...progress,
            customerExportArtifactsDeleted:
              Number(progress.customerExportArtifactsDeleted ?? 0) +
              result.deleted,
          },
        }
      : {
          completed: false,
          phase:
            subject.accountId || subject.shopperId
              ? "enumerate_customer_vouchers"
              : "purge_customer_order_cache",
          cursor: Prisma.DbNull,
          progress: progress as Prisma.InputJsonObject,
        };
  }

  if (request.phase === "enumerate_customer_vouchers") {
    if (!subject.accountId && !subject.shopperId) {
      return {
        completed: false,
        phase: "purge_customer_order_cache",
        cursor: Prisma.DbNull,
      };
    }
    const step = await processAccountVoucherEnumerationComplianceStep({
      requestId: request.id,
      storeId: request.storeId,
      accountId: subject.accountId,
      shopperId: subject.shopperId,
      cursor: request.cursor,
    });
    return step.phase === "scrub_customer_identity"
      ? {
          completed: false,
          phase: "purge_customer_order_cache",
          cursor: Prisma.DbNull,
        }
      : {
          ...step,
          progress: mergeComplianceProgress(progress, step.progress),
          delaySeconds: voucherEnumerationDelaySeconds(step.cursor),
        };
  }

  if (request.phase === "purge_customer_order_cache") {
    const ownership = [
      ...(subject.shopperId ? [{ shopperId: subject.shopperId }] : []),
      ...(subject.orderExternalIds.length > 0
        ? [{ externalId: { in: subject.orderExternalIds } }]
        : []),
    ];
    if (ownership.length === 0) {
      return {
        completed: false,
        phase: "purge_customer_cache",
        cursor: Prisma.DbNull,
      };
    }
    const customerOrders = await prisma.weleticCommerceOrder.findMany({
      take: SHOP_REDACT_PAGE_SIZE + 1,
      orderBy: { id: "asc" },
      ...(cursor.lastId ? { cursor: { id: cursor.lastId }, skip: 1 } : {}),
      where: { storeId: request.storeId, OR: ownership },
      select: { id: true, checkoutToken: true },
    });
    const bounded = customerOrders.slice(0, SHOP_REDACT_PAGE_SIZE);
    await Promise.all(
      bounded.flatMap(({ checkoutToken }) =>
        checkoutToken ? [deleteShopifyCheckoutCache(checkoutToken)] : [],
      ),
    );
    return customerOrders.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "purge_customer_order_cache",
          cursor: { lastId: bounded[bounded.length - 1].id },
        }
      : {
          completed: false,
          phase: "purge_customer_cache",
          cursor: Prisma.DbNull,
        };
  }

  if (request.phase === "purge_customer_cache") {
    if (!subject.customerId) {
      return {
        completed: false,
        phase: "purge_customer_backfill_preview",
        cursor: Prisma.DbNull,
      };
    }
    const result = await purgeShopifyCustomerPrivacyCacheBatch({
      storeId: request.storeId,
      workspaceId: request.store.projectId,
      customerId: subject.customerId,
      cursor: parseJsonObject<ShopifyPrivacyCachePurgeCursor>(request.cursor),
      batchSize: SHOP_REDACT_PAGE_SIZE,
    });
    return result.completed
      ? {
          completed: false,
          phase: "purge_customer_backfill_preview",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            customerPrivacyCacheDeleted: result.deleted,
          },
        }
      : {
          completed: false,
          phase: "purge_customer_cache",
          cursor: result.cursor as Prisma.InputJsonValue,
          progress: {
            ...progress,
            customerPrivacyCacheDeleted: result.deleted,
          },
        };
  }

  if (request.phase === "purge_customer_backfill_preview") {
    const owners = [
      ...(subject.accountId ? [{ accountId: subject.accountId }] : []),
      ...(subject.shopperId ? [{ shopperId: subject.shopperId }] : []),
    ];
    if (owners.length === 0) {
      return {
        completed: false,
        phase: "scrub_customer_earn_grants",
        cursor: Prisma.DbNull,
      };
    }
    const orderCredits = subject.accountId
      ? await prisma.weleticLoyaltyBackfillOrderCredit.findMany({
          take: SHOP_REDACT_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
          where: {
            storeId: request.storeId,
            accountId: subject.accountId,
          },
          select: { id: true },
        })
      : [];
    const boundedCredits = orderCredits.slice(0, SHOP_REDACT_PAGE_SIZE);
    if (boundedCredits.length > 0) {
      await prisma.weleticLoyaltyBackfillOrderCredit.deleteMany({
        where: {
          id: { in: boundedCredits.map(({ id }) => id) },
          storeId: request.storeId,
          accountId: subject.accountId,
        },
      });
      return {
        completed: false,
        phase: "purge_customer_backfill_preview",
        cursor: Prisma.DbNull,
        progress: {
          ...progress,
          customerBackfillOrderCreditsDeleted:
            Number(progress.customerBackfillOrderCreditsDeleted ?? 0) +
            boundedCredits.length,
        },
      };
    }
    const orderSnapshots =
      await prisma.weleticLoyaltyBackfillOrderSnapshot.findMany({
        take: SHOP_REDACT_PAGE_SIZE + 1,
        orderBy: { id: "asc" },
        where: {
          storeId: request.storeId,
          OR: owners,
          ...(cursor.lastId ? { id: { gt: cursor.lastId } } : {}),
        },
        select: { id: true },
      });
    const bounded = orderSnapshots.slice(0, SHOP_REDACT_PAGE_SIZE);
    if (bounded.length > 0) {
      await prisma.weleticLoyaltyBackfillOrderCredit.deleteMany({
        where: {
          storeId: request.storeId,
          snapshotId: { in: bounded.map(({ id }) => id) },
        },
      });
      await prisma.weleticLoyaltyBackfillOrderSnapshot.deleteMany({
        where: {
          id: { in: bounded.map(({ id }) => id) },
          storeId: request.storeId,
          OR: owners,
        },
      });
    }
    if (bounded.length > 0) {
      return {
        completed: false,
        phase: "purge_customer_backfill_preview",
        cursor:
          orderSnapshots.length > SHOP_REDACT_PAGE_SIZE
            ? { lastId: bounded[bounded.length - 1].id }
            : Prisma.DbNull,
        progress: {
          ...progress,
          customerBackfillOrderSnapshotsDeleted:
            Number(progress.customerBackfillOrderSnapshotsDeleted ?? 0) +
            bounded.length,
        },
      };
    }

    const previewItems =
      await prisma.weleticLoyaltyBackfillPreviewItem.findMany({
        take: SHOP_REDACT_PAGE_SIZE + 1,
        orderBy: { id: "asc" },
        where: {
          job: { storeId: request.storeId },
          OR: owners,
        },
        select: { id: true },
      });
    const boundedLegacy = previewItems.slice(0, SHOP_REDACT_PAGE_SIZE);
    if (boundedLegacy.length > 0) {
      await prisma.weleticLoyaltyBackfillPreviewItem.deleteMany({
        where: {
          id: { in: boundedLegacy.map(({ id }) => id) },
          job: { storeId: request.storeId },
          OR: owners,
        },
      });
    }
    return previewItems.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "purge_customer_backfill_preview",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            customerBackfillPreviewDeleted:
              Number(progress.customerBackfillPreviewDeleted ?? 0) +
              boundedLegacy.length,
          },
        }
      : {
          completed: false,
          phase: "scrub_customer_earn_grants",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            customerBackfillPreviewDeleted:
              Number(progress.customerBackfillPreviewDeleted ?? 0) +
              boundedLegacy.length,
          },
        };
  }

  if (request.phase === "scrub_customer_earn_grants") {
    const owners = [
      ...(subject.accountId ? [{ accountId: subject.accountId }] : []),
      ...(subject.shopperId ? [{ shopperId: subject.shopperId }] : []),
    ];
    if (owners.length === 0) {
      return {
        completed: false,
        phase: "scrub_customer_order_line_earns",
        cursor: Prisma.DbNull,
      };
    }
    const grants = await prisma.weleticLoyaltyEarnGrant.findMany({
      take: SHOP_REDACT_PAGE_SIZE + 1,
      orderBy: { id: "asc" },
      ...(cursor.lastId ? { cursor: { id: cursor.lastId }, skip: 1 } : {}),
      where: { storeId: request.storeId, OR: owners },
      select: { id: true, calculationSnapshot: true, metadata: true },
    });
    const bounded = grants.slice(0, SHOP_REDACT_PAGE_SIZE);
    for (const grant of bounded) {
      await prisma.weleticLoyaltyEarnGrant.updateMany({
        where: { id: grant.id, storeId: request.storeId, OR: owners },
        data: {
          calculationSnapshot:
            grant.calculationSnapshot == null
              ? Prisma.DbNull
              : scrubCustomerContextJsonValue(grant.calculationSnapshot),
          metadata:
            grant.metadata == null
              ? Prisma.DbNull
              : scrubCustomerContextJsonValue(grant.metadata),
        },
      });
    }
    return grants.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "scrub_customer_earn_grants",
          cursor: { lastId: bounded[bounded.length - 1].id },
          progress: {
            ...progress,
            customerEarnGrantsScrubbed:
              Number(progress.customerEarnGrantsScrubbed ?? 0) + bounded.length,
          },
        }
      : {
          completed: false,
          phase: "scrub_customer_order_line_earns",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            customerEarnGrantsScrubbed:
              Number(progress.customerEarnGrantsScrubbed ?? 0) + bounded.length,
          },
        };
  }

  if (request.phase === "scrub_customer_order_line_earns") {
    const owners = [
      ...(subject.accountId ? [{ accountId: subject.accountId }] : []),
      ...(subject.shopperId ? [{ shopperId: subject.shopperId }] : []),
    ];
    if (owners.length === 0) {
      return {
        completed: false,
        phase: "scrub_customer_identity",
        cursor: Prisma.DbNull,
      };
    }
    const lineEarns = await prisma.weleticLoyaltyOrderLineEarn.findMany({
      take: SHOP_REDACT_PAGE_SIZE + 1,
      orderBy: { id: "asc" },
      ...(cursor.lastId ? { cursor: { id: cursor.lastId }, skip: 1 } : {}),
      where: {
        storeId: request.storeId,
        grant: { storeId: request.storeId, OR: owners },
      },
      select: { id: true, metadata: true },
    });
    const bounded = lineEarns.slice(0, SHOP_REDACT_PAGE_SIZE);
    for (const lineEarn of bounded) {
      await prisma.weleticLoyaltyOrderLineEarn.updateMany({
        where: {
          id: lineEarn.id,
          storeId: request.storeId,
          grant: { storeId: request.storeId, OR: owners },
        },
        data: {
          metadata:
            lineEarn.metadata == null
              ? Prisma.DbNull
              : scrubCustomerContextJsonValue(lineEarn.metadata),
        },
      });
    }
    return lineEarns.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "scrub_customer_order_line_earns",
          cursor: { lastId: bounded[bounded.length - 1].id },
          progress: {
            ...progress,
            customerOrderLineEarnsScrubbed:
              Number(progress.customerOrderLineEarnsScrubbed ?? 0) +
              bounded.length,
          },
        }
      : {
          completed: false,
          phase: "scrub_customer_reviews",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            customerOrderLineEarnsScrubbed:
              Number(progress.customerOrderLineEarnsScrubbed ?? 0) +
              bounded.length,
          },
        };
  }

  if (request.phase === "scrub_customer_reviews") {
    const result = subject.shopperId
      ? await withCustomerComplianceLock({
          request,
          subject,
          fn: () =>
            redactNativeReviewsBatch(request.storeId, subject.shopperId),
        })
      : { hasMore: false };
    return {
      completed: false,
      phase: result.hasMore
        ? "scrub_customer_reviews"
        : "scrub_customer_identity",
      cursor: Prisma.DbNull,
    };
  }

  if (request.phase === "scrub_customer_identity") {
    if (!subject.redactedAt) {
      throw new Error("Customer redaction timestamp is unavailable.");
    }
    const redactedAt = new Date(subject.redactedAt);
    if (!Number.isFinite(redactedAt.getTime())) {
      throw new Error("Customer redaction timestamp is invalid.");
    }
    await withCustomerComplianceLock({
      request,
      subject,
      fn: async () => {
        if (subject.customerEmail) {
          await redactReferralFriendClaimsForEmail({
            storeId: request.storeId,
            email: subject.customerEmail,
            redactedAt,
          });
        }
        if (subject.customerId) {
          await scrubWeleticShopperCustomerContext({
            storeId: request.storeId,
            shopifyCustomerId: subject.customerId,
            shopperId: subject.shopperId,
            accountId: subject.accountId,
            orderExternalIds: subject.orderExternalIds,
            redactedAt,
          });
        }
        const pseudonymousExternalId = subject.customerId
          ? getShopifyCustomerPrivacyPseudonym({
              storeId: request.storeId,
              shopifyCustomerId: subject.customerId,
            })
          : null;
        await prisma.customer.updateMany({
          where: subject.legacyCustomerId
            ? {
                id: subject.legacyCustomerId,
                projectId: request.store.projectId,
              }
            : subject.customerId
              ? {
                  projectId: request.store.projectId,
                  externalId: subject.customerId,
                }
              : { id: "__no_legacy_customer__" },
          data: {
            externalId: pseudonymousExternalId,
            name: generateRandomName(),
            email: null,
            avatar: null,
            stripeCustomerId: null,
            country: null,
            linkId: null,
            clickId: null,
            clickedAt: null,
            projectConnectId: null,
          },
        });
      },
    });
    return {
      completed: false,
      phase: subject.accountId
        ? "scrub_account_outbox"
        : "customer_voucher_cleanup",
      cursor: Prisma.DbNull,
    };
  }

  if (
    [
      "scrub_account_outbox",
      "scrub_account_ledger",
      "scrub_account_redemptions",
      "scrub_account_referrals",
      "scrub_referral_link",
    ].includes(request.phase)
  ) {
    if (!subject.accountId || !subject.redactedAt) {
      throw new Error("Customer account privacy scrub context is unavailable.");
    }
    const redactedAt = new Date(subject.redactedAt);
    if (!Number.isFinite(redactedAt.getTime())) {
      throw new Error("Customer account privacy scrub timestamp is invalid.");
    }
    const step = await processWeleticLoyaltyAccountPrivacyScrubStep({
      storeId: request.storeId,
      accountId: subject.accountId,
      phase: request.phase as WeleticCustomerPrivacyScrubPhase,
      cursor: request.cursor,
      redactedAt,
    });
    return step.completed
      ? {
          completed: false,
          phase: "customer_voucher_cleanup",
          cursor: Prisma.DbNull,
          progress: mergeComplianceProgress(progress, step.progress),
        }
      : {
          ...step,
          progress: mergeComplianceProgress(progress, step.progress),
        };
  }

  if (request.phase === "customer_voucher_cleanup") {
    const counts = await getVoucherCleanupRequestTerminalCounts({
      storeId: request.storeId,
      requestId: request.id,
    });
    const cleanupProgress = {
      ...progress,
      voucherCleanup: counts,
      manualReconciliationRequired:
        counts.deadLetter > 0 || counts.cancelled > 0,
    };
    return counts.outstanding > 0
      ? {
          completed: false,
          phase: "customer_voucher_cleanup",
          progress: cleanupProgress,
        }
      : {
          completed: false,
          phase: "finalize_customer_redact",
          progress: cleanupProgress,
        };
  }

  if (request.phase === "finalize_customer_redact") {
    const result = await purgeCustomerDataExports(request);
    return result.selected > 0
      ? {
          completed: false,
          phase: "finalize_customer_redact",
          progress: {
            ...progress,
            customerExportArtifactsDeleted:
              Number(progress.customerExportArtifactsDeleted ?? 0) +
              result.deleted,
          },
        }
      : {
          completed: true,
          phase: "completed",
          progress: progress as Prisma.InputJsonObject,
        };
  }

  throw new Error(`Unsupported customer redact phase: ${request.phase}`);
}

async function redactShopperIdentityForShopErasure({
  request,
  shopper,
}: {
  request: any;
  shopper: {
    id: string;
    shopifyCustomerId: string;
    email: string | null;
    loyaltyAccount: { id: string } | null;
  };
}) {
  // The page checkpoint is intentionally separate from each bounded shopper
  // mutation. If the checkpoint response is lost, a retry may see the value
  // already pseudonymized. Treat that retained identity as the completed page
  // result instead of hashing it again and chaining pseudonyms/tombstones.
  if (parseShopifyCustomerPrivacyPseudonym(shopper.shopifyCustomerId)) {
    return;
  }
  await withShopifyCustomerSettlementLocks({
    workspaceId: request.store.projectId,
    storeId: request.storeId,
    shopifyCustomerId: shopper.shopifyCustomerId,
    fn: async () => {
      const prepared = await prepareWeleticShopperRedaction({
        storeId: request.storeId,
        shopifyCustomerId: shopper.shopifyCustomerId,
      });
      const tombstones = await upsertShopifyCustomerPrivacyTombstones({
        storeId: request.storeId,
        shopifyCustomerId: shopper.shopifyCustomerId,
        email: shopper.email ?? undefined,
        shopperId: shopper.id,
        accountId: prepared.accountId ?? shopper.loyaltyAccount?.id,
        sourceRequestId: request.id,
      });
      if (!tombstones.some((row) => row.identityKind === "customer_id")) {
        throw new Error("Customer-id privacy tombstone was not persisted.");
      }
      const pseudonymousCustomerId = getShopifyCustomerPrivacyPseudonym({
        storeId: request.storeId,
        shopifyCustomerId: shopper.shopifyCustomerId,
      });
      await purgeShopifyLegacyCustomerPrivacyCache({
        storeId: request.storeId,
        workspaceId: request.store.projectId,
        customerId: shopper.shopifyCustomerId,
      });
      // Redact only the legacy customer projection proven to belong to this
      // Shopify shopper. A workspace may also contain unrelated Dub customers;
      // shop erasure must never broad-delete or anonymize those rows.
      await prisma.customer.updateMany({
        where: {
          projectId: request.store.projectId,
          externalId: shopper.shopifyCustomerId,
        },
        data: {
          externalId: pseudonymousCustomerId,
          name: "Redacted Customer",
          email: null,
          avatar: null,
          stripeCustomerId: null,
          country: null,
          linkId: null,
          clickId: null,
          clickedAt: null,
          projectConnectId: null,
        },
      });
      await prisma.weleticShopper.update({
        where: { id: shopper.id },
        data: {
          shopifyCustomerId: pseudonymousCustomerId,
          firstName: "Redacted",
          lastName: "Customer",
          email: null,
          phone: null,
          locale: null,
          tags: Prisma.DbNull,
          segmentIds: Prisma.DbNull,
          acceptsMarketing: false,
        },
      });
    },
  });
}

function shopExportSupersededPhase(shopRedactRequestId: string) {
  return `superseded_by_shop_redact:${shopRedactRequestId}`;
}

async function revokeStoreDataExports(request: any) {
  const phase = shopExportSupersededPhase(request.id);
  return withComplianceMutationLease({
    request,
    fn: (tx) =>
      tx.weleticShopifyComplianceRequest.updateMany({
        where: {
          storeId: request.storeId,
          id: { not: request.id },
          requestType: "customer_data_request",
          NOT: {
            phase: { startsWith: "superseded_by_shop_redact:" },
          },
        },
        data: {
          status: "completed",
          phase,
          leaseVersion: { increment: 1 },
          payloadCiphertext: null,
          cursor: Prisma.DbNull,
          progress: { redactedByRequestId: request.id },
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          lockedAt: null,
          lockedBy: null,
          nextRetryAt: null,
          lastError: null,
          completedAt: new Date(),
        },
      }),
  });
}

export async function processShopRedactStep(request: any): Promise<StepState> {
  const subject = readSubject(request.payloadCiphertext);
  const cursor = parseJsonObject<ComplianceCursor>(request.cursor);
  const progress = parseJsonObject<ComplianceProgress>(request.progress);
  const page = (lastId?: string) => ({
    take: SHOP_REDACT_PAGE_SIZE + 1,
    orderBy: { id: "asc" as const },
    ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
  });

  if (request.phase === "received") {
    const state = await withComplianceMutationLease({
      request,
      allowRedactedStore: true,
      fn: async (tx, store) => {
        if (store.complianceState === "redacted") return "redacted" as const;
        const transitionsToFrozen = store.complianceState === "active";
        const programs = await tx.$queryRaw<
          Array<{ id: string; disabledAt: Date | null }>
        >(Prisma.sql`
          SELECT id, disabledAt
          FROM WeleticLoyaltyProgram
          WHERE storeId = ${request.storeId}
          LIMIT 1
          FOR UPDATE
        `);
        const existingDisabledAt = programs[0]?.disabledAt ?? null;
        const effectiveDisabledAt =
          existingDisabledAt &&
          existingDisabledAt.getTime() <= request.receivedAt.getTime()
            ? existingDisabledAt
            : request.receivedAt;
        await tx.weleticShopifyStore.update({
          where: { id: request.storeId },
          data: { complianceState: "frozen" },
        });
        const disabledPrograms = await tx.weleticLoyaltyProgram.updateMany({
          where: { storeId: request.storeId },
          data: {
            status: "disabled",
            killSwitchActive: true,
            disabledAt: effectiveDisabledAt,
          },
        });
        if (
          transitionsToFrozen &&
          programs[0] &&
          disabledPrograms.count === 1
        ) {
          // Keep policy revisions monotonic; effectiveDisabledAt remains the
          // authoritative compliance cutoff on the mutable lifecycle record.
          await publishLoyaltyEarnPolicyRevision({
            tx,
            storeId: request.storeId,
            programId: programs[0].id,
            reason: "shopify_shop_redact_frozen",
          });
        }
        return "frozen" as const;
      },
    });
    return state === "redacted"
      ? { completed: true, phase: "already_redacted" }
      : { completed: false, phase: "enumerate_vouchers" };
  }

  if (
    request.phase === "enumerate_vouchers" ||
    request.phase === "voucher_cleanup"
  ) {
    const voucherStep = await processStoreVoucherCleanupComplianceStep({
      requestId: request.id,
      storeId: request.storeId,
      shopDomain: subject.shopDomain,
      source: WeleticVoucherCleanupSource.shop_redact,
      phase: request.phase,
      cursor: request.cursor,
      progress: request.progress,
      workerId: request.lockedBy,
    });
    return {
      ...voucherStep,
      phase:
        voucherStep.phase === "credential_scrub"
          ? "scrub_shop_friend_referral_claims"
          : voucherStep.phase,
      delaySeconds:
        voucherStep.phase === "voucher_cleanup"
          ? 30
          : voucherStep.phase === "enumerate_vouchers"
            ? voucherEnumerationDelaySeconds(voucherStep.cursor)
            : 0,
    };
  }

  if (request.phase === "scrub_shop_friend_referral_claims") {
    const result = await redactReferralFriendClaimsForShopBatch({
      storeId: request.storeId,
      afterId: cursor.lastId,
      batchSize: SHOP_REDACT_PAGE_SIZE,
      redactedAt: request.receivedAt,
    });
    return result.hasMore
      ? {
          completed: false,
          phase: "scrub_shop_friend_referral_claims",
          cursor: { lastId: result.lastId },
          progress: {
            ...progress,
            shopFriendReferralClaimsScrubbed:
              Number(progress.shopFriendReferralClaimsScrubbed ?? 0) +
              result.scrubbed,
          },
        }
      : {
          completed: false,
          phase: "purge_store_cache",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            shopFriendReferralClaimsScrubbed:
              Number(progress.shopFriendReferralClaimsScrubbed ?? 0) +
              result.scrubbed,
          },
        };
  }

  if (request.phase === "purge_store_cache") {
    // Backward-compatible guard for requests checkpointed at this phase before
    // anonymous friend vouchers became part of the shop-erasure lifecycle.
    const friendGate = await redactReferralFriendClaimsForShopBatch({
      storeId: request.storeId,
      batchSize: SHOP_REDACT_PAGE_SIZE,
      redactedAt: request.receivedAt,
    });
    if (friendGate.hasMore) {
      return {
        completed: false,
        phase: "scrub_shop_friend_referral_claims",
        cursor: { lastId: friendGate.lastId },
        progress: {
          ...progress,
          shopFriendReferralClaimsScrubbed:
            Number(progress.shopFriendReferralClaimsScrubbed ?? 0) +
            friendGate.scrubbed,
        },
      };
    }
    const progressAfterFriendGate = {
      ...progress,
      shopFriendReferralClaimsScrubbed:
        Number(progress.shopFriendReferralClaimsScrubbed ?? 0) +
        friendGate.scrubbed,
    };
    const result = await purgeShopifyStorePrivacyCacheBatch({
      storeId: request.storeId,
      cursor: parseJsonObject<ShopifyPrivacyCachePurgeCursor>(request.cursor),
      batchSize: SHOP_REDACT_PAGE_SIZE,
    });
    return result.completed
      ? {
          completed: false,
          phase: "redact_native_reviews",
          cursor: Prisma.DbNull,
          progress: {
            ...progressAfterFriendGate,
            storePrivacyCacheDeleted: result.deleted,
          },
        }
      : {
          completed: false,
          phase: "purge_store_cache",
          cursor: result.cursor as Prisma.InputJsonValue,
          progress: {
            ...progressAfterFriendGate,
            storePrivacyCacheDeleted: result.deleted,
          },
        };
  }

  if (request.phase === "redact_native_reviews") {
    const result = await redactNativeReviewsBatch(request.storeId);
    return {
      completed: false,
      phase: result.hasMore ? "redact_native_reviews" : "redact_shoppers",
      cursor: Prisma.DbNull,
    };
  }

  if (request.phase === "redact_shoppers") {
    const shoppers = await prisma.weleticShopper.findMany({
      ...page(cursor.lastId),
      where: { storeId: request.storeId },
      select: {
        id: true,
        shopifyCustomerId: true,
        email: true,
        loyaltyAccount: { select: { id: true } },
      },
    });
    const bounded = shoppers.slice(0, SHOP_REDACT_PAGE_SIZE);
    for (const shopper of bounded) {
      await redactShopperIdentityForShopErasure({
        request,
        shopper,
      });
    }
    return shoppers.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "redact_shoppers",
          cursor: { lastId: bounded[bounded.length - 1].id },
        }
      : {
          completed: false,
          phase: "redact_order_calculations",
          cursor: Prisma.DbNull,
        };
  }

  if (request.phase === "redact_order_calculations") {
    const calculations = await prisma.weleticCommissionCalculation.findMany({
      ...page(cursor.lastId),
      where: {
        OR: [
          { orderLine: { order: { storeId: request.storeId } } },
          { refundLine: { refund: { storeId: request.storeId } } },
        ],
      },
      select: { id: true, inputs: true },
    });
    const bounded = calculations.slice(0, SHOP_REDACT_PAGE_SIZE);
    for (const calculation of bounded) {
      await prisma.weleticCommissionCalculation.updateMany({
        // The store is already frozen, so no operational calculation writer
        // may race this bounded scrub. Avoid copying the raw JSON into a CAS
        // predicate where database query logging could retain it.
        where: { id: calculation.id },
        data: {
          inputs: scrubCustomerContextJsonValue(
            calculation.inputs as Prisma.JsonValue,
          ),
        },
      });
    }
    return calculations.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "redact_order_calculations",
          cursor: { lastId: bounded[bounded.length - 1].id },
        }
      : {
          completed: false,
          phase: "redact_orders",
          cursor: Prisma.DbNull,
        };
  }

  if (request.phase === "redact_orders") {
    const orders = await prisma.weleticCommerceOrder.findMany({
      ...page(cursor.lastId),
      where: { storeId: request.storeId },
      select: { id: true, checkoutToken: true },
    });
    const bounded = orders.slice(0, SHOP_REDACT_PAGE_SIZE);
    await Promise.all(
      bounded.flatMap(({ checkoutToken }) =>
        checkoutToken ? [deleteShopifyCheckoutCache(checkoutToken)] : [],
      ),
    );
    if (bounded.length > 0) {
      await prisma.weleticCommerceOrder.updateMany({
        where: {
          id: { in: bounded.map(({ id }) => id) },
          storeId: request.storeId,
        },
        data: {
          checkoutToken: null,
          orderName: null,
          customerOrderSequence: null,
          customerClassification: "unknown",
          customerSegmentIds: Prisma.DbNull,
          shopperId: null,
        },
      });
    }
    return orders.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "redact_orders",
          cursor: { lastId: bounded[bounded.length - 1].id },
        }
      : {
          completed: false,
          phase: "scrub_shop_account_context",
          cursor: Prisma.DbNull,
        };
  }

  if (request.phase === "redact_accounts") {
    return {
      completed: false,
      phase: "scrub_shop_account_context",
      cursor: Prisma.DbNull,
    };
  }

  if (request.phase === "scrub_shop_account_context") {
    const accountState = parseJsonObject<ShopAccountPrivacyCursor>(
      request.cursor,
    );
    const redactedAt = accountState.redactedAt
      ? new Date(accountState.redactedAt)
      : new Date();
    if (!Number.isFinite(redactedAt.getTime())) {
      throw new Error("Shop account privacy scrub timestamp is invalid.");
    }
    const account = accountState.accountId
      ? { id: accountState.accountId }
      : await prisma.weleticLoyaltyAccount.findFirst({
          where: {
            storeId: request.storeId,
            ...(accountState.afterAccountId
              ? { id: { gt: accountState.afterAccountId } }
              : {}),
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
    if (!account) {
      return {
        completed: false,
        phase: "scrub_redacted_referral_links",
        cursor: Prisma.DbNull,
      };
    }
    const step = await processWeleticLoyaltyAccountPrivacyScrubStep({
      storeId: request.storeId,
      accountId: account.id,
      phase: accountState.accountPhase ?? "scrub_account_outbox",
      cursor: accountState.accountCursor,
      redactedAt,
      shopErasure: true,
    });
    if (!step.completed) {
      return {
        completed: false,
        phase: "scrub_shop_account_context",
        cursor: {
          afterAccountId: accountState.afterAccountId,
          accountId: account.id,
          accountPhase: step.phase,
          accountCursor:
            step.cursor === Prisma.DbNull
              ? null
              : (step.cursor as Prisma.InputJsonValue),
          redactedAt: redactedAt.toISOString(),
        },
      };
    }
    await prisma.weleticLoyaltyAccount.updateMany({
      where: { id: account.id, storeId: request.storeId },
      data: {
        status: "closed",
        metadata: {
          [SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY]: {
            status: "redacted",
            redactedAt: redactedAt.toISOString(),
            source: "shopify_customers_redact",
          },
        },
        referralCode: null,
        referredById: null,
      },
    });
    return {
      completed: false,
      phase: "scrub_shop_account_context",
      cursor: {
        afterAccountId: account.id,
        redactedAt: redactedAt.toISOString(),
      },
    };
  }

  if (request.phase === "scrub_redacted_referral_links") {
    const links = await prisma.link.findMany({
      ...page(cursor.lastId),
      where: {
        projectId: request.store.projectId,
        title: "Redacted loyalty referral",
        key: { startsWith: "redacted-" },
      },
      select: { id: true },
    });
    const bounded = links.slice(0, SHOP_REDACT_PAGE_SIZE);
    if (bounded.length > 0) {
      await prisma.link.updateMany({
        where: {
          projectId: request.store.projectId,
          id: { in: bounded.map(({ id }) => id) },
        },
        data: { url: "https://redacted.invalid" },
      });
    }
    return links.length > SHOP_REDACT_PAGE_SIZE
      ? {
          completed: false,
          phase: "scrub_redacted_referral_links",
          cursor: { lastId: bounded[bounded.length - 1].id },
        }
      : {
          completed: false,
          phase: "scrub_shop_earn_grants",
          cursor: Prisma.DbNull,
        };
  }

  if (request.phase === "scrub_shop_earn_grants") {
    const result = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const grants = await tx.weleticLoyaltyEarnGrant.findMany({
          ...page(cursor.lastId),
          where: { storeId: request.storeId },
          select: { id: true, calculationSnapshot: true, metadata: true },
        });
        const bounded = grants.slice(0, SHOP_REDACT_PAGE_SIZE);
        for (const grant of bounded) {
          await tx.weleticLoyaltyEarnGrant.updateMany({
            where: { id: grant.id, storeId: request.storeId },
            data: {
              calculationSnapshot:
                grant.calculationSnapshot == null
                  ? Prisma.DbNull
                  : scrubCustomerContextJsonValue(grant.calculationSnapshot),
              metadata:
                grant.metadata == null
                  ? Prisma.DbNull
                  : scrubCustomerContextJsonValue(grant.metadata),
            },
          });
        }
        return {
          count: bounded.length,
          hasMore: grants.length > SHOP_REDACT_PAGE_SIZE,
          lastId: bounded[bounded.length - 1]?.id,
        };
      },
    });
    return result.hasMore
      ? {
          completed: false,
          phase: "scrub_shop_earn_grants",
          cursor: { lastId: result.lastId },
          progress: {
            ...progress,
            shopEarnGrantsScrubbed:
              Number(progress.shopEarnGrantsScrubbed ?? 0) + result.count,
          },
        }
      : {
          completed: false,
          phase: "scrub_shop_order_line_earns",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            shopEarnGrantsScrubbed:
              Number(progress.shopEarnGrantsScrubbed ?? 0) + result.count,
          },
        };
  }

  if (request.phase === "scrub_shop_order_line_earns") {
    const result = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const lineEarns = await tx.weleticLoyaltyOrderLineEarn.findMany({
          ...page(cursor.lastId),
          where: { storeId: request.storeId },
          select: { id: true, metadata: true },
        });
        const bounded = lineEarns.slice(0, SHOP_REDACT_PAGE_SIZE);
        for (const lineEarn of bounded) {
          await tx.weleticLoyaltyOrderLineEarn.updateMany({
            where: { id: lineEarn.id, storeId: request.storeId },
            data: {
              metadata:
                lineEarn.metadata == null
                  ? Prisma.DbNull
                  : scrubCustomerContextJsonValue(lineEarn.metadata),
            },
          });
        }
        return {
          count: bounded.length,
          hasMore: lineEarns.length > SHOP_REDACT_PAGE_SIZE,
          lastId: bounded[bounded.length - 1]?.id,
        };
      },
    });
    return result.hasMore
      ? {
          completed: false,
          phase: "scrub_shop_order_line_earns",
          cursor: { lastId: result.lastId },
          progress: {
            ...progress,
            shopOrderLineEarnsScrubbed:
              Number(progress.shopOrderLineEarnsScrubbed ?? 0) + result.count,
          },
        }
      : {
          completed: false,
          phase: "purge_loyalty_backfill",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            shopOrderLineEarnsScrubbed:
              Number(progress.shopOrderLineEarnsScrubbed ?? 0) + result.count,
          },
        };
  }

  if (request.phase === "purge_loyalty_backfill") {
    const result = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const credits = await tx.weleticLoyaltyBackfillOrderCredit.findMany({
          take: SHOP_REDACT_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
          where: { storeId: request.storeId },
          select: { id: true },
        });
        const boundedCredits = credits.slice(0, SHOP_REDACT_PAGE_SIZE);
        if (boundedCredits.length > 0) {
          await tx.weleticLoyaltyBackfillOrderCredit.deleteMany({
            where: {
              id: { in: boundedCredits.map(({ id }) => id) },
              storeId: request.storeId,
            },
          });
          return { kind: "credit" as const, count: boundedCredits.length };
        }
        const snapshots = await tx.weleticLoyaltyBackfillOrderSnapshot.findMany(
          {
            take: SHOP_REDACT_PAGE_SIZE + 1,
            orderBy: { id: "asc" },
            where: { storeId: request.storeId },
            select: { id: true },
          },
        );
        const boundedSnapshots = snapshots.slice(0, SHOP_REDACT_PAGE_SIZE);
        if (boundedSnapshots.length > 0) {
          await tx.weleticLoyaltyBackfillOrderSnapshot.deleteMany({
            where: {
              id: { in: boundedSnapshots.map(({ id }) => id) },
              storeId: request.storeId,
            },
          });
          return {
            kind: "snapshot" as const,
            count: boundedSnapshots.length,
          };
        }
        const previews = await tx.weleticLoyaltyBackfillPreviewItem.findMany({
          take: SHOP_REDACT_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
          where: { job: { storeId: request.storeId } },
          select: { id: true },
        });
        const boundedPreviews = previews.slice(0, SHOP_REDACT_PAGE_SIZE);
        if (boundedPreviews.length > 0) {
          await tx.weleticLoyaltyBackfillPreviewItem.deleteMany({
            where: {
              id: { in: boundedPreviews.map(({ id }) => id) },
              job: { storeId: request.storeId },
            },
          });
          return { kind: "preview" as const, count: boundedPreviews.length };
        }
        const jobs = await tx.weleticLoyaltyBackfillJob.findMany({
          take: SHOP_REDACT_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
          where: { storeId: request.storeId },
          select: { id: true },
        });
        const boundedJobs = jobs.slice(0, SHOP_REDACT_PAGE_SIZE);
        if (boundedJobs.length > 0) {
          await tx.weleticLoyaltyBackfillJob.deleteMany({
            where: {
              id: { in: boundedJobs.map(({ id }) => id) },
              storeId: request.storeId,
            },
          });
          return { kind: "job" as const, count: boundedJobs.length };
        }
        return { kind: "completed" as const, count: 0 };
      },
    });
    return result.kind === "completed"
      ? {
          completed: false,
          phase: "purge_loyalty_rules",
          cursor: Prisma.DbNull,
        }
      : {
          completed: false,
          phase: "purge_loyalty_backfill",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            ...(result.kind === "credit"
              ? {
                  loyaltyBackfillCreditsDeleted:
                    Number(progress.loyaltyBackfillCreditsDeleted ?? 0) +
                    result.count,
                }
              : result.kind === "snapshot"
                ? {
                    loyaltyBackfillOrderSnapshotsDeleted:
                      Number(
                        progress.loyaltyBackfillOrderSnapshotsDeleted ?? 0,
                      ) + result.count,
                  }
                : result.kind === "preview"
                  ? {
                      loyaltyBackfillPreviewsDeleted:
                        Number(progress.loyaltyBackfillPreviewsDeleted ?? 0) +
                        result.count,
                    }
                  : {
                      loyaltyBackfillJobsDeleted:
                        Number(progress.loyaltyBackfillJobsDeleted ?? 0) +
                        result.count,
                    }),
          },
        };
  }

  if (request.phase === "purge_loyalty_rules") {
    const result = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const [earningRules, campaigns, referralRules] = await Promise.all([
          tx.weleticLoyaltyEarningRule.findMany({
            take: SHOP_REDACT_PAGE_SIZE + 1,
            orderBy: { id: "asc" },
            where: { program: { storeId: request.storeId } },
            select: { id: true },
          }),
          tx.weleticLoyaltyBonusCampaign.findMany({
            take: SHOP_REDACT_PAGE_SIZE + 1,
            orderBy: { id: "asc" },
            where: { program: { storeId: request.storeId } },
            select: { id: true },
          }),
          tx.weleticLoyaltyReferralRule.findMany({
            take: SHOP_REDACT_PAGE_SIZE + 1,
            orderBy: { id: "asc" },
            where: { program: { storeId: request.storeId } },
            select: { id: true },
          }),
        ]);
        const boundedEarningRules = earningRules.slice(
          0,
          SHOP_REDACT_PAGE_SIZE,
        );
        const boundedCampaigns = campaigns.slice(0, SHOP_REDACT_PAGE_SIZE);
        const boundedReferralRules = referralRules.slice(
          0,
          SHOP_REDACT_PAGE_SIZE,
        );
        await Promise.all([
          boundedEarningRules.length > 0
            ? tx.weleticLoyaltyEarningRule.deleteMany({
                where: {
                  id: { in: boundedEarningRules.map(({ id }) => id) },
                  program: { storeId: request.storeId },
                },
              })
            : Promise.resolve({ count: 0 }),
          boundedCampaigns.length > 0
            ? tx.weleticLoyaltyBonusCampaign.deleteMany({
                where: {
                  id: { in: boundedCampaigns.map(({ id }) => id) },
                  program: { storeId: request.storeId },
                },
              })
            : Promise.resolve({ count: 0 }),
          boundedReferralRules.length > 0
            ? tx.weleticLoyaltyReferralRule.deleteMany({
                where: {
                  id: { in: boundedReferralRules.map(({ id }) => id) },
                  program: { storeId: request.storeId },
                },
              })
            : Promise.resolve({ count: 0 }),
        ]);
        return {
          deleted:
            boundedEarningRules.length +
            boundedCampaigns.length +
            boundedReferralRules.length,
          hasMore:
            earningRules.length > SHOP_REDACT_PAGE_SIZE ||
            campaigns.length > SHOP_REDACT_PAGE_SIZE ||
            referralRules.length > SHOP_REDACT_PAGE_SIZE,
        };
      },
    });
    return result.hasMore
      ? {
          completed: false,
          phase: "purge_loyalty_rules",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            loyaltyOperationalRulesDeleted:
              Number(progress.loyaltyOperationalRulesDeleted ?? 0) +
              result.deleted,
          },
        }
      : {
          completed: false,
          phase: "scrub_loyalty_tiers",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            loyaltyOperationalRulesDeleted:
              Number(progress.loyaltyOperationalRulesDeleted ?? 0) +
              result.deleted,
          },
        };
  }

  if (request.phase === "scrub_loyalty_tiers") {
    const result = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const tiers = await tx.weleticLoyaltyTier.findMany({
          ...page(cursor.lastId),
          where: { program: { storeId: request.storeId } },
          select: { id: true },
        });
        const bounded = tiers.slice(0, SHOP_REDACT_PAGE_SIZE);
        for (const tier of bounded) {
          await tx.weleticLoyaltyTier.updateMany({
            where: {
              id: tier.id,
              program: { storeId: request.storeId },
            },
            data: {
              name: "Redacted loyalty tier",
              slug: `redacted-${tier.id}`,
              minSpendThreshold: 0,
              minPointsThreshold: 0,
              pointsMultiplier: 1,
              entryBonusPoints: 0,
              gracePeriodDays: null,
              perks: Prisma.DbNull,
              iconUrl: null,
              color: null,
              criteria: Prisma.DbNull,
            },
          });
        }
        return {
          count: bounded.length,
          hasMore: tiers.length > SHOP_REDACT_PAGE_SIZE,
          lastId: bounded[bounded.length - 1]?.id,
        };
      },
    });
    return result.hasMore
      ? {
          completed: false,
          phase: "scrub_loyalty_tiers",
          cursor: { lastId: result.lastId },
          progress: {
            ...progress,
            loyaltyTiersScrubbed:
              Number(progress.loyaltyTiersScrubbed ?? 0) + result.count,
          },
        }
      : {
          completed: false,
          phase: "scrub_loyalty_rewards",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            loyaltyTiersScrubbed:
              Number(progress.loyaltyTiersScrubbed ?? 0) + result.count,
          },
        };
  }

  if (request.phase === "scrub_loyalty_rewards") {
    const result = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const rewards = await tx.weleticRewardDefinition.findMany({
          ...page(cursor.lastId),
          where: { storeId: request.storeId },
          select: { id: true },
        });
        const bounded = rewards.slice(0, SHOP_REDACT_PAGE_SIZE);
        if (bounded.length > 0) {
          await tx.weleticRewardDefinition.updateMany({
            where: {
              id: { in: bounded.map(({ id }) => id) },
              storeId: request.storeId,
            },
            data: {
              name: "Redacted loyalty reward",
              description: null,
              exchangeType: "fixed",
              pointsCost: 0,
              pointsStep: null,
              minPointsCost: null,
              maxPointsCost: null,
              discountValue: null,
              maxDiscountValue: null,
              minOrderAmount: null,
              status: "archived",
              shopifyPriceRuleId: null,
              appliesToResource: null,
              entitledCollectionIds: Prisma.DbNull,
              entitledProductIds: Prisma.DbNull,
              entitledVariantIds: Prisma.DbNull,
              combinesWithProductDiscounts: false,
              combinesWithOrderDiscounts: false,
              combinesWithShippingDiscounts: false,
              usageLimit: null,
              usageLimitPerCustomer: null,
              expiresInDays: null,
            },
          });
        }
        return {
          count: bounded.length,
          hasMore: rewards.length > SHOP_REDACT_PAGE_SIZE,
          lastId: bounded[bounded.length - 1]?.id,
        };
      },
    });
    return result.hasMore
      ? {
          completed: false,
          phase: "scrub_loyalty_rewards",
          cursor: { lastId: result.lastId },
          progress: {
            ...progress,
            loyaltyRewardsScrubbed:
              Number(progress.loyaltyRewardsScrubbed ?? 0) + result.count,
          },
        }
      : {
          completed: false,
          phase: "scrub_loyalty_program",
          cursor: Prisma.DbNull,
          progress: {
            ...progress,
            loyaltyRewardsScrubbed:
              Number(progress.loyaltyRewardsScrubbed ?? 0) + result.count,
          },
        };
  }

  if (request.phase === "scrub_loyalty_program") {
    const revisions = await withComplianceMutationLease({
      request,
      fn: async (tx) => {
        const rows = await tx.weleticLoyaltyEarnPolicyRevision.findMany({
          take: SHOP_REDACT_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
          where: { storeId: request.storeId },
          select: { id: true },
        });
        const bounded = rows.slice(0, SHOP_REDACT_PAGE_SIZE);
        if (bounded.length > 0) {
          const revisionIds = bounded.map(({ id }) => id);
          // Composite tenant relations restrict accidental revision deletion.
          // This terminal, lease-fenced erasure explicitly detaches only the
          // scoped nullable bindings first. Earn-grant calculation snapshots
          // retain the non-PII revision ID/fingerprint and financial inputs.
          await tx.weleticCommerceOrder.updateMany({
            where: {
              storeId: request.storeId,
              loyaltyPolicyRevisionId: { in: revisionIds },
            },
            data: { loyaltyPolicyRevisionId: null },
          });
          await tx.weleticLoyaltyEarnGrant.updateMany({
            where: {
              storeId: request.storeId,
              policyRevisionId: { in: revisionIds },
            },
            data: { policyRevisionId: null },
          });
          await tx.weleticLoyaltyEarnPolicyRevision.deleteMany({
            where: {
              id: { in: revisionIds },
              storeId: request.storeId,
            },
          });
        }
        return {
          count: bounded.length,
          hasMore: rows.length > SHOP_REDACT_PAGE_SIZE,
        };
      },
    });
    const progressAfterRevisionPurge = {
      ...progress,
      loyaltyPolicyRevisionsDeleted:
        Number(progress.loyaltyPolicyRevisionsDeleted ?? 0) + revisions.count,
    };
    if (revisions.hasMore) {
      return {
        completed: false,
        phase: "scrub_loyalty_program",
        cursor: Prisma.DbNull,
        progress: progressAfterRevisionPurge,
      };
    }

    await withComplianceMutationLease({
      request,
      fn: (tx) =>
        tx.weleticLoyaltyProgram.updateMany({
          where: { storeId: request.storeId },
          data: {
            name: "Redacted loyalty program",
            status: "disabled",
            pointNameSingular: "Point",
            pointNamePlural: "Points",
            pointsPerCurrencyUnit: 0,
            holdingPeriodDays: 0,
            pointsExpiryMonths: 0,
            killSwitchActive: true,
            earnPolicyVersion: 0,
            activatedAt: null,
            enableOnlineStoreLauncher: false,
            enableCustomerAccountHub: false,
            enableCheckoutExtension: false,
            enableProductPointsWidget: false,
            enableMetafieldsSync: false,
            surfaceFlags: Prisma.DbNull,
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "rolling_12m",
            vipDowngradeGraceDays: 0,
            vipAutoDowngradeEnabled: false,
            branding: Prisma.DbNull,
            metadata: Prisma.DbNull,
          },
        }),
    });
    return {
      completed: false,
      phase: "purge_native_reviews",
      cursor: Prisma.DbNull,
      progress: progressAfterRevisionPurge,
    };
  }

  if (request.phase === "purge_native_reviews") {
    const result = await purgeNativeReviewsBatch(request.storeId);
    return {
      completed: false,
      phase: result.hasMore ? "purge_native_reviews" : "purge_catalog",
      cursor: Prisma.DbNull,
    };
  }

  if (request.phase === "purge_catalog") {
    await withDistributedLock({
      key: `weletic:catalog-sync:${request.store.projectId}`,
      ttlSeconds: 5 * 60,
      onLocked: () => {
        throw new Error(
          "Catalog sync is still draining before Shopify shop erasure.",
        );
      },
      fn: () =>
        prisma.$transaction([
          prisma.weleticShopifyProduct.deleteMany({
            where: { storeId: request.storeId },
          }),
          prisma.weleticShopifyMarket.deleteMany({
            where: { storeId: request.storeId },
          }),
          prisma.weleticShopifyWebhookEvent.deleteMany({
            where: { storeId: request.storeId },
          }),
          prisma.weleticShopifySyncRun.deleteMany({
            where: { storeId: request.storeId },
          }),
        ]),
    });
    return { completed: false, phase: "purge_export_artifacts" };
  }

  if (request.phase === "purge_export_artifacts") {
    await revokeStoreDataExports(request);
    const result = await deleteComplianceArtifactsForStoreBatch({
      storeId: request.storeId,
      batchSize: SHOP_REDACT_PAGE_SIZE,
    });
    if (result.failed > 0) {
      throw new Error(
        "One or more private compliance artifacts could not be erased.",
      );
    }
    return result.selected > 0
      ? {
          completed: false,
          phase: "purge_export_artifacts",
          progress: { complianceArtifactsDeleted: result.deleted },
        }
      : { completed: false, phase: "credential_scrub" };
  }

  if (request.phase === "credential_scrub") {
    const [project, installations] = await Promise.all([
      prisma.project.findUnique({
        where: { id: request.store.projectId },
        select: { shopifyStoreId: true },
      }),
      prisma.installedIntegration.findMany({
        where: {
          projectId: request.store.projectId,
          integrationId: SHOPIFY_INTEGRATION_ID,
        },
        select: { credentials: true },
      }),
    ]);
    const aliases = Array.from(
      new Set(
        [
          subject.shopDomain,
          project?.shopifyStoreId,
          ...installations.map(({ credentials }) => {
            const parsed = integrationCredentialsSchema.safeParse(
              credentials ?? {},
            );
            return parsed.success ? parsed.data.shop : null;
          }),
        ]
          .filter((value): value is string => Boolean(value))
          .map(normalizeShopDomain)
          .filter(Boolean),
      ),
    );
    invalidateShopifyStoreDomainCache(aliases);
    await prisma.$transaction([
      prisma.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: aliases } },
      }),
      prisma.weleticShopifySessionCoordination.deleteMany({
        where: { shop: { in: aliases } },
      }),
      prisma.weleticShopifyInstallIntent.deleteMany({
        where: { workspaceId: request.store.projectId },
      }),
      prisma.installedIntegration.deleteMany({
        where: {
          projectId: request.store.projectId,
          integrationId: SHOPIFY_INTEGRATION_ID,
        },
      }),
      prisma.project.update({
        where: { id: request.store.projectId },
        data: { shopifyStoreId: null },
      }),
    ]);
    invalidateShopifyStoreDomainCache(aliases);
    return { completed: false, phase: "finalize" };
  }

  if (request.phase === "finalize") {
    const finalized = await prisma.$transaction(async (tx) => {
      const stores = await tx.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          shopDomain: string;
          complianceState: string;
          redactedAt: Date | null;
          financialRetentionUntil: Date | null;
        }>
      >(Prisma.sql`
        SELECT id, projectId, shopDomain, complianceState, redactedAt, financialRetentionUntil
        FROM WeleticShopifyStore
        WHERE id = ${request.storeId}
        LIMIT 1
        FOR UPDATE
      `);
      const lockedStore = stores[0];
      if (!lockedStore || lockedStore.projectId !== request.store.projectId) {
        throw new Error(
          "Shop-redact finalization lost its exact Shopify store owner.",
        );
      }
      if (
        lockedStore.complianceState !== "frozen" &&
        lockedStore.complianceState !== "redacted"
      ) {
        throw new Error(
          "Shop-redact finalization requires a frozen Shopify store.",
        );
      }
      if (lockedStore.complianceState === "redacted") {
        await tx.weleticMerchantSettings.deleteMany({
          where: { storeId: request.storeId },
        });
        const tombstone = await tx.weleticShopifyShopPrivacyTombstone.findFirst(
          {
            where: {
              storeId: request.storeId,
              OR: deriveAllShopifyShopPrivacyIdentities({
                shopDomain: subject.shopDomain,
              }),
            },
            select: {
              identityKeyId: true,
              shopDomainDigest: true,
            },
          },
        );
        if (
          !tombstone ||
          !lockedStore.redactedAt ||
          !lockedStore.financialRetentionUntil ||
          lockedStore.shopDomain !==
            `redacted-${tombstone.identityKeyId}-${tombstone.shopDomainDigest.slice(0, 32)}.invalid`
        ) {
          throw new Error(
            "The already-redacted Shopify store failed its immutable tombstone invariant.",
          );
        }
        const staffCleanup = await purgeShopifyStaffPrivacyBatch(
          tx,
          lockedStore.id,
        );
        if (staffCleanup.pending) return { staffCleanupPending: true as const };
        return {
          aliases: [] as string[],
          financialRetentionUntil: lockedStore.financialRetentionUntil,
        };
      }
      if (
        normalizeShopDomain(lockedStore.shopDomain) !==
        normalizeShopDomain(subject.shopDomain)
      ) {
        throw new Error(
          "Shop-redact finalization detected a changed Shopify domain.",
        );
      }

      const redactedAt = lockedStore.redactedAt ?? new Date();
      const staffCleanup = await purgeShopifyStaffPrivacyBatch(
        tx,
        lockedStore.id,
      );
      if (staffCleanup.pending) return { staffCleanupPending: true as const };
      const financialRetentionUntil =
        lockedStore.financialRetentionUntil ??
        addRetentionDays(redactedAt, getShopifyFinancialRetentionDays());
      const tombstone = await upsertShopifyShopPrivacyTombstone({
        storeId: request.storeId,
        shopDomain: subject.shopDomain,
        sourceRequestId: request.id,
        redactedAt,
        expiresAt: financialRetentionUntil,
        tx,
      });
      const pseudonymousDomain = `redacted-${tombstone.identityKeyId}-${tombstone.shopDomainDigest.slice(0, 32)}.invalid`;
      const [project, installations] = await Promise.all([
        tx.project.findUnique({
          where: { id: lockedStore.projectId },
          select: { shopifyStoreId: true },
        }),
        tx.installedIntegration.findMany({
          where: {
            projectId: lockedStore.projectId,
            OR: [
              { integrationId: SHOPIFY_INTEGRATION_ID },
              { integration: { slug: "shopify" } },
            ],
          },
          select: { credentials: true },
        }),
      ]);
      const aliases = Array.from(
        new Set(
          [
            subject.shopDomain,
            lockedStore.shopDomain,
            project?.shopifyStoreId,
            ...installations.map(({ credentials }) => {
              const parsed = integrationCredentialsSchema.safeParse(
                credentials ?? {},
              );
              return parsed.success ? parsed.data.shop : null;
            }),
          ]
            .filter((value): value is string => Boolean(value))
            .map(normalizeShopDomain)
            .filter(Boolean),
        ),
      );

      // This is the authoritative final drain. Credential/session writers
      // acquire the same store row before their final lifecycle checks, so a
      // writer either commits first and is swept here or observes the redacted
      // state/tombstone after this transaction commits.
      await tx.weleticMerchantSettings.deleteMany({
        where: { storeId: request.storeId },
      });
      await tx.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: aliases } },
      });
      await tx.weleticShopifySessionCoordination.deleteMany({
        where: { shop: { in: aliases } },
      });
      await tx.weleticShopifyInstallIntent.deleteMany({
        where: { workspaceId: lockedStore.projectId },
      });
      // Remove only this nonfinancial operational incident under the same final
      // store lock. Retained financial reconciliation evidence is untouched.
      await tx.weleticReconciliationIssue.deleteMany({
        where: {
          storeId: lockedStore.id,
          kind: SHOPIFY_SESSION_MISSING_ISSUE_KIND,
        },
      });
      await tx.installedIntegration.deleteMany({
        where: {
          projectId: lockedStore.projectId,
          OR: [
            { integrationId: SHOPIFY_INTEGRATION_ID },
            { integration: { slug: "shopify" } },
          ],
        },
      });
      await tx.project.update({
        where: { id: lockedStore.projectId },
        data: { shopifyStoreId: null },
      });
      await tx.weleticShopifyStore.update({
        where: { id: request.storeId },
        data: {
          shopDomain: pseudonymousDomain,
          complianceState: "redacted",
          redactedAt,
          financialRetentionUntil,
        },
      });
      await tx.weleticShopifyComplianceRequest.updateMany({
        where: { storeId: request.storeId },
        data: { shopDomain: pseudonymousDomain },
      });
      await tx.weleticShopifyComplianceRequest.updateMany({
        where: { storeId: request.storeId, id: { not: request.id } },
        data: {
          payloadCiphertext: null,
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          cursor: Prisma.DbNull,
          lastError: null,
        },
      });
      await tx.weleticShopifyComplianceRequest.updateMany({
        where: {
          storeId: request.storeId,
          id: { not: request.id },
          status: { in: ["pending", "processing", "retrying"] },
        },
        data: {
          status: "completed",
          phase: "already_redacted",
          completedAt: redactedAt,
          lockedAt: null,
          lockedBy: null,
          nextRetryAt: null,
        },
      });
      return { aliases, financialRetentionUntil };
    });
    if ("staffCleanupPending" in finalized) {
      return { completed: false, phase: "finalize" };
    }
    if (finalized.aliases.length > 0) {
      invalidateShopifyStoreDomainCache(finalized.aliases);
    }
    return {
      completed: true,
      phase: "completed",
      progress: {
        financialRetentionUntil:
          finalized.financialRetentionUntil.toISOString(),
        financialHardPurge: "operator_gated",
      },
    };
  }

  throw new Error(`Unsupported shop redact phase: ${request.phase}`);
}

async function executeComplianceStep(request: any): Promise<StepState> {
  if (request.requestType === "customer_data_request") {
    return processCustomerDataRequestStep(request);
  }
  if (request.requestType === "customer_redact") {
    return processCustomerRedactStep(request);
  }
  if (request.requestType === "shop_redact") {
    return processShopRedactStep(request);
  }
  if (request.requestType === "app_uninstalled") {
    const subject = readSubject(request.payloadCiphertext);
    if (!subject.installationGeneration) {
      throw new ComplianceOperatorReviewError(
        "The uninstall request is missing its immutable installation generation.",
      );
    }
    const uninstallCutoff = request.triggeredAt ?? request.receivedAt;
    if (request.phase === "received") {
      const freeze = await freezeShopifyStoreForUninstall({
        storeId: request.storeId,
        workspaceId: request.store.projectId,
        canonicalShopDomain: subject.shopDomain,
        cutoff: uninstallCutoff,
        expectedInstallationGeneration: subject.installationGeneration,
      });
      if (freeze.complianceState === "stale_reinstall") {
        return {
          completed: true,
          phase: "stale_after_reinstall",
          cursor: Prisma.DbNull,
          progress: { staleReinstall: true },
        };
      }
      if (freeze.complianceState === "redacted") {
        return {
          completed: true,
          phase: "already_redacted",
          cursor: Prisma.DbNull,
        };
      }
    }
    const uninstallStep = await processAppUninstalledComplianceStep({
      requestId: request.id,
      workspaceId: request.store.projectId,
      storeId: request.storeId,
      shopDomain: subject.shopDomain,
      receivedAt: uninstallCutoff,
      installationGeneration: subject.installationGeneration,
      phase: request.phase,
      cursor: request.cursor,
      progress: request.progress,
      workerId: request.lockedBy,
    });
    return uninstallStep;
  }
  throw new Error(
    `Unsupported compliance request type: ${request.requestType}`,
  );
}

function retryDelayMs(attempt: number) {
  return Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attempt, 8));
}

function privacySafeComplianceError(error: unknown, request: any) {
  let message = error instanceof Error ? error.message : String(error);
  const rawValues = new Set<string>();
  if (typeof request.shopDomain === "string") rawValues.add(request.shopDomain);
  try {
    const subject = readSubject(request.payloadCiphertext);
    for (const value of [
      subject.shopDomain,
      subject.customerId,
      subject.customerEmail,
    ]) {
      if (typeof value === "string" && value) rawValues.add(value);
    }
  } catch {
    // The original parse error is already subject-independent.
  }
  for (const value of rawValues) {
    message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 4_000);
}

export async function processShopifyComplianceRequest({
  requestId,
  workerId,
  enqueueContinuation = true,
}: {
  requestId: string;
  workerId: string;
  /**
   * The periodic worker and authenticated route keep this enabled. A bounded
   * staging harness may disable it while it drains an exact request itself so
   * QStash cannot race the harness for the next lease.
   */
  enqueueContinuation?: boolean;
}) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  const candidate = await prisma.weleticShopifyComplianceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      nextRetryAt: true,
      lockedAt: true,
      leaseVersion: true,
    },
  });
  if (!candidate || ["completed", "dead_letter"].includes(candidate.status)) {
    return { claimed: false, status: candidate?.status ?? "missing" };
  }
  if (candidate.nextRetryAt && candidate.nextRetryAt > now) {
    return { claimed: false, status: "not_due" };
  }
  if (
    candidate.status === "processing" &&
    candidate.lockedAt &&
    candidate.lockedAt > staleBefore
  ) {
    return { claimed: false, status: "leased" };
  }

  const claimed = await prisma.weleticShopifyComplianceRequest.updateMany({
    where: {
      id: requestId,
      leaseVersion: candidate.leaseVersion,
      OR: [
        { status: { in: ["pending", "retrying"] } },
        { status: "processing", lockedAt: { lte: staleBefore } },
      ],
    },
    data: {
      status: "processing",
      lockedAt: now,
      lockedBy: workerId,
      leaseVersion: { increment: 1 },
      startedAt: candidate.status === "pending" ? now : undefined,
      lastError: null,
    },
  });
  if (claimed.count !== 1) return { claimed: false, status: "lost_race" };

  const expectedLeaseVersion = candidate.leaseVersion + 1;
  const request = await prisma.weleticShopifyComplianceRequest.findFirst({
    where: {
      id: requestId,
      status: "processing",
      lockedBy: workerId,
      leaseVersion: expectedLeaseVersion,
    },
    include: { store: { select: { projectId: true } } },
  });
  if (!request) {
    return { claimed: true, completed: false, status: "lost_lease" };
  }
  const leaseVersion = request.leaseVersion;
  try {
    const step = await executeComplianceStep(request);
    const finishedAt = new Date();
    const defaultDelaySeconds = [
      "voucher_cleanup",
      "customer_voucher_cleanup",
    ].includes(step.phase)
      ? 30
      : 0;
    const delaySeconds = step.delaySeconds ?? defaultDelaySeconds;
    const nextRetryAt =
      !step.completed && delaySeconds > 0
        ? new Date(finishedAt.getTime() + delaySeconds * 1000)
        : null;
    const updated = await prisma.weleticShopifyComplianceRequest.updateMany({
      where: { id: requestId, lockedBy: workerId, leaseVersion },
      data: {
        status: step.completed ? "completed" : "pending",
        phase: step.phase,
        ...(step.cursor !== undefined ? { cursor: step.cursor } : {}),
        ...(step.progress !== undefined ? { progress: step.progress } : {}),
        ...(step.payloadCiphertext !== undefined
          ? { payloadCiphertext: step.payloadCiphertext }
          : {}),
        ...(step.completed
          ? {
              payloadCiphertext: null,
              cursor: Prisma.DbNull,
              subjectKind: null,
              subjectKeyId: null,
              subjectDigest: null,
              completedAt: finishedAt,
            }
          : {}),
        lockedAt: null,
        lockedBy: null,
        nextRetryAt,
        lastError: null,
      },
    });
    if (updated.count !== 1) {
      throw new ComplianceLeaseLostError(
        "Compliance request lease was lost before checkpoint.",
      );
    }
    if (!step.completed && enqueueContinuation) {
      await dispatchDurableShopifyComplianceRequest({
        requestId,
        dispatch: () =>
          enqueueShopifyComplianceWorker(requestId, { delaySeconds }),
        failurePolicy: "preserve-retry-deadline",
      });
    }
    return { claimed: true, completed: step.completed, phase: step.phase };
  } catch (error) {
    // The phase checkpoint is already committed and its durable row was made
    // immediately due. Let the current queue delivery fail so QStash retries;
    // the generic step-failure path no longer owns this released lease.
    if (error instanceof ShopifyComplianceDispatchUnavailableError) throw error;
    if (error instanceof ComplianceLeaseLostError) {
      return {
        claimed: true,
        completed: false,
        status: "lost_lease",
      };
    }
    const nextAttempt = request.attempts + 1;
    const deadLetter =
      error instanceof ComplianceOperatorReviewError ||
      error instanceof ShopifyCustomerPrivacyOwnerConflictError ||
      nextAttempt >= request.maxAttempts;
    const failed = await prisma.weleticShopifyComplianceRequest.updateMany({
      where: { id: requestId, lockedBy: workerId, leaseVersion },
      data: {
        status: deadLetter ? "dead_letter" : "retrying",
        attempts: nextAttempt,
        nextRetryAt: deadLetter
          ? null
          : new Date(Date.now() + retryDelayMs(nextAttempt)),
        lockedAt: null,
        lockedBy: null,
        lastError: privacySafeComplianceError(error, request),
      },
    });
    if (failed.count !== 1) {
      return {
        claimed: true,
        completed: false,
        status: "lost_lease",
      };
    }
    return {
      claimed: true,
      completed: false,
      status: deadLetter ? "dead_letter" : "retrying",
    };
  }
}

export async function processShopifyComplianceBatch({
  batchSize,
  workerId,
  timeBudgetMs = COMPLIANCE_RECOVERY_TIME_BUDGET_MS,
}: {
  batchSize: number;
  workerId: string;
  timeBudgetMs?: number;
}) {
  const recoveryStartedAt = Date.now();
  const boundedBatchSize = boundedComplianceRecoveryBatchSize(batchSize);
  // Retention is an independent privacy deadline, not best-effort tail work.
  // Service both bounded sweepers first so a sustained sequence of slow
  // oldest requests cannot starve artifact/tombstone deletion indefinitely.
  const artifactExpiry = await deleteExpiredComplianceArtifactsBatch({
    batchSize: boundedBatchSize,
  });
  const tombstoneExpiry = await deleteExpiredShopifyPrivacyTombstonesBatch({
    batchSize: boundedBatchSize,
  });
  const couponUseExpiry = await deleteExpiredShopperCouponUsesBatch({
    batchSize: boundedBatchSize,
  });
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  const requests = await prisma.weleticShopifyComplianceRequest.findMany({
    where: {
      OR: [
        {
          status: "pending",
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        { status: "retrying", nextRetryAt: { lte: now } },
        { status: "processing", lockedAt: { lte: staleBefore } },
      ],
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: boundedBatchSize,
    select: { id: true },
  });
  const results: Array<
    Awaited<ReturnType<typeof processShopifyComplianceRequest>>
  > = [];
  let budgetExhausted = false;
  for (const request of requests) {
    if (Date.now() - recoveryStartedAt >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    results.push(
      await processShopifyComplianceRequest({
        requestId: request.id,
        workerId,
      }),
    );
  }

  const hasRecoveryBudget = () => Date.now() - recoveryStartedAt < timeBudgetMs;
  return {
    selected: requests.length,
    processed: results.length,
    budgetExhausted:
      budgetExhausted ||
      results.length < requests.length ||
      !hasRecoveryBudget(),
    results,
    artifactExpiry,
    tombstoneExpiry,
    couponUseExpiry,
  };
}
