import { Prisma } from "@prisma/client";

type CountRow = {
  accounts: string;
  balanceMismatch: string;
  pendingMismatch: string;
  earnedMismatch: string;
  redeemedMismatch: string;
  sequenceMismatch: string;
};

type OrphanRow = { orphanLedger: string; orphanGrants: string };

type GrantRow = {
  grantConservationMismatch: string;
  lineAllocationMismatch: string;
  orphanLines: string;
};

const decimalCount = /^(?:0|[1-9]\d*)$/;

/** Read-only, full-store ledger check for an operator's release gate.
 * It returns aggregate mismatch counts only, without shopper identifiers.
 * The SQL intentionally recomputes values independently of account writers.
 */
export async function readStoreWalletReconciliation({
  tx,
  storeId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
}) {
  const [row] = await tx.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT CAST(COUNT(*) AS CHAR) AS accounts,
      CAST(COALESCE(SUM(a.cachedPointsBalance <> COALESCE(l.balance, 0)), 0) AS CHAR) AS balanceMismatch,
      CAST(COALESCE(SUM(a.cachedPendingPoints <> COALESCE(g.pending, 0)), 0) AS CHAR) AS pendingMismatch,
      CAST(COALESCE(SUM(a.lifetimePointsEarned <> COALESCE(l.earned, 0)), 0) AS CHAR) AS earnedMismatch,
      CAST(COALESCE(SUM(a.lifetimePointsRedeemed <> COALESCE(l.redeemed, 0)), 0) AS CHAR) AS redeemedMismatch,
      CAST(COALESCE(SUM(a.ledgerVersion <> COALESCE(l.entries, 0)
        OR a.ledgerVersion <> COALESCE(l.lastSequence, 0)), 0) AS CHAR) AS sequenceMismatch
    FROM WeleticLoyaltyAccount a
    LEFT JOIN (
      SELECT accountId,
        SUM(pointsDelta) AS balance,
        COUNT(*) AS entries,
        MAX(sequenceNumber) AS lastSequence,
        SUM(CASE
          WHEN entryType IN ('EARN_ORDER','EARN_REFERRAL','EARN_BONUS','BACKFILL','TIER_BONUS') AND pointsDelta > 0
            THEN pointsDelta
          WHEN (entryType = 'BACKFILL_CORRECTION'
            OR (entryType = 'REFUND_REVERSAL' AND referenceType = 'REVIEW_INCENTIVE_REVERSAL')) AND pointsDelta < 0
            THEN pointsDelta
          ELSE 0 END) AS earned,
        SUM(CASE WHEN entryType = 'REDEEM_REWARD' AND pointsDelta < 0 THEN -pointsDelta ELSE 0 END) AS redeemed
      FROM WeleticPointsLedgerEntry
      WHERE storeId = ${storeId}
      GROUP BY accountId
    ) l ON l.accountId = a.id
    LEFT JOIN (
      SELECT accountId, SUM(pendingPoints) AS pending
      FROM WeleticLoyaltyEarnGrant
      WHERE storeId = ${storeId}
      GROUP BY accountId
    ) g ON g.accountId = a.id
    WHERE a.storeId = ${storeId}
  `);
  const [history] = await tx.$queryRaw<Array<{ chainMismatch: string }>>(
    Prisma.sql`
      SELECT CAST(COUNT(*) AS CHAR) AS chainMismatch
      FROM (
        SELECT balanceAfter, sequenceNumber,
          SUM(pointsDelta) OVER (PARTITION BY accountId ORDER BY sequenceNumber ROWS UNBOUNDED PRECEDING) AS expectedBalance,
          ROW_NUMBER() OVER (PARTITION BY accountId ORDER BY sequenceNumber) AS expectedSequence
        FROM WeleticPointsLedgerEntry
        WHERE storeId = ${storeId}
      ) history
      WHERE balanceAfter <> expectedBalance OR sequenceNumber <> expectedSequence
    `,
  );
  // Prisma relationMode does not create database foreign keys. Detect rows
  // without an account in this store instead of silently omitting them.
  const [orphans] = await tx.$queryRaw<OrphanRow[]>(Prisma.sql`
    SELECT
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticPointsLedgerEntry entry
        LEFT JOIN WeleticLoyaltyAccount account
          ON account.id = entry.accountId AND account.storeId = entry.storeId
        WHERE entry.storeId = ${storeId} AND account.id IS NULL) AS orphanLedger,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticLoyaltyEarnGrant grantRow
        LEFT JOIN WeleticLoyaltyAccount account
          ON account.id = grantRow.accountId AND account.storeId = grantRow.storeId
        WHERE grantRow.storeId = ${storeId} AND account.id IS NULL) AS orphanGrants
  `);
  const [grants] = await tx.$queryRaw<GrantRow[]>(Prisma.sql`
    SELECT
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticLoyaltyEarnGrant grantRow
        WHERE grantRow.storeId = ${storeId}
          AND (grantRow.grossPoints <> grantRow.pendingPoints + grantRow.settledPoints + grantRow.reversedPoints
            OR grantRow.grossPoints < 0 OR grantRow.pendingPoints < 0
            OR grantRow.settledPoints < 0 OR grantRow.reversedPoints < 0)) AS grantConservationMismatch,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticLoyaltyEarnGrant grantRow
        LEFT JOIN (
          SELECT grantId, SUM(awardedPoints) AS awarded, SUM(reversedPoints) AS reversed
          FROM WeleticLoyaltyOrderLineEarn
          WHERE storeId = ${storeId}
          GROUP BY grantId
        ) lineTotals ON lineTotals.grantId = grantRow.id
        WHERE grantRow.storeId = ${storeId}
          AND (grantRow.grossPoints <> COALESCE(lineTotals.awarded, 0)
            OR grantRow.reversedPoints <> COALESCE(lineTotals.reversed, 0))) AS lineAllocationMismatch,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticLoyaltyOrderLineEarn lineEarn
        LEFT JOIN WeleticLoyaltyEarnGrant grantRow
          ON grantRow.id = lineEarn.grantId AND grantRow.storeId = lineEarn.storeId
        WHERE lineEarn.storeId = ${storeId} AND grantRow.id IS NULL) AS orphanLines
  `);
  if (
    !row ||
    !history ||
    !orphans ||
    !grants ||
    Object.values(row).some((value) => !decimalCount.test(value)) ||
    !decimalCount.test(history.chainMismatch) ||
    Object.values(orphans).some((value) => !decimalCount.test(value)) ||
    Object.values(grants).some((value) => !decimalCount.test(value))
  )
    throw new Error("Wallet reconciliation returned invalid counts");
  const accounts = BigInt(row.accounts);
  const mismatches = [
    row.balanceMismatch,
    row.pendingMismatch,
    row.earnedMismatch,
    row.redeemedMismatch,
    row.sequenceMismatch,
  ];
  if (mismatches.some((value) => BigInt(value) > accounts))
    throw new Error("Wallet reconciliation exceeded account count");
  return {
    ...row,
    chainMismatch: history.chainMismatch,
    ...orphans,
    ...grants,
    status:
      mismatches.every((value) => value === "0") &&
      history.chainMismatch === "0" &&
      orphans.orphanLedger === "0" &&
      orphans.orphanGrants === "0" &&
      Object.values(grants).every((value) => value === "0")
        ? ("clean" as const)
        : ("mismatch" as const),
  };
}
