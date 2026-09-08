-- Historical backfill remediation, stage 2 release-gate queries.
-- This file is intentionally read-only. Every result must be zero before a
-- separately reviewed application change may re-enable backfill commits.

-- Incomplete per-order credit transactions (should be impossible after a
-- committed transaction; any row indicates manual or out-of-band mutation).
SELECT COUNT(*) AS incomplete_credit_claims
FROM `WeleticLoyaltyBackfillOrderCredit`
WHERE `status` = 'claimed'
   OR `ledgerEntryId` IS NULL
   OR `earnGrantId` IS NULL
   OR `creditedAt` IS NULL;

-- Credited rows whose immutable financial artifacts are missing or disagree.
SELECT COUNT(*) AS orphaned_credit_artifacts
FROM `WeleticLoyaltyBackfillOrderCredit` credit
LEFT JOIN `WeleticLoyaltyBackfillOrderSnapshot` snapshot
  ON snapshot.`id` = credit.`snapshotId`
LEFT JOIN `WeleticPointsLedgerEntry` ledger
  ON ledger.`id` = credit.`ledgerEntryId`
LEFT JOIN `WeleticLoyaltyEarnGrant` earnGrant
  ON earnGrant.`id` = credit.`earnGrantId`
WHERE credit.`status` = 'credited'
  AND (
    credit.`points` <= 0
    OR snapshot.`id` IS NULL
    OR snapshot.`storeId` <> credit.`storeId`
    OR snapshot.`jobId` <> credit.`jobId`
    OR snapshot.`programId` <> credit.`programId`
    OR snapshot.`orderId` <> credit.`orderId`
    OR snapshot.`accountId` <> credit.`accountId`
    OR snapshot.`projectedPoints` <> credit.`points`
    OR ledger.`id` IS NULL
    OR ledger.`storeId` <> credit.`storeId`
    OR ledger.`accountId` <> credit.`accountId`
    OR ledger.`entryType` <> 'BACKFILL'
    OR ledger.`pointsDelta` <> credit.`points`
    OR ledger.`pendingDelta` <> 0
    OR ledger.`grantId` <> earnGrant.`id`
    OR ledger.`referenceType` <> 'historical_order'
    OR ledger.`referenceId` <> credit.`orderId`
    OR ledger.`idempotencyKey` <> CONCAT('backfill:order:', credit.`orderId`)
    OR earnGrant.`id` IS NULL
    OR earnGrant.`storeId` <> credit.`storeId`
    OR earnGrant.`programId` <> credit.`programId`
    OR earnGrant.`accountId` <> credit.`accountId`
    OR earnGrant.`shopperId` <> snapshot.`shopperId`
    OR earnGrant.`orderId` <> credit.`orderId`
    OR earnGrant.`currency` <> snapshot.`currency`
    OR earnGrant.`policyRevisionId` <> snapshot.`policyRevisionId`
    OR earnGrant.`grossPoints` <> credit.`points`
  );

-- Per-order grants whose line allocations do not conserve gross points.
SELECT COUNT(*) AS nonconserving_backfill_grants
FROM `WeleticLoyaltyBackfillOrderCredit` credit
JOIN `WeleticLoyaltyBackfillOrderSnapshot` snapshot
  ON snapshot.`id` = credit.`snapshotId`
JOIN `WeleticLoyaltyEarnGrant` earnGrant
  ON earnGrant.`id` = credit.`earnGrantId`
LEFT JOIN (
  SELECT
    `grantId`,
    COUNT(*) AS lineCount,
    COALESCE(SUM(`lineNetAmount`), 0) AS allocatedSpend,
    COALESCE(SUM(`awardedPoints`), 0) AS allocatedPoints
  FROM `WeleticLoyaltyOrderLineEarn`
  GROUP BY `grantId`
) allocation
  ON allocation.`grantId` = earnGrant.`id`
WHERE credit.`status` = 'credited'
  AND (
    COALESCE(allocation.`lineCount`, 0) <> JSON_LENGTH(snapshot.`lineAllocations`)
    OR COALESCE(allocation.`allocatedSpend`, 0) <> snapshot.`eligibleSpend`
    OR COALESCE(allocation.`allocatedPoints`, 0) <> earnGrant.`grossPoints`
  );

-- Backfill corrections must remove the invalid lifetime-earned contribution
-- before the corrected per-order grants add it back. Refunds and manual
-- balance changes intentionally do not change this cached metric.
SELECT COUNT(*) AS backfill_lifetime_earned_drift
FROM `WeleticLoyaltyAccount` account
JOIN (
  SELECT
    ledger.`accountId`,
    COALESCE(SUM(
      CASE
        WHEN ledger.`entryType` IN (
          'EARN_ORDER',
          'EARN_REFERRAL',
          'EARN_BONUS',
          'BACKFILL',
          'TIER_BONUS'
        ) AND ledger.`pointsDelta` > 0
          THEN ledger.`pointsDelta`
        WHEN ledger.`entryType` = 'BACKFILL_CORRECTION'
          AND ledger.`pointsDelta` < 0
          THEN ledger.`pointsDelta`
        ELSE 0
      END
    ), 0) AS authoritativeLifetimeEarned
  FROM `WeleticPointsLedgerEntry` ledger
  GROUP BY ledger.`accountId`
) totals
  ON totals.`accountId` = account.`id`
WHERE account.`lifetimePointsEarned` <> totals.`authoritativeLifetimeEarned`
  AND EXISTS (
    SELECT 1
    FROM `WeleticPointsLedgerEntry` backfillLedger
    WHERE backfillLedger.`storeId` = account.`storeId`
      AND backfillLedger.`accountId` = account.`id`
      AND backfillLedger.`entryType` IN ('BACKFILL', 'BACKFILL_CORRECTION')
  );

-- The audit CLI is authoritative for this last gate because legacy aggregate
-- rows can be unresolved even when the additive tables above are internally
-- consistent:
--   pnpm loyalty:audit-backfill -- --environment=<env> --json
