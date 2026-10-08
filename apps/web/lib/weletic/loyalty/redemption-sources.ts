import { Prisma } from "@prisma/client";

const decimalCount = /^(?:0|[1-9]\d*)$/;
const rewardId = Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(l.metadata, '$.rewardId'))`;
const rewardName = Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(l.metadata, '$.rewardName'))`;
const rewardType = Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(l.metadata, '$.rewardType'))`;
const grossPoints = Prisma.sql`-CAST(l.pointsDelta AS DECIMAL(65, 0))`;
const known = Prisma.sql`
  BINARY l.referenceType = BINARY 'REWARD_REDEMPTION'
  AND r.id IS NOT NULL
  AND BINARY r.rewardDefinitionId = BINARY ${rewardId}
  AND r.pointsSpent = ${grossPoints}
  AND JSON_TYPE(JSON_EXTRACT(l.metadata, '$.rewardId')) = 'STRING'
  AND JSON_TYPE(JSON_EXTRACT(l.metadata, '$.rewardName')) = 'STRING'
  AND JSON_TYPE(JSON_EXTRACT(l.metadata, '$.rewardType')) = 'STRING'
  AND CHAR_LENGTH(${rewardId}) BETWEEN 1 AND 191
  AND CHAR_LENGTH(${rewardName}) BETWEEN 1 AND 255
  AND BINARY ${rewardType} IN (
    'amount_off', 'percentage_off', 'free_shipping',
    'free_product', 'gift_card', 'store_credit'
  )
`;

type Aggregate = { eventCount: string; pointsSpent: string };
type KnownRow = Aggregate & {
  rewardDefinitionId: string;
  capturedName: string;
  rewardType: string;
};

function validAggregate(row: Aggregate) {
  return (
    decimalCount.test(row.eventCount) &&
    decimalCount.test(row.pointsSpent) &&
    (BigInt(row.eventCount) === BigInt(0)) ===
      (BigInt(row.pointsSpent) === BigInt(0))
  );
}

/** Gross immutable redemption debits, not remote discount usage or net cost.
 * A linked redemption corroborates reward ID and points; debit metadata supplies name and type.
 */
export async function readMerchantRedemptionSources({
  tx,
  storeId,
  startAt,
  endAt,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  startAt: Date | null;
  endAt: Date | null;
}) {
  const scope = Prisma.sql`
    FROM WeleticPointsLedgerEntry l
    LEFT JOIN WeleticRewardRedemption r
      ON r.storeId = l.storeId AND BINARY r.storeId = BINARY l.storeId
      AND r.id = l.referenceId AND BINARY r.id = BINARY l.referenceId
      AND r.ledgerEntryId = l.id AND BINARY r.ledgerEntryId = BINARY l.id
    WHERE l.storeId = ${storeId} AND BINARY l.storeId = BINARY ${storeId}
      ${startAt ? Prisma.sql`AND l.createdAt >= ${startAt}` : Prisma.empty}
      ${endAt ? Prisma.sql`AND l.createdAt <= ${endAt}` : Prisma.empty}
      AND l.entryType = 'REDEEM_REWARD'
      AND BINARY l.entryType = BINARY 'REDEEM_REWARD'
      AND l.pointsDelta < 0
  `;
  const [summary] = await tx.$queryRaw<
    Array<Aggregate & { knownCount: string; knownPoints: string }>
  >(Prisma.sql`
    SELECT CAST(COUNT(*) AS CHAR) AS eventCount,
           CAST(COALESCE(SUM(${grossPoints}), 0) AS CHAR) AS pointsSpent,
           CAST(COALESCE(SUM(CASE WHEN ${known} THEN 1 ELSE 0 END), 0) AS CHAR) AS knownCount,
           CAST(COALESCE(SUM(CASE WHEN ${known} THEN ${grossPoints} ELSE 0 END), 0) AS CHAR) AS knownPoints
    ${scope}
  `);
  if (
    !summary ||
    !validAggregate(summary) ||
    !validAggregate({
      eventCount: summary.knownCount,
      pointsSpent: summary.knownPoints,
    })
  )
    throw new Error("Redemption source aggregate is inconsistent");

  const rows = await tx.$queryRaw<KnownRow[]>(Prisma.sql`
    SELECT MIN(CAST(${rewardId} AS CHAR(191))) AS rewardDefinitionId,
           MIN(CAST(${rewardName} AS CHAR(255))) AS capturedName,
           MIN(CAST(${rewardType} AS CHAR(32))) AS rewardType,
           CAST(COUNT(*) AS CHAR) AS eventCount,
           CAST(SUM(${grossPoints}) AS CHAR) AS pointsSpent
    ${scope} AND ${known}
    GROUP BY BINARY CAST(${rewardId} AS CHAR(191)),
             BINARY CAST(${rewardName} AS CHAR(255)),
             BINARY CAST(${rewardType} AS CHAR(32))
    ORDER BY SUM(${grossPoints}) DESC,
             BINARY CAST(${rewardId} AS CHAR(191)) ASC,
             BINARY CAST(${rewardName} AS CHAR(255)) ASC,
             BINARY CAST(${rewardType} AS CHAR(32)) ASC
    LIMIT 10
  `);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.rewardDefinitionId,
      row.capturedName,
      row.rewardType,
    ]);
    if (
      !validAggregate(row) ||
      BigInt(row.eventCount) === BigInt(0) ||
      !row.rewardDefinitionId ||
      !row.capturedName ||
      ![
        "amount_off",
        "percentage_off",
        "free_shipping",
        "free_product",
        "gift_card",
        "store_credit",
      ].includes(row.rewardType) ||
      seen.has(key)
    )
      throw new Error("Redemption source row is inconsistent");
    seen.add(key);
  }
  const knownCount = BigInt(summary.knownCount);
  const knownPoints = BigInt(summary.knownPoints);
  const shownCount = rows.reduce(
    (sum, row) => sum + BigInt(row.eventCount),
    BigInt(0),
  );
  const shownPoints = rows.reduce(
    (sum, row) => sum + BigInt(row.pointsSpent),
    BigInt(0),
  );
  const otherCount = knownCount - shownCount;
  const otherPoints = knownPoints - shownPoints;
  const unknownCount = BigInt(summary.eventCount) - knownCount;
  const unknownPoints = BigInt(summary.pointsSpent) - knownPoints;
  if (
    [otherCount, otherPoints, unknownCount, unknownPoints].some(
      (value) => value < BigInt(0),
    ) ||
    (otherCount === BigInt(0)) !== (otherPoints === BigInt(0)) ||
    (unknownCount === BigInt(0)) !== (unknownPoints === BigInt(0))
  )
    throw new Error("Redemption source totals do not reconcile");
  return {
    coverage: "retained_redemption_debits_only" as const,
    rows,
    other: {
      eventCount: otherCount.toString(),
      pointsSpent: otherPoints.toString(),
    },
    unknown: {
      eventCount: unknownCount.toString(),
      pointsSpent: unknownPoints.toString(),
    },
    total: {
      eventCount: summary.eventCount,
      pointsSpent: summary.pointsSpent,
    },
  };
}
