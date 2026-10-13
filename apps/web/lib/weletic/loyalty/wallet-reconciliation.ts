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
  grantLedgerMismatch: string;
  orphanGrantLedger: string;
  grantLedgerSourceMismatch: string;
};

type PendingHistoryRow = {
  pendingEventMismatch: string;
  pendingHistoryUnavailable: string;
  unattributedPendingEvents: string;
  pendingEventShapeMismatch: string;
  pendingSourceMismatch: string;
};

type RefundAllocationRow = {
  refundAllocationMismatch: string;
  refundAllocationUnavailable: string;
};

type RefundSourceTargetRow = {
  refundSourceTargetMismatch: string;
  refundSourceTargetUnavailable: string;
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
        WHERE lineEarn.storeId = ${storeId} AND grantRow.id IS NULL) AS orphanLines,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticLoyaltyEarnGrant grantRow
        LEFT JOIN (
          SELECT grantId,
            SUM(CASE WHEN entryType IN ('EARN_ORDER', 'BACKFILL') THEN pointsDelta ELSE 0 END) AS earned,
            SUM(CASE WHEN entryType = 'REFUND_REVERSAL' THEN pointsDelta ELSE 0 END) AS refundedBalance,
            SUM(CASE WHEN entryType = 'REFUND_REVERSAL' THEN pendingDelta ELSE 0 END) AS refundedPending,
            SUM(CASE WHEN entryType NOT IN ('EARN_ORDER', 'BACKFILL', 'REFUND_REVERSAL')
              OR (entryType IN ('EARN_ORDER', 'BACKFILL') AND pointsDelta < 0)
              THEN 1 ELSE 0 END) AS invalidEvents
          FROM WeleticPointsLedgerEntry
          WHERE storeId = ${storeId} AND grantId IS NOT NULL
          GROUP BY grantId
        ) events ON events.grantId = grantRow.id
        WHERE grantRow.storeId = ${storeId}
          AND (grantRow.settledPoints <> COALESCE(events.earned, 0) + COALESCE(events.refundedBalance, 0)
            OR grantRow.reversedPoints <> -COALESCE(events.refundedBalance, 0) - COALESCE(events.refundedPending, 0)
            OR COALESCE(events.invalidEvents, 0) <> 0)) AS grantLedgerMismatch,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticPointsLedgerEntry entry
        LEFT JOIN WeleticLoyaltyEarnGrant grantRow
          ON grantRow.id = entry.grantId AND grantRow.storeId = entry.storeId
          AND grantRow.accountId = entry.accountId
        WHERE entry.storeId = ${storeId} AND entry.grantId IS NOT NULL
          AND grantRow.id IS NULL) AS orphanGrantLedger,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticPointsLedgerEntry entry
        JOIN WeleticLoyaltyEarnGrant grantRow
          ON grantRow.id = entry.grantId AND grantRow.storeId = entry.storeId
          AND grantRow.accountId = entry.accountId
        LEFT JOIN WeleticCommerceRefund refund
          ON refund.id = entry.referenceId AND refund.storeId = entry.storeId
        WHERE entry.storeId = ${storeId}
          AND ((entry.entryType = 'EARN_ORDER'
              AND (COALESCE(entry.referenceType, '') <> 'COMMERCE_ORDER'
                OR COALESCE(entry.referenceId, '') <> grantRow.orderId))
            OR (entry.entryType = 'BACKFILL'
              AND (COALESCE(entry.referenceType, '') <> 'historical_order'
                OR COALESCE(entry.referenceId, '') <> grantRow.orderId))
            OR (entry.entryType = 'REFUND_REVERSAL'
              AND NOT ((COALESCE(entry.referenceType, '') = 'COMMERCE_ORDER'
                  AND COALESCE(entry.referenceId, '') = grantRow.orderId)
                OR (COALESCE(entry.referenceType, '') = 'COMMERCE_REFUND'
                  AND COALESCE(refund.orderId, '') = grantRow.orderId))))) AS grantLedgerSourceMismatch
  `);
  // Held grants begin with pending points but no ledger entry. Their later
  // release/refund events must explain gross minus the remaining pending
  // balance. Immediate grants instead have no pending event history.
  const [pendingHistory] = await tx.$queryRaw<PendingHistoryRow[]>(Prisma.sql`
    SELECT
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM (
          SELECT id, grossPoints, pendingPoints,
            CASE WHEN json_type(calculationSnapshot, '$.holdingPeriodDays') IN ('integer', 'INTEGER')
              THEN CAST(json_extract(calculationSnapshot, '$.holdingPeriodDays') AS INTEGER)
              ELSE NULL END AS holdingDays
          FROM WeleticLoyaltyEarnGrant
          WHERE storeId = ${storeId}
        ) grantRow
        LEFT JOIN (
          SELECT grantId, SUM(pendingDelta) AS totalPendingDelta
          FROM WeleticPointsLedgerEntry
          WHERE storeId = ${storeId} AND grantId IS NOT NULL AND pendingDelta <> 0
          GROUP BY grantId
        ) events ON events.grantId = grantRow.id
        WHERE (grantRow.holdingDays > 0
            AND COALESCE(events.totalPendingDelta, 0) <> grantRow.pendingPoints - grantRow.grossPoints)
          OR (grantRow.holdingDays = 0
            AND (grantRow.pendingPoints <> 0 OR COALESCE(events.totalPendingDelta, 0) <> 0))) AS pendingEventMismatch,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticLoyaltyEarnGrant grantRow
        LEFT JOIN (
          SELECT grantId, COUNT(*) AS eventCount
          FROM WeleticPointsLedgerEntry
          WHERE storeId = ${storeId} AND grantId IS NOT NULL AND pendingDelta <> 0
          GROUP BY grantId
        ) events ON events.grantId = grantRow.id
        WHERE grantRow.storeId = ${storeId}
          AND COALESCE(json_type(grantRow.calculationSnapshot, '$.holdingPeriodDays'), '') NOT IN ('integer', 'INTEGER')
          AND (grantRow.pendingPoints <> 0 OR COALESCE(events.eventCount, 0) <> 0
            OR (grantRow.grossPoints > 0
              AND COALESCE(CAST(json_extract(grantRow.calculationSnapshot, '$.source') AS TEXT), '') <> 'historical_backfill'))) AS pendingHistoryUnavailable,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticPointsLedgerEntry entry
        LEFT JOIN WeleticLoyaltyEarnGrant grantRow
          ON grantRow.id = entry.grantId AND grantRow.storeId = entry.storeId
          AND grantRow.accountId = entry.accountId
        WHERE entry.storeId = ${storeId} AND entry.pendingDelta <> 0
          AND grantRow.id IS NULL) AS unattributedPendingEvents,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticPointsLedgerEntry entry
        WHERE entry.storeId = ${storeId} AND entry.pendingDelta <> 0
          AND (entry.entryType NOT IN ('EARN_ORDER', 'REFUND_REVERSAL')
            OR (entry.entryType = 'EARN_ORDER'
              AND entry.pointsDelta <> -entry.pendingDelta))) AS pendingEventShapeMismatch,
      (SELECT CAST(COUNT(*) AS CHAR)
        FROM WeleticPointsLedgerEntry entry
        JOIN WeleticLoyaltyEarnGrant grantRow
          ON grantRow.id = entry.grantId AND grantRow.storeId = entry.storeId
          AND grantRow.accountId = entry.accountId
        LEFT JOIN WeleticCommerceRefund refund
          ON refund.id = entry.referenceId AND refund.storeId = entry.storeId
        WHERE entry.storeId = ${storeId} AND entry.pendingDelta <> 0
          AND ((entry.entryType = 'EARN_ORDER'
              AND (COALESCE(entry.referenceType, '') <> 'COMMERCE_ORDER'
                OR COALESCE(entry.referenceId, '') <> grantRow.orderId))
            OR (entry.entryType = 'REFUND_REVERSAL'
              AND NOT ((COALESCE(entry.referenceType, '') = 'COMMERCE_ORDER'
                  AND COALESCE(entry.referenceId, '') = grantRow.orderId)
                OR (COALESCE(entry.referenceType, '') = 'COMMERCE_REFUND'
                  AND COALESCE(refund.orderId, '') = grantRow.orderId))))) AS pendingSourceMismatch
  `);
  // A refund event and its immutable line allocations are written in one
  // transaction. Legacy events lack this provenance; never infer their lines.
  const [refundAllocations] = await tx.$queryRaw<RefundAllocationRow[]>(
    Prisma.sql`
      SELECT
        CAST(COALESCE(SUM(CASE
          WHEN entry.referenceType = 'COMMERCE_ORDER'
            OR (entry.referenceType = 'COMMERCE_REFUND'
              AND json_type(entry.metadata, '$.refundAllocationVersion') IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM WeleticLoyaltyRefundAllocation allocation
                WHERE allocation.storeId = entry.storeId AND allocation.ledgerEntryId = entry.id))
            THEN 1 ELSE 0 END), 0) AS CHAR) AS refundAllocationUnavailable,
        CAST(COALESCE(SUM(CASE
          WHEN entry.referenceType = 'COMMERCE_REFUND'
            AND (json_type(entry.metadata, '$.refundAllocationVersion') IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM WeleticLoyaltyRefundAllocation allocation
                WHERE allocation.storeId = entry.storeId AND allocation.ledgerEntryId = entry.id))
            AND (
              COALESCE(json_type(entry.metadata, '$.refundAllocationVersion'), '') NOT IN ('integer', 'INTEGER')
              OR COALESCE(CAST(json_extract(entry.metadata, '$.refundAllocationVersion') AS TEXT), '') <> '1'
              OR ((COALESCE(CAST(json_extract(entry.metadata, '$.privacyRedacted') AS TEXT), '') IN ('true', '1')
                   OR json_extract(entry.metadata, '$.privacyRedacted') = 1)
                AND json_type(entry.metadata, '$.lineReversals') IS NOT NULL)
              OR ((COALESCE(CAST(json_extract(entry.metadata, '$.privacyRedacted') AS TEXT), '') NOT IN ('true', '1')
                   AND COALESCE(json_extract(entry.metadata, '$.privacyRedacted'), 0) <> 1)
                AND COALESCE(json_type(entry.metadata, '$.lineReversals'), '') NOT IN ('array', 'ARRAY'))
              OR COALESCE(CAST(json_extract(entry.metadata, '$.refundAllocationMode') AS TEXT), '')
                NOT IN ('line_refund', 'order_adjustment')
              OR entry.grantId IS NULL
              OR entry.pointsDelta + entry.pendingDelta >= 0
              OR COALESCE(CAST(json_extract(entry.metadata, '$.totalClawback') AS TEXT), '')
                <> CAST(-entry.pointsDelta - entry.pendingDelta AS TEXT)
              OR COALESCE(json_type(entry.metadata, '$.lineReversalCount'), '') NOT IN ('integer', 'INTEGER')
              OR (SELECT COUNT(*) FROM WeleticLoyaltyRefundAllocation allocation
                  WHERE allocation.storeId = entry.storeId AND allocation.ledgerEntryId = entry.id) = 0
              OR (SELECT COUNT(*) FROM WeleticLoyaltyRefundAllocation allocation
                  WHERE allocation.storeId = entry.storeId AND allocation.ledgerEntryId = entry.id)
                <> CAST(COALESCE(CAST(json_extract(entry.metadata, '$.lineReversalCount') AS TEXT), '-1') AS INTEGER)
              OR ((COALESCE(CAST(json_extract(entry.metadata, '$.privacyRedacted') AS TEXT), '') NOT IN ('true', '1')
                   AND COALESCE(json_extract(entry.metadata, '$.privacyRedacted'), 0) <> 1)
                AND (SELECT COUNT(*) FROM WeleticLoyaltyRefundAllocation allocation
                  WHERE allocation.storeId = entry.storeId AND allocation.ledgerEntryId = entry.id)
                  <> COALESCE(json_array_length(entry.metadata, '$.lineReversals'), -1))
              OR (SELECT COALESCE(SUM(allocation.points), 0)
                  FROM WeleticLoyaltyRefundAllocation allocation
                  WHERE allocation.storeId = entry.storeId AND allocation.ledgerEntryId = entry.id)
                <> -entry.pointsDelta - entry.pendingDelta
              OR EXISTS (
                SELECT 1 FROM WeleticLoyaltyRefundAllocation allocation
                LEFT JOIN WeleticLoyaltyOrderLineEarn lineEarn
                  ON lineEarn.grantId = entry.grantId AND lineEarn.storeId = entry.storeId
                  AND lineEarn.orderLineId = allocation.orderLineId
                WHERE allocation.storeId = entry.storeId
                  AND allocation.ledgerEntryId = entry.id
                  AND (allocation.grantId <> entry.grantId
                    OR allocation.refundId <> entry.referenceId
                    OR allocation.points <= 0
                    OR lineEarn.id IS NULL OR lineEarn.isExcluded <> 0
                    OR allocation.points > lineEarn.awardedPoints
                    OR ((COALESCE(CAST(json_extract(entry.metadata, '$.privacyRedacted') AS TEXT), '') NOT IN ('true', '1')
                         AND COALESCE(json_extract(entry.metadata, '$.privacyRedacted'), 0) <> 1)
                      AND NOT EXISTS (
                        SELECT 1 FROM json_each(entry.metadata, '$.lineReversals') elem
                        WHERE json_extract(elem.value, '$.orderLineId') = allocation.orderLineId
                          AND CAST(json_extract(elem.value, '$.points') AS TEXT) = CAST(allocation.points AS TEXT)
                      ))
                    OR (COALESCE(CAST(json_extract(entry.metadata, '$.refundAllocationMode') AS TEXT), '') = 'line_refund'
                      AND NOT EXISTS (
                        SELECT 1 FROM WeleticCommerceRefundLine refundLine
                        WHERE refundLine.refundId = entry.referenceId
                          AND refundLine.orderLineId = allocation.orderLineId)))
              )
              OR (COALESCE(CAST(json_extract(entry.metadata, '$.refundAllocationMode') AS TEXT), '') = 'order_adjustment'
                AND EXISTS (
                  SELECT 1 FROM WeleticCommerceRefundLine refundLine
                  JOIN WeleticLoyaltyOrderLineEarn lineEarn
                    ON lineEarn.orderLineId = refundLine.orderLineId
                    AND lineEarn.grantId = entry.grantId AND lineEarn.storeId = entry.storeId
                  WHERE refundLine.refundId = entry.referenceId))
            ) THEN 1 ELSE 0 END), 0) AS CHAR) AS refundAllocationMismatch
      FROM WeleticPointsLedgerEntry entry
      WHERE entry.storeId = ${storeId}
        AND entry.entryType = 'REFUND_REVERSAL'
        AND entry.referenceType IN ('COMMERCE_REFUND', 'COMMERCE_ORDER')
    `,
  );
  const [refundLineAllocations] = await tx.$queryRaw<
    Array<{ refundLineAllocationMismatch: string }>
  >(Prisma.sql`
    SELECT CAST(COUNT(*) AS CHAR) AS refundLineAllocationMismatch
    FROM WeleticLoyaltyOrderLineEarn lineEarn
    JOIN WeleticLoyaltyEarnGrant grantRow
      ON grantRow.id = lineEarn.grantId AND grantRow.storeId = lineEarn.storeId
    LEFT JOIN (
      SELECT allocation.grantId, allocation.orderLineId,
        SUM(allocation.points) AS allocatedPoints
      FROM WeleticLoyaltyRefundAllocation allocation
      WHERE allocation.storeId = ${storeId}
      GROUP BY allocation.grantId, allocation.orderLineId
    ) allocations ON allocations.grantId = grantRow.id
      AND allocations.orderLineId = lineEarn.orderLineId
    WHERE grantRow.storeId = ${storeId}
      AND NOT EXISTS (
        SELECT 1 FROM WeleticPointsLedgerEntry unknownEntry
        WHERE unknownEntry.storeId = grantRow.storeId
          AND unknownEntry.grantId = grantRow.id
          AND unknownEntry.entryType = 'REFUND_REVERSAL'
          AND (unknownEntry.referenceType = 'COMMERCE_ORDER'
            OR (unknownEntry.referenceType = 'COMMERCE_REFUND'
              AND COALESCE(CAST(json_extract(unknownEntry.metadata, '$.refundAllocationVersion') AS TEXT), '') <> '1'))
      )
      AND lineEarn.reversedPoints <> COALESCE(allocations.allocatedPoints, 0)
  `);
  const [orphanRefundAllocations] = await tx.$queryRaw<
    Array<{ orphanRefundAllocations: string }>
  >(Prisma.sql`
    SELECT CAST(COUNT(*) AS CHAR) AS orphanRefundAllocations
    FROM WeleticLoyaltyRefundAllocation allocation
    LEFT JOIN WeleticPointsLedgerEntry entry
      ON entry.id = allocation.ledgerEntryId AND entry.storeId = allocation.storeId
    WHERE allocation.storeId = ${storeId}
      AND (entry.id IS NULL OR entry.entryType <> 'REFUND_REVERSAL'
        OR entry.referenceType <> 'COMMERCE_REFUND')
  `);
  // Recompute the final cumulative target from persisted refund money and
  // returned quantities, independently of the grant's mutable reversal total.
  // Order-level adjustments, holding voids and legacy correction events do not
  // follow this line formula; retain an explicit unavailable count for them.
  const [refundSourceTargets] = await tx.$queryRaw<RefundSourceTargetRow[]>(
    Prisma.sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN COALESCE(unsupported.hasUnsupported, 0) = 1
          THEN 1 ELSE 0 END), 0) AS CHAR) AS refundSourceTargetUnavailable,
        CAST(COALESCE(SUM(CASE WHEN COALESCE(unsupported.hasUnsupported, 0) = 0
          AND lineEarn.reversedPoints <> min(
            lineEarn.awardedPoints,
            max(
              CASE WHEN lineEarn.lineNetAmount > 0 AND COALESCE(source.refundedAmount, 0) > 0
                THEN ((source.refundedAmount * lineEarn.awardedPoints) / lineEarn.lineNetAmount)
                  + (CASE WHEN ((source.refundedAmount * lineEarn.awardedPoints) % lineEarn.lineNetAmount) * 2
                    >= lineEarn.lineNetAmount THEN 1 ELSE 0 END)
                ELSE 0 END,
              CASE WHEN lineEarn.quantity > 0 AND COALESCE(source.refundedQuantity, 0) > 0
                THEN ((min(source.refundedQuantity, lineEarn.quantity) * lineEarn.awardedPoints) / lineEarn.quantity)
                  + (CASE WHEN ((min(source.refundedQuantity, lineEarn.quantity) * lineEarn.awardedPoints) % lineEarn.quantity) * 2
                    >= lineEarn.quantity THEN 1 ELSE 0 END)
                ELSE 0 END
            )) THEN 1 ELSE 0 END), 0) AS CHAR) AS refundSourceTargetMismatch
      FROM WeleticLoyaltyOrderLineEarn lineEarn
      JOIN WeleticLoyaltyEarnGrant grantRow
        ON grantRow.id = lineEarn.grantId AND grantRow.storeId = lineEarn.storeId
      LEFT JOIN (
        SELECT refund.storeId, refund.orderId, refundLine.orderLineId,
          SUM(refundLine.shopAmount) AS refundedAmount,
          SUM(refundLine.quantity) AS refundedQuantity
        FROM WeleticCommerceRefundLine refundLine
        JOIN WeleticCommerceRefund refund ON refund.id = refundLine.refundId
        WHERE refund.storeId = ${storeId}
        GROUP BY refund.storeId, refund.orderId, refundLine.orderLineId
      ) source ON source.storeId = grantRow.storeId
        AND source.orderId = grantRow.orderId
        AND source.orderLineId = lineEarn.orderLineId
      LEFT JOIN (
        SELECT grantId, MAX(CASE
          WHEN referenceType = 'COMMERCE_ORDER'
            OR (referenceType = 'COMMERCE_REFUND'
              AND (COALESCE(CAST(json_extract(metadata, '$.refundAllocationVersion') AS TEXT), '') <> '1'
                OR COALESCE(CAST(json_extract(metadata, '$.refundAllocationMode') AS TEXT), '') = 'order_adjustment'))
            THEN 1 ELSE 0 END) AS hasUnsupported
        FROM WeleticPointsLedgerEntry
        WHERE storeId = ${storeId} AND entryType = 'REFUND_REVERSAL'
          AND grantId IS NOT NULL
        GROUP BY grantId
      ) unsupported ON unsupported.grantId = grantRow.id
      WHERE grantRow.storeId = ${storeId} AND lineEarn.isExcluded = 0
    `,
  );
  if (
    !row ||
    !history ||
    !orphans ||
    !grants ||
    !pendingHistory ||
    !refundAllocations ||
    !refundLineAllocations ||
    !orphanRefundAllocations ||
    !refundSourceTargets ||
    Object.values(row).some((value) => !decimalCount.test(value)) ||
    !decimalCount.test(history.chainMismatch) ||
    Object.values(orphans).some((value) => !decimalCount.test(value)) ||
    Object.values(grants).some((value) => !decimalCount.test(value)) ||
    Object.values(pendingHistory).some((value) => !decimalCount.test(value)) ||
    Object.values(refundAllocations).some(
      (value) => !decimalCount.test(value),
    ) ||
    !decimalCount.test(refundLineAllocations.refundLineAllocationMismatch) ||
    !decimalCount.test(orphanRefundAllocations.orphanRefundAllocations) ||
    Object.values(refundSourceTargets).some(
      (value) => !decimalCount.test(value),
    )
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
  const hasMismatch =
    mismatches.some((value) => value !== "0") ||
    history.chainMismatch !== "0" ||
    orphans.orphanLedger !== "0" ||
    orphans.orphanGrants !== "0" ||
    Object.values(grants).some((value) => value !== "0") ||
    pendingHistory.pendingEventMismatch !== "0" ||
    pendingHistory.pendingEventShapeMismatch !== "0" ||
    pendingHistory.pendingSourceMismatch !== "0" ||
    refundAllocations.refundAllocationMismatch !== "0" ||
    refundLineAllocations.refundLineAllocationMismatch !== "0" ||
    orphanRefundAllocations.orphanRefundAllocations !== "0" ||
    refundSourceTargets.refundSourceTargetMismatch !== "0";
  const hasUnavailable =
    pendingHistory.pendingHistoryUnavailable !== "0" ||
    pendingHistory.unattributedPendingEvents !== "0" ||
    refundAllocations.refundAllocationUnavailable !== "0" ||
    refundSourceTargets.refundSourceTargetUnavailable !== "0";
  return {
    ...row,
    chainMismatch: history.chainMismatch,
    ...orphans,
    ...grants,
    ...pendingHistory,
    ...refundAllocations,
    ...refundLineAllocations,
    ...orphanRefundAllocations,
    ...refundSourceTargets,
    status: hasMismatch
      ? ("mismatch" as const)
      : hasUnavailable
        ? ("unavailable" as const)
        : ("clean" as const),
  };
}
