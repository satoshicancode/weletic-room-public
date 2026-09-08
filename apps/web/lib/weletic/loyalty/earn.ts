import { prisma } from "@/lib/prisma";
import {
  doesOrderLineMatchBonusCampaign,
  normalizeBonusCampaignTargets,
  resolveActiveBonusCampaign,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import {
  LoyaltyEarnPolicyRevisionError,
  resolveLoyaltyEarnPolicyRevisionAt,
  type ParsedLoyaltyEarnPolicy,
} from "@/lib/weletic/loyalty/earn-policy-revision";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import {
  appendPointsLedgerEntry,
  OptimisticConcurrencyError,
} from "@/lib/weletic/loyalty/ledger";
import { allocateReversalAcrossRemainingLines } from "@/lib/weletic/loyalty/line-reversal-allocation";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { calculateNextPointsExpiryDate } from "@/lib/weletic/loyalty/points-expiry-policy";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import {
  currencyMinorUnits,
  decimalToMinorUnits,
  normalizeCurrency,
} from "@/lib/weletic/money";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
} from "@/lib/weletic/shopify/store-compliance-state";
import { nanoid } from "@dub/utils";
import {
  Prisma,
  WeleticLoyaltyEarnGrantStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { createHash } from "node:crypto";
import {
  classifyLoyaltyPurchaseLine,
  DEFAULT_EARNING_PURCHASE_POLICY,
  isLoyaltyPurchaseLineEligible,
  readLoyaltyPurchasePolicy,
  type LoyaltyPurchasePolicy,
} from "./purchase-policy";

const FINANCIAL_TRANSACTION_RETRIES = 5;

function fingerprintLegacyLedgerAdoption(
  entries: Array<{
    id: string;
    pointsDelta: bigint | number;
    pendingDelta: bigint | number;
  }>,
): string {
  const canonicalPayload = entries
    .map((entry) => ({
      id: entry.id,
      pointsDelta: BigInt(entry.pointsDelta).toString(),
      pendingDelta: BigInt(entry.pendingDelta).toString(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (entry) =>
        `${entry.id.length}:${entry.id}:${entry.pointsDelta}:${entry.pendingDelta}`,
    )
    .join("|");

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

function isRetryableFinancialTransactionError(error: unknown): boolean {
  return (
    error instanceof OptimisticConcurrencyError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code))
  );
}

async function runFinancialTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= FINANCIAL_TRANSACTION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        attempt === FINANCIAL_TRANSACTION_RETRIES ||
        !isRetryableFinancialTransactionError(error)
      ) {
        throw error;
      }
    }
  }

  throw new Error("Financial transaction retry budget exhausted");
}

// ============================================================================
// 1. Pure Rational Fraction Types and Helpers
// ============================================================================

export interface RationalFraction {
  num: bigint;
  den: bigint;
}

export function powerOfTenBigInt(exponent: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < exponent; i++) {
    result *= BigInt(10);
  }
  return result;
}

/**
 * Parses any decimal representation (Prisma.Decimal, string, number, bigint)
 * into an exact BigInt rational fraction { num, den } with zero floating point drift.
 */
export function parseDecimalToFraction(
  value: string | number | bigint | Prisma.Decimal | null | undefined,
): RationalFraction {
  if (value == null) {
    return { num: BigInt(1), den: BigInt(1) };
  }
  if (typeof value === "bigint") {
    return { num: value, den: BigInt(1) };
  }
  const str =
    typeof value === "object" && "toFixed" in value
      ? (value as Prisma.Decimal).toFixed()
      : String(value).trim();

  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    return { num: BigInt(1), den: BigInt(1) };
  }

  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [whole, fraction = ""] = unsigned.split(".");
  const den = powerOfTenBigInt(fraction.length);
  const num = BigInt(`${whole}${fraction}`);

  return {
    num: negative ? -num : num,
    den,
  };
}

/**
 * Multiplies an array of rational fractions into a single combined rational fraction.
 */
export function multiplyFractions(
  fractions: RationalFraction[],
): RationalFraction {
  let num = BigInt(1);
  let den = BigInt(1);
  for (const f of fractions) {
    num *= f.num;
    den *= f.den;
  }
  return { num, den };
}

function reduceFraction({ num, den }: RationalFraction): RationalFraction {
  if (num === BigInt(0)) return { num: BigInt(0), den: BigInt(1) };
  let left = num < BigInt(0) ? -num : num;
  let right = den < BigInt(0) ? -den : den;
  while (right !== BigInt(0)) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  const divisor = left;
  const sign = den < BigInt(0) ? -BigInt(1) : BigInt(1);
  return { num: (num / divisor) * sign, den: (den / divisor) * sign };
}

// ============================================================================
// 2. Pure BigInt Points Calculation Functions
// ============================================================================

export interface CalculateOrderPointsOptions {
  netAmountCents: bigint | number;
  currency: string;
  pointsPerCurrencyUnit?: Prisma.Decimal | number | string | null;
  multiplier?: Prisma.Decimal | number | string | null;
  minOrderSubtotalCents?: bigint | number | null;
}

/**
 * Pure BigInt rational points calculation function.
 * Eliminates all IEEE 754 floating-point operations.
 */
export function calculateEligibleOrderPoints({
  netAmountCents,
  currency,
  pointsPerCurrencyUnit = 1.0,
  multiplier = 1.0,
  minOrderSubtotalCents,
}: CalculateOrderPointsOptions): bigint {
  const netMinor = BigInt(netAmountCents);
  if (netMinor <= BigInt(0)) {
    return BigInt(0);
  }

  if (minOrderSubtotalCents && netMinor < BigInt(minOrderSubtotalCents)) {
    return BigInt(0);
  }

  const normalizedCurrency = normalizeCurrency(currency);
  const minorDigits = currencyMinorUnits(normalizedCurrency);
  const currencyScale = powerOfTenBigInt(minorDigits);

  const rateFraction = parseDecimalToFraction(pointsPerCurrencyUnit);
  const mulFraction = parseDecimalToFraction(multiplier);

  const totalNumerator = netMinor * rateFraction.num * mulFraction.num;
  const totalDenominator = currencyScale * rateFraction.den * mulFraction.den;

  if (totalDenominator <= BigInt(0) || totalNumerator <= BigInt(0)) {
    return BigInt(0);
  }

  return totalNumerator / totalDenominator;
}

/**
 * Calculates next expiration date based on qualifying activity and expiry duration in months.
 */
export function calculateNextExpiryDate(
  lastActivityAt: Date,
  expiryMonths: number,
): Date | null {
  if (expiryMonths <= 0) return null;
  const expiry = new Date(lastActivityAt.getTime());
  expiry.setUTCMonth(expiry.getUTCMonth() + expiryMonths);
  return expiry;
}

// ============================================================================
// 3. Penny-Conserving Largest Remainder Proportional Line Allocation
// ============================================================================

export interface LineAllocationInput {
  orderLineId: string;
  lineNetAmount: bigint;
  isExcluded?: boolean;
  productId?: string | null;
  variantId?: string | null;
  lineExternalId?: string | null;
  title?: string | null;
  quantity?: number;
  sku?: string | null;
  collectionExternalIds?: unknown;
  exclusionReason?: string | null;
}

export interface LineAllocationResult {
  orderLineId: string;
  lineNetAmount: bigint;
  awardedPoints: bigint;
  isExcluded: boolean;
  exclusionReason?: string | null;
  productId?: string | null;
  variantId?: string | null;
  lineExternalId?: string | null;
  title?: string | null;
  quantity?: number;
  sku?: string | null;
  collectionExternalIds?: string[];
  campaignMatched?: boolean;
  appliedCampaignMultiplier?: string;
}

/**
 * Allocates total gross points across eligible order lines using the
 * Hare-Niemeyer (Largest Remainder) integer allocation method.
 * Guarantees exact penny conservation: sum(awardedPoints) === grossPoints.
 */
export function allocatePointsAcrossOrderLines({
  grossPoints,
  lines,
}: {
  grossPoints: bigint;
  lines: LineAllocationInput[];
}): LineAllocationResult[] {
  if (lines.length === 0) return [];

  const eligibleLines = lines.filter(
    (l) => !l.isExcluded && l.lineNetAmount > BigInt(0),
  );

  if (eligibleLines.length === 0 || grossPoints <= BigInt(0)) {
    return lines.map((l) => ({
      orderLineId: l.orderLineId,
      lineNetAmount: l.lineNetAmount,
      awardedPoints: BigInt(0),
      isExcluded: Boolean(l.isExcluded),
      exclusionReason: l.exclusionReason ?? null,
      productId: l.productId ?? null,
      variantId: l.variantId ?? null,
      lineExternalId: l.lineExternalId ?? null,
      title: l.title ?? null,
      quantity: l.quantity ?? 1,
      sku: l.sku ?? null,
      collectionExternalIds: Array.isArray(l.collectionExternalIds)
        ? l.collectionExternalIds.filter(
            (identifier): identifier is string =>
              typeof identifier === "string",
          )
        : [],
    }));
  }

  const totalEligibleNet = eligibleLines.reduce(
    (sum, l) => sum + l.lineNetAmount,
    BigInt(0),
  );

  if (totalEligibleNet <= BigInt(0)) {
    return lines.map((l) => ({
      orderLineId: l.orderLineId,
      lineNetAmount: l.lineNetAmount,
      awardedPoints: BigInt(0),
      isExcluded: Boolean(l.isExcluded),
      exclusionReason: l.exclusionReason ?? null,
      productId: l.productId ?? null,
      variantId: l.variantId ?? null,
      lineExternalId: l.lineExternalId ?? null,
      title: l.title ?? null,
      quantity: l.quantity ?? 1,
      sku: l.sku ?? null,
      collectionExternalIds: Array.isArray(l.collectionExternalIds)
        ? l.collectionExternalIds.filter(
            (identifier): identifier is string =>
              typeof identifier === "string",
          )
        : [],
    }));
  }

  // Phase 1: Compute integer base points and remainder for each eligible line
  interface LineRemainderItem {
    line: LineAllocationInput;
    basePoints: bigint;
    remainder: bigint;
    allocated: bigint;
  }

  const remainderItems: LineRemainderItem[] = eligibleLines.map((line) => {
    const exactNumerator = grossPoints * line.lineNetAmount;
    const basePoints = exactNumerator / totalEligibleNet;
    const remainder = exactNumerator % totalEligibleNet;
    return {
      line,
      basePoints,
      remainder,
      allocated: basePoints,
    };
  });

  const sumBase = remainderItems.reduce(
    (sum, item) => sum + item.basePoints,
    BigInt(0),
  );
  let leftoverPoints = Number(grossPoints - sumBase);

  // Phase 2: Distribute leftover points to lines with largest remainders
  remainderItems.sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.line.orderLineId.localeCompare(b.line.orderLineId);
  });

  for (let i = 0; i < remainderItems.length && leftoverPoints > 0; i++) {
    remainderItems[i].allocated += BigInt(1);
    leftoverPoints--;
  }

  const allocatedMap = new Map<string, bigint>();
  for (const item of remainderItems) {
    allocatedMap.set(item.line.orderLineId, item.allocated);
  }

  return lines.map((l) => ({
    orderLineId: l.orderLineId,
    lineNetAmount: l.lineNetAmount,
    awardedPoints: allocatedMap.get(l.orderLineId) ?? BigInt(0),
    isExcluded: Boolean(l.isExcluded),
    exclusionReason: l.exclusionReason ?? null,
    productId: l.productId ?? null,
    variantId: l.variantId ?? null,
    lineExternalId: l.lineExternalId ?? null,
    title: l.title ?? null,
    quantity: l.quantity ?? 1,
    sku: l.sku ?? null,
    collectionExternalIds: Array.isArray(l.collectionExternalIds)
      ? l.collectionExternalIds.filter(
          (identifier): identifier is string => typeof identifier === "string",
        )
      : [],
  }));
}

type CampaignCalculationInput = {
  multiplier: Prisma.Decimal | number | string;
  eligibleSkus?: unknown;
  eligibleCollectionIds?: unknown;
};

function calculateTargetedMultiplierOrderPoints({
  lines,
  currency,
  pointsPerCurrencyUnit,
  ruleMultiplier,
  tierMultiplier,
  campaign,
  maxPointsPerEvent,
}: {
  lines: LineAllocationInput[];
  currency: string;
  pointsPerCurrencyUnit: Prisma.Decimal | number | string;
  ruleMultiplier: Prisma.Decimal | number | string;
  tierMultiplier: Prisma.Decimal | number | string;
  campaign: CampaignCalculationInput | null;
  maxPointsPerEvent?: bigint | null;
}): {
  grossPoints: bigint;
  effectiveMultiplier: number;
  combinedFraction: RationalFraction;
  lineAllocations: LineAllocationResult[];
} {
  const eligibleLines = lines.filter(
    (line) => !line.isExcluded && line.lineNetAmount > BigInt(0),
  );
  const eligibleSubtotal = eligibleLines.reduce(
    (sum, line) => sum + line.lineNetAmount,
    BigInt(0),
  );
  const campaignFraction = parseDecimalToFraction(
    campaign?.multiplier ?? BigInt(1),
  );
  const targets = campaign
    ? normalizeBonusCampaignTargets(campaign)
    : { eligibleSkus: [], eligibleCollectionIds: [] };
  const configuredCampaignMultiplier = campaign
    ? new Prisma.Decimal(campaign.multiplier).toString()
    : "1";

  const weightedLines = lines.map((line) => {
    const campaignMatched = Boolean(
      campaign && doesOrderLineMatchBonusCampaign({ targets, line }),
    );
    const allocationWeight =
      !line.isExcluded && line.lineNetAmount > BigInt(0)
        ? line.lineNetAmount *
          (campaignMatched ? campaignFraction.num : campaignFraction.den)
        : BigInt(0);
    return {
      line,
      allocationWeight,
      campaignMatched,
      appliedCampaignMultiplier: campaignMatched
        ? configuredCampaignMultiplier
        : "1",
    };
  });
  const weightedNetNumerator = weightedLines.reduce(
    (sum, item) => sum + item.allocationWeight,
    BigInt(0),
  );
  const rateAndBaseMultiplier = multiplyFractions([
    parseDecimalToFraction(pointsPerCurrencyUnit),
    parseDecimalToFraction(ruleMultiplier),
    parseDecimalToFraction(tierMultiplier),
  ]);
  const baseMultiplier = multiplyFractions([
    parseDecimalToFraction(ruleMultiplier),
    parseDecimalToFraction(tierMultiplier),
  ]);
  const currencyScale = powerOfTenBigInt(
    currencyMinorUnits(normalizeCurrency(currency)),
  );

  let grossPoints =
    eligibleSubtotal > BigInt(0)
      ? (weightedNetNumerator * rateAndBaseMultiplier.num) /
        (currencyScale * campaignFraction.den * rateAndBaseMultiplier.den)
      : BigInt(0);
  if (grossPoints < BigInt(0)) grossPoints = BigInt(0);
  if (maxPointsPerEvent !== null && maxPointsPerEvent !== undefined) {
    grossPoints =
      grossPoints > maxPointsPerEvent ? maxPointsPerEvent : grossPoints;
  }

  const combinedFraction = reduceFraction(
    eligibleSubtotal > BigInt(0)
      ? {
          num: rateAndBaseMultiplier.num * weightedNetNumerator,
          den:
            rateAndBaseMultiplier.den * campaignFraction.den * eligibleSubtotal,
        }
      : multiplyFractions([rateAndBaseMultiplier, campaignFraction]),
  );
  const effectiveMultiplier =
    eligibleSubtotal > BigInt(0)
      ? Number(baseMultiplier.num * weightedNetNumerator) /
        Number(baseMultiplier.den * campaignFraction.den * eligibleSubtotal)
      : Number(baseMultiplier.num * campaignFraction.num) /
        Number(baseMultiplier.den * campaignFraction.den);
  const uncappedBasePoints =
    eligibleSubtotal > BigInt(0)
      ? (eligibleSubtotal * rateAndBaseMultiplier.num) /
        (currencyScale * rateAndBaseMultiplier.den)
      : BigInt(0);
  const basePoints =
    uncappedBasePoints < grossPoints ? uncappedBasePoints : grossPoints;
  const bonusPoints = grossPoints - basePoints;
  const baseAllocations = allocatePointsAcrossOrderLines({
    grossPoints: basePoints,
    lines,
  });
  const baseByLine = new Map(
    baseAllocations.map((allocation) => [
      allocation.orderLineId,
      allocation.awardedPoints,
    ]),
  );
  const matchedLineIds = new Set(
    weightedLines
      .filter((item) => item.campaignMatched)
      .map((item) => item.line.orderLineId),
  );
  const bonusAllocations = allocatePointsAcrossOrderLines({
    grossPoints: bonusPoints,
    lines: lines.map((line) => ({
      ...line,
      isExcluded:
        Boolean(line.isExcluded) || !matchedLineIds.has(line.orderLineId),
    })),
  });
  const bonusByLine = new Map(
    bonusAllocations.map((allocation) => [
      allocation.orderLineId,
      allocation.awardedPoints,
    ]),
  );

  return {
    grossPoints,
    effectiveMultiplier,
    combinedFraction,
    lineAllocations: weightedLines.map(
      ({ line, campaignMatched, appliedCampaignMultiplier }) => ({
        orderLineId: line.orderLineId,
        lineNetAmount: line.lineNetAmount,
        awardedPoints:
          (baseByLine.get(line.orderLineId) ?? BigInt(0)) +
          (bonusByLine.get(line.orderLineId) ?? BigInt(0)),
        isExcluded: Boolean(line.isExcluded),
        exclusionReason: line.exclusionReason ?? null,
        productId: line.productId ?? null,
        variantId: line.variantId ?? null,
        lineExternalId: line.lineExternalId ?? null,
        title: line.title ?? null,
        quantity: line.quantity ?? 1,
        sku: line.sku ?? null,
        collectionExternalIds: Array.isArray(line.collectionExternalIds)
          ? line.collectionExternalIds.filter(
              (identifier): identifier is string =>
                typeof identifier === "string",
            )
          : [],
        campaignMatched,
        appliedCampaignMultiplier,
      }),
    ),
  };
}

/**
 * Calculates proportional integer allocation of total points across line amounts
 * without penny drift (array-based helper).
 */
export function allocatePointsProportionally({
  totalPoints,
  lineAmounts,
}: {
  totalPoints: bigint;
  lineAmounts: bigint[];
}): bigint[] {
  const lineInputs: LineAllocationInput[] = lineAmounts.map((amt, idx) => ({
    orderLineId: `line_${idx}`,
    lineNetAmount: amt,
  }));

  const results = allocatePointsAcrossOrderLines({
    grossPoints: totalPoints,
    lines: lineInputs,
  });

  return results.map((r) => r.awardedPoints);
}

// ============================================================================
// 4. Extended Allocation & Reversal Interfaces
// ============================================================================

export interface OrderLineAllocationSnapshot {
  orderLineId: string;
  productId: string | null;
  variantId: string | null;
  lineExternalId: string | null;
  title: string | null;
  quantity: number;
  sku?: string | null;
  collectionExternalIds?: string[];
  lineNetAmount: bigint;
  awardedPoints: bigint;
  isExcluded: boolean;
  exclusionReason?: string | null;
}

export interface CalculateOrderPointsAllocationParams {
  lines: Array<{
    id: string;
    externalId: string;
    productId?: string | null;
    variantId?: string | null;
    title?: string | null;
    quantity: number;
    sku?: string | null;
    collectionExternalIds?: unknown;
    shopNet: bigint;
    isExcluded?: boolean;
    exclusionReason?: string | null;
  }>;
  currency: string;
  pointsPerCurrencyUnit: number | Prisma.Decimal | string;
  ruleMultiplier?: number | Prisma.Decimal | string;
  campaignMultiplier?: number | Prisma.Decimal | string;
  tierMultiplier?: number | Prisma.Decimal | string;
  minOrderSubtotalCents?: bigint | null;
}

export function calculateOrderPointsAllocation(
  params: CalculateOrderPointsAllocationParams,
): {
  grossPoints: bigint;
  eligibleSubtotal: bigint;
  effectiveMultiplier: number;
  lineAllocations: OrderLineAllocationSnapshot[];
} {
  const {
    lines,
    currency,
    pointsPerCurrencyUnit,
    ruleMultiplier = 1.0,
    campaignMultiplier = 1.0,
    tierMultiplier = 1.0,
    minOrderSubtotalCents,
  } = params;

  const combinedFraction = multiplyFractions([
    parseDecimalToFraction(ruleMultiplier),
    parseDecimalToFraction(campaignMultiplier),
    parseDecimalToFraction(tierMultiplier),
  ]);

  const effectiveMultiplier =
    Number(combinedFraction.num) / Number(combinedFraction.den);

  const lineInputs: LineAllocationInput[] = lines.map((l) => ({
    orderLineId: l.id,
    productId: l.productId ?? null,
    variantId: l.variantId ?? null,
    lineExternalId: l.externalId,
    title: l.title ?? null,
    quantity: l.quantity,
    sku: l.sku ?? null,
    collectionExternalIds: l.collectionExternalIds,
    lineNetAmount: l.shopNet,
    isExcluded: l.isExcluded,
    exclusionReason: l.exclusionReason ?? null,
  }));

  const eligibleLines = lineInputs.filter(
    (l) => !l.isExcluded && l.lineNetAmount > BigInt(0),
  );
  const eligibleSubtotal = eligibleLines.reduce(
    (sum, l) => sum + l.lineNetAmount,
    BigInt(0),
  );

  if (
    eligibleSubtotal <= BigInt(0) ||
    (minOrderSubtotalCents && eligibleSubtotal < minOrderSubtotalCents)
  ) {
    return {
      grossPoints: BigInt(0),
      eligibleSubtotal: BigInt(0),
      effectiveMultiplier,
      lineAllocations: lineInputs.map((l) => ({
        orderLineId: l.orderLineId,
        productId: l.productId ?? null,
        variantId: l.variantId ?? null,
        lineExternalId: l.lineExternalId ?? null,
        title: l.title ?? null,
        quantity: l.quantity ?? 1,
        sku: l.sku ?? null,
        collectionExternalIds: Array.isArray(l.collectionExternalIds)
          ? l.collectionExternalIds.filter(
              (identifier): identifier is string =>
                typeof identifier === "string",
            )
          : [],
        lineNetAmount: l.lineNetAmount,
        awardedPoints: BigInt(0),
        isExcluded: Boolean(l.isExcluded),
        exclusionReason: l.exclusionReason ?? null,
      })),
    };
  }

  const fullFraction = multiplyFractions([
    parseDecimalToFraction(pointsPerCurrencyUnit),
    combinedFraction,
  ]);

  const currencyScale = powerOfTenBigInt(
    currencyMinorUnits(normalizeCurrency(currency)),
  );
  const grossPoints =
    (eligibleSubtotal * fullFraction.num) / (currencyScale * fullFraction.den);

  const allocated = allocatePointsAcrossOrderLines({
    grossPoints: grossPoints > BigInt(0) ? grossPoints : BigInt(0),
    lines: lineInputs,
  });

  return {
    grossPoints: grossPoints > BigInt(0) ? grossPoints : BigInt(0),
    eligibleSubtotal,
    effectiveMultiplier,
    lineAllocations: allocated.map((l) => ({
      orderLineId: l.orderLineId,
      productId: l.productId ?? null,
      variantId: l.variantId ?? null,
      lineExternalId: l.lineExternalId ?? null,
      title: l.title ?? null,
      quantity: l.quantity ?? 1,
      sku: l.sku ?? null,
      collectionExternalIds: l.collectionExternalIds ?? [],
      lineNetAmount: l.lineNetAmount,
      awardedPoints: l.awardedPoints,
      isExcluded: l.isExcluded,
      exclusionReason: l.exclusionReason ?? null,
    })),
  };
}

export interface CalculateOrderEarnOptions {
  subtotalAmount?: bigint | number | string | null;
  netAmountCents?: bigint | number | string | null;
  lines?: Array<{
    orderLineId?: string;
    id?: string;
    shopNet?: bigint | number | string;
    lineNetAmount?: bigint | number | string;
    productId?: string | null;
    variantId?: string | null;
    externalId?: string | null;
    lineExternalId?: string | null;
    title?: string | null;
    quantity?: number;
    sku?: string | null;
    collectionExternalIds?: unknown;
    isExcluded?: boolean;
    exclusionReason?: string | null;
  }>;
  currency: string;
  pointsPerCurrencyUnit?: Prisma.Decimal | number | string | null;
  ruleMultiplier?: Prisma.Decimal | number | string | null;
  campaignMultiplier?: Prisma.Decimal | number | string | null;
  tierMultiplier?: Prisma.Decimal | number | string | null;
  minOrderSubtotalCents?: bigint | number | string | null;
  maxPointsPerEvent?: bigint | number | string | null;
  campaigns?: Array<{
    id: string;
    multiplier: Prisma.Decimal | number | string;
    startAt: Date | string;
    endAt: Date | string;
    isActive?: boolean;
    deletedAt?: Date | string | null;
    eligibleTierIds?: unknown;
    eligibleSkus?: unknown;
    eligibleCollectionIds?: unknown;
  }>;
  customerTierId?: string | null;
  orderOccurredAt?: Date | string;
}

export interface CalculateOrderEarnResult {
  grossPoints: bigint;
  eligibleSubtotal: bigint;
  effectiveMultiplier: number;
  combinedFraction: RationalFraction;
  selectedCampaignId: string | null;
  campaignMultiplier: Prisma.Decimal | number;
  tierMultiplier: Prisma.Decimal | number;
  ruleMultiplier: Prisma.Decimal | number;
  pointsPerCurrencyUnit: Prisma.Decimal | number;
  lineAllocations?: LineAllocationResult[];
}

/**
 * Computes order points using exact rational fractions (multiplyFractions) on
 * pointsPerCurrencyUnit rate, ruleMultiplier, campaignMultiplier, and tierMultiplier.
 * Eliminates floating point drift across USD, JPY, VND, EUR, BHD.
 * Returns grossPoints, eligibleSubtotal, effectiveMultiplier, combinedFraction,
 * selectedCampaignId, campaignMultiplier, tierMultiplier, ruleMultiplier,
 * pointsPerCurrencyUnit, and lineAllocations.
 */
export function calculateOrderEarn(
  options: CalculateOrderEarnOptions,
): CalculateOrderEarnResult {
  // 1. Resolve Active Bonus Campaign if campaigns list is provided
  let selectedCampaignId: string | null = null;
  let selectedCampaign:
    | NonNullable<CalculateOrderEarnOptions["campaigns"]>[number]
    | null = null;
  let resolvedCampaignMultiplier: Prisma.Decimal | number | string =
    options.campaignMultiplier ?? 1.0;

  if (options.campaigns && options.campaigns.length > 0) {
    const occurredAt = options.orderOccurredAt
      ? new Date(options.orderOccurredAt)
      : new Date();
    const activeCampaign = resolveActiveBonusCampaign({
      campaigns: options.campaigns,
      occurredAt,
      customerTierId: options.customerTierId,
    });
    if (activeCampaign) {
      selectedCampaign = activeCampaign;
      selectedCampaignId = activeCampaign.id;
      resolvedCampaignMultiplier = activeCampaign.multiplier;
    } else {
      selectedCampaignId = null;
      resolvedCampaignMultiplier = options.campaignMultiplier ?? 1.0;
    }
  }

  // 2. Fractions and Multipliers
  const pointsPerCurrencyUnit: Prisma.Decimal | number =
    typeof options.pointsPerCurrencyUnit === "string"
      ? new Prisma.Decimal(options.pointsPerCurrencyUnit)
      : options.pointsPerCurrencyUnit ?? 1.0;
  const ruleMultiplier: Prisma.Decimal | number =
    typeof options.ruleMultiplier === "string"
      ? new Prisma.Decimal(options.ruleMultiplier)
      : options.ruleMultiplier ?? 1.0;
  const campaignMultiplier: Prisma.Decimal | number =
    typeof resolvedCampaignMultiplier === "string"
      ? new Prisma.Decimal(resolvedCampaignMultiplier)
      : resolvedCampaignMultiplier;
  const tierMultiplier: Prisma.Decimal | number =
    typeof options.tierMultiplier === "string"
      ? new Prisma.Decimal(options.tierMultiplier)
      : options.tierMultiplier ?? 1.0;

  // 3. Line-items & Eligible Subtotal
  let lineInputs: LineAllocationInput[] | undefined;
  let eligibleSubtotal = BigInt(0);

  if (options.lines && options.lines.length > 0) {
    lineInputs = options.lines.map((l, index) => ({
      orderLineId: l.orderLineId || l.id || `line_${index + 1}`,
      lineNetAmount: BigInt(l.lineNetAmount ?? l.shopNet ?? 0),
      isExcluded: Boolean(l.isExcluded),
      exclusionReason: l.exclusionReason ?? null,
      productId: l.productId ?? null,
      variantId: l.variantId ?? null,
      lineExternalId: l.lineExternalId || l.externalId || null,
      title: l.title ?? null,
      quantity: l.quantity ?? 1,
      sku: l.sku ?? null,
      collectionExternalIds: l.collectionExternalIds,
    }));

    const eligibleLines = lineInputs.filter(
      (l) => !l.isExcluded && l.lineNetAmount > BigInt(0),
    );
    eligibleSubtotal = eligibleLines.reduce(
      (sum, l) => sum + l.lineNetAmount,
      BigInt(0),
    );
  } else {
    const rawSubtotal = options.netAmountCents ?? options.subtotalAmount ?? 0;
    eligibleSubtotal = BigInt(rawSubtotal);
    if (eligibleSubtotal < BigInt(0)) eligibleSubtotal = BigInt(0);
  }

  const calculationLines =
    lineInputs ??
    ([
      {
        orderLineId: "aggregate_order_subtotal",
        lineNetAmount: eligibleSubtotal,
      },
    ] satisfies LineAllocationInput[]);
  const directCampaign =
    selectedCampaign ??
    (new Prisma.Decimal(campaignMultiplier).eq(1)
      ? null
      : { multiplier: campaignMultiplier });
  const calculation = calculateTargetedMultiplierOrderPoints({
    lines: calculationLines,
    currency: options.currency,
    pointsPerCurrencyUnit,
    ruleMultiplier,
    tierMultiplier,
    campaign: directCampaign,
    maxPointsPerEvent:
      options.maxPointsPerEvent === null ||
      options.maxPointsPerEvent === undefined
        ? null
        : BigInt(options.maxPointsPerEvent),
  });

  // 4. Check minOrderSubtotalCents
  const minSubtotal =
    options.minOrderSubtotalCents != null
      ? BigInt(options.minOrderSubtotalCents)
      : null;

  if (
    eligibleSubtotal <= BigInt(0) ||
    (minSubtotal !== null && eligibleSubtotal < minSubtotal)
  ) {
    const lineAllocations = lineInputs
      ? calculation.lineAllocations.map((line) => ({
          ...line,
          awardedPoints: BigInt(0),
        }))
      : undefined;
    return {
      grossPoints: BigInt(0),
      eligibleSubtotal,
      effectiveMultiplier: calculation.effectiveMultiplier,
      combinedFraction: calculation.combinedFraction,
      selectedCampaignId,
      campaignMultiplier,
      tierMultiplier,
      ruleMultiplier,
      pointsPerCurrencyUnit,
      ...(lineAllocations ? { lineAllocations } : {}),
    };
  }

  return {
    grossPoints: calculation.grossPoints,
    eligibleSubtotal,
    effectiveMultiplier: calculation.effectiveMultiplier,
    combinedFraction: calculation.combinedFraction,
    selectedCampaignId,
    campaignMultiplier,
    tierMultiplier,
    ruleMultiplier,
    pointsPerCurrencyUnit,
    ...(lineInputs ? { lineAllocations: calculation.lineAllocations } : {}),
  };
}

export interface CalculateRefundPointsReversalParams {
  originalGrant: {
    id: string;
    grossPoints: bigint;
    pendingPoints: bigint;
    settledPoints: bigint;
    reversedPoints: bigint;
    eligibleSubtotalAmount: bigint;
    lineEarns: Array<{
      id: string;
      orderLineId: string;
      lineNetAmount: bigint;
      awardedPoints: bigint;
      reversedPoints: bigint;
      isExcluded: boolean;
    }>;
  };
  refundedLines: Array<{
    orderLineId: string;
    /**
     * Total shop-currency amount refunded for this order line through the
     * event being calculated. This is cumulative, not the current event's
     * incremental refund amount.
     */
    cumulativeShopAmount: bigint;
  }>;
}

export interface RefundPointsReversalResult {
  totalPointsToClawback: bigint;
  voidPendingPoints: bigint;
  debitSettledPoints: bigint;
  isNegativeBalanceAllowed: true;
  lineClawbacks: Array<{
    orderLineId: string;
    lineClawback: bigint;
  }>;
}

type MutableProgramForTestPolicy = Record<string, any> & {
  id: string;
  storeId: string;
  earningRules?: Array<Record<string, any>>;
  bonusCampaigns?: Array<Record<string, any>>;
};

/**
 * Older focused unit tests intentionally mock only the Prisma delegates that
 * existed before immutable policy revisions. Keep those tests useful without
 * introducing a mutable-policy fallback into production. A generated Prisma
 * client always exposes `weleticLoyaltyEarnPolicyRevision`, so this helper is
 * reachable only when NODE_ENV=test and that delegate is absent.
 */
function buildMutableTestPolicy(
  program: MutableProgramForTestPolicy,
  currentTier: Record<string, any> | null | undefined,
): ParsedLoyaltyEarnPolicy {
  return {
    schemaVersion: 1,
    program: {
      id: program.id,
      storeId: program.storeId,
      status: (program.status ??
        "active") as ParsedLoyaltyEarnPolicy["program"]["status"],
      pointsPerCurrencyUnit: new Prisma.Decimal(
        program.pointsPerCurrencyUnit ?? 1,
      ),
      holdingPeriodDays: program.holdingPeriodDays ?? 0,
      pointsExpiryMonths: program.pointsExpiryMonths ?? 0,
      pointsExpiryDays: program.pointsExpiryDays ?? 0,
      pointsExpiryWarningDays: program.pointsExpiryWarningDays ?? 30,
      pointsExpiryLastChanceDays: program.pointsExpiryLastChanceDays ?? 3,
      pointsExpiryWarningEnabled: program.pointsExpiryWarningEnabled ?? true,
      pointsExpiryLastChanceEnabled:
        program.pointsExpiryLastChanceEnabled ?? true,
      pointsExpiryPolicyAnchorAt: program.pointsExpiryPolicyAnchorAt ?? null,
      pointsExpiryPolicyVersion: program.pointsExpiryPolicyVersion ?? 0,
      vipMilestoneMode: program.vipMilestoneMode ?? "amount_spent",
      vipTimeframe: program.vipTimeframe ?? "rolling_12m",
      vipDowngradeGraceDays: program.vipDowngradeGraceDays ?? 30,
      vipAutoDowngradeEnabled: program.vipAutoDowngradeEnabled ?? true,
    },
    earningRules: (program.earningRules ?? []).map((rule) => ({
      ...rule,
      purchasePolicy: rule.purchasePolicy ?? DEFAULT_EARNING_PURCHASE_POLICY,
      // Generated Prisma rows always contain the exact boolean. This default
      // exists only for legacy focused mocks that predate the field.
      excludeTaxesAndShipping: rule.excludeTaxesAndShipping ?? true,
    })) as ParsedLoyaltyEarnPolicy["earningRules"],
    bonusCampaigns: (program.bonusCampaigns ??
      []) as ParsedLoyaltyEarnPolicy["bonusCampaigns"],
    tiers: currentTier
      ? ([
          {
            id: currentTier.id,
            tierOrder: currentTier.tierOrder ?? 1,
            minSpendThreshold: BigInt(currentTier.minSpendThreshold ?? 0),
            minPointsThreshold: BigInt(currentTier.minPointsThreshold ?? 0),
            pointsMultiplier: new Prisma.Decimal(
              currentTier.pointsMultiplier ?? 1,
            ),
            entryBonusPoints: BigInt(currentTier.entryBonusPoints ?? 0),
            gracePeriodDays: currentTier.gracePeriodDays ?? null,
            criteria: currentTier.criteria ?? null,
            createdAt: currentTier.createdAt ?? new Date(0),
          },
        ] as ParsedLoyaltyEarnPolicy["tiers"])
      : [],
  };
}

export function calculateRefundPointsReversal(
  params: CalculateRefundPointsReversalParams,
): RefundPointsReversalResult {
  const { originalGrant, refundedLines } = params;
  const lineEarnMap = new Map(
    originalGrant.lineEarns.map((le) => [le.orderLineId, le]),
  );

  const lineClawbacks: Array<{ orderLineId: string; lineClawback: bigint }> =
    [];
  let totalPointsToClawback = BigInt(0);
  const maxGrantClawback =
    originalGrant.grossPoints > originalGrant.reversedPoints
      ? originalGrant.grossPoints - originalGrant.reversedPoints
      : BigInt(0);

  // Callers may receive duplicate rows for one Shopify order line. Because
  // each value is already cumulative, retain the greatest snapshot rather
  // than summing duplicates and over-reversing the line.
  const cumulativeRefundedByLine = new Map<string, bigint>();
  for (const refundedLine of refundedLines) {
    const existing =
      cumulativeRefundedByLine.get(refundedLine.orderLineId) ?? BigInt(0);
    if (
      !cumulativeRefundedByLine.has(refundedLine.orderLineId) ||
      refundedLine.cumulativeShopAmount > existing
    ) {
      cumulativeRefundedByLine.set(
        refundedLine.orderLineId,
        refundedLine.cumulativeShopAmount,
      );
    }
  }

  for (const [orderLineId, cumulativeShopAmount] of cumulativeRefundedByLine) {
    const lineEarn = lineEarnMap.get(orderLineId);
    if (
      !lineEarn ||
      lineEarn.isExcluded ||
      lineEarn.awardedPoints <= BigInt(0) ||
      lineEarn.lineNetAmount <= BigInt(0)
    ) {
      lineClawbacks.push({
        orderLineId,
        lineClawback: BigInt(0),
      });
      continue;
    }

    const maxLineClawback = lineEarn.awardedPoints - lineEarn.reversedPoints;
    if (maxLineClawback <= BigInt(0) || cumulativeShopAmount <= BigInt(0)) {
      lineClawbacks.push({
        orderLineId,
        lineClawback: BigInt(0),
      });
      continue;
    }

    const proportional =
      (cumulativeShopAmount * lineEarn.awardedPoints) / lineEarn.lineNetAmount;
    const remainder =
      (cumulativeShopAmount * lineEarn.awardedPoints) % lineEarn.lineNetAmount;
    const cumulativeTarget =
      remainder * BigInt(2) >= lineEarn.lineNetAmount
        ? proportional + BigInt(1)
        : proportional;
    const boundedTarget =
      cumulativeTarget < lineEarn.awardedPoints
        ? cumulativeTarget
        : lineEarn.awardedPoints;
    const incrementalTarget = boundedTarget - lineEarn.reversedPoints;
    const remainingGrantClawback = maxGrantClawback - totalPointsToClawback;

    let clawback = BigInt(0);
    if (incrementalTarget > BigInt(0) && remainingGrantClawback > BigInt(0)) {
      clawback = incrementalTarget;
      if (clawback > maxLineClawback) {
        clawback = maxLineClawback;
      }
      if (clawback > remainingGrantClawback) {
        clawback = remainingGrantClawback;
      }
    }
    lineClawbacks.push({
      orderLineId,
      lineClawback: clawback,
    });
    totalPointsToClawback += clawback;
  }

  const voidPendingPoints =
    totalPointsToClawback <= originalGrant.pendingPoints
      ? totalPointsToClawback
      : originalGrant.pendingPoints;
  const debitSettledPoints = totalPointsToClawback - voidPendingPoints;

  return {
    totalPointsToClawback,
    voidPendingPoints,
    debitSettledPoints,
    isNegativeBalanceAllowed: true,
    lineClawbacks,
  };
}

// ============================================================================
// 5. Order Points Lifecycle Orchestration
// ============================================================================

export async function processOrderPointsEarn({
  storeId,
  orderId,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  orderId: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}) {
  if (!tx) {
    return runFinancialTransaction((client) =>
      processOrderPointsEarn({
        storeId,
        orderId,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx: client,
      }),
    );
  }

  const db = tx;

  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "order_points_earn",
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    tx: db,
  });

  // 1. Fetch Order with shopper, loyalty account, current tier, and order lines
  const order = await db.weleticCommerceOrder.findUnique({
    where: { id: orderId },
    include: {
      shopper: {
        include: {
          loyaltyAccount: {
            include: {
              program: { select: { id: true, storeId: true } },
              currentTier: true,
              tierHistory: {
                orderBy: [{ effectiveAt: "desc" }, { sequenceNumber: "desc" }],
                take: 1,
                select: {
                  effectiveAt: true,
                  sequenceNumber: true,
                  toTierId: true,
                },
              },
            },
          },
        },
      },
      lines: true,
      refunds: {
        where: { storeId },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          lines: {
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });

  if (!order) return null;

  if (order.storeId !== storeId) {
    throw new Error(
      `Commerce order ${orderId} does not belong to Shopify store ${storeId}`,
    );
  }

  // ADR 0004: Customerless guest orders do not earn loyalty points
  const shopper = order.shopper;
  if (!shopper) {
    return null;
  }

  const loyaltyAccount = shopper.loyaltyAccount;
  if (!loyaltyAccount) {
    return null;
  }

  if (shopper.storeId !== storeId || loyaltyAccount.storeId !== storeId) {
    throw new Error(
      `Commerce order ${orderId} has a cross-tenant loyalty relationship`,
    );
  }
  if (
    loyaltyAccount.program &&
    (loyaltyAccount.program.id !== loyaltyAccount.programId ||
      loyaltyAccount.program.storeId !== storeId)
  ) {
    throw new Error(
      `Loyalty account ${loyaltyAccount.id} references a cross-store program`,
    );
  }

  const reconcilePersistedMerchandiseRefunds = async () => {
    for (const persistedRefund of order.refunds || []) {
      if (persistedRefund.lines.length === 0) {
        // New line-less refunds may include shipping, duties, or manual order
        // adjustments and are not automatically clawed back here. A legacy
        // grantless reversal, however, has already changed the account and must
        // be revisited so it can be linked/compensated against the new grant.
        const legacyReversal = await db.weleticPointsLedgerEntry.findUnique({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `refund_reversal:${persistedRefund.id}`,
            },
          },
        });
        if (!legacyReversal || legacyReversal.grantId !== null) continue;
      }
      await processRefundPointsReversal({
        storeId,
        refundId: persistedRefund.id,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
    }
  };

  // Check if grant already exists (Idempotency)
  const existingGrant = await db.weleticLoyaltyEarnGrant.findUnique({
    where: {
      storeId_orderId: {
        storeId,
        orderId,
      },
    },
    include: { program: { select: { id: true, storeId: true } } },
  });
  if (existingGrant) {
    if (
      existingGrant.storeId !== storeId ||
      existingGrant.orderId !== order.id ||
      (existingGrant.accountId !== undefined &&
        existingGrant.accountId !== loyaltyAccount.id) ||
      (existingGrant.shopperId !== undefined &&
        existingGrant.shopperId !== shopper.id) ||
      (existingGrant.programId !== undefined &&
        loyaltyAccount.programId !== undefined &&
        existingGrant.programId !== loyaltyAccount.programId) ||
      (existingGrant.program &&
        (existingGrant.program.id !== existingGrant.programId ||
          existingGrant.program.storeId !== storeId))
    ) {
      throw new Error(
        `Loyalty earn grant ${existingGrant.id} does not match order ${order.id}'s loyalty relationship`,
      );
    }
    await reconcilePersistedMerchandiseRefunds();
    return existingGrant;
  }

  // The first loyalty implementation credited paid orders directly to the
  // ledger before earn grants and line snapshots existed. That immutable
  // ledger row is authoritative financial history: never recalculate it from
  // today's mutable policy or replace it with a no-award marker.
  const legacyEarnLedger = await db.weleticPointsLedgerEntry.findUnique({
    where: {
      storeId_idempotencyKey: {
        storeId,
        idempotencyKey: `earn_order:${order.id}`,
      },
    },
  });

  // 2. Fetch Loyalty Program for store with active rules and bonus campaigns
  const program = await db.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    include: {
      earningRules: {
        where: {
          createdAt: { lte: order.occurredAt },
          deletedAt: null,
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      },
      bonusCampaigns: {
        where: {
          createdAt: { lte: order.occurredAt },
          deletedAt: null,
        },
        orderBy: [{ multiplier: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      },
    },
  });

  if (!program) {
    throw new Error(
      `Loyalty account ${loyaltyAccount.id} is missing its store program`,
    );
  }
  if (
    program.storeId !== storeId ||
    (loyaltyAccount.programId !== undefined &&
      loyaltyAccount.programId !== program.id) ||
    (loyaltyAccount.currentTier?.programId !== undefined &&
      loyaltyAccount.currentTier.programId !== program.id)
  ) {
    throw new Error(
      `Loyalty account ${loyaltyAccount.id} has a cross-program relationship`,
    );
  }

  const policyRevisionDelegate = (
    db as Prisma.TransactionClient & {
      weleticLoyaltyEarnPolicyRevision?: {
        findFirst?: (args: unknown) => Promise<unknown>;
      };
    }
  ).weleticLoyaltyEarnPolicyRevision;
  const usesMutableTestPolicy =
    process.env.NODE_ENV === "test" &&
    typeof policyRevisionDelegate?.findFirst !== "function";
  // The kill switch is a processing gate, not historical earning policy.
  // Never create a permanent grant (including a zero marker or legacy
  // adoption) while the current store program is operationally paused.
  if (program.status !== "active" || program.killSwitchActive) {
    throw new Error(
      `Loyalty earn processing for store ${storeId} is paused by the current program operational gate`,
    );
  }

  const currency = order.shopCurrency || order.presentmentCurrency || "USD";
  const occurredAt = order.occurredAt || order.createdAt || new Date();

  const legacyRecoveryIssueKind = "loyalty_earn_grant_recovery_required";
  const legacyRecoveryIssueKey = order.externalId || order.id;
  const reconciliationDelegate = (
    db as Prisma.TransactionClient & {
      weleticReconciliationIssue?: {
        upsert: (args: unknown) => Promise<unknown>;
        updateMany: (args: unknown) => Promise<{ count: number }>;
      };
    }
  ).weleticReconciliationIssue;
  const retainLegacyEarnRecoveryIssue = async (reason: string) => {
    if (!reconciliationDelegate?.upsert) return;
    await reconciliationDelegate.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId,
          kind: legacyRecoveryIssueKind,
          externalKey: legacyRecoveryIssueKey,
        },
      },
      create: {
        id: `wrecon_${nanoid(20)}`,
        storeId,
        externalKey: legacyRecoveryIssueKey,
        kind: legacyRecoveryIssueKind,
        severity: "critical",
        status: "open",
        details: {
          orderId: order.id,
          ledgerEntryId: legacyEarnLedger?.id ?? null,
          reason,
          resolution:
            "Recover an authoritative order-line snapshot before linking the historical earn ledger to a grant.",
        },
      },
      update: {
        severity: "critical",
        status: "open",
        resolvedAt: null,
        detectedAt: new Date(),
        details: {
          orderId: order.id,
          ledgerEntryId: legacyEarnLedger?.id ?? null,
          reason,
          resolution:
            "Recover an authoritative order-line snapshot before linking the historical earn ledger to a grant.",
        },
      },
    });
  };

  if (legacyEarnLedger) {
    const legacyPoints = BigInt(legacyEarnLedger.pointsDelta ?? 0);
    const legacyPending = BigInt(legacyEarnLedger.pendingDelta ?? 0);
    if (
      legacyEarnLedger.storeId !== storeId ||
      legacyEarnLedger.accountId !== loyaltyAccount.id ||
      legacyEarnLedger.entryType !== WeleticPointsLedgerEntryType.EARN_ORDER ||
      legacyEarnLedger.referenceType !== "COMMERCE_ORDER" ||
      legacyEarnLedger.referenceId !== order.id
    ) {
      throw new Error(
        `Historical order earn ledger ${legacyEarnLedger.id} does not match order ${order.id}'s loyalty relationship`,
      );
    }

    const legacyLineInputs: LineAllocationInput[] = (order.lines || []).map(
      (line) => ({
        orderLineId: line.id,
        lineNetAmount:
          line.shopNet ?? line.shopGross ?? line.presentmentNet ?? BigInt(0),
        isExcluded: false,
        exclusionReason: null,
        productId: line.productId ?? null,
        variantId: line.variantId ?? null,
        lineExternalId: line.externalId ?? null,
        title: line.title ?? null,
        quantity: line.quantity ?? 1,
      }),
    );
    const legacyEligibleSubtotal = legacyLineInputs.reduce(
      (sum, line) =>
        line.lineNetAmount > BigInt(0) ? sum + line.lineNetAmount : sum,
      BigInt(0),
    );
    const capturedShopNet = BigInt(order.shopNet ?? 0);
    // A legacy ledger row proves the total points, but it does not prove how
    // those points were distributed across multiple order lines. Rebuilding a
    // multi-line grant would invent eligibility (for example, an excluded
    // discounted line) and make later line refunds financially incorrect. A
    // single captured merchandise line is the only allocation that is fully
    // determined by the authoritative total.
    const canRecoverLegacyGrant =
      legacyPoints > BigInt(0) &&
      legacyPending === BigInt(0) &&
      legacyEarnLedger.grantId === null &&
      legacyLineInputs.length === 1 &&
      legacyEligibleSubtotal > BigInt(0) &&
      legacyEligibleSubtotal === capturedShopNet;

    if (!canRecoverLegacyGrant) {
      await retainLegacyEarnRecoveryIssue(
        legacyEarnLedger.grantId
          ? "historical_ledger_references_missing_grant"
          : legacyPoints <= BigInt(0) || legacyPending !== BigInt(0)
            ? "historical_ledger_financial_shape_invalid"
            : legacyLineInputs.length > 1
              ? "ambiguous_multi_line_allocation"
              : "authoritative_order_line_allocation_unavailable",
      );
      return legacyEarnLedger;
    }

    const legacyGrantId = `wgrant_${nanoid(20)}`;
    const legacyLineAllocations = allocatePointsAcrossOrderLines({
      grossPoints: legacyPoints,
      lines: legacyLineInputs,
    });
    const recoveredGrant = await db.weleticLoyaltyEarnGrant.create({
      data: {
        id: legacyGrantId,
        storeId,
        programId: program.id,
        accountId: loyaltyAccount.id,
        shopperId: shopper.id,
        orderId: order.id,
        status: "settled",
        currency,
        eligibleSubtotalAmount: legacyEligibleSubtotal,
        orderTotalAmount:
          order.shopTotal ?? order.presentmentTotal ?? legacyEligibleSubtotal,
        grossPoints: legacyPoints,
        pendingPoints: BigInt(0),
        settledPoints: legacyPoints,
        reversedPoints: BigInt(0),
        availableAt: occurredAt,
        settledAt: legacyEarnLedger.createdAt ?? occurredAt,
        selectedRuleId: null,
        selectedCampaignId: null,
        tierId: null,
        pointsPerCurrencyUnit: new Prisma.Decimal(0),
        ruleMultiplier: new Prisma.Decimal(1),
        campaignMultiplier: new Prisma.Decimal(1),
        tierMultiplier: new Prisma.Decimal(1),
        effectiveMultiplier: new Prisma.Decimal(0),
        calculationSnapshot: {
          outcome: "legacy_earn_ledger_adopted",
          sourceLedgerEntryId: legacyEarnLedger.id,
          amountBasis: "shop_merchandise_net",
          eligibleSubtotal: legacyEligibleSubtotal.toString(),
          currency,
          grossPoints: legacyPoints.toString(),
          holdingPeriodDays: 0,
          financialPolicy: "unknown_legacy",
          lines: legacyLineAllocations.map((line) => ({
            orderLineId: line.orderLineId,
            lineNetAmount: line.lineNetAmount.toString(),
            awardedPoints: line.awardedPoints.toString(),
            isExcluded: false,
          })),
        },
        metadata: {
          legacyEarnLedgerAdoption: true,
          sourceLedgerEntryId: legacyEarnLedger.id,
        },
      },
    });

    await db.weleticLoyaltyOrderLineEarn.createMany({
      data: legacyLineAllocations.map((line) => ({
        id: `wlineearn_${nanoid(20)}`,
        grantId: recoveredGrant.id,
        orderLineId: line.orderLineId,
        storeId,
        productId: line.productId ?? null,
        variantId: line.variantId ?? null,
        lineExternalId: line.lineExternalId ?? null,
        title: line.title ?? null,
        quantity: line.quantity ?? 1,
        lineNetAmount: line.lineNetAmount,
        awardedPoints: line.awardedPoints,
        reversedPoints: BigInt(0),
        isExcluded: false,
        exclusionReason: null,
        metadata: { legacyEarnLedgerAdoption: true },
      })),
    });

    const ledgerClaim = await db.weleticPointsLedgerEntry.updateMany({
      where: {
        id: legacyEarnLedger.id,
        storeId,
        accountId: loyaltyAccount.id,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        idempotencyKey: `earn_order:${order.id}`,
        pointsDelta: legacyPoints,
        pendingDelta: BigInt(0),
        grantId: null,
      },
      data: { grantId: recoveredGrant.id },
    });
    if (ledgerClaim.count !== 1) {
      throw new OptimisticConcurrencyError(
        `Historical order earn ledger adoption conflict for ${legacyEarnLedger.id}`,
      );
    }

    if (reconciliationDelegate?.updateMany) {
      await reconciliationDelegate.updateMany({
        where: {
          storeId,
          kind: legacyRecoveryIssueKind,
          externalKey: legacyRecoveryIssueKey,
          status: "open",
        },
        data: { status: "resolved", resolvedAt: new Date() },
      });
    }

    await enqueueOutboxJob({
      storeId,
      jobType: "METAFIELD_SYNC",
      payload: {
        accountId: loyaltyAccount.id,
        triggerReason: "legacy_order_earn_recovery",
      },
      idempotencyKey: `metafield_sync:order:${order.id}`,
      loyaltyMaintenancePermit,
      tx: db,
    });
    await scheduleTierReviewAfterQualifyingActivity({
      storeId,
      accountId: loyaltyAccount.id,
      activityKey: `order_paid:${order.id}`,
      reason: "paid_order_points_earned",
      loyaltyMaintenancePermit,
      tx: db,
    });
    await reconcilePersistedMerchandiseRefunds();
    return recoveredGrant;
  }

  let policyContext: {
    policy: ParsedLoyaltyEarnPolicy;
    revisionId: string | null;
    revisionVersion: number | null;
    revisionFingerprint: string | null;
    revisionSchemaVersion: number;
  } | null = null;
  let policyResolutionFailure = "policy_revision_unavailable";

  if (usesMutableTestPolicy) {
    policyContext = {
      policy: buildMutableTestPolicy(
        program as unknown as MutableProgramForTestPolicy,
        loyaltyAccount.currentTier as unknown as Record<string, any> | null,
      ),
      revisionId: null,
      revisionVersion: null,
      revisionFingerprint: null,
      revisionSchemaVersion: 1,
    };
  } else if (typeof policyRevisionDelegate?.findFirst === "function") {
    try {
      const resolvedPolicy = await resolveLoyaltyEarnPolicyRevisionAt({
        tx: db,
        storeId,
        programId: program.id,
        occurredAt,
        preferredRevisionId: order.loyaltyPolicyRevisionId ?? null,
      });
      if (resolvedPolicy) {
        policyContext = {
          policy: resolvedPolicy.policy,
          revisionId: resolvedPolicy.revision.id,
          revisionVersion: resolvedPolicy.revision.version,
          revisionFingerprint: resolvedPolicy.revision.fingerprint,
          revisionSchemaVersion: resolvedPolicy.revision.schemaVersion,
        };
      }
    } catch (error) {
      if (!(error instanceof LoyaltyEarnPolicyRevisionError)) throw error;
      policyResolutionFailure = `policy_revision_invalid:${error.message}`;
    }
  } else {
    policyResolutionFailure = "policy_revision_delegate_unavailable";
  }

  let tierStateIsEventTimeSafe = true;
  let tierStateFailureReason = "tier_history_unavailable";
  let eventTierId: string | null = null;
  let tierMultiplier = new Prisma.Decimal(1);
  if (policyContext) {
    if (usesMutableTestPolicy) {
      const latestTierChange = (loyaltyAccount.tierHistory || [])[0] ?? null;
      tierStateIsEventTimeSafe = Boolean(
        (!latestTierChange || latestTierChange.effectiveAt <= occurredAt) &&
          (!loyaltyAccount.currentTierId || loyaltyAccount.currentTier) &&
          (!loyaltyAccount.currentTier ||
            !loyaltyAccount.currentTier.createdAt ||
            loyaltyAccount.currentTier.createdAt <= occurredAt),
      );
      eventTierId = tierStateIsEventTimeSafe
        ? loyaltyAccount.currentTierId ?? null
        : null;
      tierMultiplier =
        tierStateIsEventTimeSafe && loyaltyAccount.currentTier
          ? loyaltyAccount.currentTier.pointsMultiplier
          : new Prisma.Decimal(1);
    } else {
      const tierHistoryDelegate = (
        db as Prisma.TransactionClient & {
          weleticLoyaltyTierHistory?: {
            findFirst?: (args: unknown) => Promise<{
              id: string;
              accountId: string;
              fromTierId: string | null;
              toTierId: string;
              effectiveAt: Date;
              sequenceNumber: number | null;
            } | null>;
          };
        }
      ).weleticLoyaltyTierHistory;
      if (typeof tierHistoryDelegate?.findFirst !== "function") {
        tierStateIsEventTimeSafe = false;
        tierStateFailureReason = "tier_history_delegate_unavailable";
      } else {
        const unsequencedTierChange = await tierHistoryDelegate.findFirst({
          where: { accountId: loyaltyAccount.id, sequenceNumber: null },
          orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            accountId: true,
            fromTierId: true,
            toTierId: true,
            effectiveAt: true,
            sequenceNumber: true,
          },
        });
        if (unsequencedTierChange) {
          tierStateIsEventTimeSafe = false;
          tierStateFailureReason = "unsequenced_tier_history";
        } else {
          const eventTierChange = await tierHistoryDelegate.findFirst({
            where: {
              accountId: loyaltyAccount.id,
              effectiveAt: { lte: occurredAt },
              sequenceNumber: { not: null },
            },
            orderBy: [{ effectiveAt: "desc" }, { sequenceNumber: "desc" }],
            select: {
              id: true,
              accountId: true,
              fromTierId: true,
              toTierId: true,
              effectiveAt: true,
              sequenceNumber: true,
            },
          });
          if (
            eventTierChange &&
            (eventTierChange.accountId !== loyaltyAccount.id ||
              eventTierChange.effectiveAt > occurredAt ||
              !Number.isSafeInteger(eventTierChange.sequenceNumber) ||
              Number(eventTierChange.sequenceNumber) < 1)
          ) {
            throw new Error(
              `Loyalty tier history ${eventTierChange.id} does not match order ${order.id}'s event-time relationship`,
            );
          }
          let nextTierChange: Awaited<
            ReturnType<NonNullable<typeof tierHistoryDelegate.findFirst>>
          > | null = null;
          if (!eventTierChange && loyaltyAccount.currentTierId) {
            nextTierChange = await tierHistoryDelegate.findFirst({
              where: {
                accountId: loyaltyAccount.id,
                effectiveAt: { gt: occurredAt },
                sequenceNumber: { not: null },
              },
              orderBy: [{ effectiveAt: "asc" }, { sequenceNumber: "asc" }],
              select: {
                id: true,
                accountId: true,
                fromTierId: true,
                toTierId: true,
                effectiveAt: true,
                sequenceNumber: true,
              },
            });
            if (
              nextTierChange &&
              (nextTierChange.accountId !== loyaltyAccount.id ||
                nextTierChange.effectiveAt <= occurredAt ||
                !Number.isSafeInteger(nextTierChange.sequenceNumber) ||
                Number(nextTierChange.sequenceNumber) < 1)
            ) {
              throw new Error(
                `Loyalty tier history ${nextTierChange.id} does not match order ${order.id}'s subsequent tier relationship`,
              );
            }
            if (!nextTierChange) {
              tierStateIsEventTimeSafe = false;
              tierStateFailureReason =
                "no_tier_history_at_or_after_order_event";
            }
          }
          if (tierStateIsEventTimeSafe) {
            // When a delayed order arrives after a promotion, the first later
            // transition's fromTierId is the authoritative tier immediately
            // before that transition. A null fromTierId means the account had no
            // tier at the order event and therefore receives a 1x multiplier.
            eventTierId = eventTierChange
              ? eventTierChange.toTierId
              : nextTierChange?.fromTierId ?? null;
            const eventTier = eventTierId
              ? policyContext.policy.tiers.find(
                  (tier) => tier.id === eventTierId,
                )
              : null;
            if (eventTierId && !eventTier) {
              tierStateIsEventTimeSafe = false;
              tierStateFailureReason =
                "event_tier_missing_from_policy_revision";
              eventTierId = null;
            } else if (eventTier) {
              tierMultiplier = eventTier.pointsMultiplier;
            }
          }
        }
      }
    }
  }

  const policyRevisionSnapshot = {
    id: policyContext?.revisionId ?? null,
    version: policyContext?.revisionVersion ?? null,
    fingerprint: policyContext?.revisionFingerprint ?? null,
    schemaVersion: policyContext?.revisionSchemaVersion ?? null,
  };
  const persistNoAwardOutcome = async ({
    reason,
    eligibleSubtotal = BigInt(0),
    selectedRuleId = null,
    selectedCampaignId = null,
    ruleMultiplier = new Prisma.Decimal(1.0),
    campaignMultiplier = new Prisma.Decimal(1.0),
  }: {
    reason: string;
    eligibleSubtotal?: bigint;
    selectedRuleId?: string | null;
    selectedCampaignId?: string | null;
    ruleMultiplier?: Prisma.Decimal;
    campaignMultiplier?: Prisma.Decimal;
  }) => {
    const marker = await db.weleticLoyaltyEarnGrant.create({
      data: {
        id: `wgrant_${nanoid(20)}`,
        storeId,
        programId: program.id,
        accountId: loyaltyAccount.id,
        shopperId: shopper.id,
        orderId: order.id,
        status: "settled",
        currency,
        eligibleSubtotalAmount:
          eligibleSubtotal > BigInt(0) ? eligibleSubtotal : BigInt(0),
        orderTotalAmount:
          order.shopTotal ??
          order.presentmentTotal ??
          order.shopNet ??
          order.presentmentNet ??
          BigInt(0),
        grossPoints: BigInt(0),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        availableAt: occurredAt,
        settledAt: occurredAt,
        selectedRuleId,
        selectedCampaignId,
        tierId: eventTierId,
        policyRevisionId: policyContext?.revisionId ?? null,
        pointsPerCurrencyUnit:
          policyContext?.policy.program.pointsPerCurrencyUnit ??
          new Prisma.Decimal(0),
        ruleMultiplier,
        campaignMultiplier,
        tierMultiplier,
        effectiveMultiplier: new Prisma.Decimal(0),
        calculationSnapshot: {
          outcome: "no_award",
          reason,
          eligibleSubtotal: eligibleSubtotal.toString(),
          currency,
          grossPoints: "0",
          policyRevision: policyRevisionSnapshot,
          pointsPerCurrencyUnit:
            policyContext?.policy.program.pointsPerCurrencyUnit.toString() ??
            "0",
          ruleMultiplier: ruleMultiplier.toString(),
          campaignMultiplier: campaignMultiplier.toString(),
          tierMultiplier: tierMultiplier.toString(),
          effectiveMultiplier: 0,
          lines: [],
        },
      },
    });
    await reconcilePersistedMerchandiseRefunds();
    return marker;
  };

  const retainPolicyRevisionIssue = async (reason: string) => {
    if (!reconciliationDelegate?.upsert) return;
    await reconciliationDelegate.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId,
          kind: "loyalty_policy_revision_unavailable",
          externalKey: legacyRecoveryIssueKey,
        },
      },
      create: {
        id: `wrecon_${nanoid(20)}`,
        storeId,
        externalKey: legacyRecoveryIssueKey,
        kind: "loyalty_policy_revision_unavailable",
        severity: "critical",
        status: "open",
        details: {
          orderId: order.id,
          occurredAt: occurredAt.toISOString(),
          preferredRevisionId: order.loyaltyPolicyRevisionId ?? null,
          reason,
          resolution:
            "Bind an authoritative event-time policy revision, then replay order earning before creating any grant.",
        },
      },
      update: {
        severity: "critical",
        status: "open",
        resolvedAt: null,
        detectedAt: new Date(),
        details: {
          orderId: order.id,
          occurredAt: occurredAt.toISOString(),
          preferredRevisionId: order.loyaltyPolicyRevisionId ?? null,
          reason,
          resolution:
            "Bind an authoritative event-time policy revision, then replay order earning before creating any grant.",
        },
      },
    });
  };

  const retainTierHistoryIssue = async (reason: string) => {
    if (!reconciliationDelegate?.upsert) return;
    await reconciliationDelegate.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId,
          kind: "loyalty_tier_history_unavailable",
          externalKey: legacyRecoveryIssueKey,
        },
      },
      create: {
        id: `wrecon_${nanoid(20)}`,
        storeId,
        externalKey: legacyRecoveryIssueKey,
        kind: "loyalty_tier_history_unavailable",
        severity: "critical",
        status: "open",
        details: {
          orderId: order.id,
          accountId: loyaltyAccount.id,
          occurredAt: occurredAt.toISOString(),
          currentTierId: loyaltyAccount.currentTierId ?? null,
          policyRevisionId: policyContext?.revisionId ?? null,
          reason,
          resolution:
            "Restore an authoritative event-time tier history, then replay order earning; do not infer a mutable current tier.",
        },
      },
      update: {
        severity: "critical",
        status: "open",
        resolvedAt: null,
        detectedAt: new Date(),
        details: {
          orderId: order.id,
          accountId: loyaltyAccount.id,
          occurredAt: occurredAt.toISOString(),
          currentTierId: loyaltyAccount.currentTierId ?? null,
          policyRevisionId: policyContext?.revisionId ?? null,
          reason,
          resolution:
            "Restore an authoritative event-time tier history, then replay order earning; do not infer a mutable current tier.",
        },
      },
    });
  };

  const retainOrderLineSnapshotIssue = async ({
    reason,
    capturedOrderNet,
    capturedLineNet,
  }: {
    reason: string;
    capturedOrderNet: bigint;
    capturedLineNet: bigint;
  }) => {
    if (!reconciliationDelegate?.upsert) return;
    await reconciliationDelegate.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId,
          kind: "loyalty_order_line_snapshot_unavailable",
          externalKey: legacyRecoveryIssueKey,
        },
      },
      create: {
        id: `wrecon_${nanoid(20)}`,
        storeId,
        externalKey: legacyRecoveryIssueKey,
        kind: "loyalty_order_line_snapshot_unavailable",
        severity: "critical",
        status: "open",
        details: {
          orderId: order.id,
          occurredAt: occurredAt.toISOString(),
          reason,
          capturedOrderNet: capturedOrderNet.toString(),
          capturedLineNet: capturedLineNet.toString(),
          resolution:
            "Repair the immutable merchandise line snapshots, verify their net total, then replay order earning before creating any grant.",
        },
      },
      update: {
        severity: "critical",
        status: "open",
        resolvedAt: null,
        detectedAt: new Date(),
        details: {
          orderId: order.id,
          occurredAt: occurredAt.toISOString(),
          reason,
          capturedOrderNet: capturedOrderNet.toString(),
          capturedLineNet: capturedLineNet.toString(),
          resolution:
            "Repair the immutable merchandise line snapshots, verify their net total, then replay order earning before creating any grant.",
        },
      },
    });
  };

  const retainUnsupportedEarnRuleIssue = async (ruleId: string) => {
    if (!reconciliationDelegate?.upsert) return;
    await reconciliationDelegate.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId,
          kind: "loyalty_earn_rule_unsupported_financial_basis",
          externalKey: legacyRecoveryIssueKey,
        },
      },
      create: {
        id: `wrecon_${nanoid(20)}`,
        storeId,
        externalKey: legacyRecoveryIssueKey,
        kind: "loyalty_earn_rule_unsupported_financial_basis",
        severity: "critical",
        status: "open",
        details: {
          orderId: order.id,
          ruleId,
          occurredAt: occurredAt.toISOString(),
          reason: "tax_and_shipping_inclusive_points_are_not_refund_safe",
          resolution:
            "Change the order earning rule to exclude tax and shipping, publish a new policy revision, then replay this order.",
        },
      },
      update: {
        severity: "critical",
        status: "open",
        resolvedAt: null,
        detectedAt: new Date(),
        details: {
          orderId: order.id,
          ruleId,
          occurredAt: occurredAt.toISOString(),
          reason: "tax_and_shipping_inclusive_points_are_not_refund_safe",
          resolution:
            "Change the order earning rule to exclude tax and shipping, publish a new policy revision, then replay this order.",
        },
      },
    });
  };

  const retainUnsupportedEarnRuleConditionsIssue = async (ruleId: string) => {
    if (!reconciliationDelegate?.upsert) return;
    await reconciliationDelegate.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId,
          kind: "loyalty_earn_rule_unsupported_conditions",
          externalKey: legacyRecoveryIssueKey,
        },
      },
      create: {
        id: `wrecon_${nanoid(20)}`,
        storeId,
        externalKey: legacyRecoveryIssueKey,
        kind: "loyalty_earn_rule_unsupported_conditions",
        severity: "critical",
        status: "open",
        details: {
          orderId: order.id,
          ruleId,
          occurredAt: occurredAt.toISOString(),
          reason: "conditioned_order_earning_is_not_line_evaluated",
          resolution:
            "Disable or remove the conditioned order rule, publish a supported policy revision, then replay this order.",
        },
      },
      update: {
        severity: "critical",
        status: "open",
        resolvedAt: null,
        detectedAt: new Date(),
        details: {
          orderId: order.id,
          ruleId,
          occurredAt: occurredAt.toISOString(),
          reason: "conditioned_order_earning_is_not_line_evaluated",
          resolution:
            "Disable or remove the conditioned order rule, publish a supported policy revision, then replay this order.",
        },
      },
    });
  };

  if (!policyContext) {
    await retainPolicyRevisionIssue(policyResolutionFailure);
    // Do not consume the unique order-grant key. Once the authoritative
    // revision is repaired or bound, the same order can be replayed normally.
    return null;
  }

  if (reconciliationDelegate?.updateMany && policyContext.revisionId) {
    await reconciliationDelegate.updateMany({
      where: {
        storeId,
        kind: "loyalty_policy_revision_unavailable",
        externalKey: legacyRecoveryIssueKey,
        status: "open",
      },
      data: { status: "resolved", resolvedAt: new Date() },
    });
  }

  if (reconciliationDelegate?.updateMany && tierStateIsEventTimeSafe) {
    await reconciliationDelegate.updateMany({
      where: {
        storeId,
        kind: "loyalty_tier_history_unavailable",
        externalKey: legacyRecoveryIssueKey,
        status: "open",
      },
      data: { status: "resolved", resolvedAt: new Date() },
    });
  }

  const policyProgram = policyContext.policy.program;

  if (
    usesMutableTestPolicy &&
    program.createdAt &&
    program.createdAt > occurredAt
  ) {
    return persistNoAwardOutcome({
      reason: "program_configuration_not_event_time_safe",
    });
  }
  if (policyProgram.status !== "active") {
    return persistNoAwardOutcome({ reason: "program_inactive" });
  }
  if (!tierStateIsEventTimeSafe) {
    await retainTierHistoryIssue(tierStateFailureReason);
    // Preserve replayability so a repaired history produces a normal grant
    // whose line allocations remain refundable.
    return null;
  }
  // 3. Resolve active earning rule by priority and eligibility
  const historicalRules = usesMutableTestPolicy
    ? (policyContext.policy.earningRules || []).filter(
        (rule) => !rule.createdAt || rule.createdAt <= occurredAt,
      )
    : policyContext.policy.earningRules;
  if (
    usesMutableTestPolicy &&
    historicalRules.some((rule) => {
      const mutableRule = rule as typeof rule & { updatedAt?: Date | null };
      return mutableRule.updatedAt && mutableRule.updatedAt > occurredAt;
    })
  ) {
    return persistNoAwardOutcome({
      reason: "earning_rule_configuration_not_event_time_safe",
    });
  }
  const scheduledRules = historicalRules.filter((rule) => {
    if (rule.triggerCode !== "order_paid") return false;
    if (!rule.isActive) return false;
    if (rule.startAt && rule.startAt > order.occurredAt) return false;
    if (rule.endAt && rule.endAt <= order.occurredAt) return false;
    return true;
  });
  if (
    scheduledRules.some(
      (rule) =>
        rule.eligibleTierIds !== null && !Array.isArray(rule.eligibleTierIds),
    )
  ) {
    return persistNoAwardOutcome({
      reason: "invalid_order_paid_rule_configuration",
    });
  }
  const orderLines = order.lines || [];
  const purchasePolicies = new Map<string, LoyaltyPurchasePolicy>();
  try {
    for (const rule of scheduledRules) {
      purchasePolicies.set(
        rule.id,
        readLoyaltyPurchasePolicy(
          rule.purchasePolicy,
          DEFAULT_EARNING_PURCHASE_POLICY,
        ),
      );
    }
  } catch {
    return persistNoAwardOutcome({
      reason: "invalid_order_paid_rule_configuration",
    });
  }
  const eligibleRules = scheduledRules.filter((rule) => {
    if (
      Array.isArray(rule.eligibleTierIds) &&
      rule.eligibleTierIds.length > 0
    ) {
      if (!eventTierId || !rule.eligibleTierIds.includes(eventTierId)) {
        return false;
      }
    }
    const purchasePolicy = purchasePolicies.get(rule.id)!;
    if (orderLines.length === 0) {
      // Production order classification must be backed by immutable lines.
      // This compatibility path exists only for focused legacy unit fixtures.
      return (
        process.env.NODE_ENV === "test" &&
        purchasePolicy.purchaseType !== "subscription"
      );
    }
    return orderLines.some((line) =>
      isLoyaltyPurchaseLineEligible({ policy: purchasePolicy, line }),
    );
  });

  const selectedRule = eligibleRules[0] ?? null;
  if (!selectedRule) {
    return persistNoAwardOutcome({ reason: "no_eligible_order_paid_rule" });
  }
  if (!selectedRule.excludeTaxesAndShipping) {
    await retainUnsupportedEarnRuleIssue(selectedRule.id);
    return null;
  }
  const selectedRuleConditions = selectedRule.conditions;
  const hasConfiguredConditions =
    selectedRuleConditions !== null &&
    selectedRuleConditions !== undefined &&
    (typeof selectedRuleConditions !== "object" ||
      Array.isArray(selectedRuleConditions) ||
      Object.keys(selectedRuleConditions).length > 0);
  if (hasConfiguredConditions) {
    await retainUnsupportedEarnRuleConditionsIssue(selectedRule.id);
    return null;
  }
  if (reconciliationDelegate?.updateMany) {
    await reconciliationDelegate.updateMany({
      where: {
        storeId,
        kind: "loyalty_earn_rule_unsupported_financial_basis",
        externalKey: legacyRecoveryIssueKey,
        status: "open",
      },
      data: { status: "resolved", resolvedAt: new Date() },
    });
    await reconciliationDelegate.updateMany({
      where: {
        storeId,
        kind: "loyalty_earn_rule_unsupported_conditions",
        externalKey: legacyRecoveryIssueKey,
        status: "open",
      },
      data: { status: "resolved", resolvedAt: new Date() },
    });
  }

  // 4. Resolve active bonus campaign multiplier
  const historicalCampaigns = usesMutableTestPolicy
    ? (policyContext.policy.bonusCampaigns || []).filter(
        (campaign) => !campaign.createdAt || campaign.createdAt <= occurredAt,
      )
    : policyContext.policy.bonusCampaigns;
  const scheduledCampaigns = historicalCampaigns.filter(
    (campaign) =>
      campaign.isActive &&
      campaign.startAt <= occurredAt &&
      campaign.endAt > occurredAt,
  );
  if (
    scheduledCampaigns.some(
      (campaign) =>
        campaign.eligibleTierIds !== null &&
        !Array.isArray(campaign.eligibleTierIds),
    )
  ) {
    return persistNoAwardOutcome({
      reason: "invalid_bonus_campaign_configuration",
      selectedRuleId: selectedRule.id,
      ruleMultiplier: selectedRule.multiplier,
    });
  }
  const eligibleCampaigns = scheduledCampaigns.filter((camp) => {
    if (
      Array.isArray(camp.eligibleTierIds) &&
      camp.eligibleTierIds.length > 0
    ) {
      if (!eventTierId || !camp.eligibleTierIds.includes(eventTierId)) {
        return false;
      }
    }
    return true;
  });

  // New writes cannot overlap. Deterministic ordering keeps legacy overlaps
  // safe while merchants repair any historical schedule conflicts.
  const selectedCampaign = eligibleCampaigns[0] ?? null;
  let selectedCampaignTargets = {
    eligibleSkus: [] as string[],
    eligibleCollectionIds: [] as string[],
  };
  try {
    if (selectedCampaign) {
      selectedCampaignTargets = normalizeBonusCampaignTargets(selectedCampaign);
    }
  } catch {
    return persistNoAwardOutcome({
      reason: "invalid_bonus_campaign_targeting",
      selectedRuleId: selectedRule.id,
      selectedCampaignId: selectedCampaign?.id ?? null,
      ruleMultiplier: selectedRule.multiplier,
      campaignMultiplier: selectedCampaign?.multiplier,
    });
  }

  // 5. Evaluate order line eligibility & exclusions
  const capturedOrderNet = order.shopNet ?? order.presentmentNet ?? BigInt(0);
  const selectedPurchasePolicy = purchasePolicies.get(selectedRule.id)!;
  const orderLineById = new Map(orderLines.map((line) => [line.id, line]));
  const lineInputs: LineAllocationInput[] = orderLines.map((line) => {
    let isExcluded = false;
    let exclusionReason: string | null = null;
    if (
      !isLoyaltyPurchaseLineEligible({
        policy: selectedPurchasePolicy,
        line,
      })
    ) {
      isExcluded = true;
      exclusionReason =
        classifyLoyaltyPurchaseLine(line).kind === "unknown"
          ? "subscription_classification_unknown"
          : "purchase_policy_ineligible";
    }
    if (
      !isExcluded &&
      selectedRule.excludeDiscountedItems &&
      line.shopDiscount &&
      line.shopDiscount > BigInt(0)
    ) {
      isExcluded = true;
      exclusionReason = "discounted_item";
    }
    const lineNetAmount =
      line.shopNet ?? line.shopGross ?? line.presentmentNet ?? BigInt(0);

    return {
      orderLineId: line.id,
      lineNetAmount,
      isExcluded,
      exclusionReason,
      productId: line.productId ?? null,
      variantId: line.variantId ?? null,
      lineExternalId: line.externalId ?? null,
      title: line.title ?? null,
      quantity: line.quantity ?? 1,
      sku: line.sku ?? null,
      collectionExternalIds: line.collectionExternalIds,
    };
  });
  const capturedLineNet = lineInputs.reduce(
    (sum, line) => sum + line.lineNetAmount,
    BigInt(0),
  );
  if (
    (capturedOrderNet > BigInt(0) || capturedLineNet > BigInt(0)) &&
    capturedLineNet !== capturedOrderNet
  ) {
    await retainOrderLineSnapshotIssue({
      reason:
        orderLines.length === 0
          ? "positive_order_missing_line_snapshots"
          : "order_line_net_does_not_match_order_net",
      capturedOrderNet,
      capturedLineNet,
    });
    // Do not consume the unique order-grant key. A repaired immutable line
    // snapshot can be replayed safely and close the reconciliation issue.
    return null;
  }
  if (reconciliationDelegate?.updateMany) {
    await reconciliationDelegate.updateMany({
      where: {
        storeId,
        kind: "loyalty_order_line_snapshot_unavailable",
        externalKey: legacyRecoveryIssueKey,
        status: "open",
      },
      data: { status: "resolved", resolvedAt: new Date() },
    });
  }

  const eligibleSubtotal =
    lineInputs.length > 0
      ? lineInputs
          .filter((l) => !l.isExcluded)
          .reduce((sum, l) => sum + l.lineNetAmount, BigInt(0))
      : capturedOrderNet;

  if (eligibleSubtotal <= BigInt(0)) {
    return persistNoAwardOutcome({
      reason: "non_positive_eligible_subtotal",
      eligibleSubtotal,
      selectedRuleId: selectedRule.id,
      selectedCampaignId: selectedCampaign?.id ?? null,
      ruleMultiplier: selectedRule.multiplier,
      campaignMultiplier: selectedCampaign?.multiplier,
    });
  }

  // Check rule minimum subtotal requirement
  if (selectedRule.minOrderSubtotal) {
    const minSubtotalMinor = decimalToMinorUnits(
      selectedRule.minOrderSubtotal.toString(),
      currency,
    );
    if (eligibleSubtotal < minSubtotalMinor) {
      return persistNoAwardOutcome({
        reason: "minimum_subtotal_not_met",
        eligibleSubtotal,
        selectedRuleId: selectedRule.id,
        selectedCampaignId: selectedCampaign?.id ?? null,
        ruleMultiplier: selectedRule.multiplier,
        campaignMultiplier: selectedCampaign?.multiplier,
      });
    }
  }

  // 6. Compute gross points using pure rational fractions
  const pointsPerCurrencyUnit = policyProgram.pointsPerCurrencyUnit;
  const ruleMultiplier = selectedRule.multiplier;
  const campaignMultiplier = selectedCampaign
    ? selectedCampaign.multiplier
    : new Prisma.Decimal(1.0);
  const targetedCalculation =
    selectedRule.ruleType === "fixed_points"
      ? null
      : calculateTargetedMultiplierOrderPoints({
          lines: lineInputs,
          currency,
          pointsPerCurrencyUnit,
          ruleMultiplier,
          tierMultiplier,
          campaign: selectedCampaign,
          maxPointsPerEvent: selectedRule.maxPointsPerEvent,
        });
  let grossPoints = targetedCalculation
    ? targetedCalculation.grossPoints
    : selectedRule.fixedPoints ?? BigInt(0);

  if (
    !targetedCalculation &&
    selectedRule.maxPointsPerEvent !== null &&
    selectedRule.maxPointsPerEvent !== undefined &&
    grossPoints > selectedRule.maxPointsPerEvent
  ) {
    grossPoints = selectedRule.maxPointsPerEvent;
  }

  if (grossPoints <= BigInt(0)) {
    return persistNoAwardOutcome({
      reason: "non_positive_points_calculation",
      eligibleSubtotal,
      selectedRuleId: selectedRule.id,
      selectedCampaignId: selectedCampaign?.id ?? null,
      ruleMultiplier,
      campaignMultiplier,
    });
  }

  // 7. Execute penny-conserving proportional allocation
  const lineAllocations =
    targetedCalculation?.lineAllocations ??
    allocatePointsAcrossOrderLines({ grossPoints, lines: lineInputs });

  // 8. Determine holding period lifecycle
  const holdingPeriodDays = policyProgram.holdingPeriodDays || 0;
  const isHoldingPeriodActive = holdingPeriodDays > 0;
  const grantStatus: WeleticLoyaltyEarnGrantStatus = isHoldingPeriodActive
    ? "pending"
    : "settled";

  const availableAt = new Date(
    occurredAt.getTime() + holdingPeriodDays * 24 * 60 * 60 * 1000,
  );
  const grantId = `wgrant_${nanoid(20)}`;

  const effectiveMulNum =
    targetedCalculation?.effectiveMultiplier ??
    Number(ruleMultiplier) *
      Number(campaignMultiplier) *
      Number(tierMultiplier);

  const priorQualifyingActivityAt = loyaltyAccount.lastQualifyingActivityAt;
  const qualifyingActivityAt =
    priorQualifyingActivityAt && priorQualifyingActivityAt > occurredAt
      ? priorQualifyingActivityAt
      : occurredAt;
  const nextExpiryDate = calculateNextPointsExpiryDate({
    // Expiry is an account-level operational clock. Use the current policy and
    // a monotonic activity timestamp rather than regressing it to a delayed
    // order's historical policy/event time.
    policy: program,
    lastActivityAt: qualifyingActivityAt,
    fallbackAt: qualifyingActivityAt,
  });

  // 9. Persist WeleticLoyaltyEarnGrant and WeleticLoyaltyOrderLineEarn records if tables exist
  const grant = await db.weleticLoyaltyEarnGrant.create({
    data: {
      id: grantId,
      storeId,
      programId: program.id,
      accountId: loyaltyAccount.id,
      shopperId: shopper.id,
      orderId: order.id,
      status: grantStatus,
      currency,
      eligibleSubtotalAmount: eligibleSubtotal,
      orderTotalAmount:
        order.shopTotal ?? order.presentmentTotal ?? eligibleSubtotal,
      grossPoints,
      pendingPoints: isHoldingPeriodActive ? grossPoints : BigInt(0),
      settledPoints: isHoldingPeriodActive ? BigInt(0) : grossPoints,
      reversedPoints: BigInt(0),
      availableAt,
      settledAt: isHoldingPeriodActive ? null : occurredAt,
      selectedRuleId: selectedRule.id,
      selectedCampaignId: selectedCampaign?.id ?? null,
      tierId: eventTierId,
      policyRevisionId: policyContext.revisionId,
      pointsPerCurrencyUnit,
      ruleMultiplier,
      campaignMultiplier,
      tierMultiplier,
      effectiveMultiplier: new Prisma.Decimal(effectiveMulNum),
      calculationSnapshot: {
        eligibleSubtotal: eligibleSubtotal.toString(),
        currency,
        grossPoints: grossPoints.toString(),
        policyRevision: policyRevisionSnapshot,
        holdingPeriodDays,
        pointsPerCurrencyUnit: pointsPerCurrencyUnit.toString(),
        ruleMultiplier: ruleMultiplier.toString(),
        purchasePolicy: selectedPurchasePolicy,
        campaignMultiplier: campaignMultiplier.toString(),
        campaignTargets: selectedCampaign
          ? {
              eligibleSkus: selectedCampaignTargets.eligibleSkus,
              eligibleCollectionIds:
                selectedCampaignTargets.eligibleCollectionIds,
            }
          : null,
        tierMultiplier: tierMultiplier.toString(),
        effectiveMultiplier: effectiveMulNum,
        lines: lineAllocations.map((l) => ({
          orderLineId: l.orderLineId,
          lineNetAmount: l.lineNetAmount.toString(),
          awardedPoints: l.awardedPoints.toString(),
          isExcluded: l.isExcluded,
          purchaseClassification: classifyLoyaltyPurchaseLine(
            orderLineById.get(l.orderLineId) ?? {},
          ),
          sku: l.sku ?? null,
          collectionExternalIds: l.collectionExternalIds ?? [],
          campaignMatched: l.campaignMatched ?? false,
          appliedCampaignMultiplier: l.appliedCampaignMultiplier ?? "1",
        })),
      },
    },
  });

  // Bulk create order line earns
  if (orderLines.length > 0) {
    const lineMap = new Map(orderLines.map((l) => [l.id, l]));
    await db.weleticLoyaltyOrderLineEarn.createMany({
      data: lineAllocations.map((alloc) => {
        const line = lineMap.get(alloc.orderLineId);
        return {
          id: `wlineearn_${nanoid(20)}`,
          grantId: grant.id,
          orderLineId: alloc.orderLineId,
          storeId,
          productId: line?.productId ?? null,
          variantId: line?.variantId ?? null,
          lineExternalId: line?.externalId ?? null,
          title: line?.title ?? null,
          quantity: line?.quantity ?? 1,
          lineNetAmount: alloc.lineNetAmount,
          awardedPoints: alloc.awardedPoints,
          reversedPoints: BigInt(0),
          isExcluded: alloc.isExcluded,
          exclusionReason: alloc.exclusionReason ?? null,
          metadata: {
            sku: alloc.sku ?? null,
            collectionExternalIds: alloc.collectionExternalIds ?? [],
            selectedCampaignId: selectedCampaign?.id ?? null,
            campaignMatched: alloc.campaignMatched ?? false,
            appliedCampaignMultiplier: alloc.appliedCampaignMultiplier ?? "1",
          },
        };
      }),
    });
  }

  // 10. Ledger / Outbox Integration
  if (isHoldingPeriodActive) {
    // Update account cachedPendingPoints and activity
    await db.weleticLoyaltyAccount.update({
      where: { id: loyaltyAccount.id },
      data: {
        cachedPendingPoints: { increment: grossPoints },
        lastQualifyingActivityAt: qualifyingActivityAt,
        nextExpiryDate,
        pointsExpiryPolicyVersion: program.pointsExpiryPolicyVersion,
        pointsExpiryJobsScheduledAt: null,
      },
    });

    // Enqueue HOLDING_PERIOD_RELEASE outbox job if outbox exists
    await enqueueOutboxJob({
      storeId,
      jobType: "HOLDING_PERIOD_RELEASE",
      payload: {
        orderId: order.id,
        accountId: loyaltyAccount.id,
        shopperId: shopper.id,
        pendingPoints: grossPoints.toString(),
        holdingPeriodDays,
        availableAt: availableAt.toISOString(),
        grantId: grant?.id || grantId,
        policyRevisionId: policyContext.revisionId,
        sourceOrderExternalId: order.externalId,
      },
      scheduledFor: availableAt,
      idempotencyKey: `holding_release:${order.id}`,
      loyaltyMaintenancePermit,
      tx,
    });

    // Amount-spent VIP milestones qualify when the paid order is recorded.
    // A second review is scheduled when held points mature for points-based VIP.
    await scheduleTierReviewAfterQualifyingActivity({
      storeId,
      accountId: loyaltyAccount.id,
      activityKey: `order_paid:${order.id}`,
      reason: "paid_order_recorded",
      loyaltyMaintenancePermit,
      tx,
    });

    await reconcilePersistedMerchandiseRefunds();
    return grant;
  } else {
    // Immediate maturity: append immutable ledger entry
    const idempotencyKey = `earn_order:${order.id}`;
    const ledgerEntry = await appendPointsLedgerEntry({
      storeId,
      accountId: loyaltyAccount.id,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      pointsDelta: grossPoints,
      grantId: grant?.id ?? null,
      referenceType: "COMMERCE_ORDER",
      referenceId: order.id,
      idempotencyKey,
      reason: `Points earned on order ${order.orderName || order.externalId}`,
      metadata: {
        grantId: grant?.id ?? null,
        orderId: order.id,
        orderName: order.orderName,
        eligibleSubtotal: eligibleSubtotal.toString(),
        currency,
        effectiveMultiplier: effectiveMulNum,
        selectedCampaignId: selectedCampaign?.id ?? null,
        campaignMultiplier: campaignMultiplier.toString(),
        policyRevisionId: policyContext.revisionId,
        policyRevisionVersion: policyContext.revisionVersion,
        policyRevisionFingerprint: policyContext.revisionFingerprint,
      },
      tx,
    });

    await enqueueFlowTriggerJob({
      storeId,
      eventId: ledgerEntry.id,
      payload: {
        accountId: loyaltyAccount.id,
        handle: "weletic-points-earned",
        pointsDelta: grossPoints.toString(),
        pointsBalance: ledgerEntry.balanceAfter.toString(),
        reason: "order_purchase",
        orderId: order.externalId,
      },
      loyaltyMaintenancePermit,
      tx,
    });

    // Enqueue Metafield sync if outbox exists
    await enqueueOutboxJob({
      storeId,
      jobType: "METAFIELD_SYNC",
      payload: {
        accountId: loyaltyAccount.id,
        triggerReason: "order_earn",
      },
      idempotencyKey: `metafield_sync:order:${order.id}`,
      loyaltyMaintenancePermit,
      tx,
    });

    await scheduleTierReviewAfterQualifyingActivity({
      storeId,
      accountId: loyaltyAccount.id,
      activityKey: `order_paid:${order.id}`,
      reason: "paid_order_points_earned",
      loyaltyMaintenancePermit,
      tx,
    });

    await reconcilePersistedMerchandiseRefunds();
    return ledgerEntry;
  }
}

// ============================================================================
// 6. Source-Based Refund Reversal with Snapshot Accounting
// ============================================================================

export async function processRefundPointsReversal({
  storeId,
  refundId,
  tx,
  privacyMinimized = false,
  allowSupplementalCorrection = false,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  refundId: string;
  tx?: Prisma.TransactionClient;
  privacyMinimized?: boolean;
  /**
   * Maintenance-only escape hatch for repairing a previously persisted
   * under-clawback after the deterministic target calculation changes. Normal
   * webhook replays keep the original immutable idempotency key and return it.
   */
  allowSupplementalCorrection?: boolean;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!tx) {
    return runFinancialTransaction((client) =>
      processRefundPointsReversal({
        storeId,
        refundId,
        tx: client,
        privacyMinimized,
        allowSupplementalCorrection,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      }),
    );
  }

  const db = tx;
  if (privacyMinimized) {
    const financialStore =
      await assertShopifyStoreMatchesInstallationGeneration({
        storeId,
        action: "refund_points_financial_settlement",
        expectedInstallationGeneration,
        tx,
      });
    if (financialStore?.complianceState === "active") {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId,
        action: "refund_points_financial_settlement",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
    }
  } else {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "refund_points_reversal",
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      tx,
    });
  }

  // 1. Fetch Refund with order, shopper, loyalty account, and refund lines
  const refund = await db.weleticCommerceRefund.findUnique({
    where: { id: refundId },
    include: {
      order: {
        include: {
          shopper: {
            include: {
              loyaltyAccount: {
                include: {
                  program: { select: { id: true, storeId: true } },
                },
              },
            },
          },
          refunds: {
            where: { storeId },
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              occurredAt: true,
              shopAmount: true,
              lines: {
                select: {
                  orderLineId: true,
                  shopAmount: true,
                  quantity: true,
                },
              },
            },
          },
        },
      },
      lines: true,
    },
  });

  if (!refund || !refund.order || !refund.order.shopper?.loyaltyAccount) {
    return null;
  }

  if (
    refund.storeId !== storeId ||
    refund.order.storeId !== storeId ||
    refund.order.shopper.storeId !== storeId ||
    refund.order.shopper.loyaltyAccount.storeId !== storeId
  ) {
    throw new Error(
      `Commerce refund ${refundId} has a cross-tenant loyalty relationship`,
    );
  }

  const loyaltyAccount = refund.order.shopper.loyaltyAccount;
  if (
    loyaltyAccount.program &&
    (loyaltyAccount.program.id !== loyaltyAccount.programId ||
      loyaltyAccount.program.storeId !== storeId)
  ) {
    throw new Error(
      `Loyalty account ${loyaltyAccount.id} references a cross-store program`,
    );
  }
  const privacyRedacted =
    privacyMinimized ||
    hasShopifyCustomerRedactionTombstone(loyaltyAccount.metadata);

  const existingReversal = await db.weleticPointsLedgerEntry.findUnique({
    where: {
      storeId_idempotencyKey: {
        storeId,
        idempotencyKey: `refund_reversal:${refund.id}`,
      },
    },
  });

  // 2. Fetch original WeleticLoyaltyEarnGrant and associated line earns
  const grant = await db.weleticLoyaltyEarnGrant.findUnique({
    where: {
      storeId_orderId: {
        storeId,
        orderId: refund.orderId,
      },
    },
    include: {
      lineEarns: true,
      program: { select: { id: true, storeId: true } },
    },
  });
  if (
    grant &&
    ((grant.storeId !== undefined && grant.storeId !== storeId) ||
      (grant.orderId !== undefined && grant.orderId !== refund.order.id) ||
      (grant.accountId !== undefined &&
        grant.accountId !== loyaltyAccount.id) ||
      (grant.shopperId !== undefined &&
        grant.shopperId !== refund.order.shopper.id) ||
      (grant.programId !== undefined &&
        loyaltyAccount.programId !== undefined &&
        grant.programId !== loyaltyAccount.programId) ||
      (grant.program &&
        (grant.program.id !== grant.programId ||
          grant.program.storeId !== storeId)))
  ) {
    throw new Error(
      `Loyalty earn grant ${grant.id} does not match refund ${refund.id}'s loyalty relationship`,
    );
  }
  if (grant) {
    let allocatedGrossPoints = BigInt(0);
    let allocatedReversedPoints = BigInt(0);
    for (const lineEarn of grant.lineEarns || []) {
      if (lineEarn.storeId !== storeId || lineEarn.grantId !== grant.id) {
        throw new Error(
          `Loyalty earn grant ${grant.id} has a cross-tenant line allocation`,
        );
      }

      const awardedPoints = BigInt(lineEarn.awardedPoints);
      const reversedPoints = BigInt(lineEarn.reversedPoints);
      if (
        awardedPoints < BigInt(0) ||
        reversedPoints < BigInt(0) ||
        reversedPoints > awardedPoints
      ) {
        throw new Error(
          `Line reversal invariant failed for loyalty earn grant ${grant.id}`,
        );
      }
      if (!lineEarn.isExcluded) {
        allocatedGrossPoints += awardedPoints;
        allocatedReversedPoints += reversedPoints;
      }
    }
    if (
      allocatedGrossPoints !== BigInt(grant.grossPoints) ||
      allocatedReversedPoints !== BigInt(grant.reversedPoints)
    ) {
      throw new Error(
        `Source allocation invariant failed for loyalty earn grant ${grant.id}`,
      );
    }
  }
  if (
    existingReversal &&
    ((existingReversal.accountId !== undefined &&
      existingReversal.accountId !== loyaltyAccount.id) ||
      (existingReversal.grantId !== undefined &&
        existingReversal.grantId !== null &&
        (!grant || existingReversal.grantId !== grant.id)))
  ) {
    throw new Error(
      `Refund reversal ${existingReversal.id} does not match refund ${refund.id}'s loyalty relationship`,
    );
  }

  // A short-lived legacy path could post a refund debit before the immutable
  // order earn grant existed. Once that source grant is available, adopt the
  // old reversal into its snapshots exactly once. A populated grantId is the
  // durable adoption marker; financial ledger columns remain unchanged.
  const grantCalculationSnapshot = grant?.calculationSnapshot as {
    outcome?: unknown;
  } | null;
  const isNoAwardGrant = Boolean(
    grant &&
      BigInt(grant.grossPoints) === BigInt(0) &&
      grantCalculationSnapshot?.outcome === "no_award",
  );
  const grantSupportsLegacyAdoption = Boolean(
    grant && (BigInt(grant.grossPoints) > BigInt(0) || isNoAwardGrant),
  );
  const currentReversalNeedsAdoption = Boolean(
    existingReversal &&
      existingReversal.grantId === null &&
      grantSupportsLegacyAdoption,
  );
  const persistedRefundIds = Array.from(
    new Set([
      refund.id,
      ...(refund.order.refunds || [])
        .map((orderRefund) => orderRefund.id)
        .filter((id): id is string => typeof id === "string"),
    ]),
  );
  const legacyReversalsToAdopt = grantSupportsLegacyAdoption
    ? (await db.weleticPointsLedgerEntry.findMany({
        where: {
          storeId,
          accountId: loyaltyAccount.id,
          grantId: null,
          entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
          idempotencyKey: {
            in: persistedRefundIds.map(
              (persistedRefundId) => `refund_reversal:${persistedRefundId}`,
            ),
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })) ?? []
    : [];
  if (
    currentReversalNeedsAdoption &&
    existingReversal &&
    !legacyReversalsToAdopt.some((entry) => entry.id === existingReversal.id)
  ) {
    legacyReversalsToAdopt.push(existingReversal);
  }
  for (const legacyReversal of legacyReversalsToAdopt) {
    const pointsDelta = BigInt(legacyReversal.pointsDelta ?? 0);
    const pendingDelta = BigInt(legacyReversal.pendingDelta ?? 0);
    const expectedIdempotencyKey =
      typeof legacyReversal.referenceId === "string"
        ? `refund_reversal:${legacyReversal.referenceId}`
        : null;
    if (
      legacyReversal.storeId !== storeId ||
      legacyReversal.accountId !== loyaltyAccount.id ||
      legacyReversal.grantId !== null ||
      legacyReversal.entryType !==
        WeleticPointsLedgerEntryType.REFUND_REVERSAL ||
      legacyReversal.referenceType !== "COMMERCE_REFUND" ||
      !legacyReversal.referenceId ||
      !persistedRefundIds.includes(legacyReversal.referenceId) ||
      legacyReversal.idempotencyKey !== expectedIdempotencyKey ||
      pointsDelta > BigInt(0) ||
      pendingDelta > BigInt(0) ||
      (pointsDelta === BigInt(0) && pendingDelta === BigInt(0))
    ) {
      throw new Error(
        `Legacy refund reversal ${legacyReversal.id} is not a trustworthy financial source`,
      );
    }
  }
  const isLegacyGrantAdoption = legacyReversalsToAdopt.length > 0;
  const legacyAdoptionFingerprint = isLegacyGrantAdoption
    ? fingerprintLegacyLedgerAdoption(legacyReversalsToAdopt)
    : null;
  const legacyPointsDelta = legacyReversalsToAdopt.reduce(
    (sum, legacyReversal) =>
      sum + BigInt(legacyReversal.pointsDelta ?? BigInt(0)),
    BigInt(0),
  );
  const legacyPendingDelta = legacyReversalsToAdopt.reduce(
    (sum, legacyReversal) =>
      sum + BigInt(legacyReversal.pendingDelta ?? BigInt(0)),
    BigInt(0),
  );
  const legacyNetDelta = legacyPointsDelta + legacyPendingDelta;
  const legacyHistoricalClawback =
    legacyNetDelta < BigInt(0) ? -legacyNetDelta : BigInt(0);
  if (
    existingReversal &&
    !allowSupplementalCorrection &&
    !isLegacyGrantAdoption
  ) {
    return existingReversal;
  }

  let totalPointsToClawback = BigInt(0);

  if (grant && BigInt(grant.grossPoints) > BigInt(0)) {
    const remainingGrantClawback =
      BigInt(grant.grossPoints) - BigInt(grant.reversedPoints ?? 0);
    if (remainingGrantClawback <= BigInt(0) && !isLegacyGrantAdoption) {
      return null;
    }

    const lineEarnMap = new Map(
      (grant.lineEarns || []).map((le: any) => [le.orderLineId, le]),
    );

    // Refund amounts are incremental events, but point rounding must be based
    // on the cumulative refunded amount. Otherwise many sub-half-point refunds
    // can permanently evade reversal. Loading every persisted refund also lets
    // a replay from the pre-ledger pending-refund implementation converge to
    // the already-applied target instead of clawing the same refund twice.
    const currentRefundRecord = {
      id: refund.id,
      occurredAt: refund.occurredAt,
      shopAmount: refund.shopAmount,
      lines: refund.lines || [],
    };
    const persistedOrderRefunds =
      Array.isArray(refund.order.refunds) && refund.order.refunds.length > 0
        ? refund.order.refunds
        : [currentRefundRecord];
    const summarizeRefunds = (orderRefunds: typeof persistedOrderRefunds) => {
      const refundedByLine = new Map<string, bigint>();
      const refundedQuantityByLine = new Map<string, bigint>();
      let orderRefundAmount = BigInt(0);
      for (const orderRefund of orderRefunds) {
        orderRefundAmount += BigInt(orderRefund.shopAmount ?? 0);
        for (const orderRefundLine of orderRefund.lines || []) {
          refundedByLine.set(
            orderRefundLine.orderLineId,
            (refundedByLine.get(orderRefundLine.orderLineId) ?? BigInt(0)) +
              BigInt(orderRefundLine.shopAmount ?? 0),
          );
          refundedQuantityByLine.set(
            orderRefundLine.orderLineId,
            (refundedQuantityByLine.get(orderRefundLine.orderLineId) ??
              BigInt(0)) + BigInt(orderRefundLine.quantity ?? 0),
          );
        }
      }
      return { refundedByLine, refundedQuantityByLine, orderRefundAmount };
    };
    const cumulativeRefunds = summarizeRefunds(persistedOrderRefunds);

    // A Shopify refund can contain more than one row for the same order line.
    // Calculate and mutate each line once so its reversed points can never
    // exceed the original line award because of duplicate rows.
    const currentRefundOrderLineIds = new Set(
      (isLegacyGrantAdoption
        ? persistedOrderRefunds.flatMap(
            (persistedRefund) => persistedRefund.lines || [],
          )
        : refund.lines || []
      ).map((refundLine: any) => refundLine.orderLineId),
    );
    let matchedKnownLine = false;

    // Exact proportional line-level clawbacks from snapshot
    for (const orderLineId of currentRefundOrderLineIds) {
      const lineEarn = lineEarnMap.get(orderLineId);
      if (!lineEarn) {
        continue;
      }
      matchedKnownLine = true;
      if (lineEarn.isExcluded) continue;

      const lineAwarded = BigInt(lineEarn.awardedPoints || 0);
      const lineReversed = BigInt(lineEarn.reversedPoints || 0);
      const lineNet = BigInt(lineEarn.lineNetAmount || 0);
      const lineQuantity = BigInt(lineEarn.quantity || 0);
      const cumulativeRefundAmount =
        cumulativeRefunds.refundedByLine.get(orderLineId) ?? BigInt(0);
      const cumulativeRefundQuantity =
        cumulativeRefunds.refundedQuantityByLine.get(orderLineId) ?? BigInt(0);

      if (lineAwarded <= BigInt(0)) {
        continue;
      }

      const maxLineClawback = lineAwarded - lineReversed;
      if (
        maxLineClawback <= BigInt(0) ||
        (cumulativeRefundAmount <= BigInt(0) &&
          cumulativeRefundQuantity <= BigInt(0))
      ) {
        continue;
      }

      let amountTarget = BigInt(0);
      if (lineNet > BigInt(0) && cumulativeRefundAmount > BigInt(0)) {
        const proportional = (cumulativeRefundAmount * lineAwarded) / lineNet;
        const remainder = (cumulativeRefundAmount * lineAwarded) % lineNet;
        amountTarget =
          remainder * BigInt(2) >= lineNet
            ? proportional + BigInt(1)
            : proportional;
      }

      // Shopify line refunds carry authoritative returned quantities. Use the
      // quantity target as a floor so a discounted full return cannot reverse
      // only the post-discount cash amount when earning used the captured
      // pre-discount eligible line value. The target still converges exactly
      // across split refunds and is capped at the original line award.
      let quantityTarget = BigInt(0);
      if (lineQuantity > BigInt(0) && cumulativeRefundQuantity > BigInt(0)) {
        const boundedRefundQuantity =
          cumulativeRefundQuantity < lineQuantity
            ? cumulativeRefundQuantity
            : lineQuantity;
        const proportional =
          (boundedRefundQuantity * lineAwarded) / lineQuantity;
        const remainder = (boundedRefundQuantity * lineAwarded) % lineQuantity;
        quantityTarget =
          remainder * BigInt(2) >= lineQuantity
            ? proportional + BigInt(1)
            : proportional;
      }

      const cumulativeTarget =
        quantityTarget > amountTarget ? quantityTarget : amountTarget;
      const boundedTarget =
        cumulativeTarget < lineAwarded ? cumulativeTarget : lineAwarded;
      let lineClawback = boundedTarget - lineReversed;
      if (lineClawback > maxLineClawback) {
        lineClawback = maxLineClawback;
      }
      const remainingOverall = remainingGrantClawback - totalPointsToClawback;
      if (lineClawback > remainingOverall) {
        lineClawback = remainingOverall;
      }

      if (lineClawback > BigInt(0)) {
        const lineClaim = await db.weleticLoyaltyOrderLineEarn.updateMany({
          where: {
            id: lineEarn.id,
            grantId: grant.id,
            storeId,
            reversedPoints: lineReversed,
          },
          data: {
            reversedPoints: lineReversed + lineClawback,
          },
        });
        if (lineClaim.count !== 1) {
          throw new OptimisticConcurrencyError(
            `Refund line conflict for ${lineEarn.id}`,
          );
        }
        totalPointsToClawback += lineClawback;
      }
    }

    // Fallback if no line match (order-level adjustment refund)
    if (!matchedKnownLine && cumulativeRefunds.orderRefundAmount > BigInt(0)) {
      const grantGross = BigInt(grant.grossPoints || 0);
      const grantReversed = BigInt(grant.reversedPoints || 0);
      const maxGrantClawback = grantGross - grantReversed;
      const subtotal =
        BigInt(grant.eligibleSubtotalAmount || 0) > BigInt(0)
          ? BigInt(grant.eligibleSubtotalAmount)
          : BigInt(grant.orderTotalAmount || 0);

      if (subtotal > BigInt(0) && maxGrantClawback > BigInt(0)) {
        const cumulativeTarget = isLegacyGrantAdoption
          ? legacyHistoricalClawback
          : (() => {
              const proportional =
                (cumulativeRefunds.orderRefundAmount * grantGross) / subtotal;
              const remainder =
                (cumulativeRefunds.orderRefundAmount * grantGross) % subtotal;
              return remainder * BigInt(2) >= subtotal
                ? proportional + BigInt(1)
                : proportional;
            })();
        const boundedTarget =
          cumulativeTarget < grantGross ? cumulativeTarget : grantGross;
        const incrementalClawback = boundedTarget - grantReversed;
        totalPointsToClawback =
          incrementalClawback > BigInt(0)
            ? incrementalClawback < maxGrantClawback
              ? incrementalClawback
              : maxGrantClawback
            : BigInt(0);
      }

      if (totalPointsToClawback > BigInt(0)) {
        const orderLevelAllocations = allocateReversalAcrossRemainingLines({
          grantId: grant.id,
          storeId,
          grossPoints: grantGross,
          alreadyReversedPoints: grantReversed,
          pointsToAllocate: totalPointsToClawback,
          lineEarns: grant.lineEarns || [],
        });

        // Order-level adjustments have no Shopify line attribution. Persist a
        // deterministic source allocation anyway so line and grant reversal
        // snapshots remain exactly conserved for later refunds/holding voids.
        for (const allocation of orderLevelAllocations) {
          const lineClaim = await db.weleticLoyaltyOrderLineEarn.updateMany({
            where: {
              id: allocation.id,
              grantId: grant.id,
              storeId,
              reversedPoints: allocation.reversedPoints,
            },
            data: {
              reversedPoints:
                allocation.reversedPoints + allocation.pointsToReverse,
            },
          });
          if (lineClaim.count !== 1) {
            throw new OptimisticConcurrencyError(
              `Order-level refund line conflict for ${allocation.id}`,
            );
          }
        }
      }
    }
  } else if (!isLegacyGrantAdoption) {
    // Mutable current rules cannot prove what a grantless historical order
    // earned. Fail closed instead of manufacturing a refund debit without an
    // immutable source snapshot.
    return existingReversal ?? null;
  }

  if (totalPointsToClawback <= BigInt(0) && !isLegacyGrantAdoption) {
    return null;
  }

  // 3. Dual-Bucket Reconciliation: void pending points before debiting
  // settled points. Every applied reversal claims one immutable ledger event,
  // including pending-only reversals whose available-balance delta is zero.
  // Keeping both deltas in the ledger makes duplicate webhook recovery
  // idempotent and makes pending mutations participate in account ledger OCC.
  const currentPending = BigInt(grant?.pendingPoints ?? 0);
  const currentSettled = BigInt(grant?.settledPoints ?? 0);
  const currentReversed = BigInt(grant?.reversedPoints ?? 0);
  const reversalTarget = currentReversed + totalPointsToClawback;
  const pendingVoided =
    grant && currentPending > BigInt(0)
      ? totalPointsToClawback < currentPending
        ? totalPointsToClawback
        : currentPending
      : BigInt(0);
  const settledClawback = totalPointsToClawback - pendingVoided;

  if (grant && totalPointsToClawback > BigInt(0)) {
    const newPending = currentPending - pendingVoided;
    const newSettled =
      currentSettled >= settledClawback
        ? currentSettled - settledClawback
        : BigInt(0);
    const newReversed = currentReversed + totalPointsToClawback;
    const fullyReversed = newReversed >= BigInt(grant.grossPoints);
    const fullyVoided = fullyReversed && currentSettled === BigInt(0);

    const grantClaim = await db.weleticLoyaltyEarnGrant.updateMany({
      where: {
        id: grant.id,
        storeId,
        status: grant.status,
        pendingPoints: currentPending,
        settledPoints: currentSettled,
        reversedPoints: currentReversed,
      },
      data: {
        pendingPoints: newPending,
        settledPoints: newSettled,
        reversedPoints: newReversed,
        voidedAt: fullyVoided ? new Date() : grant.voidedAt,
        status: fullyVoided
          ? "voided"
          : fullyReversed
            ? "reversed"
            : "partially_reversed",
      },
    });

    if (grantClaim.count !== 1) {
      throw new OptimisticConcurrencyError(
        `Refund grant conflict for loyalty earn grant ${grant.id}`,
      );
    }
  }

  // Link a historical grantless reversal to its immutable source. This is a
  // provenance-only CAS update: points, pending points, balances, sequence,
  // and every other financial fact in the original ledger entry stay fixed.
  if (isLegacyGrantAdoption && grant) {
    for (const legacyReversal of legacyReversalsToAdopt) {
      const adoptionClaim = await db.weleticPointsLedgerEntry.updateMany({
        where: {
          id: legacyReversal.id,
          storeId,
          accountId: loyaltyAccount.id,
          grantId: null,
        },
        data: { grantId: grant.id },
      });
      if (adoptionClaim.count !== 1) {
        throw new OptimisticConcurrencyError(
          `Legacy refund reversal adoption conflict for ${legacyReversal.id}`,
        );
      }
    }
  }

  // 4. Append one REFUND_REVERSAL ledger event for both balance buckets. A
  // legacy adoption posts only the difference between the historical account
  // effect and the immutable grant target, so it can never double-claw points.
  const ledgerPointsDelta = isLegacyGrantAdoption
    ? -settledClawback - legacyPointsDelta
    : -settledClawback;
  const ledgerPendingDelta = isLegacyGrantAdoption
    ? -pendingVoided - legacyPendingDelta
    : -pendingVoided;
  const needsLedgerCorrection =
    ledgerPointsDelta !== BigInt(0) || ledgerPendingDelta !== BigInt(0);
  type LedgerEntryResult = Awaited<ReturnType<typeof appendPointsLedgerEntry>>;
  let ledgerEntry: LedgerEntryResult | typeof existingReversal =
    existingReversal;
  if (!isLegacyGrantAdoption || needsLedgerCorrection) {
    ledgerEntry = await appendPointsLedgerEntry({
      storeId,
      accountId: loyaltyAccount.id,
      entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
      pointsDelta: ledgerPointsDelta,
      pendingDelta: ledgerPendingDelta,
      grantId: grant?.id ?? null,
      referenceType: "COMMERCE_REFUND",
      referenceId: refund.id,
      idempotencyKey: isLegacyGrantAdoption
        ? `refund_reversal:${refund.id}:adopt_grant:${grant?.id}:${legacyAdoptionFingerprint}`
        : existingReversal
          ? `refund_reversal:${refund.id}:correction:${reversalTarget}`
          : `refund_reversal:${refund.id}`,
      reason: privacyRedacted
        ? "Refund points adjustment after customer redaction."
        : `Points reversed on refund ${refund.externalId} for order ${refund.order.orderName || refund.order.externalId}`,
      metadata: privacyRedacted
        ? {
            privacyRedacted: true,
            ...(isLegacyGrantAdoption
              ? {
                  legacyGrantAdoption: true,
                  legacyGrantAdoptionCount: legacyReversalsToAdopt.length,
                  legacyAdoptionFingerprint,
                  legacyAdoptedLedgerEntryIds: legacyReversalsToAdopt
                    .map((entry) => entry.id)
                    .sort(),
                }
              : {}),
            totalClawback: totalPointsToClawback.toString(),
            settledClawback: settledClawback.toString(),
            pendingVoided: pendingVoided.toString(),
          }
        : {
            grantId: grant?.id ?? null,
            refundId: refund.id,
            orderId: refund.order.id,
            ...(isLegacyGrantAdoption
              ? {
                  legacyGrantAdoption: true,
                  legacyGrantAdoptionCount: legacyReversalsToAdopt.length,
                  legacyAdoptionFingerprint,
                  legacyAdoptedLedgerEntryIds: legacyReversalsToAdopt
                    .map((entry) => entry.id)
                    .sort(),
                }
              : {}),
            totalClawback: totalPointsToClawback.toString(),
            settledClawback: settledClawback.toString(),
            pendingVoided: pendingVoided.toString(),
          },
      tx: db,
    });
  }

  // 5. Enqueue Metafield Sync if outbox exists
  if (!privacyRedacted) {
    await enqueueOutboxJob({
      storeId,
      jobType: "METAFIELD_SYNC",
      payload: {
        accountId: loyaltyAccount.id,
        triggerReason: "refund_reversal",
      },
      idempotencyKey: isLegacyGrantAdoption
        ? `metafield_sync:refund:${refund.id}:adopt_grant:${grant?.id}:${legacyAdoptionFingerprint}`
        : existingReversal
          ? `metafield_sync:refund:${refund.id}:correction:${reversalTarget}`
          : `metafield_sync:refund:${refund.id}`,
      loyaltyMaintenancePermit,
      tx: db,
    });
    await scheduleTierReviewAfterQualifyingActivity({
      storeId,
      accountId: loyaltyAccount.id,
      activityKey: isLegacyGrantAdoption
        ? `refund:${refund.id}:${reversalTarget}:adopt_batch:${legacyAdoptionFingerprint}`
        : `refund:${refund.id}:${reversalTarget}`,
      reason: "order_refund_recorded",
      loyaltyMaintenancePermit,
      tx: db,
    });
  }

  return ledgerEntry;
}
