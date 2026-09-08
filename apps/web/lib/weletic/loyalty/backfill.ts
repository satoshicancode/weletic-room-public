import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { decimalToMinorUnits, normalizeCurrency } from "@/lib/weletic/money";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import {
  hasShopifyCustomerPrivacyTombstone,
  SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN,
} from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticLoyaltyBackfillCreditStatus,
  WeleticLoyaltyBackfillJobStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { createHash } from "node:crypto";
import {
  allocatePointsAcrossOrderLines,
  calculateEligibleOrderPoints,
} from "./earn";
import { appendPointsLedgerEntry } from "./ledger";
import {
  assertActiveLoyaltyAccountForMutation,
  withActiveStoreLoyaltyMutation,
} from "./merchant-write-fence";
import { lockLoyaltyProgramRow } from "./program-write-fence";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

// Preview-time enrollment remains supported for explicitly active programs.
// The store -> program fence serializes this with disable, redaction and
// overlapping previews. Existing/closed accounts are never replaced or reopened.
export async function ensureBackfillPreviewAccount({
  storeId,
  programId,
  shopperId,
  expectedInstallationGeneration,
}: {
  storeId: string;
  programId: string;
  shopperId: string;
  expectedInstallationGeneration?: string | null;
}) {
  return withActiveStoreLoyaltyMutation({
    storeId,
    action: "loyalty_backfill_preview_account",
    expectedInstallationGeneration,
    operation: async (tx) => {
      const program = await lockLoyaltyProgramRow({
        tx,
        storeId,
        mode: "active",
      });
      if (program.id !== programId)
        throw new Error("Backfill program no longer matches this store.");
      const shopper = await tx.weleticShopper.findUnique({
        where: { id: shopperId },
        include: { loyaltyAccount: true },
      });
      if (!shopper || shopper.storeId !== storeId || !shopper.shopifyCustomerId)
        return null;
      if (
        SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN.test(
          shopper.shopifyCustomerId,
        )
      )
        return null;
      const account = shopper.loyaltyAccount;
      // Owner links survive identity scrubbing and expiry of identity matching.
      if (
        await tx.weleticShopifyCustomerPrivacyTombstone.findFirst({
          where: {
            storeId,
            OR: [
              { shopperId },
              ...(account ? [{ accountId: account.id }] : []),
            ],
          },
          select: { id: true },
        })
      )
        return null;
      if (
        await hasShopifyCustomerPrivacyTombstone({
          storeId,
          shopifyCustomerId: shopper.shopifyCustomerId,
          email: shopper.email,
          tx,
        })
      )
        return null;
      if (account)
        return account.storeId === storeId &&
          account.programId === programId &&
          account.status === "active" &&
          !hasShopifyCustomerRedactionTombstone(account.metadata)
          ? account
          : null;
      return tx.weleticLoyaltyAccount.create({
        data: {
          id: createWeleticId("wlacc_"),
          storeId,
          programId,
          shopperId,
          status: "active",
        },
      });
    },
  });
}

export const BACKFILL_JOB_LOCK_TTL_SECONDS = 60;
export const BACKFILL_COMMIT_STALE_AFTER_MS = 5 * 60 * 1000;

function backfillJobLockKey(jobId: string) {
  return `loyalty:backfill-job:${jobId}`;
}

async function withBackfillJobLock<T>({
  jobId,
  operation,
}: {
  jobId: string;
  operation: () => Promise<T>;
}) {
  return withDistributedLock({
    key: backfillJobLockKey(jobId),
    ttlSeconds: BACKFILL_JOB_LOCK_TTL_SECONDS,
    onLocked: () => {
      throw new Error(
        `Backfill job ${jobId} is already being committed or cancelled.`,
      );
    },
    fn: operation,
  });
}

export function readBackfillInstallationGeneration(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return process.env.NODE_ENV === "test" ? null : undefined;
  }
  const value = (metadata as Record<string, unknown>).installationGeneration;
  return typeof value === "string"
    ? value
    : process.env.NODE_ENV === "test"
      ? null
      : undefined;
}

export function readBackfillPolicyVersion(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).policyVersion;
  return typeof value === "number" ? value : null;
}

export function readBackfillPolicyRevisionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).policyRevisionId;
  return typeof value === "string" ? value : null;
}

export function readBackfillRepairAccountIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const value = (metadata as Record<string, unknown>).repairAccountIds;
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      ),
    ),
  ].sort();
}

export function readBackfillRepairSourceJobId(
  metadata: unknown,
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).repairSourceJobId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildBackfillOrderCompoundKey(orderId: string): string {
  return `backfill:order:${orderId}`;
}

export interface CompensatoryOrderReconciliation {
  orderId: string;
  originalNetSpend: bigint;
  refundedSpend: bigint;
  eligibleNetSpend: bigint;
  projectedPoints: bigint;
  isCancelled: boolean;
  isFullyRefunded: boolean;
  isPartiallyRefunded: boolean;
  missingLinesFallback: boolean;
  lineAllocations: BackfillLineAllocation[];
}

export interface BackfillLineAllocation {
  orderLineId: string;
  productId: string | null;
  variantId: string | null;
  lineExternalId: string | null;
  title: string | null;
  quantity: number;
  lineNetAmount: bigint;
  awardedPoints: bigint;
}

export type HistoricalBackfillOrder = {
  id: string;
  status?: string | null;
  shopperId?: string | null;
  shopCurrency?: string | null;
  shopNet?: bigint | null;
  shopSubtotal?: bigint | null;
  shopTotal?: bigint | null;
  presentmentCurrency?: string | null;
  presentmentNet?: bigint | null;
  presentmentTotal?: bigint | null;
  occurredAt?: Date | null;
  updatedAt?: Date | null;
  refunds?: Array<{
    id?: string;
    shopAmount?: bigint | null;
    presentmentAmount?: bigint | null;
    updatedAt?: Date | null;
    lines?: Array<{
      id?: string;
      orderLineId: string;
      shopAmount?: bigint | null;
      quantity?: number | null;
    }> | null;
  }> | null;
  lines?: Array<{
    id: string;
    externalId?: string | null;
    productId?: string | null;
    variantId?: string | null;
    title?: string | null;
    shopNet?: bigint | null;
    shopGross?: bigint | null;
    quantity?: number | null;
    updatedAt?: Date | null;
  }> | null;
};

function canonicalHistoricalOrderValue(order: HistoricalBackfillOrder) {
  return {
    id: order.id,
    status: order.status ?? null,
    shopperId: order.shopperId ?? null,
    shopCurrency: order.shopCurrency ?? null,
    shopNet: order.shopNet?.toString() ?? null,
    shopSubtotal: order.shopSubtotal?.toString() ?? null,
    shopTotal: order.shopTotal?.toString() ?? null,
    presentmentCurrency: order.presentmentCurrency ?? null,
    presentmentNet: order.presentmentNet?.toString() ?? null,
    presentmentTotal: order.presentmentTotal?.toString() ?? null,
    occurredAt: order.occurredAt?.toISOString() ?? null,
    updatedAt: order.updatedAt?.toISOString() ?? null,
    lines: [...(order.lines ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((line) => ({
        id: line.id,
        externalId: line.externalId ?? null,
        productId: line.productId ?? null,
        variantId: line.variantId ?? null,
        title: line.title ?? null,
        shopNet: line.shopNet?.toString() ?? null,
        shopGross: line.shopGross?.toString() ?? null,
        quantity: line.quantity ?? null,
        updatedAt: line.updatedAt?.toISOString() ?? null,
      })),
    refunds: [...(order.refunds ?? [])]
      .sort((left, right) =>
        String(left.id ?? "").localeCompare(String(right.id ?? "")),
      )
      .map((refund) => ({
        id: refund.id ?? null,
        shopAmount: refund.shopAmount?.toString() ?? null,
        presentmentAmount: refund.presentmentAmount?.toString() ?? null,
        updatedAt: refund.updatedAt?.toISOString() ?? null,
        lines: [...(refund.lines ?? [])]
          .sort((left, right) =>
            `${left.orderLineId}:${left.id ?? ""}`.localeCompare(
              `${right.orderLineId}:${right.id ?? ""}`,
            ),
          )
          .map((line) => ({
            id: line.id ?? null,
            orderLineId: line.orderLineId,
            shopAmount: line.shopAmount?.toString() ?? null,
            quantity: line.quantity ?? null,
          })),
      })),
  };
}

export function buildHistoricalOrderSnapshotHash(
  order: HistoricalBackfillOrder,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalHistoricalOrderValue(order)))
    .digest("hex");
}

export function reconcileCompensatoryHistoricalOrder({
  order,
  pointsPerCurrencyUnit,
  multiplier = 1.0,
  minOrderAmount,
}: {
  order: HistoricalBackfillOrder;
  pointsPerCurrencyUnit: number;
  multiplier?: number;
  minOrderAmount?: Prisma.Decimal | number | string | null;
}): CompensatoryOrderReconciliation {
  const isCancelled =
    order.status === "cancelled" ||
    order.status === "voided" ||
    Boolean((order as Record<string, unknown>).cancelledAt);

  if (isCancelled) {
    return {
      orderId: order.id,
      originalNetSpend: BigInt(0),
      refundedSpend: BigInt(0),
      eligibleNetSpend: BigInt(0),
      projectedPoints: BigInt(0),
      isCancelled: true,
      isFullyRefunded: false,
      isPartiallyRefunded: false,
      missingLinesFallback: !order.lines || order.lines.length === 0,
      lineAllocations: [],
    };
  }

  const rawShopNet =
    order.shopNet !== undefined && order.shopNet !== null
      ? order.shopNet
      : order.presentmentNet !== undefined && order.presentmentNet !== null
        ? order.presentmentNet
        : order.shopSubtotal !== undefined && order.shopSubtotal !== null
          ? order.shopSubtotal
          : BigInt(0);

  const cashRefundedSpend = (order.refunds || []).reduce(
    (acc, refund) =>
      acc + (refund.shopAmount ?? refund.presentmentAmount ?? BigInt(0)),
    BigInt(0),
  );
  const refundedAmountByOrderLine = new Map<string, bigint>();
  const refundedQuantityByOrderLine = new Map<string, bigint>();
  for (const refund of order.refunds ?? []) {
    for (const line of refund.lines ?? []) {
      refundedAmountByOrderLine.set(
        line.orderLineId,
        (refundedAmountByOrderLine.get(line.orderLineId) ?? BigInt(0)) +
          (line.shopAmount ?? BigInt(0)),
      );
      refundedQuantityByOrderLine.set(
        line.orderLineId,
        (refundedQuantityByOrderLine.get(line.orderLineId) ?? BigInt(0)) +
          BigInt(line.quantity ?? 0),
      );
    }
  }

  const effectiveRefundedByOrderLine = new Map<string, bigint>();
  for (const line of order.lines ?? []) {
    const lineNet = line.shopNet ?? line.shopGross ?? BigInt(0);
    const lineQuantity = BigInt(line.quantity ?? 0);
    const returnedQuantity =
      refundedQuantityByOrderLine.get(line.id) ?? BigInt(0);
    const boundedReturnedQuantity =
      returnedQuantity > lineQuantity ? lineQuantity : returnedQuantity;
    let quantityRefundTarget = BigInt(0);
    if (
      lineNet > BigInt(0) &&
      lineQuantity > BigInt(0) &&
      boundedReturnedQuantity > BigInt(0)
    ) {
      const numerator = boundedReturnedQuantity * lineNet;
      const quotient = numerator / lineQuantity;
      quantityRefundTarget =
        (numerator % lineQuantity) * BigInt(2) >= lineQuantity
          ? quotient + BigInt(1)
          : quotient;
    }
    const amountRefundTarget =
      refundedAmountByOrderLine.get(line.id) ?? BigInt(0);
    const effectiveRefundTarget =
      amountRefundTarget > quantityRefundTarget
        ? amountRefundTarget
        : quantityRefundTarget;
    effectiveRefundedByOrderLine.set(
      line.id,
      effectiveRefundTarget < lineNet ? effectiveRefundTarget : lineNet,
    );
  }
  const lineRefundedSpend = [...effectiveRefundedByOrderLine.values()].reduce(
    (total, amount) => total + amount,
    BigInt(0),
  );
  const effectiveRefundedSpend =
    lineRefundedSpend > cashRefundedSpend
      ? lineRefundedSpend
      : cashRefundedSpend;
  const refundedSpend =
    effectiveRefundedSpend > rawShopNet ? rawShopNet : effectiveRefundedSpend;

  const isFullyRefunded =
    order.status === "refunded" ||
    (refundedSpend >= rawShopNet && rawShopNet > BigInt(0));

  if (isFullyRefunded) {
    return {
      orderId: order.id,
      originalNetSpend: rawShopNet,
      refundedSpend,
      eligibleNetSpend: BigInt(0),
      projectedPoints: BigInt(0),
      isCancelled: false,
      isFullyRefunded: true,
      isPartiallyRefunded: false,
      missingLinesFallback: !order.lines || order.lines.length === 0,
      lineAllocations: [],
    };
  }

  const isPartiallyRefunded =
    order.status === "partially_refunded" ||
    refundedSpend > BigInt(0) ||
    [...refundedQuantityByOrderLine.values()].some(
      (quantity) => quantity > BigInt(0),
    );

  const eligibleNetSpend =
    rawShopNet > refundedSpend ? rawShopNet - refundedSpend : BigInt(0);

  const orderLineIds = new Set((order.lines ?? []).map(({ id }) => id));
  const hasUnauditableRefund =
    (order.status === "partially_refunded" &&
      (order.refunds ?? []).length === 0) ||
    (order.refunds ?? []).some(
      (refund) =>
        !refund.lines ||
        refund.lines.length === 0 ||
        refund.lines.some((line) => !orderLineIds.has(line.orderLineId)),
    );
  const missingLinesFallback =
    !order.lines || order.lines.length === 0 || hasUnauditableRefund;
  const currency = order.shopCurrency || order.presentmentCurrency || "USD";

  const minOrderSubtotalCents = minOrderAmount
    ? decimalToMinorUnits(String(minOrderAmount), normalizeCurrency(currency))
    : undefined;

  const projectedPoints = calculateEligibleOrderPoints({
    netAmountCents: eligibleNetSpend,
    currency,
    pointsPerCurrencyUnit,
    multiplier,
    minOrderSubtotalCents,
  });

  const remainingLines = (order.lines ?? []).map((line) => ({
    orderLineId: line.id,
    productId: line.productId ?? null,
    variantId: line.variantId ?? null,
    lineExternalId: line.externalId ?? null,
    title: line.title ?? null,
    quantity: line.quantity ?? 1,
    lineNetAmount:
      (line.shopNet ?? line.shopGross ?? BigInt(0)) >
      (effectiveRefundedByOrderLine.get(line.id) ?? BigInt(0))
        ? (line.shopNet ?? line.shopGross ?? BigInt(0)) -
          (effectiveRefundedByOrderLine.get(line.id) ?? BigInt(0))
        : BigInt(0),
  }));

  // Shopify can report order-level adjustments that are not attached to a
  // refund line. Scale the remaining line values to the authoritative order
  // net with Hare-Niemeyer so both spend and points conserve exactly.
  const normalizedLineSpend = allocatePointsAcrossOrderLines({
    grossPoints: eligibleNetSpend,
    lines: remainingLines,
  });
  const pointsByLine = allocatePointsAcrossOrderLines({
    grossPoints: projectedPoints,
    lines: normalizedLineSpend.map((line) => ({
      ...line,
      lineNetAmount: line.awardedPoints,
    })),
  });
  const lineAllocations = normalizedLineSpend.map((line) => {
    const points = pointsByLine.find(
      (candidate) => candidate.orderLineId === line.orderLineId,
    );
    return {
      orderLineId: line.orderLineId,
      productId: line.productId ?? null,
      variantId: line.variantId ?? null,
      lineExternalId: line.lineExternalId ?? null,
      title: line.title ?? null,
      quantity: line.quantity ?? 1,
      lineNetAmount: line.awardedPoints,
      awardedPoints: points?.awardedPoints ?? BigInt(0),
    };
  });

  return {
    orderId: order.id,
    originalNetSpend: rawShopNet,
    refundedSpend,
    eligibleNetSpend,
    projectedPoints,
    isCancelled: false,
    isFullyRefunded: false,
    isPartiallyRefunded,
    missingLinesFallback:
      missingLinesFallback ||
      lineAllocations.reduce(
        (total, line) => total + line.lineNetAmount,
        BigInt(0),
      ) !== eligibleNetSpend,
    lineAllocations,
  };
}

export interface CreateBackfillJobInput {
  storeId: string;
  programId?: string;
  lookbackDays?: number | null;
  lookbackStartDate?: Date | null;
  pointsPerCurrencyUnit?: Prisma.Decimal | number | string;
  minOrderAmount?: Prisma.Decimal | number | string;
  metadata?: Record<string, unknown>;
}

export interface BackfillJobSummary {
  id: string;
  storeId: string;
  programId: string;
  status: WeleticLoyaltyBackfillJobStatus;
  lookbackDays: number | null;
  lookbackStartDate: Date | null;
  pointsPerCurrencyUnit: number;
  minOrderAmount: number | null;
  totalShoppersCount: number;
  totalOrdersCount: number;
  totalProjectedPoints: bigint;
  processedAccountsCount: number;
  totalCommittedPoints: bigint;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

type BackfillJobForSummary = {
  id: string;
  storeId: string;
  programId: string;
  status: WeleticLoyaltyBackfillJobStatus;
  lookbackDays: number | null;
  lookbackStartDate: Date | null;
  pointsPerCurrencyUnit: Prisma.Decimal | number;
  minOrderAmount: Prisma.Decimal | number | null;
  totalShoppersCount: number;
  totalOrdersCount: number;
  totalProjectedPoints: bigint;
  processedAccountsCount: number;
  totalCommittedPoints: bigint;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

function summarizeBackfillJob(job: BackfillJobForSummary): BackfillJobSummary {
  return {
    id: job.id,
    storeId: job.storeId,
    programId: job.programId,
    status: job.status,
    lookbackDays: job.lookbackDays,
    lookbackStartDate: job.lookbackStartDate,
    pointsPerCurrencyUnit: Number(job.pointsPerCurrencyUnit),
    minOrderAmount:
      job.minOrderAmount === null ? null : Number(job.minOrderAmount),
    totalShoppersCount: job.totalShoppersCount,
    totalOrdersCount: job.totalOrdersCount,
    totalProjectedPoints: job.totalProjectedPoints,
    processedAccountsCount: job.processedAccountsCount,
    totalCommittedPoints: job.totalCommittedPoints,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

async function readAuthoritativeBackfillCommitProgress({
  tx,
  storeId,
  jobId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  jobId: string;
}) {
  const credits = await tx.weleticLoyaltyBackfillOrderCredit.findMany({
    where: {
      storeId,
      jobId,
      status: WeleticLoyaltyBackfillCreditStatus.credited,
    },
    select: { accountId: true, points: true },
  });
  return {
    processedAccountsCount: new Set(credits.map(({ accountId }) => accountId))
      .size,
    totalCommittedPoints: credits.reduce(
      (total, { points }) => total + points,
      BigInt(0),
    ),
  };
}

function commitFailureMessage({
  error,
  processedAccountsCount,
  totalCommittedPoints,
}: {
  error: unknown;
  processedAccountsCount: number;
  totalCommittedPoints: bigint;
}) {
  const message = error instanceof Error ? error.message : String(error);
  const state =
    processedAccountsCount > 0 || totalCommittedPoints !== BigInt(0)
      ? "PARTIAL_COMMIT"
      : "COMMIT_FAILED";
  return `${state}: ${processedAccountsCount} account(s), ${totalCommittedPoints.toString()} point(s) committed. ${message}`;
}

async function persistBackfillCommitFailure({
  jobId,
  storeId,
  commitLeaseId,
  expectedUpdatedAt,
  error,
}: {
  jobId: string;
  storeId: string;
  commitLeaseId: string | null;
  expectedUpdatedAt?: Date;
  error: unknown;
}) {
  return prisma.$transaction(async (tx) => {
    // This is audit-only bookkeeping after liability creation has stopped. It
    // deliberately does not require the obsolete active installation
    // generation, so freeze/reconnect failures cannot strand `committing`.
    const progress = await readAuthoritativeBackfillCommitProgress({
      tx,
      storeId,
      jobId,
    });
    const failed = await tx.weleticLoyaltyBackfillJob.updateMany({
      where: {
        id: jobId,
        storeId,
        status: WeleticLoyaltyBackfillJobStatus.committing,
        commitLeaseId,
        ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
      },
      data: {
        status: WeleticLoyaltyBackfillJobStatus.failed,
        commitLeaseId: null,
        ...progress,
        errorLog: commitFailureMessage({ error, ...progress }),
        completedAt: null,
      },
    });
    // A zero count means a newer worker already reclaimed the stale lease.
    // The obsolete worker must never overwrite that worker's durable state.
    return failed.count === 1;
  });
}

type BackfillOrderSnapshotToPublish =
  Prisma.WeleticLoyaltyBackfillOrderSnapshotCreateManyInput & {
    shopperId: string;
    accountId: string;
    projectedPoints: bigint;
  };

async function lockAndFilterPublishableBackfillOrderSnapshots({
  tx,
  storeId,
  items,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  items: BackfillOrderSnapshotToPublish[];
}) {
  const accountIds = [...new Set(items.map(({ accountId }) => accountId))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (accountIds.length === 0) return [];

  const lockedAccounts = await tx.$queryRaw<
    Array<{
      id: string;
      status: string;
      metadata: Prisma.JsonValue | null;
    }>
  >(Prisma.sql`
    SELECT id, status, metadata
    FROM WeleticLoyaltyAccount
    WHERE storeId = ${storeId}
      AND id IN (${Prisma.join(accountIds)})
    ORDER BY id
    FOR UPDATE
  `);
  const publishableAccountIds = new Set(
    lockedAccounts
      .filter(
        (account) =>
          account.status === "active" &&
          !hasShopifyCustomerRedactionTombstone(account.metadata),
      )
      .map(({ id }) => id),
  );

  return items.filter(({ accountId }) => publishableAccountIds.has(accountId));
}

/**
 * Creates a new Historical Opening Balance Backfill Job (ADR 0005).
 * Enforces 'read_all_orders' scope validation for lookback windows exceeding 60 days.
 */
export async function createBackfillJob(
  input: CreateBackfillJobInput,
): Promise<BackfillJobSummary> {
  const operationalStore = await assertShopifyStoreAcceptsOperationalWrites({
    storeId: input.storeId,
    action: "loyalty_backfill_create",
  });
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { id: input.storeId },
  });

  if (!store) {
    throw new Error(`Shopify store ${input.storeId} not found.`);
  }

  const program = await prisma.weleticLoyaltyProgram.findUnique({
    where: { storeId: input.storeId },
  });

  if (!program) {
    throw new Error(
      `No loyalty program found for store ${input.storeId}. Create a loyalty program first.`,
    );
  }

  // Enforce read_all_orders scope requirement for lookbacks beyond 60 days or all-time
  const isHistorical =
    input.lookbackDays === null ||
    input.lookbackDays === undefined ||
    input.lookbackDays > 60 ||
    (input.lookbackStartDate &&
      input.lookbackStartDate.getTime() <
        Date.now() - 60 * 24 * 60 * 60 * 1000);

  if (isHistorical) {
    const session = await prisma.weleticShopifyAppSession.findFirst({
      where: {
        isOnline: false,
        shop: store.shopDomain,
      },
      orderBy: { updatedAt: "desc" },
    });

    let scopeString = "";
    if (session?.payload) {
      try {
        let parsed: any;
        try {
          const { decrypt } = await import("@/lib/encryption");
          parsed = JSON.parse(decrypt(session.payload));
        } catch {
          parsed = JSON.parse(session.payload);
        }
        if (Array.isArray(parsed)) {
          const sessionValues = Object.fromEntries(parsed);
          scopeString = String(sessionValues.scope || "");
        } else if (typeof parsed === "object" && parsed !== null) {
          scopeString = String(parsed.scope || "");
        }
      } catch {
        // payload parse fallback
      }
    }

    const scopes = scopeString
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hasReadAllOrders = scopes.includes("read_all_orders");

    if (!session || !hasReadAllOrders) {
      throw new Error(
        "READ_ALL_ORDERS_REQUIRED: Shopify access scope 'read_all_orders' is required to perform historical backfill beyond 60 days. Please request access or choose a lookback window <= 60 days.",
      );
    }
  }

  const jobId = createWeleticId("wbackfill_");
  const pointsRate =
    input.pointsPerCurrencyUnit !== undefined
      ? new Prisma.Decimal(input.pointsPerCurrencyUnit)
      : program.pointsPerCurrencyUnit;

  const minOrder =
    input.minOrderAmount !== undefined
      ? new Prisma.Decimal(input.minOrderAmount)
      : null;

  let startDate = input.lookbackStartDate || null;
  if (!startDate && input.lookbackDays) {
    startDate = new Date(Date.now() - input.lookbackDays * 24 * 60 * 60 * 1000);
  }

  const latestRevision =
    await prisma.weleticLoyaltyEarnPolicyRevision.findFirst({
      where: {
        storeId: input.storeId,
        programId: program.id,
      },
      orderBy: { version: "desc" },
      select: { id: true },
    });

  const policyVersion = program.earnPolicyVersion ?? 0;
  const policyRevisionId = latestRevision?.id ?? null;

  if (!policyRevisionId) {
    throw new Error(
      "BACKFILL_POLICY_REVISION_REQUIRED: create the immutable earn-policy baseline before creating a historical backfill.",
    );
  }

  const job = await withActiveStoreLoyaltyMutation({
    storeId: input.storeId,
    action: "loyalty_backfill_create",
    expectedInstallationGeneration:
      operationalStore?.installationGeneration ?? null,
    operation: (tx, installationGeneration) =>
      tx.weleticLoyaltyBackfillJob.create({
        data: {
          id: jobId,
          storeId: input.storeId,
          programId: program.id,
          status: WeleticLoyaltyBackfillJobStatus.pending,
          lookbackDays: input.lookbackDays || null,
          lookbackStartDate: startDate,
          pointsPerCurrencyUnit: pointsRate,
          minOrderAmount: minOrder,
          metadata: {
            ...(input.metadata ?? {}),
            installationGeneration,
            policyVersion,
            policyRevisionId,
          } as Prisma.InputJsonValue,
        },
      }),
  });

  return {
    id: job.id,
    storeId: job.storeId,
    programId: job.programId,
    status: job.status,
    lookbackDays: job.lookbackDays,
    lookbackStartDate: job.lookbackStartDate,
    pointsPerCurrencyUnit: Number(job.pointsPerCurrencyUnit),
    minOrderAmount: job.minOrderAmount ? Number(job.minOrderAmount) : null,
    totalShoppersCount: job.totalShoppersCount,
    totalOrdersCount: job.totalOrdersCount,
    totalProjectedPoints: job.totalProjectedPoints,
    processedAccountsCount: job.processedAccountsCount,
    totalCommittedPoints: job.totalCommittedPoints,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

/**
 * Scans historical paid and partially refunded orders and publishes one
 * immutable valuation snapshot per order without modifying ledger balances.
 */
export async function generateBackfillPreview(
  jobId: string,
): Promise<BackfillJobSummary> {
  const job = await prisma.weleticLoyaltyBackfillJob.findUnique({
    where: { id: jobId },
    include: {
      program: {
        include: {
          earningRules: { where: { isActive: true, deletedAt: null } },
        },
      },
    },
  });

  if (!job) {
    throw new Error(`Backfill job ${jobId} not found.`);
  }
  const policyRevisionId = readBackfillPolicyRevisionId(job.metadata);
  if (!policyRevisionId) {
    throw new Error(
      `BACKFILL_POLICY_REVISION_REQUIRED: backfill job ${jobId} has no immutable earn-policy revision and must be recreated.`,
    );
  }
  const expectedInstallationGeneration = readBackfillInstallationGeneration(
    job.metadata,
  );
  if (expectedInstallationGeneration === undefined) {
    throw new Error(
      `Backfill job ${jobId} predates installation-generation fencing and must be recreated.`,
    );
  }

  if (
    job.status !== WeleticLoyaltyBackfillJobStatus.pending &&
    job.status !== WeleticLoyaltyBackfillJobStatus.preview_ready
  ) {
    throw new Error(
      `Cannot generate preview for backfill job in status '${job.status}'.`,
    );
  }

  await withActiveStoreLoyaltyMutation({
    storeId: job.storeId,
    action: "loyalty_backfill_preview_claim",
    expectedInstallationGeneration,
    operation: async (tx) => {
      const existingCredits =
        await tx.weleticLoyaltyBackfillOrderCredit.findMany({
          where: { jobId },
          select: { snapshotId: true },
        });
      const retainedSnapshotIds = existingCredits.map(
        ({ snapshotId }) => snapshotId,
      );
      await Promise.all([
        tx.weleticLoyaltyBackfillPreviewItem.deleteMany({ where: { jobId } }),
        tx.weleticLoyaltyBackfillOrderSnapshot.deleteMany({
          where: {
            jobId,
            ...(retainedSnapshotIds.length > 0
              ? { id: { notIn: retainedSnapshotIds } }
              : {}),
          },
        }),
      ]);
      return tx.weleticLoyaltyBackfillJob.update({
        where: { id: jobId },
        data: { status: WeleticLoyaltyBackfillJobStatus.calculating },
      });
    },
  });

  try {
    // Build order filter criteria
    const orderWhere: Prisma.WeleticCommerceOrderWhereInput = {
      storeId: job.storeId,
      status: { in: ["paid", "partially_refunded"] },
      shopperId: { not: null },
    };

    if (job.lookbackStartDate) {
      orderWhere.occurredAt = { gte: job.lookbackStartDate };
    }

    // Fetch qualifying historical orders
    const historicalOrders = await prisma.weleticCommerceOrder.findMany({
      where: orderWhere,
      orderBy: { occurredAt: "asc" },
      select: {
        id: true,
        status: true,
        shopperId: true,
        shopCurrency: true,
        shopNet: true,
        shopSubtotal: true,
        shopTotal: true,
        presentmentCurrency: true,
        presentmentNet: true,
        presentmentTotal: true,
        occurredAt: true,
        updatedAt: true,
        refunds: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            shopAmount: true,
            presentmentAmount: true,
            updatedAt: true,
            lines: {
              orderBy: { id: "asc" },
              select: {
                id: true,
                orderLineId: true,
                shopAmount: true,
                quantity: true,
              },
            },
          },
        },
        lines: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            externalId: true,
            productId: true,
            variantId: true,
            title: true,
            shopNet: true,
            shopGross: true,
            quantity: true,
            updatedAt: true,
          },
        },
      },
    });

    const orderIds = historicalOrders.map((o) => o.id);

    // Compound Idempotency: Check if orders already granted or backfilled
    const existingGrants = await prisma.weleticLoyaltyEarnGrant.findMany({
      where: {
        storeId: job.storeId,
        orderId: { in: orderIds },
      },
      select: { orderId: true, metadata: true },
    });
    const repairSourceJobId = readBackfillRepairSourceJobId(job.metadata);
    const grantedOrderIds = new Set(
      existingGrants
        .filter((grant) => {
          if (!repairSourceJobId) return true;
          const metadata = grant.metadata;
          return !(
            metadata &&
            typeof metadata === "object" &&
            !Array.isArray(metadata) &&
            (metadata as Record<string, unknown>).jobId === repairSourceJobId
          );
        })
        .map((grant) => grant.orderId),
    );

    const compoundKeys = orderIds.flatMap((id) => [
      `backfill:order:${id}`,
      `earn_order:${id}`,
    ]);
    const existingEntries = await prisma.weleticPointsLedgerEntry.findMany({
      where: {
        storeId: job.storeId,
        idempotencyKey: { in: compoundKeys },
      },
      select: { idempotencyKey: true },
    });
    const creditedOrderKeys = new Set(
      existingEntries.map((entry) => entry.idempotencyKey),
    );

    const existingOrderCredits =
      await prisma.weleticLoyaltyBackfillOrderCredit.findMany({
        where: { storeId: job.storeId, orderId: { in: orderIds } },
        select: { orderId: true },
      });
    const creditedOrderIds = new Set(
      existingOrderCredits.map(({ orderId }) => orderId),
    );

    const pointsRate = Number(job.pointsPerCurrencyUnit);
    const minOrderThreshold = job.minOrderAmount ?? undefined;

    // Group eligible orders by shopperId with compensatory reconciliation
    const shopperOrdersMap = new Map<
      string,
      Array<{
        order: (typeof historicalOrders)[0];
        reconciliation: CompensatoryOrderReconciliation;
      }>
    >();

    for (const order of historicalOrders) {
      if (!order.shopperId) continue;

      // Skip already granted or backfilled orders (deterministic compound idempotency)
      if (
        grantedOrderIds.has(order.id) ||
        creditedOrderIds.has(order.id) ||
        creditedOrderKeys.has(`backfill:order:${order.id}`) ||
        creditedOrderKeys.has(`earn_order:${order.id}`)
      ) {
        continue;
      }

      // Compensatory anomaly reconciliation (cancelled, refunded, partial refund, missing lines)
      const reconciliation = reconcileCompensatoryHistoricalOrder({
        order,
        pointsPerCurrencyUnit: pointsRate,
        multiplier: 1.0,
        minOrderAmount: minOrderThreshold,
      });

      if (
        reconciliation.isCancelled ||
        reconciliation.isFullyRefunded ||
        reconciliation.projectedPoints <= BigInt(0)
      ) {
        continue;
      }
      if (reconciliation.missingLinesFallback) {
        throw new Error(
          `BACKFILL_ORDER_LINES_REQUIRED: historical order ${order.id} has no immutable line snapshot; resync the order before regenerating the preview.`,
        );
      }

      const list = shopperOrdersMap.get(order.shopperId) || [];
      list.push({ order, reconciliation });
      shopperOrdersMap.set(order.shopperId, list);
    }

    // Lookup or ensure loyalty accounts for shoppers
    const shopperIds = Array.from(shopperOrdersMap.keys());
    const repairAccountIds = readBackfillRepairAccountIds(job.metadata);
    const accounts = await prisma.weleticLoyaltyAccount.findMany({
      where: {
        storeId: job.storeId,
        ...(repairAccountIds.length > 0
          ? { id: { in: repairAccountIds } }
          : { shopperId: { in: shopperIds } }),
        status: "active",
      },
    });

    const shopperAccountMap = new Map<string, string>();
    for (const acc of accounts) {
      shopperAccountMap.set(acc.shopperId, acc.id);
    }

    // For any shopper with orders but no loyalty account yet, auto-create loyalty account
    for (const shopperId of repairAccountIds.length > 0 ? [] : shopperIds) {
      if (!shopperAccountMap.has(shopperId)) {
        const newAccount = await ensureBackfillPreviewAccount({
          storeId: job.storeId,
          programId: job.programId,
          shopperId,
          expectedInstallationGeneration,
        });
        if (newAccount) shopperAccountMap.set(shopperId, newAccount.id);
      }
    }

    const orderSnapshotsToCreate: BackfillOrderSnapshotToPublish[] = [];

    for (const [shopperId, orderEntries] of shopperOrdersMap.entries()) {
      const accountId = shopperAccountMap.get(shopperId);
      if (!accountId) continue;

      for (const { order, reconciliation } of orderEntries) {
        const currency = normalizeCurrency(
          order.shopCurrency || order.presentmentCurrency || "USD",
        );
        orderSnapshotsToCreate.push({
          id: createWeleticId("wbfsnap_"),
          jobId,
          storeId: job.storeId,
          programId: job.programId,
          shopperId,
          accountId,
          orderId: order.id,
          orderVersion: order.updatedAt,
          orderStatus: order.status,
          orderHash: buildHistoricalOrderSnapshotHash(order),
          policyRevisionId,
          currency,
          eligibleSpend: reconciliation.eligibleNetSpend,
          refundedSpend: reconciliation.refundedSpend,
          orderTotalAmount: order.shopTotal,
          projectedPoints: reconciliation.projectedPoints,
          pointsPerCurrencyUnit: job.pointsPerCurrencyUnit,
          effectiveMultiplier: new Prisma.Decimal(1),
          lineAllocations: reconciliation.lineAllocations.map((line) => ({
            ...line,
            lineNetAmount: line.lineNetAmount.toString(),
            awardedPoints: line.awardedPoints.toString(),
          })) as Prisma.InputJsonValue,
        });
      }
    }

    const updatedJob = await withActiveStoreLoyaltyMutation({
      storeId: job.storeId,
      action: "loyalty_backfill_preview_publish",
      expectedInstallationGeneration,
      operation: async (tx) => {
        // Customer redaction closes this same account row before purging its
        // preview rows. Locking and revalidating immediately before publish
        // makes the race deterministic: a publisher that wins is swept by the
        // later purge; a redaction that wins makes the account unpublishable.
        const publishableOrderSnapshots =
          await lockAndFilterPublishableBackfillOrderSnapshots({
            tx,
            storeId: job.storeId,
            items: orderSnapshotsToCreate,
          });
        const committedCredits =
          await tx.weleticLoyaltyBackfillOrderCredit.findMany({
            where: {
              jobId,
              status: WeleticLoyaltyBackfillCreditStatus.credited,
            },
            select: { accountId: true, points: true },
          });
        const totalShoppersCount = new Set([
          ...committedCredits.map(({ accountId }) => accountId),
          ...publishableOrderSnapshots.map(({ accountId }) => accountId),
        ]).size;
        const totalOrdersCount =
          committedCredits.length + publishableOrderSnapshots.length;
        const totalProjectedPoints = [
          ...committedCredits.map(({ points }) => points),
          ...publishableOrderSnapshots.map(
            ({ projectedPoints }) => projectedPoints,
          ),
        ].reduce((total, points) => total + points, BigInt(0));

        if (publishableOrderSnapshots.length > 0) {
          await tx.weleticLoyaltyBackfillOrderSnapshot.createMany({
            data: publishableOrderSnapshots,
          });
        }
        return tx.weleticLoyaltyBackfillJob.update({
          where: { id: jobId },
          data: {
            status: WeleticLoyaltyBackfillJobStatus.preview_ready,
            totalShoppersCount,
            totalOrdersCount,
            totalProjectedPoints,
          },
        });
      },
    });

    return {
      id: updatedJob.id,
      storeId: updatedJob.storeId,
      programId: updatedJob.programId,
      status: updatedJob.status,
      lookbackDays: updatedJob.lookbackDays,
      lookbackStartDate: updatedJob.lookbackStartDate,
      pointsPerCurrencyUnit: Number(updatedJob.pointsPerCurrencyUnit),
      minOrderAmount: updatedJob.minOrderAmount
        ? Number(updatedJob.minOrderAmount)
        : null,
      totalShoppersCount: updatedJob.totalShoppersCount,
      totalOrdersCount: updatedJob.totalOrdersCount,
      totalProjectedPoints: updatedJob.totalProjectedPoints,
      processedAccountsCount: updatedJob.processedAccountsCount,
      totalCommittedPoints: updatedJob.totalCommittedPoints,
      createdAt: updatedJob.createdAt,
      updatedAt: updatedJob.updatedAt,
      completedAt: updatedJob.completedAt,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await withActiveStoreLoyaltyMutation({
      storeId: job.storeId,
      action: "loyalty_backfill_preview_failure",
      expectedInstallationGeneration,
      operation: (tx) =>
        tx.weleticLoyaltyBackfillJob.update({
          where: { id: jobId },
          data: {
            status: WeleticLoyaltyBackfillJobStatus.failed,
            errorLog: errorMsg,
          },
        }),
    }).catch(() => undefined);
    throw error;
  }
}

export class BackfillPreviewStaleError extends Error {
  constructor(orderId: string) {
    super(
      `BACKFILL_PREVIEW_STALE: historical order ${orderId} changed after preview; regenerate the preview before committing.`,
    );
    this.name = "BackfillPreviewStaleError";
  }
}

function parseBackfillLineAllocations({
  value,
  eligibleSpend,
  projectedPoints,
}: {
  value: Prisma.JsonValue;
  eligibleSpend: bigint;
  projectedPoints: bigint;
}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Backfill snapshot has no line allocations.");
  }

  const allocations = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Backfill line allocation ${index} is malformed.`);
    }
    const allocation = entry as Record<string, Prisma.JsonValue>;
    const orderLineId = allocation.orderLineId;
    const quantity = allocation.quantity;
    const lineNetAmount = allocation.lineNetAmount;
    const awardedPoints = allocation.awardedPoints;
    if (
      typeof orderLineId !== "string" ||
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      typeof lineNetAmount !== "string" ||
      !/^\d+$/.test(lineNetAmount) ||
      typeof awardedPoints !== "string" ||
      !/^\d+$/.test(awardedPoints)
    ) {
      throw new Error(`Backfill line allocation ${index} is malformed.`);
    }
    const nullableString = (field: string) => {
      const fieldValue = allocation[field];
      if (fieldValue === null || fieldValue === undefined) return null;
      if (typeof fieldValue !== "string") {
        throw new Error(
          `Backfill line allocation ${index}.${field} is malformed.`,
        );
      }
      return fieldValue;
    };
    return {
      orderLineId,
      productId: nullableString("productId"),
      variantId: nullableString("variantId"),
      lineExternalId: nullableString("lineExternalId"),
      title: nullableString("title"),
      quantity,
      lineNetAmount: BigInt(lineNetAmount),
      awardedPoints: BigInt(awardedPoints),
    };
  });
  const orderLineIds = new Set(
    allocations.map(({ orderLineId }) => orderLineId),
  );
  const allocatedSpend = allocations.reduce(
    (total, line) => total + line.lineNetAmount,
    BigInt(0),
  );
  const allocatedPoints = allocations.reduce(
    (total, line) => total + line.awardedPoints,
    BigInt(0),
  );
  if (
    orderLineIds.size !== allocations.length ||
    allocatedSpend !== eligibleSpend ||
    allocatedPoints !== projectedPoints
  ) {
    throw new Error(
      "Backfill line allocations do not conserve the immutable order snapshot.",
    );
  }
  return allocations;
}

async function readHistoricalOrderForCommit(
  tx: Prisma.TransactionClient,
  orderId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM WeleticCommerceOrder
    WHERE id = ${orderId}
    FOR UPDATE
  `);
  return tx.weleticCommerceOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      storeId: true,
      status: true,
      shopperId: true,
      shopCurrency: true,
      shopNet: true,
      shopSubtotal: true,
      shopTotal: true,
      presentmentCurrency: true,
      presentmentNet: true,
      presentmentTotal: true,
      occurredAt: true,
      updatedAt: true,
      refunds: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          shopAmount: true,
          presentmentAmount: true,
          updatedAt: true,
          lines: {
            orderBy: { id: "asc" },
            select: {
              id: true,
              orderLineId: true,
              shopAmount: true,
              quantity: true,
            },
          },
        },
      },
      lines: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          externalId: true,
          productId: true,
          variantId: true,
          title: true,
          shopNet: true,
          shopGross: true,
          quantity: true,
          updatedAt: true,
        },
      },
    },
  });
}

async function restoreBackfillPreviewAfterMutation({
  jobId,
  storeId,
  commitLeaseId,
  error,
}: {
  jobId: string;
  storeId: string;
  commitLeaseId: string | null;
  error: BackfillPreviewStaleError;
}) {
  await prisma.weleticLoyaltyBackfillJob.updateMany({
    where: {
      id: jobId,
      storeId,
      status: WeleticLoyaltyBackfillJobStatus.committing,
      commitLeaseId,
    },
    data: {
      status: WeleticLoyaltyBackfillJobStatus.preview_ready,
      commitLeaseId: null,
      errorLog: error.message,
      completedAt: null,
    },
  });
}

/**
 * Commits a previewed backfill job, writing immutable BACKFILL ledger entries
 * and updating loyalty account balances atomically with idempotency protection.
 */
export async function commitBackfillJob(
  jobId: string,
): Promise<BackfillJobSummary> {
  return withBackfillJobLock({
    jobId,
    operation: async () => {
      const job = await prisma.weleticLoyaltyBackfillJob.findUnique({
        where: { id: jobId },
      });
      if (!job) {
        throw new Error(`Backfill job ${jobId} not found.`);
      }
      if (job.status === WeleticLoyaltyBackfillJobStatus.completed) {
        return summarizeBackfillJob(job);
      }
      if (
        job.status !== WeleticLoyaltyBackfillJobStatus.preview_ready &&
        job.status !== WeleticLoyaltyBackfillJobStatus.committing &&
        !(
          job.status === WeleticLoyaltyBackfillJobStatus.failed &&
          readBackfillRepairSourceJobId(job.metadata)
        )
      ) {
        throw new Error(
          `Cannot commit backfill job in terminal status '${job.status}'.`,
        );
      }

      const expectedInstallationGeneration = readBackfillInstallationGeneration(
        job.metadata,
      );
      if (expectedInstallationGeneration === undefined) {
        throw new Error(
          `Backfill job ${jobId} predates installation-generation fencing and must be recreated.`,
        );
      }

      const resuming =
        job.status === WeleticLoyaltyBackfillJobStatus.committing;
      if (
        resuming &&
        job.updatedAt.getTime() > Date.now() - BACKFILL_COMMIT_STALE_AFTER_MS
      ) {
        throw new Error(
          `Backfill job ${jobId} is still within its active commit lease.`,
        );
      }

      const commitLeaseId = createWeleticId("wlease_");
      let claimedCommitLease = false;
      try {
        await withActiveStoreLoyaltyMutation({
          storeId: job.storeId,
          action: resuming
            ? "loyalty_backfill_commit_resume"
            : "loyalty_backfill_commit_claim",
          expectedInstallationGeneration,
          operation: async (tx) => {
            const claim = await tx.weleticLoyaltyBackfillJob.updateMany({
              where: {
                id: jobId,
                storeId: job.storeId,
                status: job.status,
                updatedAt: job.updatedAt,
                commitLeaseId: job.commitLeaseId ?? null,
              },
              data: {
                status: WeleticLoyaltyBackfillJobStatus.committing,
                commitLeaseId,
                errorLog: null,
                completedAt: null,
              },
            });
            if (claim.count !== 1) {
              throw new Error(
                `Backfill job ${jobId} changed while its commit lease was being claimed.`,
              );
            }
          },
        });
        claimedCommitLease = true;

        const snapshots =
          await prisma.weleticLoyaltyBackfillOrderSnapshot.findMany({
            where: { jobId },
            orderBy: { id: "asc" },
          });

        for (const snapshot of snapshots) {
          await withActiveStoreLoyaltyMutation({
            storeId: job.storeId,
            action: "loyalty_backfill_commit_order",
            expectedInstallationGeneration,
            operation: async (tx) => {
              const durableLease =
                await tx.weleticLoyaltyBackfillJob.updateMany({
                  where: {
                    id: jobId,
                    storeId: job.storeId,
                    status: WeleticLoyaltyBackfillJobStatus.committing,
                    commitLeaseId,
                  },
                  data: { commitLeaseId },
                });
              if (durableLease.count !== 1) {
                throw new Error(
                  `Backfill job ${jobId} lost its durable commit lease before recording ${snapshot.id}.`,
                );
              }
              await assertActiveLoyaltyAccountForMutation({
                tx,
                storeId: job.storeId,
                accountId: snapshot.accountId,
              });

              const order = await readHistoricalOrderForCommit(
                tx,
                snapshot.orderId,
              );
              if (
                !order ||
                order.storeId !== job.storeId ||
                order.shopperId !== snapshot.shopperId ||
                order.status !== snapshot.orderStatus ||
                order.updatedAt.getTime() !== snapshot.orderVersion.getTime() ||
                buildHistoricalOrderSnapshotHash(order) !== snapshot.orderHash
              ) {
                throw new BackfillPreviewStaleError(snapshot.orderId);
              }

              const existingCredit =
                await tx.weleticLoyaltyBackfillOrderCredit.findUnique({
                  where: {
                    storeId_orderId: {
                      storeId: job.storeId,
                      orderId: snapshot.orderId,
                    },
                  },
                });
              if (existingCredit) return;

              const existingGrant = await tx.weleticLoyaltyEarnGrant.findUnique(
                {
                  where: {
                    storeId_orderId: {
                      storeId: job.storeId,
                      orderId: snapshot.orderId,
                    },
                  },
                  select: { id: true, status: true, metadata: true },
                },
              );
              const repairSourceJobId = readBackfillRepairSourceJobId(
                job.metadata,
              );
              const existingGrantJobId =
                existingGrant?.metadata &&
                typeof existingGrant.metadata === "object" &&
                !Array.isArray(existingGrant.metadata)
                  ? (existingGrant.metadata as Record<string, unknown>).jobId
                  : null;
              const replaysMalformedLegacyGrant = Boolean(
                existingGrant &&
                  repairSourceJobId &&
                  existingGrantJobId === repairSourceJobId,
              );
              if (existingGrant && !replaysMalformedLegacyGrant) {
                throw new BackfillPreviewStaleError(snapshot.orderId);
              }
              if (existingGrant && existingGrant.status !== "voided") {
                throw new Error(
                  `Legacy backfill grant ${existingGrant.id} must be voided before repair replay.`,
                );
              }
              const lineAllocations = parseBackfillLineAllocations({
                value: snapshot.lineAllocations,
                eligibleSpend: snapshot.eligibleSpend,
                projectedPoints: snapshot.projectedPoints,
              });

              const creditId = createWeleticId("wbfcredit_");
              const claimed =
                await tx.weleticLoyaltyBackfillOrderCredit.createMany({
                  data: [
                    {
                      id: creditId,
                      storeId: job.storeId,
                      programId: job.programId,
                      jobId,
                      snapshotId: snapshot.id,
                      orderId: snapshot.orderId,
                      accountId: snapshot.accountId,
                      status: WeleticLoyaltyBackfillCreditStatus.claimed,
                      points: snapshot.projectedPoints,
                    },
                  ],
                  skipDuplicates: true,
                });
              if (claimed.count !== 1) return;

              const grantId = existingGrant?.id ?? createWeleticId("wgrant_");
              const lineEarnCreates = lineAllocations.map((line) => ({
                id: createWeleticId("wlineearn_"),
                storeId: job.storeId,
                orderLineId: line.orderLineId,
                productId: line.productId,
                variantId: line.variantId,
                lineExternalId: line.lineExternalId,
                title: line.title,
                quantity: line.quantity,
                lineNetAmount: line.lineNetAmount,
                awardedPoints: line.awardedPoints,
              }));
              const grantSnapshot = {
                status: "settled" as const,
                currency: snapshot.currency,
                eligibleSubtotalAmount: snapshot.eligibleSpend,
                orderTotalAmount: snapshot.orderTotalAmount,
                grossPoints: snapshot.projectedPoints,
                pendingPoints: BigInt(0),
                settledPoints: snapshot.projectedPoints,
                reversedPoints: BigInt(0),
                availableAt: order.occurredAt,
                settledAt: new Date(),
                voidedAt: null,
                selectedRuleId: null,
                selectedCampaignId: null,
                tierId: null,
                pointsPerCurrencyUnit: snapshot.pointsPerCurrencyUnit,
                ruleMultiplier: new Prisma.Decimal(1),
                campaignMultiplier: new Prisma.Decimal(1),
                tierMultiplier: new Prisma.Decimal(1),
                effectiveMultiplier: snapshot.effectiveMultiplier,
                policyRevisionId: snapshot.policyRevisionId,
                calculationSnapshot: {
                  source: "historical_backfill",
                  backfillJobId: jobId,
                  backfillSnapshotId: snapshot.id,
                  orderVersion: snapshot.orderVersion.toISOString(),
                  orderHash: snapshot.orderHash,
                  refundedSpend: snapshot.refundedSpend.toString(),
                  repairedFromLegacyBackfillJobId: repairSourceJobId,
                },
                metadata: {
                  ...(existingGrant?.metadata &&
                  typeof existingGrant.metadata === "object" &&
                  !Array.isArray(existingGrant.metadata)
                    ? (existingGrant.metadata as Record<string, unknown>)
                    : {}),
                  idempotencyKey: buildBackfillOrderCompoundKey(
                    snapshot.orderId,
                  ),
                  jobId,
                  repairedFromLegacyBackfillJobId: repairSourceJobId,
                },
              };
              const grant = existingGrant
                ? await (async () => {
                    await tx.weleticLoyaltyOrderLineEarn.deleteMany({
                      where: { grantId: existingGrant.id },
                    });
                    return tx.weleticLoyaltyEarnGrant.update({
                      where: { id: existingGrant.id },
                      data: {
                        storeId: job.storeId,
                        programId: job.programId,
                        accountId: snapshot.accountId,
                        shopperId: snapshot.shopperId,
                        orderId: snapshot.orderId,
                        ...grantSnapshot,
                        lineEarns: { create: lineEarnCreates },
                      },
                    });
                  })()
                : await tx.weleticLoyaltyEarnGrant.create({
                    data: {
                      id: grantId,
                      storeId: job.storeId,
                      programId: job.programId,
                      accountId: snapshot.accountId,
                      shopperId: snapshot.shopperId,
                      orderId: snapshot.orderId,
                      ...grantSnapshot,
                      lineEarns: { create: lineEarnCreates },
                    },
                  });

              const committedEntry = await appendPointsLedgerEntry({
                storeId: job.storeId,
                accountId: snapshot.accountId,
                entryType: WeleticPointsLedgerEntryType.BACKFILL,
                pointsDelta: snapshot.projectedPoints,
                grantId: grant.id,
                referenceType: "historical_order",
                referenceId: snapshot.orderId,
                idempotencyKey: buildBackfillOrderCompoundKey(snapshot.orderId),
                reason: `Historical order backfill (${snapshot.orderId})`,
                metadata: {
                  jobId,
                  snapshotId: snapshot.id,
                  shopperId: snapshot.shopperId,
                  orderId: snapshot.orderId,
                  orderVersion: snapshot.orderVersion.toISOString(),
                  orderHash: snapshot.orderHash,
                  eligibleSpend: snapshot.eligibleSpend.toString(),
                  currency: snapshot.currency,
                },
                tx,
              });

              const marked =
                await tx.weleticLoyaltyBackfillOrderCredit.updateMany({
                  where: {
                    id: creditId,
                    storeId: job.storeId,
                    jobId,
                    snapshotId: snapshot.id,
                    status: WeleticLoyaltyBackfillCreditStatus.claimed,
                  },
                  data: {
                    status: WeleticLoyaltyBackfillCreditStatus.credited,
                    ledgerEntryId: committedEntry.id,
                    earnGrantId: grant.id,
                    creditedAt: new Date(),
                  },
                });
              if (marked.count !== 1) {
                throw new Error(
                  `Backfill order claim ${creditId} changed before its ledger entry could be recorded.`,
                );
              }

              const progress = await readAuthoritativeBackfillCommitProgress({
                tx,
                storeId: job.storeId,
                jobId,
              });
              const heartbeat = await tx.weleticLoyaltyBackfillJob.updateMany({
                where: {
                  id: jobId,
                  storeId: job.storeId,
                  status: WeleticLoyaltyBackfillJobStatus.committing,
                  commitLeaseId,
                },
                data: progress,
              });
              if (heartbeat.count !== 1) {
                throw new Error(
                  `Backfill job ${jobId} lost its commit lease while recording ${snapshot.id}.`,
                );
              }
            },
          });
        }

        const updatedJob = await withActiveStoreLoyaltyMutation({
          storeId: job.storeId,
          action: "loyalty_backfill_commit_complete",
          expectedInstallationGeneration,
          operation: async (tx) => {
            const incompleteClaims =
              await tx.weleticLoyaltyBackfillOrderCredit.count({
                where: {
                  jobId,
                  status: WeleticLoyaltyBackfillCreditStatus.claimed,
                },
              });
            if (incompleteClaims !== 0) {
              throw new Error(
                `Backfill job ${jobId} still has ${incompleteClaims} incomplete order claim(s).`,
              );
            }
            const progress = await readAuthoritativeBackfillCommitProgress({
              tx,
              storeId: job.storeId,
              jobId,
            });
            const completed = await tx.weleticLoyaltyBackfillJob.updateMany({
              where: {
                id: jobId,
                storeId: job.storeId,
                status: WeleticLoyaltyBackfillJobStatus.committing,
                commitLeaseId,
              },
              data: {
                status: WeleticLoyaltyBackfillJobStatus.completed,
                commitLeaseId: null,
                ...progress,
                errorLog: null,
                completedAt: new Date(),
              },
            });
            if (completed.count !== 1) {
              throw new Error(
                `Backfill job ${jobId} lost its commit lease before completion.`,
              );
            }
            return tx.weleticLoyaltyBackfillJob.findUniqueOrThrow({
              where: { id: jobId },
            });
          },
        });
        return summarizeBackfillJob(updatedJob);
      } catch (error) {
        if (claimedCommitLease || resuming) {
          try {
            const activeLeaseId = claimedCommitLease
              ? commitLeaseId
              : job.commitLeaseId ?? null;
            if (error instanceof BackfillPreviewStaleError) {
              await restoreBackfillPreviewAfterMutation({
                jobId,
                storeId: job.storeId,
                commitLeaseId: activeLeaseId,
                error,
              });
            } else {
              await persistBackfillCommitFailure({
                jobId,
                storeId: job.storeId,
                commitLeaseId: activeLeaseId,
                expectedUpdatedAt: claimedCommitLease
                  ? undefined
                  : job.updatedAt,
                error,
              });
            }
          } catch (auditError) {
            throw new AggregateError(
              [error, auditError],
              `Backfill job ${jobId} failed and its failure audit could not be persisted.`,
            );
          }
        }
        throw error;
      }
    },
  });
}

/**
 * Cancels a pending or preview-ready backfill job.
 */
export async function cancelBackfillJob(
  jobId: string,
): Promise<BackfillJobSummary> {
  return withBackfillJobLock({
    jobId,
    operation: async () => {
      const job = await prisma.weleticLoyaltyBackfillJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new Error(`Backfill job ${jobId} not found.`);
      }
      const expectedInstallationGeneration = readBackfillInstallationGeneration(
        job.metadata,
      );
      if (expectedInstallationGeneration === undefined) {
        throw new Error(
          `Backfill job ${jobId} predates installation-generation fencing and must be recreated.`,
        );
      }

      if (
        job.status !== WeleticLoyaltyBackfillJobStatus.pending &&
        job.status !== WeleticLoyaltyBackfillJobStatus.preview_ready
      ) {
        throw new Error(
          `Cannot cancel backfill job in status '${job.status}'.`,
        );
      }

      const updatedJob = await withActiveStoreLoyaltyMutation({
        storeId: job.storeId,
        action: "loyalty_backfill_cancel_claim",
        expectedInstallationGeneration,
        operation: async (tx) => {
          const committedOrderCredits =
            await tx.weleticLoyaltyBackfillOrderCredit.count({
              where: {
                jobId,
                storeId: job.storeId,
                status: WeleticLoyaltyBackfillCreditStatus.credited,
              },
            });
          if (committedOrderCredits !== 0) {
            throw new Error(
              `Backfill job ${jobId} has committed liability and cannot be cancelled.`,
            );
          }
          const claim = await tx.weleticLoyaltyBackfillJob.updateMany({
            where: {
              id: jobId,
              storeId: job.storeId,
              status: job.status,
              processedAccountsCount: 0,
              totalCommittedPoints: BigInt(0),
              previewItems: {
                none: { committedLedgerEntryId: { not: null } },
              },
            },
            data: { status: WeleticLoyaltyBackfillJobStatus.cancelled },
          });
          if (claim.count !== 1) {
            throw new Error(
              `Backfill job ${jobId} was already claimed or has committed liability and cannot be cancelled.`,
            );
          }
          return tx.weleticLoyaltyBackfillJob.findUniqueOrThrow({
            where: { id: jobId },
          });
        },
      });

      return summarizeBackfillJob(updatedJob);
    },
  });
}

/**
 * Gets backfill job details with preview items.
 */
export async function getBackfillJob(jobId: string) {
  const [job, orderSnapshots] = await Promise.all([
    prisma.weleticLoyaltyBackfillJob.findUnique({
      where: { id: jobId },
      include: {
        previewItems: {
          include: {
            account: {
              include: {
                shopper: true,
              },
            },
          },
        },
      },
    }),
    prisma.weleticLoyaltyBackfillOrderSnapshot.findMany({
      where: { jobId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return job ? { ...job, orderSnapshots } : null;
}
