import { prisma } from "@/lib/prisma";
import { auditHistoricalBackfill } from "@/lib/weletic/loyalty/backfill-repair";
import { Prisma } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HistoricalBackfillValidationOptions = {
  confirmStaging?: boolean;
  dryRun?: boolean;
  json?: boolean;
  live?: boolean;
  mock?: boolean;
  outputReportPath?: string;
  store?: string;
};

type CountRow = { count: bigint };

export function parseCliArgs(
  argv: string[],
): HistoricalBackfillValidationOptions {
  const value = (name: string) =>
    argv
      .find((argument) => argument.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  return {
    confirmStaging: argv.includes("--confirm-staging"),
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
    live: argv.includes("--live"),
    mock: argv.includes("--mock"),
    outputReportPath: value("--report"),
    store: value("--store"),
  };
}

async function resolveStore(value: string) {
  return prisma.weleticShopifyStore.findFirst({
    where: { OR: [{ id: value }, { shopDomain: value }] },
    select: { id: true, shopDomain: true },
  });
}

function count(rows: CountRow[]) {
  return Number(rows[0]?.count ?? BigInt(0));
}

export async function runHistoricalBackfillValidation(
  options: HistoricalBackfillValidationOptions = {},
) {
  if (options.mock) {
    throw new Error(
      "The simulator-only historical backfill validator was removed. Run the production-service unit suite and isolated-MySQL integration suite instead.",
    );
  }
  if (options.live && !options.confirmStaging) {
    throw new Error(
      "Missing mandatory --confirm-staging flag for staging database validation.",
    );
  }
  if (
    options.live &&
    (process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production")
  ) {
    throw new Error("Staging validation is forbidden in production runtime.");
  }

  const store = options.store ? await resolveStore(options.store) : null;
  if (options.store && !store) {
    throw new Error(`Shopify store '${options.store}' was not found.`);
  }
  const storeFilter = store?.id;
  const legacyAudit = await auditHistoricalBackfill({
    ...(storeFilter ? { storeId: storeFilter } : {}),
  });
  const storeSql = storeFilter
    ? Prisma.sql`AND credit.storeId = ${storeFilter}`
    : Prisma.empty;
  const accountStoreSql = storeFilter
    ? Prisma.sql`AND account.storeId = ${storeFilter}`
    : Prisma.empty;

  const [incompleteRows, inconsistentArtifactRows, lifetimeEarnedDriftRows] =
    await Promise.all([
      prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM WeleticLoyaltyBackfillOrderCredit credit
      WHERE (
        credit.status = 'claimed'
        OR credit.ledgerEntryId IS NULL
        OR credit.earnGrantId IS NULL
        OR credit.creditedAt IS NULL
      )
      ${storeSql}
    `),
      prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM WeleticLoyaltyBackfillOrderCredit credit
      LEFT JOIN WeleticLoyaltyBackfillOrderSnapshot snapshot
        ON snapshot.id = credit.snapshotId
      LEFT JOIN WeleticPointsLedgerEntry ledger
        ON ledger.id = credit.ledgerEntryId
      LEFT JOIN WeleticLoyaltyEarnGrant earnGrant
        ON earnGrant.id = credit.earnGrantId
      LEFT JOIN (
        SELECT
          grantId,
          COUNT(*) AS lineCount,
          COALESCE(SUM(lineNetAmount), 0) AS allocatedSpend,
          COALESCE(SUM(awardedPoints), 0) AS allocatedPoints
        FROM WeleticLoyaltyOrderLineEarn
        GROUP BY grantId
      ) allocation ON allocation.grantId = earnGrant.id
      WHERE credit.status = 'credited'
        AND (
          credit.points <= 0
          OR snapshot.id IS NULL
          OR snapshot.storeId <> credit.storeId
          OR snapshot.jobId <> credit.jobId
          OR snapshot.programId <> credit.programId
          OR snapshot.orderId <> credit.orderId
          OR snapshot.accountId <> credit.accountId
          OR snapshot.projectedPoints <> credit.points
          OR ledger.id IS NULL
          OR ledger.storeId <> credit.storeId
          OR ledger.accountId <> credit.accountId
          OR ledger.entryType <> 'BACKFILL'
          OR ledger.pointsDelta <> credit.points
          OR ledger.pendingDelta <> 0
          OR ledger.grantId <> earnGrant.id
          OR ledger.referenceType <> 'historical_order'
          OR ledger.referenceId <> credit.orderId
          OR ledger.idempotencyKey <> CONCAT('backfill:order:', credit.orderId)
          OR earnGrant.id IS NULL
          OR earnGrant.storeId <> credit.storeId
          OR earnGrant.programId <> credit.programId
          OR earnGrant.accountId <> credit.accountId
          OR earnGrant.shopperId <> snapshot.shopperId
          OR earnGrant.orderId <> credit.orderId
          OR earnGrant.currency <> snapshot.currency
          OR earnGrant.policyRevisionId <> snapshot.policyRevisionId
          OR earnGrant.grossPoints <> credit.points
          OR COALESCE(allocation.lineCount, 0) <> JSON_LENGTH(snapshot.lineAllocations)
          OR COALESCE(allocation.allocatedSpend, 0) <> snapshot.eligibleSpend
          OR COALESCE(allocation.allocatedPoints, 0) <> earnGrant.grossPoints
        )
        ${storeSql}
      `),
      prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*) AS count
        FROM WeleticLoyaltyAccount account
        JOIN (
          SELECT
            ledger.accountId,
            COALESCE(SUM(
              CASE
                WHEN ledger.entryType IN (
                  'EARN_ORDER',
                  'EARN_REFERRAL',
                  'EARN_BONUS',
                  'BACKFILL',
                  'TIER_BONUS'
                ) AND ledger.pointsDelta > 0
                  THEN ledger.pointsDelta
                WHEN ledger.entryType = 'BACKFILL_CORRECTION'
                  AND ledger.pointsDelta < 0
                  THEN ledger.pointsDelta
                ELSE 0
              END
            ), 0) AS authoritativeLifetimeEarned
          FROM WeleticPointsLedgerEntry ledger
          GROUP BY ledger.accountId
        ) totals ON totals.accountId = account.id
        WHERE account.lifetimePointsEarned <> totals.authoritativeLifetimeEarned
          AND EXISTS (
            SELECT 1
            FROM WeleticPointsLedgerEntry backfillLedger
            WHERE backfillLedger.storeId = account.storeId
              AND backfillLedger.accountId = account.id
              AND backfillLedger.entryType IN ('BACKFILL', 'BACKFILL_CORRECTION')
          )
          ${accountStoreSql}
      `),
    ]);

  const checks = {
    incompleteCreditClaims: count(incompleteRows),
    inconsistentCreditArtifacts: count(inconsistentArtifactRows),
    lifetimeEarnedDrift: count(lifetimeEarnedDriftRows),
    legacyRepairable: legacyAudit.totals.repairable,
    legacyReplayPending: legacyAudit.totals.replayPending,
    legacyUnresolved: legacyAudit.totals.unresolved,
  };
  const readyToEnableCommits = Object.values(checks).every(
    (value) => value === 0,
  );
  const report = {
    version: 2,
    generatedAt: new Date().toISOString(),
    executionMode: "persisted-database" as const,
    provenance: {
      source: "persisted-database" as const,
      auditServiceExercised: true,
      commitPathExercised: false,
      note: "Commit behavior is proven separately by the production-service unit suite and isolated-MySQL transaction suite.",
    },
    scope: store
      ? { storeId: store.id, shopDomain: store.shopDomain }
      : { storeId: null, shopDomain: null },
    checks,
    readyToEnableCommits,
    legacyAudit,
  };

  if (options.outputReportPath) {
    await mkdir(dirname(options.outputReportPath), { recursive: true });
    await writeFile(
      options.outputReportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
  return report;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  try {
    const report = await runHistoricalBackfillValidation(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.readyToEnableCommits ? 0 : 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.includes("validate-historical-backfill")) {
  void main();
}
