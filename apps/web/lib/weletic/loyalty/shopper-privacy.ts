import { linkCache } from "@/lib/api/links/cache";
import { prisma } from "@/lib/prisma";
import {
  attachReviewIncentivePolicyExports,
  reviewIncentiveClaimExportSelect,
  reviewIncentiveInvalidationExportSelect,
  reviewIncentivePolicyExportSelect,
  reviewParticipationExportSelect,
} from "@/lib/weletic/reviews/incentive-export";
import {
  getShopifyCustomerPrivacyPseudonym,
  hasShopifyCustomerPrivacyTombstone,
} from "@/lib/weletic/shopify/privacy-identity";
import {
  Prisma,
  WeleticLoyaltyAccountStatus,
  WeleticLoyaltyOutboxJobStatus,
  WeleticLoyaltyOutboxJobType,
} from "@prisma/client";

const PRIVACY_CAS_MAX_ATTEMPTS = 5;
export const SHOPPER_DATA_EXPORT_RECORD_LIMIT = 100;
export const SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY =
  "shopifyCustomerRedaction";
const BIRTHDAY_JOB_STATUSES_TO_CANCEL = new Set<WeleticLoyaltyOutboxJobStatus>([
  WeleticLoyaltyOutboxJobStatus.pending,
  WeleticLoyaltyOutboxJobStatus.failed,
  WeleticLoyaltyOutboxJobStatus.processing,
  WeleticLoyaltyOutboxJobStatus.dead_letter,
]);

const CUSTOMER_CONTEXT_JSON_KEYS = new Set([
  "expiryDeliverySnapshot",
  "birthDate",
  "birthday",
  "registeredAt",
  "orderName",
  "checkoutToken",
  "customerOrderSequence",
  "customerClassification",
  "customerSegmentIds",
  "matchedSegmentId",
  "referralCode",
  "ipHash",
  "userAgentHash",
  "clientIp",
  "ipAddress",
  "userAgent",
  "customerEmail",
  "customerName",
  "shopifyCustomerId",
  "email",
  "phone",
  "firstName",
  "lastName",
  "locale",
  "segmentIds",
  "country",
]);

function readJsonObject(
  value: Prisma.JsonValue | null | undefined,
): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : null;
}

export function scrubCustomerContextJsonValue(
  value: Prisma.JsonValue,
): Prisma.InputJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === "object"
        ? scrubCustomerContextJsonValue(item as Prisma.JsonValue)
        : item,
    ) as Prisma.InputJsonArray;
  }
  if (value === null) return null as unknown as Prisma.InputJsonValue;
  if (typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CUSTOMER_CONTEXT_JSON_KEYS.has(key))
      .map(([key, item]) => [
        key,
        item && typeof item === "object"
          ? scrubCustomerContextJsonValue(item as Prisma.JsonValue)
          : item,
      ]),
  ) as Prisma.InputJsonObject;
}

function scrubCustomerContextJson(
  value: Prisma.JsonValue | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value == null) return Prisma.DbNull;
  const scrubbed = scrubCustomerContextJsonValue(value);
  return typeof scrubbed === "object" &&
    !Array.isArray(scrubbed) &&
    Object.keys(scrubbed).length === 0
    ? Prisma.DbNull
    : scrubbed;
}

export function readShopifyCustomerRedactionTombstone(
  metadata: Prisma.JsonValue | null | undefined,
): { redactedAt: string; source: "shopify_customers_redact" } | null {
  const value =
    readJsonObject(metadata)?.[SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const tombstone = value as Prisma.JsonObject;
  return tombstone.status === "redacted" &&
    typeof tombstone.redactedAt === "string" &&
    tombstone.source === "shopify_customers_redact"
    ? {
        redactedAt: tombstone.redactedAt,
        source: "shopify_customers_redact",
      }
    : null;
}

export function hasShopifyCustomerRedactionTombstone(
  metadata: Prisma.JsonValue | null | undefined,
): boolean {
  return readShopifyCustomerRedactionTombstone(metadata) !== null;
}

export async function isShopifyCustomerPrivacyTombstonedForWorkspace({
  workspaceId,
  shopifyCustomerId,
}: {
  workspaceId: string;
  shopifyCustomerId: string;
}): Promise<boolean> {
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { projectId: workspaceId },
    select: { id: true },
  });
  if (!store) return false;

  if (
    await hasShopifyCustomerPrivacyTombstone({
      storeId: store.id,
      shopifyCustomerId,
    })
  ) {
    return true;
  }

  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId: store.id,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
    select: { loyaltyAccount: { select: { metadata: true } } },
  });
  return hasShopifyCustomerRedactionTombstone(
    shopper?.loyaltyAccount?.metadata,
  );
}

function readBirthdayMetadata(metadata: Prisma.JsonValue | null) {
  const birthday = readJsonObject(metadata)?.birthday;
  return birthday && typeof birthday === "object" && !Array.isArray(birthday)
    ? birthday
    : null;
}

export function redactBirthdayFromLoyaltyMetadata(
  metadata: Prisma.JsonValue | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const value = readJsonObject(metadata);
  if (!value) {
    return metadata == null
      ? Prisma.DbNull
      : (metadata as Prisma.InputJsonValue);
  }

  const { birthday: _birthday, ...nonPiiMetadata } = value;
  return Object.keys(nonPiiMetadata).length > 0
    ? (nonPiiMetadata as Prisma.InputJsonObject)
    : Prisma.DbNull;
}

export function addShopifyCustomerRedactionTombstone({
  metadata,
  redactedAt,
}: {
  metadata: Prisma.JsonValue | null | undefined;
  redactedAt: Date;
}): Prisma.InputJsonObject {
  const value = readJsonObject(metadata) ?? {};
  const previousTombstone = readShopifyCustomerRedactionTombstone(metadata);
  const { birthday: _birthday, ...nonPiiMetadata } = value;

  return {
    ...nonPiiMetadata,
    [SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY]: {
      status: "redacted",
      redactedAt: previousTombstone?.redactedAt ?? redactedAt.toISOString(),
      source: "shopify_customers_redact",
    },
  };
}

function redactBirthdayRewardPayload({
  payload,
  accountId,
  redactedAt,
}: {
  payload: Prisma.JsonValue;
  accountId: string;
  redactedAt: Date;
}): Prisma.InputJsonObject {
  const value = readJsonObject(payload);
  const calendarYear = value?.calendarYear;
  const existingRedactedAt = value?.birthdayRedactedAt;

  return {
    accountId,
    ...(typeof calendarYear === "number" && Number.isInteger(calendarYear)
      ? { calendarYear }
      : {}),
    birthdayRedactedAt:
      typeof existingRedactedAt === "string"
        ? existingRedactedAt
        : redactedAt.toISOString(),
    redactionReason: "shopify_customer_redact",
  };
}

function redactBirthdayFromLedgerMetadata(
  metadata: Prisma.JsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata == null
      ? Prisma.DbNull
      : (metadata as Prisma.InputJsonValue);
  }

  const {
    birthDate: _birthDate,
    birthday: _birthday,
    registeredAt: _registeredAt,
    ...nonPiiMetadata
  } = metadata;
  return Object.keys(nonPiiMetadata).length > 0
    ? (nonPiiMetadata as Prisma.InputJsonObject)
    : Prisma.DbNull;
}

function ledgerMetadataContainsBirthday(metadata: Prisma.JsonValue | null) {
  const value = metadata && readJsonObject(metadata);
  return Boolean(
    value &&
      ("birthDate" in value || "birthday" in value || "registeredAt" in value),
  );
}

async function closeLoyaltyAccountAndRedactBirthday({
  storeId,
  shopifyCustomerId,
  redactedAt,
}: {
  storeId: string;
  shopifyCustomerId: string;
  redactedAt: Date;
}): Promise<string | null> {
  for (let attempt = 0; attempt < PRIVACY_CAS_MAX_ATTEMPTS; attempt++) {
    const account = await prisma.weleticLoyaltyAccount.findFirst({
      where: {
        storeId,
        shopper: { storeId, shopifyCustomerId },
      },
      select: {
        id: true,
        metadata: true,
        updatedAt: true,
      },
    });
    if (!account) return null;

    const metadata = addShopifyCustomerRedactionTombstone({
      metadata: account.metadata,
      redactedAt,
    });
    const updated = await prisma.weleticLoyaltyAccount.updateMany({
      where: {
        id: account.id,
        storeId,
        updatedAt: account.updatedAt,
        shopper: { storeId, shopifyCustomerId },
      },
      data: {
        status: WeleticLoyaltyAccountStatus.closed,
        metadata,
        referralCode: null,
        referredById: null,
        lastQualifyingActivityAt: null,
        nextExpiryDate: null,
      },
    });
    if (updated.count === 1) return account.id;
  }

  throw new Error(
    "Loyalty account kept changing during Shopify customer redaction.",
  );
}

async function scrubBirthdayRewardOutboxJob({
  storeId,
  accountId,
  jobId,
  redactedAt,
}: {
  storeId: string;
  accountId: string;
  jobId: string;
  redactedAt: Date;
}): Promise<void> {
  for (let attempt = 0; attempt < PRIVACY_CAS_MAX_ATTEMPTS; attempt++) {
    const job = await prisma.weleticLoyaltyOutboxJob.findFirst({
      where: {
        id: jobId,
        storeId,
        jobType: WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD,
        payload: { path: "$.accountId", equals: accountId },
      },
      select: {
        id: true,
        status: true,
        payload: true,
        updatedAt: true,
      },
    });
    if (!job) return;

    const shouldCancel = BIRTHDAY_JOB_STATUSES_TO_CANCEL.has(job.status);
    const wasCompleted = job.status === WeleticLoyaltyOutboxJobStatus.completed;
    const updated = await prisma.weleticLoyaltyOutboxJob.updateMany({
      where: {
        id: job.id,
        storeId,
        jobType: WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD,
        status: job.status,
        updatedAt: job.updatedAt,
        payload: { path: "$.accountId", equals: accountId },
      },
      data: {
        payload: redactBirthdayRewardPayload({
          payload: job.payload,
          accountId,
          redactedAt,
        }),
        // Chained jobs are created and scheduled on the member's birthday.
        // Replace every operational timestamp/log that could reconstruct the
        // month/day, retaining only the explicit redaction audit timestamp.
        createdAt: redactedAt,
        scheduledFor: redactedAt,
        processedAt: wasCompleted ? redactedAt : null,
        completedAt: wasCompleted ? redactedAt : null,
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: Prisma.DbNull,
        lastError: shouldCancel
          ? "Cancelled after Shopify customer birthday redaction."
          : null,
        ...(shouldCancel
          ? {
              status: WeleticLoyaltyOutboxJobStatus.cancelled,
            }
          : {}),
      },
    });
    if (updated.count === 1) return;
  }

  throw new Error(
    `Birthday outbox job ${jobId} kept changing during customer redaction.`,
  );
}

export async function scrubBirthdayRewardOutboxJobs({
  storeId,
  accountId,
  redactedAt = new Date(),
}: {
  storeId: string;
  accountId: string;
  redactedAt?: Date;
}): Promise<number> {
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      storeId,
      jobType: WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD,
      payload: { path: "$.accountId", equals: accountId },
    },
    select: { id: true },
  });

  for (const job of jobs) {
    await scrubBirthdayRewardOutboxJob({
      storeId,
      accountId,
      jobId: job.id,
      redactedAt,
    });
  }

  return jobs.length;
}

async function scrubBirthdayLedgerEntry({
  storeId,
  accountId,
  ledgerEntryId,
  redactedAt,
}: {
  storeId: string;
  accountId: string;
  ledgerEntryId: string;
  redactedAt: Date;
}): Promise<void> {
  for (let attempt = 0; attempt < PRIVACY_CAS_MAX_ATTEMPTS; attempt++) {
    const entry = await prisma.weleticPointsLedgerEntry.findFirst({
      where: {
        id: ledgerEntryId,
        storeId,
        accountId,
        referenceType: "BIRTHDAY_REWARD",
      },
      select: { id: true, metadata: true },
    });
    if (!entry || !ledgerMetadataContainsBirthday(entry.metadata)) return;

    const updated = await prisma.weleticPointsLedgerEntry.updateMany({
      where: {
        id: entry.id,
        storeId,
        accountId,
        referenceType: "BIRTHDAY_REWARD",
        metadata: { equals: entry.metadata as Prisma.InputJsonValue },
      },
      data: {
        metadata: redactBirthdayFromLedgerMetadata(entry.metadata),
        reason: "Birthday reward details redacted.",
        createdAt: redactedAt,
      },
    });
    if (updated.count === 1) return;
  }

  throw new Error(
    `Birthday ledger entry ${ledgerEntryId} kept changing during customer redaction.`,
  );
}

export async function scrubLegacyBirthdayLedgerMetadata({
  storeId,
  accountId,
  redactedAt = new Date(),
}: {
  storeId: string;
  accountId: string;
  redactedAt?: Date;
}): Promise<number> {
  const entries = await prisma.weleticPointsLedgerEntry.findMany({
    where: {
      storeId,
      accountId,
      referenceType: "BIRTHDAY_REWARD",
    },
    select: { id: true },
  });

  for (const entry of entries) {
    await scrubBirthdayLedgerEntry({
      storeId,
      accountId,
      ledgerEntryId: entry.id,
      redactedAt,
    });
  }

  return entries.length;
}

export async function redactLoyaltyBirthdayData({
  storeId,
  shopifyCustomerId,
  redactedAt = new Date(),
}: {
  storeId: string;
  shopifyCustomerId: string;
  redactedAt?: Date;
}) {
  const accountId = await closeLoyaltyAccountAndRedactBirthday({
    storeId,
    shopifyCustomerId,
    redactedAt,
  });
  if (!accountId) {
    return { accountId: null, scrubbedJobs: 0, scrubbedLedgerEntries: 0 };
  }

  const [scrubbedJobs, scrubbedLedgerEntries] = await Promise.all([
    scrubBirthdayRewardOutboxJobs({ storeId, accountId, redactedAt }),
    scrubLegacyBirthdayLedgerMetadata({ storeId, accountId, redactedAt }),
  ]);
  return { accountId, scrubbedJobs, scrubbedLedgerEntries };
}

async function scrubRequestedOrderCustomerContext({
  storeId,
  orderExternalIds,
}: {
  storeId: string;
  orderExternalIds: readonly string[];
}) {
  if (orderExternalIds.length === 0) return { count: 0 };

  const orders = await prisma.weleticCommerceOrder.findMany({
    where: { storeId, externalId: { in: [...orderExternalIds] } },
    select: {
      id: true,
      lines: {
        select: {
          calculations: { select: { id: true, inputs: true } },
        },
      },
      refunds: {
        select: {
          lines: {
            select: {
              calculations: { select: { id: true, inputs: true } },
            },
          },
        },
      },
    },
  });

  const calculations = orders.flatMap((order) => [
    ...order.lines.flatMap((line) => line.calculations),
    ...order.refunds.flatMap((refund) =>
      refund.lines.flatMap((line) => line.calculations),
    ),
  ]);
  for (const calculation of calculations) {
    await prisma.weleticCommissionCalculation.updateMany({
      where: {
        id: calculation.id,
        inputs: { equals: calculation.inputs as Prisma.InputJsonValue },
      },
      data: {
        inputs: scrubCustomerContextJsonValue(
          calculation.inputs as Prisma.JsonValue,
        ),
      },
    });
  }

  return prisma.weleticCommerceOrder.updateMany({
    where: {
      storeId,
      id: { in: orders.map((order) => order.id) },
    },
    data: {
      checkoutToken: null,
      orderName: null,
      customerOrderSequence: null,
      customerClassification: "unknown",
      customerSegmentIds: Prisma.DbNull,
    },
  });
}

async function scrubLoyaltyAccountCustomerContext({
  storeId,
  accountId,
  projectId,
  shopDomain,
  redactedAt,
}: {
  storeId: string;
  accountId: string;
  projectId: string;
  shopDomain: string;
  redactedAt: Date;
}) {
  const [ledgerEntries, redemptions, referrals, referralLink] =
    await Promise.all([
      prisma.weleticPointsLedgerEntry.findMany({
        where: { storeId, accountId },
        select: { id: true, metadata: true },
      }),
      prisma.weleticRewardRedemption.findMany({
        where: { storeId, accountId },
        select: { id: true, metadata: true },
      }),
      prisma.weleticLoyaltyReferral.findMany({
        where: {
          storeId,
          OR: [
            { advocateAccountId: accountId },
            { refereeAccountId: accountId },
          ],
        },
        select: { id: true, metadata: true },
      }),
      prisma.link.findFirst({
        where: {
          projectId,
          externalId: `loyalty_referral:${accountId}`,
        },
        select: {
          id: true,
          domain: true,
          key: true,
          externalId: true,
        },
      }),
    ]);

  for (const entry of ledgerEntries) {
    await prisma.weleticPointsLedgerEntry.updateMany({
      where: { id: entry.id, storeId, accountId },
      data: {
        reason: "Customer context redacted.",
        metadata: scrubCustomerContextJson(entry.metadata),
      },
    });
  }

  for (const redemption of redemptions) {
    await prisma.weleticRewardRedemption.updateMany({
      where: { id: redemption.id, storeId, accountId },
      data: {
        metadata: scrubCustomerContextJson(redemption.metadata),
      },
    });
  }

  for (const referral of referrals) {
    await prisma.weleticLoyaltyReferral.updateMany({
      where: { id: referral.id, storeId },
      data: {
        dubLinkId: null,
        ipHash: null,
        userAgentHash: null,
        fraudReason: null,
        fraudSignals: Prisma.DbNull,
        metadata: scrubCustomerContextJson(referral.metadata),
      },
    });
  }

  if (referralLink) {
    // Phase 1 persists a disabled state while retaining the old lookup key.
    // If cache invalidation fails, the privacy webhook can safely retry and
    // rediscover this row instead of leaving an untraceable live redirect.
    const disabled = await prisma.link.updateMany({
      where: {
        id: referralLink.id,
        projectId,
        externalId: referralLink.externalId,
        key: referralLink.key,
      },
      data: {
        url: `https://${shopDomain}`,
        title: "Redacted loyalty referral",
        description: null,
        archived: true,
        disabledAt: redactedAt,
      },
    });
    if (disabled.count !== 1) {
      throw new Error(
        `Referral link ${referralLink.id} changed during customer redaction.`,
      );
    }

    await linkCache.invalidateMany([referralLink]);

    // Phase 2 removes the customer-derived lookup identity only after every
    // cache layer has acknowledged invalidation.
    const redactedKey = `redacted-${referralLink.id}`;
    const scrubbed = await prisma.link.updateMany({
      where: {
        id: referralLink.id,
        projectId,
        externalId: referralLink.externalId,
        key: referralLink.key,
      },
      data: {
        externalId: null,
        key: redactedKey,
        shortLink: `https://${referralLink.domain}/${redactedKey}`,
        url: `https://${shopDomain}`,
        title: "Redacted loyalty referral",
        description: null,
        archived: true,
        disabledAt: redactedAt,
      },
    });
    if (scrubbed.count !== 1) {
      throw new Error(
        `Referral link ${referralLink.id} could not finish customer redaction.`,
      );
    }
  }
}

async function scrubAccountScopedOutboxJob({
  storeId,
  accountId,
  jobId,
  redactedAt,
}: {
  storeId: string;
  accountId: string;
  jobId: string;
  redactedAt: Date;
}): Promise<void> {
  for (let attempt = 0; attempt < PRIVACY_CAS_MAX_ATTEMPTS; attempt++) {
    const job = await prisma.weleticLoyaltyOutboxJob.findFirst({
      where: {
        id: jobId,
        storeId,
        payload: { path: "$.accountId", equals: accountId },
      },
      select: {
        id: true,
        jobType: true,
        status: true,
        payload: true,
        scheduledFor: true,
        updatedAt: true,
      },
    });
    if (!job) return;

    const isNonterminal = BIRTHDAY_JOB_STATUSES_TO_CANCEL.has(job.status);
    const requiresAuditedDiscountCleanup =
      isNonterminal &&
      (job.jobType === WeleticLoyaltyOutboxJobType.REDEMPTION_RECOVERY ||
        job.jobType === WeleticLoyaltyOutboxJobType.REFERRAL_REWARD_PROVISION ||
        job.jobType === WeleticLoyaltyOutboxJobType.VOUCHER_PRIVACY_CLEANUP);
    const preserveExpirySchedule =
      requiresAuditedDiscountCleanup &&
      job.jobType === WeleticLoyaltyOutboxJobType.REDEMPTION_RECOVERY &&
      readJsonObject(job.payload)?.sagaPhase === "expiry";
    const scrubbedPayload = scrubCustomerContextJsonValue(job.payload);
    const privacySafePayload =
      job.jobType === WeleticLoyaltyOutboxJobType.REFERRAL_REWARD_PROVISION &&
      typeof scrubbedPayload === "object" &&
      !Array.isArray(scrubbedPayload)
        ? (Object.fromEntries(
            Object.entries(scrubbedPayload).filter(
              ([key]) => key !== "rewardSnapshot",
            ),
          ) as Prisma.InputJsonObject)
        : scrubbedPayload;

    const updated = await prisma.weleticLoyaltyOutboxJob.updateMany({
      where: {
        id: job.id,
        storeId,
        status: job.status,
        updatedAt: job.updatedAt,
        payload: { path: "$.accountId", equals: accountId },
      },
      data: !isNonterminal
        ? {
            payload: privacySafePayload,
            lastError:
              job.status === WeleticLoyaltyOutboxJobStatus.completed
                ? null
                : "Customer context scrubbed after Shopify customer redaction.",
            errorLog: Prisma.DbNull,
          }
        : requiresAuditedDiscountCleanup
          ? {
              status: WeleticLoyaltyOutboxJobStatus.pending,
              payload: privacySafePayload,
              scheduledFor: preserveExpirySchedule
                ? job.scheduledFor
                : redactedAt,
              attempts: 0,
              processedAt: null,
              completedAt: null,
              nextRetryAt: null,
              lockedAt: null,
              lockedBy: null,
              lastError:
                "Queued for audited Shopify discount cleanup after customer redaction.",
              errorLog: Prisma.DbNull,
            }
          : {
              status: WeleticLoyaltyOutboxJobStatus.cancelled,
              payload: privacySafePayload,
              scheduledFor: redactedAt,
              processedAt: redactedAt,
              completedAt: redactedAt,
              nextRetryAt: null,
              lockedAt: null,
              lockedBy: null,
              lastError: "Cancelled after Shopify customer redaction.",
              errorLog: Prisma.DbNull,
            },
    });
    if (updated.count === 1) return;
  }

  throw new Error(
    `Loyalty outbox job ${jobId} kept changing during customer redaction.`,
  );
}

async function cancelAccountScopedOutboxJobs({
  storeId,
  accountId,
  redactedAt,
}: {
  storeId: string;
  accountId: string;
  redactedAt: Date;
}) {
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      storeId,
      payload: { path: "$.accountId", equals: accountId },
    },
    select: { id: true },
  });

  for (const job of jobs) {
    await scrubAccountScopedOutboxJob({
      storeId,
      accountId,
      jobId: job.id,
      redactedAt,
    });
  }
}

const CUSTOMER_PRIVACY_SCRUB_PAGE_SIZE = 50;
export type WeleticCustomerPrivacyScrubPhase =
  | "scrub_account_outbox"
  | "scrub_account_ledger"
  | "scrub_account_redemptions"
  | "scrub_account_referrals"
  | "scrub_referral_link"
  | "completed";

function privacyScrubCursor(value: Prisma.JsonValue | null | undefined) {
  const object = readJsonObject(value);
  return typeof object?.lastId === "string" ? object.lastId : undefined;
}

function nextPrivacyScrubPage<T extends { id: string }>({
  records,
  currentPhase,
  nextPhase,
}: {
  records: T[];
  currentPhase: WeleticCustomerPrivacyScrubPhase;
  nextPhase: WeleticCustomerPrivacyScrubPhase;
}) {
  const hasMore = records.length > CUSTOMER_PRIVACY_SCRUB_PAGE_SIZE;
  const bounded = records.slice(0, CUSTOMER_PRIVACY_SCRUB_PAGE_SIZE);
  return {
    bounded,
    result: {
      completed: false as const,
      phase: hasMore ? currentPhase : nextPhase,
      cursor: hasMore
        ? ({
            lastId: bounded[bounded.length - 1].id,
          } satisfies Prisma.InputJsonObject)
        : Prisma.DbNull,
      progress: {
        lastBatchScrubbed: bounded.length,
      } satisfies Prisma.InputJsonObject,
    },
  };
}

/** Executes one bounded account-context scrub phase for durable compliance. */
export async function processWeleticLoyaltyAccountPrivacyScrubStep({
  storeId,
  accountId,
  phase,
  cursor,
  redactedAt,
  shopErasure = false,
}: {
  storeId: string;
  accountId: string;
  phase: WeleticCustomerPrivacyScrubPhase;
  cursor?: Prisma.JsonValue | null;
  redactedAt: Date;
  shopErasure?: boolean;
}): Promise<{
  completed: boolean;
  phase: WeleticCustomerPrivacyScrubPhase;
  cursor: Prisma.InputJsonValue | typeof Prisma.DbNull;
  progress?: Prisma.InputJsonValue;
}> {
  const lastId = privacyScrubCursor(cursor);
  const page = {
    take: CUSTOMER_PRIVACY_SCRUB_PAGE_SIZE + 1,
    orderBy: { id: "asc" as const },
    ...(lastId ? { where: { id: { gt: lastId } } } : {}),
  };

  if (phase === "scrub_account_outbox") {
    const records = await prisma.weleticLoyaltyOutboxJob.findMany({
      where: {
        storeId,
        payload: { path: "$.accountId", equals: accountId },
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      take: page.take,
      orderBy: page.orderBy,
      select: { id: true, jobType: true },
    });
    const { bounded, result } = nextPrivacyScrubPage({
      records,
      currentPhase: phase,
      nextPhase: "scrub_account_ledger",
    });
    for (const job of bounded) {
      if (job.jobType === WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD) {
        await scrubBirthdayRewardOutboxJob({
          storeId,
          accountId,
          jobId: job.id,
          redactedAt,
        });
      } else {
        await scrubAccountScopedOutboxJob({
          storeId,
          accountId,
          jobId: job.id,
          redactedAt,
        });
      }
    }
    return result;
  }

  if (phase === "scrub_account_ledger") {
    const records = await prisma.weleticPointsLedgerEntry.findMany({
      where: {
        storeId,
        accountId,
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      take: page.take,
      orderBy: page.orderBy,
      select: { id: true, referenceType: true, metadata: true },
    });
    const { bounded, result } = nextPrivacyScrubPage({
      records,
      currentPhase: phase,
      nextPhase: "scrub_account_redemptions",
    });
    for (const entry of bounded) {
      if (entry.referenceType === "BIRTHDAY_REWARD") {
        await scrubBirthdayLedgerEntry({
          storeId,
          accountId,
          ledgerEntryId: entry.id,
          redactedAt,
        });
      } else {
        await prisma.weleticPointsLedgerEntry.updateMany({
          where: { id: entry.id, storeId, accountId },
          data: {
            reason: "Customer context redacted.",
            metadata: scrubCustomerContextJson(entry.metadata),
          },
        });
      }
    }
    return result;
  }

  if (phase === "scrub_account_redemptions") {
    const records = await prisma.weleticRewardRedemption.findMany({
      where: {
        storeId,
        accountId,
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      take: page.take,
      orderBy: page.orderBy,
      select: { id: true, metadata: true },
    });
    const { bounded, result } = nextPrivacyScrubPage({
      records,
      currentPhase: phase,
      nextPhase: "scrub_account_referrals",
    });
    for (const redemption of bounded) {
      await prisma.weleticRewardRedemption.updateMany({
        where: { id: redemption.id, storeId, accountId },
        data: { metadata: scrubCustomerContextJson(redemption.metadata) },
      });
    }
    return result;
  }

  if (phase === "scrub_account_referrals") {
    const records = await prisma.weleticLoyaltyReferral.findMany({
      where: {
        storeId,
        OR: [{ advocateAccountId: accountId }, { refereeAccountId: accountId }],
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      take: page.take,
      orderBy: page.orderBy,
      select: { id: true, metadata: true },
    });
    const { bounded, result } = nextPrivacyScrubPage({
      records,
      currentPhase: phase,
      nextPhase: "scrub_referral_link",
    });
    for (const referral of bounded) {
      await prisma.weleticLoyaltyReferral.updateMany({
        where: { id: referral.id, storeId },
        data: {
          dubLinkId: null,
          ipHash: null,
          userAgentHash: null,
          fraudReason: null,
          fraudSignals: Prisma.DbNull,
          metadata: scrubCustomerContextJson(referral.metadata),
        },
      });
    }
    return result;
  }

  if (phase === "scrub_referral_link") {
    const store = await prisma.weleticShopifyStore.findUniqueOrThrow({
      where: { id: storeId },
      select: { projectId: true, shopDomain: true },
    });
    const referralLink = await prisma.link.findFirst({
      where: {
        projectId: store.projectId,
        externalId: `loyalty_referral:${accountId}`,
      },
      select: {
        id: true,
        domain: true,
        key: true,
        externalId: true,
      },
    });
    if (referralLink) {
      const safeDestination = shopErasure
        ? "https://redacted.invalid"
        : `https://${store.shopDomain}`;
      const disabled = await prisma.link.updateMany({
        where: {
          id: referralLink.id,
          projectId: store.projectId,
          externalId: referralLink.externalId,
          key: referralLink.key,
        },
        data: {
          url: safeDestination,
          title: "Redacted loyalty referral",
          description: null,
          archived: true,
          disabledAt: redactedAt,
        },
      });
      if (disabled.count !== 1) {
        throw new Error(
          `Referral link ${referralLink.id} changed during customer redaction.`,
        );
      }
      await linkCache.invalidateMany([referralLink]);
      const redactedKey = `redacted-${referralLink.id}`;
      const scrubbed = await prisma.link.updateMany({
        where: {
          id: referralLink.id,
          projectId: store.projectId,
          externalId: referralLink.externalId,
          key: referralLink.key,
        },
        data: {
          externalId: null,
          key: redactedKey,
          shortLink: `https://${referralLink.domain}/${redactedKey}`,
          url: safeDestination,
          title: "Redacted loyalty referral",
          description: null,
          archived: true,
          disabledAt: redactedAt,
        },
      });
      if (scrubbed.count !== 1) {
        throw new Error(
          `Referral link ${referralLink.id} could not finish customer redaction.`,
        );
      }
    }
    return {
      completed: true,
      phase: "completed",
      cursor: Prisma.DbNull,
      progress: { referralLinkScrubbed: Boolean(referralLink) },
    };
  }

  return { completed: true, phase: "completed", cursor: Prisma.DbNull };
}

export async function prepareWeleticShopperRedaction({
  storeId,
  shopifyCustomerId,
}: {
  storeId: string;
  shopifyCustomerId: string;
}) {
  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
    select: { id: true },
  });
  const redactedAt = new Date();

  if (!shopper) {
    return {
      found: false as const,
      shopperId: null,
      accountId: null,
      redactedAt,
    };
  }

  const accountId = await closeLoyaltyAccountAndRedactBirthday({
    storeId,
    shopifyCustomerId: String(shopifyCustomerId),
    redactedAt,
  });

  return {
    found: true as const,
    shopperId: shopper.id,
    accountId,
    redactedAt,
  };
}

export async function scrubWeleticShopperCustomerContext({
  storeId,
  shopifyCustomerId,
  shopperId,
  accountId,
  orderExternalIds = [],
  redactedAt = new Date(),
}: {
  storeId: string;
  shopifyCustomerId: string;
  shopperId?: string | null;
  accountId?: string | null;
  orderExternalIds?: readonly string[];
  redactedAt?: Date;
}) {
  const normalizedOrderExternalIds = [
    ...new Set(orderExternalIds.map(String).filter(Boolean)),
  ];
  if (shopperId) {
    const pseudonymousCustomerId = getShopifyCustomerPrivacyPseudonym({
      storeId,
      shopifyCustomerId,
    });
    const anonymized = await prisma.weleticShopper.updateMany({
      where: {
        id: shopperId,
        storeId,
        shopifyCustomerId: {
          in: [String(shopifyCustomerId), pseudonymousCustomerId],
        },
      },
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
    if (anonymized.count !== 1) {
      throw new Error(
        `Shopper ${shopperId} changed tenant identity during customer redaction.`,
      );
    }
  }

  const redactedOrders = await scrubRequestedOrderCustomerContext({
    storeId,
    orderExternalIds: normalizedOrderExternalIds,
  });
  return {
    found: Boolean(shopperId),
    shopperId: shopperId ?? undefined,
    redactedOrders: redactedOrders.count,
  };
}

export async function anonymizeWeleticShopper({
  storeId,
  shopifyCustomerId,
  orderExternalIds = [],
  sourceRequestId,
}: {
  storeId: string;
  shopifyCustomerId: string;
  orderExternalIds?: readonly string[];
  sourceRequestId?: string | null;
}) {
  const prepared = await prepareWeleticShopperRedaction({
    storeId,
    shopifyCustomerId,
  });
  if (prepared.shopperId) {
    const { fenceShopperIncentiveRedaction } = await import(
      "@/lib/weletic/reviews/incentive-privacy-fence"
    );
    await fenceShopperIncentiveRedaction({
      storeId,
      shopperId: prepared.shopperId,
      shopifyCustomerId,
      accountId: prepared.accountId,
      sourceRequestId,
      redactedAt: prepared.redactedAt,
    });
    const { redactNativeReviewsBatch } = await import(
      "@/lib/weletic/reviews/privacy"
    );
    while (
      (await redactNativeReviewsBatch(storeId, prepared.shopperId)).hasMore
    ) {
      /* Bounded, resumable pages. */
    }
  }
  if (prepared.accountId || prepared.shopperId) {
    // Compatibility path for direct callers. Durable compliance processing
    // uses the bounded page helper and request-link relation instead.
    const { enqueueVoucherPrivacyCleanupsForAccount } = await import(
      "@/lib/weletic/loyalty/voucher-privacy-cleanup"
    );
    await enqueueVoucherPrivacyCleanupsForAccount({
      storeId,
      accountId: prepared.accountId,
      shopperId: prepared.shopperId,
      sourceRequestId,
    });
  }
  const scrubbed = await scrubWeleticShopperCustomerContext({
    storeId,
    shopifyCustomerId,
    shopperId: prepared.shopperId,
    accountId: prepared.accountId,
    orderExternalIds,
    redactedAt: prepared.redactedAt,
  });
  if (prepared.accountId) {
    const store = await prisma.weleticShopifyStore.findUniqueOrThrow({
      where: { id: storeId },
      select: { projectId: true, shopDomain: true },
    });
    await Promise.all([
      scrubBirthdayRewardOutboxJobs({
        storeId,
        accountId: prepared.accountId,
        redactedAt: prepared.redactedAt,
      }),
      scrubLegacyBirthdayLedgerMetadata({
        storeId,
        accountId: prepared.accountId,
        redactedAt: prepared.redactedAt,
      }),
    ]);
    await cancelAccountScopedOutboxJobs({
      storeId,
      accountId: prepared.accountId,
      redactedAt: prepared.redactedAt,
    });
    await scrubLoyaltyAccountCustomerContext({
      storeId,
      accountId: prepared.accountId,
      projectId: store.projectId,
      shopDomain: store.shopDomain,
      redactedAt: prepared.redactedAt,
    });
  }
  return {
    ...scrubbed,
    found: prepared.found,
    shopperId: prepared.shopperId ?? undefined,
  };
}

async function collectAllExportPages<T extends { id: string }>(
  fetchPage: (cursor: string | undefined) => Promise<T[]>,
): Promise<T[]> {
  const records: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    records.push(...page);
    cursor =
      page.length === SHOPPER_DATA_EXPORT_RECORD_LIMIT
        ? page[page.length - 1].id
        : undefined;
  } while (cursor);
  return records;
}

export async function getShopperDataExport({
  storeId,
  shopifyCustomerId,
  orderExternalIds = [],
}: {
  storeId: string;
  shopifyCustomerId: string;
  orderExternalIds?: readonly string[];
}) {
  const requestedOrderIds = [
    ...new Set(orderExternalIds.map(String).filter(Boolean)),
  ];
  const [store, shopper] = await Promise.all([
    prisma.weleticShopifyStore.findUnique({
      where: { id: storeId },
      select: { projectId: true },
    }),
    prisma.weleticShopper.findUnique({
      where: {
        storeId_shopifyCustomerId: {
          storeId,
          shopifyCustomerId: String(shopifyCustomerId),
        },
      },
      select: {
        id: true,
        shopifyCustomerId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        locale: true,
        tags: true,
        segmentIds: true,
        acceptsMarketing: true,
        ordersCount: true,
        totalSpent: true,
        createdAt: true,
        updatedAt: true,
        loyaltyAccount: {
          select: {
            id: true,
            status: true,
            ledgerVersion: true,
            cachedPointsBalance: true,
            cachedPendingPoints: true,
            lifetimePointsEarned: true,
            lifetimePointsRedeemed: true,
            lastQualifyingActivityAt: true,
            nextExpiryDate: true,
            referralCode: true,
            referredById: true,
            referralCount: true,
            referralPointsEarned: true,
            tierExpiresAt: true,
            tierSpendRolling12Months: true,
            tierPointsRolling12Months: true,
            metadata: true,
            enrolledAt: true,
            createdAt: true,
            updatedAt: true,
            currentTier: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);
  const legacyCustomer = store
    ? await prisma.customer.findUnique({
        where: {
          projectId_externalId: {
            projectId: store.projectId,
            externalId: String(shopifyCustomerId),
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          externalId: true,
          stripeCustomerId: true,
          linkId: true,
          clickId: true,
          clickedAt: true,
          country: true,
          sales: true,
          saleAmount: true,
          firstSaleAt: true,
          subscriptionCanceledAt: true,
          projectConnectId: true,
          programId: true,
          partnerId: true,
          createdAt: true,
          updatedAt: true,
        },
      })
    : null;
  const loyaltyAccount = shopper?.loyaltyAccount ?? null;

  const ledgerEntries = loyaltyAccount
    ? await collectAllExportPages((cursor) =>
        prisma.weleticPointsLedgerEntry.findMany({
          where: { storeId, accountId: loyaltyAccount.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            sequenceNumber: true,
            entryType: true,
            pointsDelta: true,
            pendingDelta: true,
            balanceAfter: true,
            grantId: true,
            referenceType: true,
            referenceId: true,
            reason: true,
            metadata: true,
            createdAt: true,
          },
        }),
      )
    : [];
  const redemptions = shopper
    ? await collectAllExportPages((cursor) =>
        prisma.weleticRewardRedemption.findMany({
          where: {
            storeId,
            OR: [
              { shopperId: shopper.id, accountId: null },
              ...(loyaltyAccount ? [{ accountId: loyaltyAccount.id }] : []),
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            pointsSpent: true,
            fulfillmentSource: true,
            fulfillmentReference: true,
            shopifyDiscountCode: true,
            shopifyDiscountId: true,
            shopifyPriceRuleId: true,
            status: true,
            compensationReason: true,
            orderId: true,
            expiresAt: true,
            usedAt: true,
            ledgerEntryId: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
            rewardDefinition: {
              select: { name: true, rewardType: true },
            },
          },
        }),
      )
    : [];
  const rewardCouponUses = shopper
    ? await collectAllExportPages((cursor) =>
        prisma.weleticRewardCouponUse.findMany({
          where: { storeId, shopperId: shopper.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      )
    : [];
  const tierHistory = loyaltyAccount
    ? await collectAllExportPages((cursor) =>
        prisma.weleticLoyaltyTierHistory.findMany({
          where: { accountId: loyaltyAccount.id },
          orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            fromTierId: true,
            toTierId: true,
            changeReason: true,
            notes: true,
            qualifyingSpendSnapshot: true,
            qualifyingPointsSnapshot: true,
            effectiveAt: true,
          },
        }),
      )
    : [];
  const advocateReferrals = loyaltyAccount
    ? await collectAllExportPages((cursor) =>
        prisma.weleticLoyaltyReferral.findMany({
          where: { storeId, advocateAccountId: loyaltyAccount.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            status: true,
            advocatePointsAwarded: true,
            rewardedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      )
    : [];
  const refereeReferrals = loyaltyAccount
    ? await collectAllExportPages((cursor) =>
        prisma.weleticLoyaltyReferral.findMany({
          where: { storeId, refereeAccountId: loyaltyAccount.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            status: true,
            qualifyingOrderId: true,
            refereePointsAwarded: true,
            rewardedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      )
    : [];

  const orderWhere = shopper
    ? {
        storeId,
        OR: [
          { shopperId: shopper.id },
          ...(requestedOrderIds.length > 0
            ? [{ externalId: { in: requestedOrderIds } }]
            : []),
        ],
      }
    : requestedOrderIds.length > 0
      ? { storeId, externalId: { in: requestedOrderIds } }
      : null;
  const orders = orderWhere
    ? await collectAllExportPages((cursor) =>
        prisma.weleticCommerceOrder.findMany({
          where: orderWhere,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            externalId: true,
            orderName: true,
            checkoutToken: true,
            customerOrderSequence: true,
            customerClassification: true,
            customerSegmentIds: true,
            status: true,
            presentmentCurrency: true,
            presentmentSubtotal: true,
            presentmentDiscount: true,
            presentmentNet: true,
            presentmentTax: true,
            presentmentShipping: true,
            presentmentTotal: true,
            shopCurrency: true,
            shopTotal: true,
            accountingCurrency: true,
            accountingNet: true,
            accountingTotal: true,
            occurredAt: true,
            processedAt: true,
            createdAt: true,
            updatedAt: true,
            lines: {
              select: {
                id: true,
                externalId: true,
                productId: true,
                variantId: true,
                sku: true,
                title: true,
                quantity: true,
                presentmentGross: true,
                presentmentDiscount: true,
                presentmentNet: true,
                accountingNet: true,
                calculations: {
                  select: {
                    id: true,
                    entryType: true,
                    commissionableAmount: true,
                    earnings: true,
                    accountingCurrency: true,
                    inputs: true,
                  },
                },
              },
            },
            refunds: {
              select: {
                id: true,
                externalId: true,
                presentmentCurrency: true,
                presentmentAmount: true,
                accountingCurrency: true,
                accountingAmount: true,
                occurredAt: true,
              },
            },
          },
        }),
      )
    : [];

  if (!shopper && !legacyCustomer && orders.length === 0) return null;
  const privacyTombstone = readShopifyCustomerRedactionTombstone(
    loyaltyAccount?.metadata,
  );

  const nativeReviews = shopper
    ? await collectAllExportPages((cursor) =>
        prisma.weleticProductReview.findMany({
          where: { storeId, shopperId: shopper.id },
          orderBy: { id: "asc" },
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            ...reviewParticipationExportSelect,
            id: true,
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
            media: {
              select: {
                id: true,
                contentType: true,
                sizeBytes: true,
                status: true,
              },
            },
          },
        }),
      )
    : [];
  const reviewModerationAudits = shopper
    ? await collectAllExportPages((cursor) =>
        prisma.weleticReviewModerationAudit.findMany({
          where: { storeId, review: { storeId, shopperId: shopper.id } },
          orderBy: { id: "asc" },
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            reviewId: true,
            reasonCode: true,
            reasonDetails: true,
            fromVersion: true,
            toVersion: true,
            fromStatus: true,
            toStatus: true,
            replyChanged: true,
            createdAt: true,
            redactedAt: true,
          },
        }),
      )
    : [];
  const reviewRequests = shopper
    ? await collectAllExportPages((cursor) =>
        prisma.weleticReviewRequest.findMany({
          where: { storeId, shopperId: shopper.id },
          orderBy: { id: "asc" },
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            incentivePolicyId: true,
            incentivePolicy: { select: reviewIncentivePolicyExportSelect },
            id: true,
            status: true,
            productId: true,
            orderId: true,
            fulfilledAt: true,
            sendAt: true,
            expiresAt: true,
            sentAt: true,
            submittedAt: true,
            cancelledAt: true,
            cancellationReason: true,
            createdAt: true,
          },
        }),
      )
    : [];

  const reviewIncentiveInvalidations = shopper
    ? await collectAllExportPages((cursor) =>
        prisma.weleticReviewIncentiveInvalidation.findMany({
          where: { storeId, shopperId: shopper.id },
          orderBy: { id: "asc" },
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: reviewIncentiveInvalidationExportSelect,
        }),
      )
    : [];
  const reviewIncentiveClaims = shopper
    ? await collectAllExportPages(async (cursor) =>
        attachReviewIncentivePolicyExports({
          db: prisma,
          storeId,
          rows: await prisma.weleticReviewIncentiveClaim.findMany({
            where: { storeId, shopperId: shopper.id },
            orderBy: { id: "asc" },
            take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: reviewIncentiveClaimExportSelect,
          }),
        }),
      )
    : [];

  return {
    shopperId: shopper?.id ?? null,
    nativeReviews,
    reviewModerationAudits,
    reviewRequests,
    reviewIncentiveClaims,
    reviewIncentiveInvalidations,
    shopifyCustomerId: shopper?.shopifyCustomerId ?? String(shopifyCustomerId),
    firstName: shopper?.firstName ?? null,
    lastName: shopper?.lastName ?? null,
    email: shopper?.email ?? null,
    phone: shopper?.phone ?? null,
    locale: shopper?.locale ?? null,
    tags: shopper?.tags ?? null,
    segmentIds: shopper?.segmentIds ?? null,
    acceptsMarketing: shopper?.acceptsMarketing ?? false,
    ordersCount: shopper?.ordersCount ?? 0,
    totalSpent: shopper?.totalSpent.toString() ?? "0",
    createdAt: shopper?.createdAt ?? null,
    updatedAt: shopper?.updatedAt ?? null,
    privacy: {
      customerRedacted: privacyTombstone !== null,
      redactedAt: privacyTombstone?.redactedAt ?? null,
    },
    legacyCustomer: legacyCustomer
      ? {
          ...legacyCustomer,
          saleAmount: legacyCustomer.saleAmount.toString(),
        }
      : null,
    exportCompleteness: {
      complete: true,
      internallyPaginated: true,
      pageSize: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
      requestedOrderIds,
      recordCounts: {
        ledgerEntries: ledgerEntries.length,
        rewards: redemptions.length,
        rewardCouponUses: rewardCouponUses.length,
        reviewIncentiveClaims: reviewIncentiveClaims.length,
        reviewIncentiveInvalidations: reviewIncentiveInvalidations.length,
        tierHistory: tierHistory.length,
        advocateReferrals: advocateReferrals.length,
        refereeReferrals: refereeReferrals.length,
        orders: orders.length,
      },
    },
    // Canonical reward collection, also present for reviews-only shoppers.
    // The nested account collection remains a compatibility alias; do not sum them.
    rewardFulfillments: redemptions.map((redemption) => ({
      ...redemption,
      pointsSpent: redemption.pointsSpent.toString(),
    })),
    rewardCouponUses: rewardCouponUses.map((use) => ({
      ...use,
      discountAmountMinor: use.discountAmountMinor?.toString() ?? null,
    })),
    loyaltyAccount: loyaltyAccount
      ? {
          id: loyaltyAccount.id,
          status: loyaltyAccount.status,
          ledgerVersion: loyaltyAccount.ledgerVersion,
          pointsBalance: loyaltyAccount.cachedPointsBalance.toString(),
          pendingPoints: loyaltyAccount.cachedPendingPoints.toString(),
          lifetimeEarned: loyaltyAccount.lifetimePointsEarned.toString(),
          lifetimeRedeemed: loyaltyAccount.lifetimePointsRedeemed.toString(),
          lastQualifyingActivityAt: loyaltyAccount.lastQualifyingActivityAt,
          nextExpiryDate: loyaltyAccount.nextExpiryDate,
          referralCode: loyaltyAccount.referralCode,
          referredById: loyaltyAccount.referredById,
          referralCount: loyaltyAccount.referralCount,
          referralPointsEarned: loyaltyAccount.referralPointsEarned.toString(),
          currentTier: loyaltyAccount.currentTier,
          tierExpiresAt: loyaltyAccount.tierExpiresAt,
          tierSpendRolling12Months:
            loyaltyAccount.tierSpendRolling12Months.toString(),
          tierPointsRolling12Months:
            loyaltyAccount.tierPointsRolling12Months.toString(),
          birthday: readBirthdayMetadata(loyaltyAccount.metadata),
          metadata: loyaltyAccount.metadata,
          enrolledAt: loyaltyAccount.enrolledAt,
          createdAt: loyaltyAccount.createdAt,
          updatedAt: loyaltyAccount.updatedAt,
          ledgerEntries: ledgerEntries.map((entry) => ({
            ...entry,
            pointsDelta: entry.pointsDelta.toString(),
            pendingDelta: entry.pendingDelta.toString(),
            balanceAfter: entry.balanceAfter.toString(),
          })),
          redemptions: redemptions.map((redemption) => ({
            ...redemption,
            pointsSpent: redemption.pointsSpent.toString(),
            rewardName: redemption.rewardDefinition?.name ?? null,
            rewardType: redemption.rewardDefinition?.rewardType ?? null,
            rewardDefinition: undefined,
          })),
          tierHistory: tierHistory.map((history) => ({
            ...history,
            qualifyingSpendSnapshot:
              history.qualifyingSpendSnapshot?.toString() ?? null,
            qualifyingPointsSnapshot:
              history.qualifyingPointsSnapshot?.toString() ?? null,
          })),
          referrals: {
            asAdvocate: advocateReferrals.map((referral) => ({
              id: referral.id,
              status: referral.status,
              advocatePointsAwarded: referral.advocatePointsAwarded.toString(),
              rewardedAt: referral.rewardedAt,
              createdAt: referral.createdAt,
              updatedAt: referral.updatedAt,
            })),
            asReferee: refereeReferrals.map((referral) => ({
              id: referral.id,
              status: referral.status,
              qualifyingOrderId: referral.qualifyingOrderId,
              refereePointsAwarded: referral.refereePointsAwarded.toString(),
              rewardedAt: referral.rewardedAt,
              createdAt: referral.createdAt,
              updatedAt: referral.updatedAt,
            })),
          },
        }
      : null,
    orders: orders.map((order) => ({
      ...order,
      presentmentSubtotal: order.presentmentSubtotal.toString(),
      presentmentDiscount: order.presentmentDiscount.toString(),
      presentmentNet: order.presentmentNet.toString(),
      presentmentTax: order.presentmentTax.toString(),
      presentmentShipping: order.presentmentShipping.toString(),
      presentmentTotal: order.presentmentTotal.toString(),
      shopTotal: order.shopTotal.toString(),
      accountingNet: order.accountingNet.toString(),
      accountingTotal: order.accountingTotal.toString(),
      lines: order.lines.map((line) => ({
        ...line,
        presentmentGross: line.presentmentGross.toString(),
        presentmentDiscount: line.presentmentDiscount.toString(),
        presentmentNet: line.presentmentNet.toString(),
        accountingNet: line.accountingNet.toString(),
        calculations: line.calculations.map((calculation) => ({
          ...calculation,
          commissionableAmount: calculation.commissionableAmount.toString(),
          earnings: calculation.earnings.toString(),
        })),
      })),
      refunds: order.refunds.map((refund) => ({
        ...refund,
        presentmentAmount: refund.presentmentAmount.toString(),
        accountingAmount: refund.accountingAmount.toString(),
      })),
    })),
  };
}
