import { prisma } from "@/lib/prisma";
import {
  calculateMemberCohortAttribution,
  calculatePointsLiability,
  calculateReferralEconomics,
  getLoyaltyProgramHealthMetrics,
} from "@/lib/weletic/loyalty/analytics";
import {
  divideRationalUp,
  resolveLoyaltyFinancialConfiguration,
} from "@/lib/weletic/loyalty/analytics-financial";
import { Prisma } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type ValidationExecutionMode = "dry-run" | "live-admin";

export interface ValidationCheckResult {
  name: string;
  passed: boolean;
  details?: Record<string, unknown>;
  error?: string;
}

export interface LoyaltyAnalyticsValidationReport {
  version: 2;
  timestamp: string;
  storeId: string | null;
  storeDomain: string | null;
  executionMode: ValidationExecutionMode;
  overallStatus: "PASSED" | "FAILED";
  provenance: {
    source: "persisted-database";
    productionServicesInvoked: boolean;
    prismaTransactionBoundary: boolean;
    independentSqlReconciliation: boolean;
  };
  checks: ValidationCheckResult[];
}

export interface ValidationCLIOptions {
  storeDomain?: string;
  storeId?: string;
  dryRun?: boolean;
  live?: boolean;
  json?: boolean;
  outputReportPath?: string;
  confirmStaging?: boolean;
  mock?: boolean;
}

type SqlInteger = bigint | number | string | Prisma.Decimal | null;

function toBigInt(value: SqlInteger | undefined): bigint {
  return value === null || value === undefined
    ? BigInt(0)
    : BigInt(value.toString());
}

function parseArguments(argv: string[]): ValidationCLIOptions {
  const options: ValidationCLIOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--live") options.live = true;
    else if (argument === "--confirm-staging") options.confirmStaging = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--mock") options.mock = true;
    else if (argument.startsWith("--store="))
      options.storeDomain = argument.slice("--store=".length);
    else if (argument === "--store" && next) {
      options.storeDomain = next;
      index += 1;
    } else if (argument.startsWith("--store-id="))
      options.storeId = argument.slice("--store-id=".length);
    else if (argument === "--store-id" && next) {
      options.storeId = next;
      index += 1;
    } else if (argument.startsWith("--output="))
      options.outputReportPath = argument.slice("--output=".length);
    else if (argument === "--output" && next) {
      options.outputReportPath = next;
      index += 1;
    }
  }
  return options;
}

function check(
  name: string,
  operation: () => Record<string, unknown> | void,
): ValidationCheckResult {
  try {
    return { name, passed: true, details: operation() || undefined };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertEqual(name: string, actual: bigint, expected: bigint) {
  if (actual !== expected)
    throw new Error(`${name}: service=${actual}, sql=${expected}`);
}

export async function validateLoyaltyAnalytics(
  options: ValidationCLIOptions,
): Promise<LoyaltyAnalyticsValidationReport> {
  if (options.mock)
    throw new Error(
      "--mock is not supported. Analytics validation requires persisted database evidence.",
    );
  if (options.live && !options.confirmStaging)
    throw new Error(
      "--live requires --confirm-staging. This validator is read-only but must not be pointed at an unconfirmed environment.",
    );
  if (options.live && options.dryRun)
    throw new Error("Choose exactly one execution mode: --dry-run or --live.");
  if (Boolean(options.storeDomain) === Boolean(options.storeId))
    throw new Error(
      "Provide exactly one selector: --store=<exact-domain> or --store-id=<store-id>.",
    );

  const store = await prisma.weleticShopifyStore.findFirst({
    where: options.storeId
      ? { id: options.storeId }
      : { shopDomain: options.storeDomain },
    select: {
      id: true,
      shopDomain: true,
      program: { select: { accountingCurrency: true } },
      loyaltyProgram: {
        select: {
          liabilityValuationCurrency: true,
          liabilityMinorUnitsNumerator: true,
          liabilityPointsDenominator: true,
        },
      },
    },
  });
  if (!store) throw new Error("The requested Shopify store was not found.");

  const configuration = resolveLoyaltyFinancialConfiguration({
    accountingCurrency: store.program.accountingCurrency,
    liabilityValuationCurrency:
      store.loyaltyProgram?.liabilityValuationCurrency,
    liabilityMinorUnitsNumerator:
      store.loyaltyProgram?.liabilityMinorUnitsNumerator,
    liabilityPointsDenominator:
      store.loyaltyProgram?.liabilityPointsDenominator,
  });
  const checks: ValidationCheckResult[] = [
    check("Exact valuation is configured in accounting currency", () => {
      if (!configuration.valuation)
        throw new Error(configuration.reason || "Valuation is unavailable.");
      return {
        accountingCurrency: configuration.accountingCurrency,
        minorUnitsNumerator:
          configuration.valuation.minorUnitsNumerator.toString(),
        pointsDenominator: configuration.valuation.pointsDenominator.toString(),
      };
    }),
  ];
  const reportBase = {
    version: 2 as const,
    timestamp: new Date().toISOString(),
    storeId: store.id,
    storeDomain: store.shopDomain,
    executionMode: (options.live ? "live-admin" : "dry-run") as
      | "live-admin"
      | "dry-run",
    provenance: {
      source: "persisted-database" as const,
      productionServicesInvoked: true,
      prismaTransactionBoundary: true,
      independentSqlReconciliation: true,
    },
  };
  if (!configuration.valuation)
    return {
      ...reportBase,
      provenance: {
        ...reportBase.provenance,
        productionServicesInvoked: false,
        prismaTransactionBoundary: false,
        independentSqlReconciliation: false,
      },
      overallStatus: "FAILED",
      checks,
    };

  const valuation = configuration.valuation;
  const evidence = await prisma.$transaction(
    async (tx) => {
      const [liability, health, cohorts] = await Promise.all([
        calculatePointsLiability({
          storeId: store.id,
          currency: valuation.currency,
          liabilityMinorUnitsNumerator: valuation.minorUnitsNumerator,
          liabilityPointsDenominator: valuation.pointsDenominator,
          tx,
        }),
        getLoyaltyProgramHealthMetrics({
          storeId: store.id,
          currency: valuation.currency,
          liabilityMinorUnitsNumerator: valuation.minorUnitsNumerator,
          liabilityPointsDenominator: valuation.pointsDenominator,
          tx,
        }),
        calculateMemberCohortAttribution({
          storeId: store.id,
          currency: valuation.currency,
          tx,
        }),
      ]);

      const [accountSql] = await tx.$queryRaw<
        Array<{
          circulatingPoints: SqlInteger;
          pendingPoints: SqlInteger;
          negativeDebt: SqlInteger;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN cachedPointsBalance > 0 THEN cachedPointsBalance ELSE 0 END), 0) AS circulatingPoints,
          COALESCE(SUM(CASE WHEN cachedPendingPoints > 0 THEN cachedPendingPoints ELSE 0 END), 0) AS pendingPoints,
          COALESCE(SUM(CASE WHEN cachedPointsBalance < 0 THEN -cachedPointsBalance ELSE 0 END), 0) AS negativeDebt
        FROM WeleticLoyaltyAccount
        WHERE storeId = ${store.id}
      `);
      const [ledgerSql] = await tx.$queryRaw<
        Array<{
          earned: SqlInteger;
          redeemed: SqlInteger;
          refunded: SqlInteger;
          expired: SqlInteger;
          backfilled: SqlInteger;
          backfillCorrected: SqlInteger;
          manualCredits: SqlInteger;
          manualDebits: SqlInteger;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN entryType IN ('EARN_ORDER','EARN_REFERRAL','EARN_BONUS','TIER_BONUS','BACKFILL') AND pointsDelta > 0 THEN pointsDelta ELSE 0 END), 0) AS earned,
          COALESCE(SUM(CASE WHEN entryType = 'REDEEM_REWARD' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END), 0) AS redeemed,
          COALESCE(SUM(CASE WHEN entryType = 'REFUND_REVERSAL' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END), 0) AS refunded,
          COALESCE(SUM(CASE WHEN entryType = 'EXPIRATION' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END), 0) AS expired,
          COALESCE(SUM(CASE WHEN entryType = 'BACKFILL' AND pointsDelta > 0 THEN pointsDelta ELSE 0 END), 0) AS backfilled,
          COALESCE(SUM(CASE WHEN entryType = 'BACKFILL_CORRECTION' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END), 0) AS backfillCorrected,
          COALESCE(SUM(CASE WHEN entryType = 'MANUAL_ADJUSTMENT' AND pointsDelta > 0 THEN pointsDelta ELSE 0 END), 0) AS manualCredits,
          COALESCE(SUM(CASE WHEN entryType = 'MANUAL_ADJUSTMENT' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END), 0) AS manualDebits
        FROM WeleticPointsLedgerEntry
        WHERE storeId = ${store.id}
      `);
      const [referralSql] = await tx.$queryRaw<
        Array<{
          totalReferrals: SqlInteger;
          successfulReferrals: SqlInteger;
          advocatePoints: SqlInteger;
          refereePoints: SqlInteger;
          attributedRevenue: SqlInteger;
          missingOrders: SqlInteger;
        }>
      >(Prisma.sql`
        SELECT
          COUNT(*) AS totalReferrals,
          COALESCE(SUM(CASE WHEN referral.status IN ('qualified','rewarded') THEN 1 ELSE 0 END), 0) AS successfulReferrals,
          COALESCE(SUM(referral.advocatePointsAwarded), 0) AS advocatePoints,
          COALESCE(SUM(referral.refereePointsAwarded), 0) AS refereePoints,
          COALESCE(SUM(CASE
            WHEN referral.status IN ('qualified','rewarded')
              AND (
                referral.qualifyingOrderId IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM WeleticCommerceOrder attributedOrder
                  WHERE attributedOrder.storeId = referral.storeId
                    AND attributedOrder.id = referral.qualifyingOrderId
                )
              )
            THEN 1 ELSE 0 END), 0) AS missingOrders,
          COALESCE((
            SELECT SUM(commerceOrder.accountingNet)
            FROM WeleticCommerceOrder commerceOrder
            WHERE commerceOrder.storeId = ${store.id}
              AND commerceOrder.id IN (
                SELECT DISTINCT qualifying.qualifyingOrderId
                FROM WeleticLoyaltyReferral qualifying
                WHERE qualifying.storeId = ${store.id}
                  AND qualifying.status IN ('qualified','rewarded')
                  AND qualifying.qualifyingOrderId IS NOT NULL
              )
          ), 0) AS attributedRevenue
        FROM WeleticLoyaltyReferral referral
        WHERE referral.storeId = ${store.id}
      `);
      const cohortSql = await tx.$queryRaw<
        Array<{
          isMember: SqlInteger;
          customerKey: string;
          orderCount: SqlInteger;
          totalSpend: SqlInteger;
        }>
      >(Prisma.sql`
        SELECT
          CASE WHEN loyaltyAccount.id IS NULL THEN 0 ELSE 1 END AS isMember,
          COALESCE(commerceOrder.shopperId, commerceOrder.externalId, commerceOrder.id) AS customerKey,
          COUNT(*) AS orderCount,
          COALESCE(SUM(commerceOrder.accountingTotal), 0) AS totalSpend
        FROM WeleticCommerceOrder commerceOrder
        LEFT JOIN WeleticLoyaltyAccount loyaltyAccount
          ON loyaltyAccount.storeId = commerceOrder.storeId
          AND loyaltyAccount.shopperId = commerceOrder.shopperId
        WHERE commerceOrder.storeId = ${store.id}
          AND commerceOrder.status <> 'voided'
        GROUP BY isMember, customerKey
      `);
      return {
        liability,
        health,
        cohorts,
        accountSql,
        ledgerSql,
        referralSql,
        cohortSql,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  checks.push(
    check("Liability service reconciles to independent SQL totals", () => {
      const circulating = toBigInt(evidence.accountSql?.circulatingPoints);
      const pending = toBigInt(evidence.accountSql?.pendingPoints);
      const debt = toBigInt(evidence.accountSql?.negativeDebt);
      assertEqual(
        "circulating points",
        evidence.liability.totalCirculatingPoints,
        circulating,
      );
      assertEqual(
        "pending points",
        evidence.liability.totalPendingPoints,
        pending,
      );
      assertEqual(
        "negative balance debt",
        evidence.liability.negativeBalancePointsDebt,
        debt,
      );
      assertEqual(
        "aggregate liability",
        evidence.liability.totalLiabilityMinorUnits,
        divideRationalUp(
          circulating * valuation.minorUnitsNumerator,
          valuation.pointsDenominator,
        ),
      );
      return {
        circulatingPoints: circulating.toString(),
        totalLiabilityMinorUnits:
          evidence.liability.totalLiabilityMinorUnits.toString(),
      };
    }),
    check("Ledger classifications reconcile to independent SQL totals", () => {
      const mappings: Array<[string, bigint, SqlInteger | undefined]> = [
        [
          "earned",
          evidence.health.totalPointsEarned,
          evidence.ledgerSql?.earned,
        ],
        [
          "redeemed",
          evidence.health.totalPointsRedeemed,
          evidence.ledgerSql?.redeemed,
        ],
        [
          "refunded",
          evidence.health.totalPointsRefundReversed,
          evidence.ledgerSql?.refunded,
        ],
        [
          "expired",
          evidence.health.totalPointsExpired,
          evidence.ledgerSql?.expired,
        ],
        [
          "backfilled",
          evidence.health.totalPointsBackfilled,
          evidence.ledgerSql?.backfilled,
        ],
        [
          "backfill corrected",
          evidence.health.totalPointsBackfillCorrected,
          evidence.ledgerSql?.backfillCorrected,
        ],
        [
          "manual credits",
          evidence.health.totalManualAdjustmentCredits,
          evidence.ledgerSql?.manualCredits,
        ],
        [
          "manual debits",
          evidence.health.totalManualAdjustmentDebits,
          evidence.ledgerSql?.manualDebits,
        ],
      ];
      for (const [name, serviceValue, sqlValue] of mappings)
        assertEqual(name, serviceValue, toBigInt(sqlValue));
      return Object.fromEntries(
        mappings.map(([name, value]) => [name, value.toString()]),
      );
    }),
    check("Referral economics reconcile to independent SQL totals", () => {
      const totalReferrals = toBigInt(evidence.referralSql?.totalReferrals);
      const successfulReferrals = toBigInt(
        evidence.referralSql?.successfulReferrals,
      );
      const advocatePoints = toBigInt(evidence.referralSql?.advocatePoints);
      const refereePoints = toBigInt(evidence.referralSql?.refereePoints);
      const attributedRevenue = toBigInt(
        evidence.referralSql?.attributedRevenue,
      );
      const missingOrders = toBigInt(evidence.referralSql?.missingOrders);
      assertEqual(
        "total referrals",
        BigInt(evidence.health.totalReferrals),
        totalReferrals,
      );
      assertEqual(
        "successful referrals",
        BigInt(evidence.health.successfulReferrals),
        successfulReferrals,
      );
      assertEqual(
        "advocate referral points",
        evidence.health.referralMetrics.totalAdvocatePointsAwarded,
        advocatePoints,
      );
      assertEqual(
        "referee referral points",
        evidence.health.referralMetrics.totalRefereePointsAwarded,
        refereePoints,
      );
      assertEqual(
        "missing referral orders",
        BigInt(evidence.health.financialDataQuality.missingOrderCount),
        missingOrders,
      );
      if (evidence.health.referralRevenueMinorUnits === null)
        throw new Error(
          evidence.health.financialDataQuality.reason ||
            "Referral attributed revenue is unavailable.",
        );
      assertEqual(
        "referral attributed revenue",
        evidence.health.referralRevenueMinorUnits,
        attributedRevenue,
      );
      return {
        totalReferrals: totalReferrals.toString(),
        successfulReferrals: successfulReferrals.toString(),
        attributedRevenueMinorUnits: attributedRevenue.toString(),
        missingOrders: missingOrders.toString(),
      };
    }),
    check("Cohort metrics reconcile to independent SQL totals", () => {
      const summarize = (isMember: boolean) => {
        const rows = evidence.cohortSql.filter(
          (row) => toBigInt(row.isMember) === BigInt(isMember ? 1 : 0),
        );
        return {
          customerCount: rows.length,
          totalOrders: rows.reduce(
            (sum, row) => sum + toBigInt(row.orderCount),
            BigInt(0),
          ),
          totalSpend: rows.reduce(
            (sum, row) => sum + toBigInt(row.totalSpend),
            BigInt(0),
          ),
          repeatPurchasers: rows.filter(
            (row) => toBigInt(row.orderCount) >= BigInt(2),
          ).length,
        };
      };
      const reconcileCohort = (
        name: string,
        service: typeof evidence.cohorts.members,
        sql: ReturnType<typeof summarize>,
      ) => {
        assertEqual(
          `${name} customer count`,
          BigInt(service.customerCount),
          BigInt(sql.customerCount),
        );
        assertEqual(
          `${name} order count`,
          BigInt(service.totalOrders),
          sql.totalOrders,
        );
        if (service.totalSpendMinorUnits === null)
          throw new Error(
            evidence.cohorts.dataQuality.reason ||
              `${name} cohort spend is unavailable.`,
          );
        assertEqual(
          `${name} spend`,
          service.totalSpendMinorUnits,
          sql.totalSpend,
        );
        assertEqual(
          `${name} repeat purchasers`,
          BigInt(service.repeatPurchaserCount),
          BigInt(sql.repeatPurchasers),
        );
      };
      const members = summarize(true);
      const nonMembers = summarize(false);
      reconcileCohort("member", evidence.cohorts.members, members);
      reconcileCohort("non-member", evidence.cohorts.nonMembers, nonMembers);
      return {
        memberSpendMinorUnits: members.totalSpend.toString(),
        nonMemberSpendMinorUnits: nonMembers.totalSpend.toString(),
      };
    }),
    check("Referral orders use one accounting currency", () => {
      if (evidence.health.financialDataQuality.status !== "available")
        throw new Error(
          evidence.health.financialDataQuality.reason ||
            "Referral order currency mismatch.",
        );
      return {
        accountingCurrency:
          evidence.health.financialDataQuality.accountingCurrency,
      };
    }),
    check("Cohort orders use one accounting currency", () => {
      if (evidence.cohorts.dataQuality.status !== "available")
        throw new Error(
          evidence.cohorts.dataQuality.reason ||
            "Cohort order currency mismatch.",
        );
      return {
        accountingCurrency: evidence.cohorts.dataQuality.accountingCurrency,
      };
    }),
    check("Zero-cost ROI is explicitly undefined", () => {
      const zeroCost = calculateReferralEconomics({
        totalReferrals: 0,
        successfulReferrals: 0,
        totalRewardPoints: BigInt(0),
        revenueMinorUnits: BigInt(0),
        currency: valuation.currency,
        liabilityMinorUnitsNumerator: valuation.minorUnitsNumerator,
        liabilityPointsDenominator: valuation.pointsDenominator,
      });
      if (zeroCost.referralROI !== null || !zeroCost.referralROIReason)
        throw new Error("Zero-cost ROI did not return null plus a reason.");
      return { reason: zeroCost.referralROIReason };
    }),
  );

  return {
    ...reportBase,
    overallStatus: checks.every((result) => result.passed)
      ? "PASSED"
      : "FAILED",
    checks,
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await validateLoyaltyAnalytics(options);
    const serialized = JSON.stringify(report, null, 2);
    if (options.outputReportPath)
      writeFileSync(
        resolve(options.outputReportPath),
        `${serialized}\n`,
        "utf8",
      );
    if (options.json) console.log(serialized);
    else {
      console.log(`Loyalty analytics validation: ${report.overallStatus}`);
      for (const result of report.checks) {
        console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
        if (result.error) console.log(`  ${result.error}`);
      }
    }
    if (report.overallStatus !== "PASSED") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1]?.endsWith("validate-loyalty-analytics.ts") ||
  process.argv[1]?.includes("validate-loyalty-analytics")
) {
  void main();
}
