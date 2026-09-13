import { prisma } from "@/lib/prisma";
import {
  currencyMinorUnits,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  availableFinancialDataQuality,
  divideRationalUp,
  evaluateOrderCurrencyDataQuality,
  FinancialDataQuality,
  finiteCompatibilityNumber,
  formatMinorUnits,
  formatRationalDecimal,
  LiabilityValuation,
  rationalMoneyDecimal,
  valuePointsConservatively,
} from "./analytics-financial";
import { escapeCsvUntrustedTextCell } from "./csv";

export { escapeCsvCell, escapeCsvUntrustedTextCell } from "./csv";

export interface DateRange {
  startDate?: Date | string;
  endDate?: Date | string;
}

const LEDGER_ANALYTICS_CLASSIFICATIONS = {
  earned: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.EARN_ORDER,
    WeleticPointsLedgerEntryType.EARN_REFERRAL,
    WeleticPointsLedgerEntryType.EARN_BONUS,
    WeleticPointsLedgerEntryType.TIER_BONUS,
    WeleticPointsLedgerEntryType.BACKFILL,
  ]),
  redeemed: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.REDEEM_REWARD,
  ]),
  refunded: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.REFUND_REVERSAL,
  ]),
  expired: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.EXPIRATION,
  ]),
  backfill: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.BACKFILL,
  ]),
  backfillCorrection: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
  ]),
  manualAdjustment: new Set<WeleticPointsLedgerEntryType>([
    WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
  ]),
} as const;

export interface PointsLiabilityCalculationParams {
  storeId: string;
  currency?: string; // ISO 4217 currency code (e.g. "USD", "JPY", "VND"), defaults to "USD"
  valuationPerPointMinorUnits?: bigint | number; // Valuation per point in minor units (e.g. 1 cent = 1, ¥1 = 1)
  valuationPerPointMinor?: bigint | number; // Alias for valuationPerPointMinorUnits
  valuationPerPointMajor?: number; // Valuation in major currency units (e.g. 0.01 for USD, 1 for JPY)
  liabilityMinorUnitsNumerator?: bigint | number;
  liabilityPointsDenominator?: bigint | number;
  activeLookbackDays?: number; // Days window to consider a member active (default: 90)
  now?: Date; // Deterministic reference date for active/inactive evaluation
  tx?: Prisma.TransactionClient;
}

export interface PointsLiabilityResult {
  storeId: string;
  currency: string;
  isZeroDecimal: boolean;
  valuationPerPointMinorUnits: bigint | null;
  liabilityMinorUnitsNumerator: bigint;
  liabilityPointsDenominator: bigint;
  totalMembersCount: number;
  activeMembersCount: number;
  inactiveMembersCount: number;
  totalCirculatingPoints: bigint;
  totalPendingPoints: bigint;
  totalPotentialPoints: bigint;
  totalLiabilityMinorUnits: bigint;
  totalPendingLiabilityMinorUnits: bigint;
  totalPotentialLiabilityMinorUnits: bigint;
  totalLiabilityDecimal: string;
  totalPendingLiabilityDecimal: string;
  totalPotentialLiabilityDecimal: string;
  averagePointsPerMember: number;
  averageLiabilityPerMemberMinorUnits: bigint;
  negativeBalancePointsDebt: bigint;
  negativeBalanceAccountsCount: number;
  netCirculatingPoints: bigint;
}

// Backward-compatibility alias
export type PointsLiabilityReport = PointsLiabilityResult;

export interface LoyaltyHealthMetricsParams {
  storeId: string;
  currency?: string;
  dateRange?: DateRange;
  valuationPerPointMinorUnits?: bigint | number;
  valuationPerPointMinor?: bigint | number;
  valuationPerPointMajor?: number;
  liabilityMinorUnitsNumerator?: bigint | number;
  liabilityPointsDenominator?: bigint | number;
  activeLookbackDays?: number;
  now?: Date;
  tx?: Prisma.TransactionClient;
}

export interface ReferralEconomicsResult {
  totalReferrals: number;
  successfulReferrals: number;
  referralConversionRate: number; // e.g. 25.0%
  totalAdvocatePointsAwarded: bigint;
  totalRefereePointsAwarded: bigint;
  totalReferralPointsAwarded: bigint;
  referralRewardCostMinorUnits: bigint | null;
  referralRevenueMinorUnits: bigint | null;
  referralCACMinorUnits: bigint | null;
  referralCAC: number | null; // Compatibility number in major currency units
  referralCACDecimal: string | null;
  referralROI: number | null; // Compatibility net gain percentage
  referralROIDecimal: string | null;
  referralROIMultiplier: number | null;
  referralROIMultiplierDecimal: string | null;
  referralROIReason: string | null;
  dataQuality: FinancialDataQuality;
}

export interface ProgramHealthMetricsResult {
  storeId: string;
  currency: string;
  isZeroDecimal: boolean;
  dateRange?: {
    startDate?: Date;
    endDate?: Date;
  };
  totalMembers: number;
  activeMembers: number;
  inactiveMembers: number;
  participationRate: number; // e.g. 68.5%
  activeRate: number; // Alias for participationRate
  totalPointsEarned: bigint;
  totalPointsRedeemed: bigint;
  totalPointsRefundReversed: bigint;
  totalPointsExpired: bigint;
  totalPointsBackfilled: bigint;
  totalPointsBackfillCorrected: bigint;
  totalManualAdjustmentCredits: bigint;
  totalManualAdjustmentDebits: bigint;
  netManualAdjustmentPoints: bigint;
  netOutstandingPoints: bigint;
  redemptionRate: number; // e.g. 42.0%
  breakageRate: number; // e.g. 58.0%
  referralMetrics: ReferralEconomicsResult;
  // Flat top-level referral shortcuts for merchant convenience
  totalReferrals: number;
  successfulReferrals: number;
  referralConversionRate: number;
  referralRevenueMinorUnits: bigint | null;
  referralRewardCostMinorUnits: bigint | null;
  referralCAC: number | null;
  referralROI: number | null;
  financialDataQuality: FinancialDataQuality;
}

// Backward-compatibility alias
export type LoyaltyHealthMetricsReport = ProgramHealthMetricsResult;

export interface TierDistributionItem {
  assignment?: "configured" | "unassigned" | "unavailable";
  tierId: string;
  name: string;
  slug?: string | null;
  tierOrder: number;
  memberCount: number;
  percentageOfTotal: number;
  totalPointsBalance: bigint;
  totalRollingSpend: bigint;
}

export interface LoyaltyDashboardOverviewResult {
  storeId: string;
  currency: string;
  liability: PointsLiabilityResult;
  healthMetrics: ProgramHealthMetricsResult;
  tierDistribution: TierDistributionItem[];
  generatedAt: Date;
}

/**
 * Calculates monetary valuation and point liability for active, pending, and total circulating balances.
 * Strictly respects zero-decimal currency safety (JPY, VND, KRW) vs 2-decimal currencies (USD, EUR).
 */
export async function calculatePointsLiability(
  params: PointsLiabilityCalculationParams,
): Promise<PointsLiabilityResult> {
  const { storeId, activeLookbackDays = 90 } = params;

  const db = (params.tx || prisma) as any;
  const rawCurrency = params.currency || "USD";
  let normalizedCurrency = "USD";
  try {
    normalizedCurrency = normalizeCurrency(rawCurrency);
  } catch {
    normalizedCurrency = rawCurrency.trim().toUpperCase();
  }

  const digits = currencyMinorUnits(normalizedCurrency);
  const isZeroDecimal = digits === 0;

  // Legacy callers can still supply an integer-per-point value. Production
  // routes use the exact numerator/denominator pair persisted on the program.
  let liabilityMinorUnitsNumerator = BigInt(1);
  let liabilityPointsDenominator = BigInt(1);
  if (
    params.liabilityMinorUnitsNumerator !== undefined ||
    params.liabilityPointsDenominator !== undefined
  ) {
    if (
      params.liabilityMinorUnitsNumerator === undefined ||
      params.liabilityPointsDenominator === undefined
    ) {
      throw new Error(
        "Liability valuation requires both a minor-unit numerator and points denominator.",
      );
    }
    liabilityMinorUnitsNumerator = BigInt(params.liabilityMinorUnitsNumerator);
    liabilityPointsDenominator = BigInt(params.liabilityPointsDenominator);
  } else if (params.valuationPerPointMinorUnits !== undefined) {
    liabilityMinorUnitsNumerator = BigInt(params.valuationPerPointMinorUnits);
  } else if (params.valuationPerPointMinor !== undefined) {
    liabilityMinorUnitsNumerator = BigInt(params.valuationPerPointMinor);
  } else if (params.valuationPerPointMajor !== undefined) {
    const scaleFactor = 10 ** digits;
    liabilityMinorUnitsNumerator = BigInt(
      Math.round(params.valuationPerPointMajor * scaleFactor),
    );
  }

  if (
    liabilityMinorUnitsNumerator <= BigInt(0) ||
    liabilityPointsDenominator <= BigInt(0)
  ) {
    throw new Error(
      "Liability valuation numerator and denominator must be positive.",
    );
  }
  const valuation: LiabilityValuation = {
    currency: normalizedCurrency,
    minorUnitsNumerator: liabilityMinorUnitsNumerator,
    pointsDenominator: liabilityPointsDenominator,
  };

  const rawAccounts = await db.weleticLoyaltyAccount.findMany({
    where: { storeId },
    select: {
      cachedPointsBalance: true,
      cachedPendingPoints: true,
      status: true,
      updatedAt: true,
      lastQualifyingActivityAt: true,
    },
  });

  const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
  const totalMembersCount = accounts.length;
  let activeMembersCount = 0;
  let totalCirculatingPoints = BigInt(0);
  let totalPendingPoints = BigInt(0);
  let negativeBalancePointsDebt = BigInt(0);
  let negativeBalanceAccountsCount = 0;

  const referenceTime = params.now
    ? params.now instanceof Date
      ? params.now.getTime()
      : new Date(params.now).getTime()
    : Date.now();
  const activeThreshold = new Date(
    referenceTime - activeLookbackDays * 24 * 60 * 60 * 1000,
  );
  for (const acc of accounts) {
    const balance: bigint = acc.cachedPointsBalance
      ? typeof acc.cachedPointsBalance === "bigint"
        ? acc.cachedPointsBalance
        : BigInt(acc.cachedPointsBalance)
      : BigInt(0);

    const pending: bigint = acc.cachedPendingPoints
      ? typeof acc.cachedPendingPoints === "bigint"
        ? acc.cachedPendingPoints
        : BigInt(acc.cachedPendingPoints)
      : BigInt(0);

    if (balance > BigInt(0)) {
      totalCirculatingPoints += balance;
    } else if (balance < BigInt(0)) {
      negativeBalancePointsDebt += BigInt(0) - balance;
      negativeBalanceAccountsCount++;
    }

    if (pending > BigInt(0)) {
      totalPendingPoints += pending;
    }

    const lastActivity = acc.lastQualifyingActivityAt ?? acc.updatedAt;
    const isAccountActive =
      (!acc.status || acc.status === "active") &&
      lastActivity &&
      new Date(lastActivity) >= activeThreshold;

    if (isAccountActive) {
      activeMembersCount++;
    }
  }

  const inactiveMembersCount = Math.max(
    0,
    totalMembersCount - activeMembersCount,
  );
  const netCirculatingPoints =
    totalCirculatingPoints - negativeBalancePointsDebt;
  const totalPotentialPoints = totalCirculatingPoints + totalPendingPoints;

  // Round up once per report aggregate. Per-account rounding would materially
  // overstate liability for ratios such as ¥1 per 100 points.
  const totalLiabilityMinorUnits = valuePointsConservatively(
    totalCirculatingPoints,
    valuation,
  );
  const totalPendingLiabilityMinorUnits = valuePointsConservatively(
    totalPendingPoints,
    valuation,
  );
  const totalPotentialLiabilityMinorUnits = valuePointsConservatively(
    totalPotentialPoints,
    valuation,
  );

  const totalLiabilityDecimal = minorUnitsToDecimal(
    totalLiabilityMinorUnits,
    normalizedCurrency,
  );
  const totalPendingLiabilityDecimal = minorUnitsToDecimal(
    totalPendingLiabilityMinorUnits,
    normalizedCurrency,
  );
  const totalPotentialLiabilityDecimal = minorUnitsToDecimal(
    totalPotentialLiabilityMinorUnits,
    normalizedCurrency,
  );

  const averagePointsPerMember =
    totalMembersCount > 0
      ? Number(totalCirculatingPoints) / totalMembersCount
      : 0;

  const averageLiabilityPerMemberMinorUnits =
    totalMembersCount > 0
      ? totalLiabilityMinorUnits / BigInt(totalMembersCount)
      : BigInt(0);

  return {
    storeId,
    currency: normalizedCurrency,
    isZeroDecimal,
    valuationPerPointMinorUnits:
      liabilityPointsDenominator === BigInt(1)
        ? liabilityMinorUnitsNumerator
        : null,
    liabilityMinorUnitsNumerator,
    liabilityPointsDenominator,
    totalMembersCount,
    activeMembersCount,
    inactiveMembersCount,
    totalCirculatingPoints,
    totalPendingPoints,
    totalPotentialPoints,
    totalLiabilityMinorUnits,
    totalPendingLiabilityMinorUnits,
    totalPotentialLiabilityMinorUnits,
    totalLiabilityDecimal,
    totalPendingLiabilityDecimal,
    totalPotentialLiabilityDecimal,
    averagePointsPerMember,
    averageLiabilityPerMemberMinorUnits,
    negativeBalancePointsDebt,
    negativeBalanceAccountsCount,
    netCirculatingPoints,
  };
}

/**
 * Pure calculation helper for referral customer acquisition cost (CAC) and return on investment (ROI).
 */
export function calculateReferralEconomics(params: {
  totalReferrals: number;
  successfulReferrals: number;
  totalRewardPoints: bigint | number;
  revenueMinorUnits: bigint | number;
  currency?: string;
  valuationPerPointMinorUnits?: bigint | number;
  liabilityMinorUnitsNumerator?: bigint | number;
  liabilityPointsDenominator?: bigint | number;
  dataQuality?: FinancialDataQuality;
}): ReferralEconomicsResult {
  const { totalReferrals, successfulReferrals, currency = "USD" } = params;

  let normalizedCurrency = "USD";
  try {
    normalizedCurrency = normalizeCurrency(currency);
  } catch {
    normalizedCurrency = currency.trim().toUpperCase();
  }

  const liabilityMinorUnitsNumerator = BigInt(
    params.liabilityMinorUnitsNumerator ??
      params.valuationPerPointMinorUnits ??
      1,
  );
  const liabilityPointsDenominator = BigInt(
    params.liabilityPointsDenominator ?? 1,
  );
  const totalRewardPointsBigInt = BigInt(params.totalRewardPoints);
  const revenueMinorBigInt = BigInt(params.revenueMinorUnits);
  const dataQuality =
    params.dataQuality ?? availableFinancialDataQuality(normalizedCurrency);

  if (
    liabilityMinorUnitsNumerator <= BigInt(0) ||
    liabilityPointsDenominator <= BigInt(0)
  ) {
    throw new Error(
      "Referral valuation requires positive numerator and denominator values.",
    );
  }
  if (totalRewardPointsBigInt < BigInt(0) || revenueMinorBigInt < BigInt(0)) {
    throw new Error(
      "Referral points and attributed revenue cannot be negative.",
    );
  }

  const referralConversionRate =
    totalReferrals > 0
      ? Math.round((successfulReferrals / totalReferrals) * 1000) / 10
      : 0;
  if (dataQuality.status !== "available") {
    return {
      totalReferrals,
      successfulReferrals,
      referralConversionRate,
      totalAdvocatePointsAwarded: totalRewardPointsBigInt,
      totalRefereePointsAwarded: BigInt(0),
      totalReferralPointsAwarded: totalRewardPointsBigInt,
      referralRewardCostMinorUnits: null,
      referralRevenueMinorUnits: null,
      referralCACMinorUnits: null,
      referralCAC: null,
      referralCACDecimal: null,
      referralROI: null,
      referralROIDecimal: null,
      referralROIMultiplier: null,
      referralROIMultiplierDecimal: null,
      referralROIReason:
        dataQuality.reason || "Referral financial data quality failed.",
      dataQuality,
    };
  }

  const referralRewardCostNumerator =
    totalRewardPointsBigInt * liabilityMinorUnitsNumerator;
  const referralRewardCostMinorUnits = valuePointsConservatively(
    totalRewardPointsBigInt,
    {
      currency: normalizedCurrency,
      minorUnitsNumerator: liabilityMinorUnitsNumerator,
      pointsDenominator: liabilityPointsDenominator,
    },
  );
  const referralCACMinorUnits =
    successfulReferrals > 0
      ? divideRationalUp(
          referralRewardCostNumerator,
          liabilityPointsDenominator * BigInt(successfulReferrals),
        )
      : null;

  const referralCACDecimal =
    successfulReferrals > 0
      ? rationalMoneyDecimal({
          numeratorMinorUnits: referralRewardCostNumerator,
          denominator: liabilityPointsDenominator * BigInt(successfulReferrals),
          currency: normalizedCurrency,
        })
      : null;
  const referralCAC = referralCACDecimal
    ? finiteCompatibilityNumber(
        formatMinorUnits(
          referralCACMinorUnits ?? BigInt(0),
          normalizedCurrency,
        ),
      )
    : null;

  let referralROIDecimal: string | null = null;
  let referralROIMultiplierDecimal: string | null = null;
  let referralROIReason: string | null = null;

  if (referralRewardCostNumerator > BigInt(0)) {
    referralROIDecimal = formatRationalDecimal({
      numerator:
        (revenueMinorBigInt * liabilityPointsDenominator -
          referralRewardCostNumerator) *
        BigInt(100),
      denominator: referralRewardCostNumerator,
    });
    referralROIMultiplierDecimal = formatRationalDecimal({
      numerator: revenueMinorBigInt * liabilityPointsDenominator,
      denominator: referralRewardCostNumerator,
    });
  } else {
    referralROIReason =
      "Referral ROI is undefined because the exact referral reward cost is zero.";
  }

  const referralROIValue = referralROIDecimal
    ? finiteCompatibilityNumber(referralROIDecimal)
    : null;
  const referralROI =
    referralROIValue === null ? null : Math.round(referralROIValue * 10) / 10;
  const referralROIMultiplierValue = referralROIMultiplierDecimal
    ? finiteCompatibilityNumber(referralROIMultiplierDecimal)
    : null;
  const referralROIMultiplier =
    referralROIMultiplierValue === null
      ? null
      : Math.round(referralROIMultiplierValue * 100) / 100;

  return {
    totalReferrals,
    successfulReferrals,
    referralConversionRate,
    totalAdvocatePointsAwarded: totalRewardPointsBigInt,
    totalRefereePointsAwarded: BigInt(0),
    totalReferralPointsAwarded: totalRewardPointsBigInt,
    referralRewardCostMinorUnits,
    referralRevenueMinorUnits: revenueMinorBigInt,
    referralCACMinorUnits,
    referralCAC,
    referralCACDecimal,
    referralROI,
    referralROIDecimal,
    referralROIMultiplier,
    referralROIMultiplierDecimal,
    referralROIReason,
    dataQuality,
  };
}

/**
 * Calculates program health, participation velocity, redemption & breakage rates, and referral CAC & ROI.
 * Supports date range filtering and zero-division safety across all metrics.
 */
export async function getLoyaltyProgramHealthMetrics(
  paramsOrStoreId: string | LoyaltyHealthMetricsParams,
  options?: Partial<LoyaltyHealthMetricsParams>,
): Promise<ProgramHealthMetricsResult> {
  const storeId =
    typeof paramsOrStoreId === "string"
      ? paramsOrStoreId
      : paramsOrStoreId.storeId;

  const config =
    typeof paramsOrStoreId === "object"
      ? { ...paramsOrStoreId, ...options }
      : { storeId, ...(options || {}) };

  const { activeLookbackDays = 90, dateRange } = config;

  const db = (config.tx || prisma) as any;
  const rawCurrency = config.currency || "USD";
  let normalizedCurrency = "USD";
  try {
    normalizedCurrency = normalizeCurrency(rawCurrency);
  } catch {
    normalizedCurrency = rawCurrency.trim().toUpperCase();
  }

  const digits = currencyMinorUnits(normalizedCurrency);
  const isZeroDecimal = digits === 0;

  let liabilityMinorUnitsNumerator = BigInt(1);
  let liabilityPointsDenominator = BigInt(1);
  if (
    config.liabilityMinorUnitsNumerator !== undefined ||
    config.liabilityPointsDenominator !== undefined
  ) {
    if (
      config.liabilityMinorUnitsNumerator === undefined ||
      config.liabilityPointsDenominator === undefined
    ) {
      throw new Error(
        "Liability valuation requires both a minor-unit numerator and points denominator.",
      );
    }
    liabilityMinorUnitsNumerator = BigInt(config.liabilityMinorUnitsNumerator);
    liabilityPointsDenominator = BigInt(config.liabilityPointsDenominator);
  } else if (config.valuationPerPointMinorUnits !== undefined) {
    liabilityMinorUnitsNumerator = BigInt(config.valuationPerPointMinorUnits);
  } else if (config.valuationPerPointMinor !== undefined) {
    liabilityMinorUnitsNumerator = BigInt(config.valuationPerPointMinor);
  } else if (config.valuationPerPointMajor !== undefined) {
    const scaleFactor = 10 ** digits;
    liabilityMinorUnitsNumerator = BigInt(
      Math.round(config.valuationPerPointMajor * scaleFactor),
    );
  }

  if (
    liabilityMinorUnitsNumerator <= BigInt(0) ||
    liabilityPointsDenominator <= BigInt(0)
  ) {
    throw new Error(
      "Liability valuation numerator and denominator must be positive.",
    );
  }

  const startDate = dateRange?.startDate
    ? new Date(dateRange.startDate)
    : undefined;
  const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : undefined;

  // 1. Query accounts
  const accounts = await db.weleticLoyaltyAccount.findMany({
    where: { storeId },
    select: {
      cachedPointsBalance: true,
      status: true,
      updatedAt: true,
      createdAt: true,
      lastQualifyingActivityAt: true,
    },
  });

  const totalMembers = accounts.length;
  const referenceTime = config.now
    ? config.now instanceof Date
      ? config.now.getTime()
      : new Date(config.now).getTime()
    : Date.now();
  const activeThreshold = new Date(
    referenceTime - activeLookbackDays * 24 * 60 * 60 * 1000,
  );

  let activeMembers = 0;
  for (const acc of accounts) {
    const lastActivity = acc.lastQualifyingActivityAt ?? acc.updatedAt;
    const isAccountActive =
      (!acc.status || acc.status === "active") &&
      lastActivity &&
      new Date(lastActivity) >= activeThreshold;

    if (isAccountActive) {
      activeMembers++;
    }
  }

  const inactiveMembers = Math.max(0, totalMembers - activeMembers);
  const participationRate =
    totalMembers > 0 ? (activeMembers / totalMembers) * 100 : 0;

  // 2. Query ledger entries
  const ledgerWhere: any = { storeId };
  if (startDate || endDate) {
    ledgerWhere.createdAt = {};
    if (startDate) ledgerWhere.createdAt.gte = startDate;
    if (endDate) ledgerWhere.createdAt.lte = endDate;
  }

  const ledgerEntries = await db.weleticPointsLedgerEntry.findMany({
    where: ledgerWhere,
    select: {
      pointsDelta: true,
      entryType: true,
    },
  });

  let totalEarned = BigInt(0);
  let totalRedeemed = BigInt(0);
  let totalRefundReversed = BigInt(0);
  let totalExpired = BigInt(0);
  let totalBackfilled = BigInt(0);
  let totalBackfillCorrected = BigInt(0);
  let totalManualAdjustmentCredits = BigInt(0);
  let totalManualAdjustmentDebits = BigInt(0);

  for (const entry of ledgerEntries) {
    const delta: bigint = entry.pointsDelta
      ? typeof entry.pointsDelta === "bigint"
        ? entry.pointsDelta
        : BigInt(entry.pointsDelta)
      : BigInt(0);

    const type = entry.entryType;

    if (
      delta > BigInt(0) &&
      LEDGER_ANALYTICS_CLASSIFICATIONS.earned.has(type)
    ) {
      totalEarned += delta;
    }
    if (
      delta > BigInt(0) &&
      LEDGER_ANALYTICS_CLASSIFICATIONS.backfill.has(type)
    ) {
      totalBackfilled += delta;
    }
    if (
      delta < BigInt(0) &&
      LEDGER_ANALYTICS_CLASSIFICATIONS.redeemed.has(type)
    ) {
      totalRedeemed += -delta;
    }
    if (
      delta < BigInt(0) &&
      LEDGER_ANALYTICS_CLASSIFICATIONS.refunded.has(type)
    ) {
      totalRefundReversed += -delta;
    }
    if (
      delta < BigInt(0) &&
      LEDGER_ANALYTICS_CLASSIFICATIONS.expired.has(type)
    ) {
      totalExpired += -delta;
    }
    if (
      delta < BigInt(0) &&
      LEDGER_ANALYTICS_CLASSIFICATIONS.backfillCorrection.has(type)
    ) {
      totalBackfillCorrected += -delta;
    }
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.manualAdjustment.has(type)) {
      if (delta > BigInt(0)) totalManualAdjustmentCredits += delta;
      if (delta < BigInt(0)) totalManualAdjustmentDebits += -delta;
    }
  }

  const redemptionRate =
    totalEarned > BigInt(0)
      ? finiteCompatibilityNumber(
          formatRationalDecimal({
            numerator: totalRedeemed * BigInt(100),
            denominator: totalEarned,
            fractionDigits: 1,
          }),
        ) ?? 0
      : 0;

  const breakageRate = Math.max(0, 100 - redemptionRate);
  const netOutstandingPoints =
    totalEarned -
    totalRedeemed -
    totalRefundReversed -
    totalExpired -
    totalBackfillCorrected +
    totalManualAdjustmentCredits -
    totalManualAdjustmentDebits;

  // 3. Query referrals and referral economics
  const referralWhere: any = { storeId };
  if (startDate || endDate) {
    referralWhere.createdAt = {};
    if (startDate) referralWhere.createdAt.gte = startDate;
    if (endDate) referralWhere.createdAt.lte = endDate;
  }
  const referrals = await db.weleticLoyaltyReferral.findMany({
    where: referralWhere,
    select: {
      id: true,
      status: true,
      advocatePointsAwarded: true,
      refereePointsAwarded: true,
      qualifyingOrderId: true,
    },
  });

  const totalReferrals = referrals.length;
  const successfulReferrals = referrals.filter(
    (r) => r.status === "rewarded" || r.status === "qualified",
  ).length;

  let totalAdvocatePointsAwarded = BigInt(0);
  let totalRefereePointsAwarded = BigInt(0);
  const qualifyingOrderIds = new Set<string>();

  for (const ref of referrals) {
    if (ref.advocatePointsAwarded) {
      totalAdvocatePointsAwarded +=
        typeof ref.advocatePointsAwarded === "bigint"
          ? ref.advocatePointsAwarded
          : BigInt(ref.advocatePointsAwarded);
    }
    if (ref.refereePointsAwarded) {
      totalRefereePointsAwarded +=
        typeof ref.refereePointsAwarded === "bigint"
          ? ref.refereePointsAwarded
          : BigInt(ref.refereePointsAwarded);
    }
    if (ref.status === "rewarded" || ref.status === "qualified") {
      if (ref.qualifyingOrderId) {
        qualifyingOrderIds.add(ref.qualifyingOrderId);
      }
    }
  }

  const totalReferralPointsAwarded =
    totalAdvocatePointsAwarded + totalRefereePointsAwarded;
  let referralRevenueMinorUnits = BigInt(0);
  let referralOrders: Array<{
    id: string;
    accountingCurrency?: string | null;
    accountingNet?: bigint | number | null;
  }> = [];
  if (qualifyingOrderIds.size > 0) {
    referralOrders = await db.weleticCommerceOrder.findMany({
      where: {
        id: { in: [...qualifyingOrderIds] },
        storeId,
      },
      select: {
        id: true,
        accountingCurrency: true,
        accountingNet: true,
      },
    });

    referralRevenueMinorUnits = referralOrders.reduce((sum, ord) => {
      const amt = ord.accountingNet ?? BigInt(0);
      return sum + (typeof amt === "bigint" ? amt : BigInt(amt));
    }, BigInt(0));
  }

  const currencyDataQuality = evaluateOrderCurrencyDataQuality(
    referralOrders,
    normalizedCurrency,
  );
  const persistedReferralOrderIds = new Set(
    referralOrders.map((order) => order.id),
  );
  const missingOrderCount = referrals.filter(
    (ref) =>
      (ref.status === "rewarded" || ref.status === "qualified") &&
      (!ref.qualifyingOrderId ||
        !persistedReferralOrderIds.has(ref.qualifyingOrderId)),
  ).length;
  const financialDataQuality: FinancialDataQuality =
    missingOrderCount > 0
      ? {
          ...currencyDataQuality,
          status: "data_quality_error",
          reason: [
            `${missingOrderCount} qualifying referral order(s) are missing.`,
            currencyDataQuality.reason,
          ]
            .filter(Boolean)
            .join(" "),
          missingOrderCount,
        }
      : currencyDataQuality;
  const calculatedReferralMetrics = calculateReferralEconomics({
    totalReferrals,
    successfulReferrals,
    totalRewardPoints: totalReferralPointsAwarded,
    revenueMinorUnits: referralRevenueMinorUnits,
    currency: normalizedCurrency,
    liabilityMinorUnitsNumerator,
    liabilityPointsDenominator,
    dataQuality: financialDataQuality,
  });
  const referralMetrics: ReferralEconomicsResult = {
    ...calculatedReferralMetrics,
    totalAdvocatePointsAwarded,
    totalRefereePointsAwarded,
    ...(financialDataQuality.status === "available"
      ? {}
      : {
          referralRewardCostMinorUnits: null,
          referralRevenueMinorUnits: null,
          referralCACMinorUnits: null,
          referralCAC: null,
          referralCACDecimal: null,
          referralROI: null,
          referralROIDecimal: null,
          referralROIMultiplier: null,
          referralROIMultiplierDecimal: null,
          referralROIReason: financialDataQuality.reason,
        }),
  };

  const roundedParticipation = Math.round(participationRate * 10) / 10;
  const roundedRedemption = Math.round(redemptionRate * 10) / 10;
  const roundedBreakage = Math.round(breakageRate * 10) / 10;

  return {
    storeId,
    currency: normalizedCurrency,
    isZeroDecimal,
    dateRange: startDate || endDate ? { startDate, endDate } : undefined,
    totalMembers,
    activeMembers,
    inactiveMembers,
    participationRate: roundedParticipation,
    activeRate: roundedParticipation,
    totalPointsEarned: totalEarned,
    totalPointsRedeemed: totalRedeemed,
    totalPointsRefundReversed: totalRefundReversed,
    totalPointsExpired: totalExpired,
    totalPointsBackfilled: totalBackfilled,
    totalPointsBackfillCorrected: totalBackfillCorrected,
    totalManualAdjustmentCredits,
    totalManualAdjustmentDebits,
    netManualAdjustmentPoints:
      totalManualAdjustmentCredits - totalManualAdjustmentDebits,
    netOutstandingPoints,
    redemptionRate: roundedRedemption,
    breakageRate: roundedBreakage,
    referralMetrics,
    totalReferrals,
    successfulReferrals,
    referralConversionRate: referralMetrics.referralConversionRate,
    referralRevenueMinorUnits: referralMetrics.referralRevenueMinorUnits,
    referralRewardCostMinorUnits: referralMetrics.referralRewardCostMinorUnits,
    referralCAC: referralMetrics.referralCAC,
    referralROI: referralMetrics.referralROI,
    financialDataQuality,
  };
}

/**
 * Returns member distribution across VIP tiers with points balances and rolling spend.
 */
export async function getLoyaltyTierDistribution(params: {
  storeId: string;
  tx?: Prisma.TransactionClient;
}): Promise<TierDistributionItem[]> {
  const { storeId } = params;
  const db = (params.tx || prisma) as any;

  // 1. Fetch loyalty program with tiers
  if (!db.weleticLoyaltyProgram?.findUnique) {
    return [];
  }

  const program = await db.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    include: {
      tiers: {
        where: { deletedAt: null },
        orderBy: { tierOrder: "asc" },
      },
    },
  });

  let tiers = program?.tiers || [];
  if (program && tiers.length === 0) {
    tiers = await db.weleticLoyaltyTier.findMany({
      where: { programId: program.id, deletedAt: null },
      orderBy: { tierOrder: "asc" },
    });
  }

  // 2. Fetch all accounts for the store
  const accounts = await db.weleticLoyaltyAccount.findMany({
    where: { storeId },
    select: {
      id: true,
      currentTierId: true,
      cachedPointsBalance: true,
      tierSpendRolling12Months: true,
    },
  });

  const totalMembers = accounts.length;

  // 3. Group accounts by tier
  const tierStatsMap = new Map<
    string,
    { count: number; points: bigint; spend: bigint }
  >();

  for (const tier of tiers) {
    tierStatsMap.set(tier.id, {
      count: 0,
      points: BigInt(0),
      spend: BigInt(0),
    });
  }

  const configuredTierIds = new Set(tiers.map((tier: any) => tier.id));
  const unassignedKey = "__analytics_unassigned__";
  const unavailableKey = "__analytics_unavailable__";

  for (const acc of accounts) {
    // Report persisted assignments; never infer tier enrollment from order.
    const tierId = !acc.currentTierId
      ? unassignedKey
      : configuredTierIds.has(acc.currentTierId)
        ? acc.currentTierId
        : unavailableKey;
    if (!tierStatsMap.has(tierId)) {
      tierStatsMap.set(tierId, {
        count: 0,
        points: BigInt(0),
        spend: BigInt(0),
      });
    }

    const stat = tierStatsMap.get(tierId)!;
    stat.count += 1;

    const points: bigint = acc.cachedPointsBalance
      ? typeof acc.cachedPointsBalance === "bigint"
        ? acc.cachedPointsBalance
        : BigInt(acc.cachedPointsBalance)
      : BigInt(0);

    const spend: bigint = acc.tierSpendRolling12Months
      ? typeof acc.tierSpendRolling12Months === "bigint"
        ? acc.tierSpendRolling12Months
        : BigInt(acc.tierSpendRolling12Months)
      : BigInt(0);

    if (points > BigInt(0)) {
      stat.points += points;
    }
    stat.spend += spend;
  }

  const reportingTiers = [
    ...tiers.map((tier: any) => ({
      ...tier,
      assignment: "configured" as const,
    })),
    ...(tierStatsMap.has(unassignedKey)
      ? [
          {
            id: unassignedKey,
            name: "Unassigned",
            slug: null,
            tierOrder: 0,
            assignment: "unassigned" as const,
          },
        ]
      : []),
    ...(tierStatsMap.has(unavailableKey)
      ? [
          {
            id: unavailableKey,
            name: "Unavailable tier",
            slug: null,
            tierOrder: 0,
            assignment: "unavailable" as const,
          },
        ]
      : []),
  ];
  return reportingTiers.map((tier: any) => {
    const stat = tierStatsMap.get(tier.id) || {
      count: 0,
      points: BigInt(0),
      spend: BigInt(0),
    };

    const percentageOfTotal =
      totalMembers > 0
        ? Math.round((stat.count / totalMembers) * 1000) / 10
        : 0;

    return {
      assignment: tier.assignment,
      tierId: tier.id,
      name: tier.name,
      slug: tier.slug,
      tierOrder: tier.tierOrder ?? 1,
      memberCount: stat.count,
      percentageOfTotal,
      totalPointsBalance: stat.points,
      totalRollingSpend: stat.spend,
    };
  });
}

/**
 * Returns a complete unified overview for the Merchant Admin Loyalty Dashboard.
 */
export async function getLoyaltyDashboardOverview(params: {
  storeId: string;
  currency?: string;
  valuationPerPointMinorUnits?: bigint | number;
  liabilityMinorUnitsNumerator?: bigint | number;
  liabilityPointsDenominator?: bigint | number;
  dateRange?: DateRange;
  now?: Date;
  tx?: Prisma.TransactionClient;
}): Promise<LoyaltyDashboardOverviewResult> {
  const { storeId, currency = "USD", tx, now } = params;

  const [liability, healthMetrics, tierDistribution] = await Promise.all([
    calculatePointsLiability({
      storeId,
      currency,
      valuationPerPointMinorUnits: params.valuationPerPointMinorUnits,
      liabilityMinorUnitsNumerator: params.liabilityMinorUnitsNumerator,
      liabilityPointsDenominator: params.liabilityPointsDenominator,
      now,
      tx,
    }),
    getLoyaltyProgramHealthMetrics({
      storeId,
      currency,
      valuationPerPointMinorUnits: params.valuationPerPointMinorUnits,
      liabilityMinorUnitsNumerator: params.liabilityMinorUnitsNumerator,
      liabilityPointsDenominator: params.liabilityPointsDenominator,
      dateRange: params.dateRange,
      now,
      tx,
    }),
    getLoyaltyTierDistribution({
      storeId,
      tx,
    }),
  ]);

  return {
    storeId,
    currency: liability.currency,
    liability,
    healthMetrics,
    tierDistribution,
    generatedAt: now ? new Date(now) : new Date(),
  };
}

// ============================================================================
// Member Cohort Attribution Engine (AOV, Repeat Purchase Rate, LTV)
// ============================================================================

export interface CohortMetrics {
  cohortName: "members" | "non_members";
  customerCount: number; // Unique customers who purchased in cohort
  totalOrders: number;
  totalSpendMinorUnits: bigint | null;
  totalSpendDecimal: string | null;
  aovMinorUnits: bigint | null;
  aovDecimal: string | null;
  repeatPurchaserCount: number; // Customers with >= 2 orders
  repeatPurchaseRate: number; // (repeatPurchasers / customerCount) * 100
  ltvMinorUnits: bigint | null; // totalSpendMinorUnits / customerCount
  ltvDecimal: string | null;
}

export interface CohortLiftComparison {
  aovLiftPercentage: number | null; // ((memberAov - nonMemberAov) / nonMemberAov) * 100
  repeatPurchaseRateLiftPercentage: number; // memberRepeatRate - nonMemberRepeatRate
  ltvLiftPercentage: number | null; // ((memberLtv - nonMemberLtv) / nonMemberLtv) * 100
}

export interface MemberCohortAttributionResult {
  storeId: string;
  currency: string;
  isZeroDecimal: boolean;
  dateRange?: { startDate?: Date; endDate?: Date };
  members: CohortMetrics;
  nonMembers: CohortMetrics;
  lift: CohortLiftComparison;
  dataQuality: FinancialDataQuality;
  generatedAt: Date;
}

export interface MemberCohortAttributionParams {
  storeId: string;
  currency?: string;
  dateRange?: DateRange;
  now?: Date;
  tx?: Prisma.TransactionClient;
}

export interface RawOrderForCohort {
  id?: string;
  shopperId?: string | null;
  customerIdentifier?: string | null;
  externalId?: string | null;
  totalMinorUnits?: bigint | number;
  accountingCurrency?: string | null;
  accountingTotal?: bigint | number | null;
  accountingNet?: bigint | number | null;
  presentmentTotal?: bigint | number;
  presentmentNet?: bigint | number;
  shopTotal?: bigint | number;
  shopNet?: bigint | number;
  amountMinorUnits?: bigint | number;
  status?: string | null;
  occurredAt?: Date | string | null;
}

function getOrderAmountMinorUnits(order: RawOrderForCohort): bigint {
  const raw =
    order.accountingTotal ??
    order.totalMinorUnits ??
    order.amountMinorUnits ??
    order.presentmentTotal ??
    order.shopTotal ??
    order.presentmentNet ??
    order.shopNet ??
    BigInt(0);

  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") return BigInt(Math.round(raw));
  return BigInt(0);
}

function computeSingleCohortMetrics(
  cohortName: "members" | "non_members",
  orders: RawOrderForCohort[],
  currency: string,
): CohortMetrics {
  const totalOrders = orders.length;
  const customerOrderCounts = new Map<string, number>();
  let totalSpendMinorUnits = BigInt(0);

  for (const order of orders) {
    const customerKey =
      order.shopperId ||
      order.customerIdentifier ||
      order.externalId ||
      order.id ||
      "unknown";

    customerOrderCounts.set(
      customerKey,
      (customerOrderCounts.get(customerKey) || 0) + 1,
    );
    totalSpendMinorUnits += getOrderAmountMinorUnits(order);
  }

  const customerCount = customerOrderCounts.size;
  let repeatPurchaserCount = 0;
  for (const count of customerOrderCounts.values()) {
    if (count >= 2) {
      repeatPurchaserCount++;
    }
  }

  const aovMinorUnits =
    totalOrders > 0 ? totalSpendMinorUnits / BigInt(totalOrders) : BigInt(0);

  const repeatPurchaseRate =
    customerCount > 0
      ? Math.round((repeatPurchaserCount / customerCount) * 1000) / 10
      : 0;

  const ltvMinorUnits =
    customerCount > 0
      ? totalSpendMinorUnits / BigInt(customerCount)
      : BigInt(0);

  return {
    cohortName,
    customerCount,
    totalOrders,
    totalSpendMinorUnits,
    totalSpendDecimal: minorUnitsToDecimal(totalSpendMinorUnits, currency),
    aovMinorUnits,
    aovDecimal:
      totalOrders > 0
        ? rationalMoneyDecimal({
            numeratorMinorUnits: totalSpendMinorUnits,
            denominator: BigInt(totalOrders),
            currency,
          })
        : minorUnitsToDecimal(BigInt(0), currency),
    repeatPurchaserCount,
    repeatPurchaseRate,
    ltvMinorUnits,
    ltvDecimal:
      customerCount > 0
        ? rationalMoneyDecimal({
            numeratorMinorUnits: totalSpendMinorUnits,
            denominator: BigInt(customerCount),
            currency,
          })
        : minorUnitsToDecimal(BigInt(0), currency),
  };
}

function calculateRelativeLiftPercentage(input: {
  subjectTotal: bigint;
  subjectCount: number;
  baselineTotal: bigint;
  baselineCount: number;
}): number | null {
  const { subjectTotal, subjectCount, baselineTotal, baselineCount } = input;
  // A missing cohort or nonpositive comparison average has no meaningful
  // relative lift. Observed zero spend is distinct from no observations.
  if (baselineCount <= 0 || baselineTotal <= BigInt(0) || subjectCount <= 0)
    return null;
  return (
    finiteCompatibilityNumber(
      formatRationalDecimal({
        numerator:
          (subjectTotal * BigInt(baselineCount) -
            baselineTotal * BigInt(subjectCount)) *
          BigInt(100),
        denominator: baselineTotal * BigInt(subjectCount),
        fractionDigits: 1,
      }),
    ) ?? 0
  );
}

/**
 * Pure calculation helper for member vs non-member cohort attribution metrics.
 */
export function calculateCohortMetricsPure(
  orders: RawOrderForCohort[],
  memberShopperIds: Set<string> | string[] | Record<string, boolean>,
  currency = "USD",
): {
  members: CohortMetrics;
  nonMembers: CohortMetrics;
  lift: CohortLiftComparison;
} {
  let normalizedCurrency = "USD";
  try {
    normalizedCurrency = normalizeCurrency(currency);
  } catch {
    normalizedCurrency = currency.trim().toUpperCase();
  }

  let memberSet: Set<string>;
  if (memberShopperIds instanceof Set) {
    memberSet = memberShopperIds;
  } else if (Array.isArray(memberShopperIds)) {
    memberSet = new Set(memberShopperIds);
  } else if (
    typeof memberShopperIds === "object" &&
    memberShopperIds !== null
  ) {
    memberSet = new Set(
      Object.keys(memberShopperIds).filter((k) => (memberShopperIds as any)[k]),
    );
  } else {
    memberSet = new Set();
  }

  const memberOrders: RawOrderForCohort[] = [];
  const nonMemberOrders: RawOrderForCohort[] = [];

  for (const order of orders) {
    if (order.status === "voided" || order.status === "cancelled") {
      continue;
    }

    const shopperId = order.shopperId;
    const customerIdentifier = order.customerIdentifier;
    const externalId = order.externalId;
    const id = order.id;

    const isMember =
      (shopperId && memberSet.has(shopperId)) ||
      (customerIdentifier && memberSet.has(customerIdentifier)) ||
      (externalId && memberSet.has(externalId)) ||
      (id && memberSet.has(id));

    if (isMember) {
      memberOrders.push(order);
    } else {
      nonMemberOrders.push(order);
    }
  }

  const members = computeSingleCohortMetrics(
    "members",
    memberOrders,
    normalizedCurrency,
  );
  const nonMembers = computeSingleCohortMetrics(
    "non_members",
    nonMemberOrders,
    normalizedCurrency,
  );
  const memberSpend = members.totalSpendMinorUnits ?? BigInt(0);
  const nonMemberSpend = nonMembers.totalSpendMinorUnits ?? BigInt(0);
  const aovLiftPercentage = calculateRelativeLiftPercentage({
    subjectTotal: memberSpend,
    subjectCount: members.totalOrders,
    baselineTotal: nonMemberSpend,
    baselineCount: nonMembers.totalOrders,
  });

  const repeatPurchaseRateLiftPercentage =
    Math.round(
      (members.repeatPurchaseRate - nonMembers.repeatPurchaseRate) * 10,
    ) / 10;

  const ltvLiftPercentage = calculateRelativeLiftPercentage({
    subjectTotal: memberSpend,
    subjectCount: members.customerCount,
    baselineTotal: nonMemberSpend,
    baselineCount: nonMembers.customerCount,
  });

  return {
    members,
    nonMembers,
    lift: {
      aovLiftPercentage,
      repeatPurchaseRateLiftPercentage,
      ltvLiftPercentage,
    },
  };
}

/**
 * Calculates member vs non-member cohort attribution by querying accounts and orders from the database.
 */
export async function calculateMemberCohortAttribution(
  params: MemberCohortAttributionParams,
): Promise<MemberCohortAttributionResult> {
  const { storeId } = params;
  const db = (params.tx || prisma) as any;
  const rawCurrency = params.currency || "USD";
  let normalizedCurrency = "USD";
  try {
    normalizedCurrency = normalizeCurrency(rawCurrency);
  } catch {
    normalizedCurrency = rawCurrency.trim().toUpperCase();
  }

  const digits = currencyMinorUnits(normalizedCurrency);
  const isZeroDecimal = digits === 0;

  const startDate = params.dateRange?.startDate
    ? new Date(params.dateRange.startDate)
    : undefined;
  const endDate = params.dateRange?.endDate
    ? new Date(params.dateRange.endDate)
    : undefined;

  // 1. Query member accounts
  const rawAccounts = await db.weleticLoyaltyAccount.findMany({
    where: { storeId },
    select: { shopperId: true },
  });
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
  const memberShopperIds = new Set<string>(
    accounts.map((a: any) => a.shopperId).filter(Boolean),
  );

  // 2. Query commerce orders
  const orderWhere: any = {
    storeId,
    status: { not: "voided" },
  };
  if (startDate || endDate) {
    orderWhere.occurredAt = {};
    if (startDate) orderWhere.occurredAt.gte = startDate;
    if (endDate) orderWhere.occurredAt.lte = endDate;
  }

  const rawOrders = await db.weleticCommerceOrder.findMany({
    where: orderWhere,
    select: {
      id: true,
      shopperId: true,
      externalId: true,
      accountingCurrency: true,
      accountingTotal: true,
      accountingNet: true,
      status: true,
      occurredAt: true,
    },
  });

  const orders = Array.isArray(rawOrders) ? rawOrders : [];

  const pureMetrics = calculateCohortMetricsPure(
    orders,
    memberShopperIds,
    normalizedCurrency,
  );
  const dataQuality = evaluateOrderCurrencyDataQuality(
    orders,
    normalizedCurrency,
  );

  if (dataQuality.status !== "available") {
    const withoutMoney = (metrics: CohortMetrics): CohortMetrics => ({
      ...metrics,
      totalSpendMinorUnits: null,
      totalSpendDecimal: null,
      aovMinorUnits: null,
      aovDecimal: null,
      ltvMinorUnits: null,
      ltvDecimal: null,
    });
    pureMetrics.members = withoutMoney(pureMetrics.members);
    pureMetrics.nonMembers = withoutMoney(pureMetrics.nonMembers);
    pureMetrics.lift.aovLiftPercentage = null;
    pureMetrics.lift.ltvLiftPercentage = null;
  }

  return {
    storeId,
    currency: normalizedCurrency,
    isZeroDecimal,
    dateRange: startDate || endDate ? { startDate, endDate } : undefined,
    members: pureMetrics.members,
    nonMembers: pureMetrics.nonMembers,
    lift: pureMetrics.lift,
    dataQuality,
    generatedAt: params.now ? new Date(params.now) : new Date(),
  };
}

// ============================================================================
// Zero-PII Cryptographic Anonymizer & Owner-Only Export Engine
// ============================================================================

/**
 * Scans any customer identity (email, phone, name, shopper ID) and creates a deterministic
 * cryptographic SHA-256 pseudonym (e.g. anon_6b86b273ff34fce1), ensuring zero PII in exports.
 */
export function scrubPiiToCryptographicDigest(identity: string): string {
  if (!identity || typeof identity !== "string") {
    return "anon_0000000000000000";
  }
  const clean = identity.toLowerCase().trim();
  const digest = createHash("sha256").update(clean).digest("hex");
  return `anon_${digest.slice(0, 16)}`;
}

export interface LoyaltyMetricsExportParams {
  storeId: string;
  currency?: string;
  valuationPerPointMinorUnits?: bigint | number;
  valuationPerPointMinor?: bigint | number;
  valuationPerPointMajor?: number;
  liabilityMinorUnitsNumerator?: bigint | number;
  liabilityPointsDenominator?: bigint | number;
  dateRange?: DateRange;
  callerRole?: string; // Required to be "owner"
  includeCohorts?: boolean; // Defaults to true
  includeTiers?: boolean; // Defaults to true
  includeMembersSample?: boolean; // Defaults to false
  sampleMembersLimit?: number; // Defaults to 50
  now?: Date;
  tx?: Prisma.TransactionClient;
}

export interface LoyaltyMetricsJsonExportResult {
  storeId: string;
  currency: string;
  isZeroDecimal: boolean;
  generatedAt: string;
  callerRole: "owner";
  liability: PointsLiabilityResult;
  healthMetrics: ProgramHealthMetricsResult;
  cohortAttribution?: MemberCohortAttributionResult;
  tierDistribution?: TierDistributionItem[];
  membersSample?: Array<{
    anonymousIdentifier: string;
    pointsBalance: string;
    pendingPoints: string;
    status: string;
  }>;
}

function recursivelySerializeBigInts(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(recursivelySerializeBigInts);
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const result: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "toJSON") continue;
      result[k] = recursivelySerializeBigInts(v);
    }
    return result;
  }
  return value;
}

/**
 * Exports loyalty metrics in JSON format with strict owner-only RBAC check,
 * cryptographic zero-PII anonymization, and automatic BigInt JSON serialization safety.
 */
export async function exportLoyaltyMetricsJson(
  params: LoyaltyMetricsExportParams,
): Promise<LoyaltyMetricsJsonExportResult> {
  if (params.callerRole !== "owner") {
    throw new Error(
      `Unauthorized: Only store owners can export loyalty financial and performance metrics. Caller role "${params.callerRole ?? "none"}" is forbidden.`,
    );
  }

  const { storeId, currency = "USD", tx, now } = params;
  const db = (tx || prisma) as any;

  const [liability, healthMetrics] = await Promise.all([
    calculatePointsLiability({
      storeId,
      currency,
      valuationPerPointMinorUnits: params.valuationPerPointMinorUnits,
      valuationPerPointMinor: params.valuationPerPointMinor,
      valuationPerPointMajor: params.valuationPerPointMajor,
      liabilityMinorUnitsNumerator: params.liabilityMinorUnitsNumerator,
      liabilityPointsDenominator: params.liabilityPointsDenominator,
      now,
      tx,
    }),
    getLoyaltyProgramHealthMetrics({
      storeId,
      currency,
      valuationPerPointMinorUnits: params.valuationPerPointMinorUnits,
      valuationPerPointMinor: params.valuationPerPointMinor,
      valuationPerPointMajor: params.valuationPerPointMajor,
      liabilityMinorUnitsNumerator: params.liabilityMinorUnitsNumerator,
      liabilityPointsDenominator: params.liabilityPointsDenominator,
      dateRange: params.dateRange,
      now,
      tx,
    }),
  ]);

  let tierDistribution: TierDistributionItem[] | undefined = undefined;
  if (params.includeTiers !== false) {
    tierDistribution = await getLoyaltyTierDistribution({ storeId, tx });
  }

  let cohortAttribution: MemberCohortAttributionResult | undefined = undefined;
  if (params.includeCohorts !== false) {
    cohortAttribution = await calculateMemberCohortAttribution({
      storeId,
      currency,
      dateRange: params.dateRange,
      now,
      tx,
    });
  }

  let membersSample:
    | Array<{
        anonymousIdentifier: string;
        pointsBalance: string;
        pendingPoints: string;
        status: string;
      }>
    | undefined = undefined;

  if (params.includeMembersSample) {
    const rawSample = await db.weleticLoyaltyAccount.findMany({
      where: { storeId },
      take: params.sampleMembersLimit || 50,
      select: {
        id: true,
        shopperId: true,
        cachedPointsBalance: true,
        cachedPendingPoints: true,
        status: true,
      },
    });
    const sampleList = Array.isArray(rawSample) ? rawSample : [];
    membersSample = sampleList.map((acc: any) => ({
      anonymousIdentifier: scrubPiiToCryptographicDigest(
        acc.shopperId || acc.id,
      ),
      pointsBalance: String(acc.cachedPointsBalance ?? 0),
      pendingPoints: String(acc.cachedPendingPoints ?? 0),
      status: String(acc.status || "active"),
    }));
  }

  const exportResult: LoyaltyMetricsJsonExportResult = {
    storeId,
    currency: liability.currency,
    isZeroDecimal: liability.isZeroDecimal,
    generatedAt: (now || new Date()).toISOString(),
    callerRole: "owner",
    liability,
    healthMetrics,
    cohortAttribution,
    tierDistribution,
    membersSample,
  };

  Object.defineProperty(exportResult, "toJSON", {
    value: function () {
      return recursivelySerializeBigInts(this);
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return exportResult;
}

/**
 * Exports loyalty metrics in CSV format with strict owner-only RBAC check,
 * spreadsheet formula injection defense (via escapeCsvUntrustedTextCell), and zero-PII cryptographic hashing.
 */
export async function exportLoyaltyMetricsCsv(
  params: LoyaltyMetricsExportParams,
  preparedResult?: LoyaltyMetricsJsonExportResult,
): Promise<string> {
  if (params.callerRole !== "owner") {
    throw new Error(
      `Unauthorized: Only store owners can export loyalty financial and performance metrics. Caller role "${params.callerRole ?? "none"}" is forbidden.`,
    );
  }

  const jsonResult = preparedResult ?? (await exportLoyaltyMetricsJson(params));
  const {
    storeId,
    currency,
    generatedAt,
    liability,
    healthMetrics,
    cohortAttribution,
    tierDistribution,
    membersSample,
  } = jsonResult;

  const rows: string[] = [];

  // Section 1: Overview Metadata
  rows.push(
    ["Section", "Property", "Value"].map(escapeCsvUntrustedTextCell).join(","),
  );
  rows.push(
    ["Metadata", "Store ID", storeId].map(escapeCsvUntrustedTextCell).join(","),
  );
  rows.push(
    ["Metadata", "Currency", currency]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    ["Metadata", "Exported At", generatedAt]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    ["Metadata", "Caller Role", "owner"]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push("");

  // Section 2: Points Liability & Financial Solvency
  rows.push(
    ["Section", "Liability Metric", "Value", "Unit"]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    ["Liability", "Total Members", String(liability.totalMembersCount), "count"]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Active Members",
      String(liability.activeMembersCount),
      "count",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Inactive Members",
      String(liability.inactiveMembersCount),
      "count",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Total Circulating Points",
      liability.totalCirculatingPoints.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Total Pending Points",
      liability.totalPendingPoints.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Total Potential Points",
      liability.totalPotentialPoints.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Negative Balance Debt Points",
      liability.negativeBalancePointsDebt.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Negative Balance Accounts Count",
      String(liability.negativeBalanceAccountsCount),
      "count",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Net Circulating Points",
      liability.netCirculatingPoints.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Total Financial Liability",
      liability.totalLiabilityDecimal,
      currency,
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Total Pending Liability",
      liability.totalPendingLiabilityDecimal,
      currency,
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Liability",
      "Total Potential Liability",
      liability.totalPotentialLiabilityDecimal,
      currency,
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push("");

  // Section 3: Program Health, Redemption Velocity & Breakage Rates
  rows.push(
    ["Section", "Health Metric", "Value", "Unit"]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Participation Rate",
      `${healthMetrics.participationRate}%`,
      "percentage",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Redemption Rate",
      `${healthMetrics.redemptionRate}%`,
      "percentage",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    ["Health", "Breakage Rate", `${healthMetrics.breakageRate}%`, "percentage"]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Total Points Earned",
      healthMetrics.totalPointsEarned.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Total Points Redeemed",
      healthMetrics.totalPointsRedeemed.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Total Points Refund Reversed",
      healthMetrics.totalPointsRefundReversed.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Total Points Expired",
      healthMetrics.totalPointsExpired.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Health",
      "Net Outstanding Points",
      healthMetrics.netOutstandingPoints.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push("");

  // Section 4: Referral Economics & Marketing ROI
  rows.push(
    ["Section", "Referral Metric", "Value", "Unit"]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Total Referrals",
      String(healthMetrics.referralMetrics.totalReferrals),
      "count",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Successful Referrals",
      String(healthMetrics.referralMetrics.successfulReferrals),
      "count",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Conversion Rate",
      `${healthMetrics.referralMetrics.referralConversionRate}%`,
      "percentage",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Advocate Points Awarded",
      healthMetrics.referralMetrics.totalAdvocatePointsAwarded.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Referee Points Awarded",
      healthMetrics.referralMetrics.totalRefereePointsAwarded.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Total Reward Points Awarded",
      healthMetrics.referralMetrics.totalReferralPointsAwarded.toString(),
      "points",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Referral Reward Cost",
      healthMetrics.referralMetrics.referralRewardCostMinorUnits === null
        ? "unavailable"
        : minorUnitsToDecimal(
            healthMetrics.referralMetrics.referralRewardCostMinorUnits,
            currency,
          ),
      currency,
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Referral Attributed Revenue",
      healthMetrics.referralMetrics.referralRevenueMinorUnits === null
        ? "unavailable"
        : minorUnitsToDecimal(
            healthMetrics.referralMetrics.referralRevenueMinorUnits,
            currency,
          ),
      currency,
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Customer Acquisition Cost (CAC)",
      healthMetrics.referralMetrics.referralCACDecimal ?? "unavailable",
      currency,
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Referral Marketing ROI",
      healthMetrics.referralMetrics.referralROIDecimal === null
        ? "unavailable"
        : `${healthMetrics.referralMetrics.referralROIDecimal}%`,
      "percentage",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push(
    [
      "Referrals",
      "Revenue Multiplier",
      healthMetrics.referralMetrics.referralROIMultiplierDecimal === null
        ? "unavailable"
        : `${healthMetrics.referralMetrics.referralROIMultiplierDecimal}x`,
      "multiplier",
    ]
      .map(escapeCsvUntrustedTextCell)
      .join(","),
  );
  rows.push("");

  // Section 5: Member Cohort Attribution (if includeCohorts !== false)
  if (cohortAttribution) {
    rows.push(
      [
        "Section",
        "Cohort",
        "Customer Count",
        "Total Orders",
        "Total Spend",
        "AOV",
        "Repeat Purchasers",
        "Repeat Purchase Rate",
        "LTV",
      ]
        .map(escapeCsvUntrustedTextCell)
        .join(","),
    );
    rows.push(
      [
        "Cohort Attribution",
        "Members",
        String(cohortAttribution.members.customerCount),
        String(cohortAttribution.members.totalOrders),
        cohortAttribution.members.totalSpendDecimal,
        cohortAttribution.members.aovDecimal,
        String(cohortAttribution.members.repeatPurchaserCount),
        `${cohortAttribution.members.repeatPurchaseRate}%`,
        cohortAttribution.members.ltvDecimal,
      ]
        .map(escapeCsvUntrustedTextCell)
        .join(","),
    );
    rows.push(
      [
        "Cohort Attribution",
        "Non-Members",
        String(cohortAttribution.nonMembers.customerCount),
        String(cohortAttribution.nonMembers.totalOrders),
        cohortAttribution.nonMembers.totalSpendDecimal,
        cohortAttribution.nonMembers.aovDecimal,
        String(cohortAttribution.nonMembers.repeatPurchaserCount),
        `${cohortAttribution.nonMembers.repeatPurchaseRate}%`,
        cohortAttribution.nonMembers.ltvDecimal,
      ]
        .map(escapeCsvUntrustedTextCell)
        .join(","),
    );
    rows.push(
      [
        "Cohort Lift",
        "Lift %",
        "-",
        "-",
        "-",
        cohortAttribution.lift.aovLiftPercentage === null
          ? ""
          : `${cohortAttribution.lift.aovLiftPercentage}%`,
        "-",
        `${cohortAttribution.lift.repeatPurchaseRateLiftPercentage}%`,
        cohortAttribution.lift.ltvLiftPercentage === null
          ? ""
          : `${cohortAttribution.lift.ltvLiftPercentage}%`,
      ]
        .map(escapeCsvUntrustedTextCell)
        .join(","),
    );
    rows.push("");
  }

  // Section 6: Tier Distribution (if includeTiers !== false && tierDistribution)
  if (tierDistribution && tierDistribution.length > 0) {
    rows.push(
      [
        "Section",
        "Tier Order",
        "Tier Name",
        "Member Count",
        "Percentage of Total",
        "Total Points Balance",
        "Total Rolling Spend",
      ]
        .map(escapeCsvUntrustedTextCell)
        .join(","),
    );
    for (const tier of tierDistribution) {
      rows.push(
        [
          "Tier Distribution",
          String(tier.tierOrder),
          tier.name,
          String(tier.memberCount),
          `${tier.percentageOfTotal}%`,
          tier.totalPointsBalance.toString(),
          minorUnitsToDecimal(tier.totalRollingSpend, currency),
        ]
          .map(escapeCsvUntrustedTextCell)
          .join(","),
      );
    }
    rows.push("");
  }

  // Section 7: Anonymized Sample Members (if includeMembersSample)
  if (membersSample && membersSample.length > 0) {
    rows.push(
      [
        "Section",
        "Cryptographic Anonymized ID",
        "Status",
        "Points Balance",
        "Pending Points",
      ]
        .map(escapeCsvUntrustedTextCell)
        .join(","),
    );
    for (const member of membersSample) {
      rows.push(
        [
          "Sample Members",
          member.anonymousIdentifier,
          member.status,
          member.pointsBalance,
          member.pendingPoints,
        ]
          .map(escapeCsvUntrustedTextCell)
          .join(","),
      );
    }
  }

  return rows.join("\r\n");
}
