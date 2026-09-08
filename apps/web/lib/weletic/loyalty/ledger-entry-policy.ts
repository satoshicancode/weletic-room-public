import { WeleticPointsLedgerEntryType } from "@prisma/client";

/**
 * Ledger entry types that represent newly earned points.
 *
 * Positive MANUAL_ADJUSTMENT entries intentionally do not qualify: they are
 * also used to restore points after a cancelled or compensated redemption and
 * therefore must not increase lifetime earnings or VIP tier progress.
 */
export const GENUINE_EARN_ENTRY_TYPES = Object.freeze([
  WeleticPointsLedgerEntryType.EARN_ORDER,
  WeleticPointsLedgerEntryType.EARN_REFERRAL,
  WeleticPointsLedgerEntryType.EARN_BONUS,
  WeleticPointsLedgerEntryType.BACKFILL,
  WeleticPointsLedgerEntryType.TIER_BONUS,
] satisfies WeleticPointsLedgerEntryType[]);

const GENUINE_EARN_ENTRY_TYPE_SET = new Set<WeleticPointsLedgerEntryType>(
  GENUINE_EARN_ENTRY_TYPES,
);

export const REVIEW_INCENTIVE_REVERSAL_REFERENCE = "REVIEW_INCENTIVE_REVERSAL";

export function isGenuineEarnLedgerEntry(
  entryType: WeleticPointsLedgerEntryType,
  pointsDelta: bigint | number,
): boolean {
  return (
    BigInt(pointsDelta) > BigInt(0) &&
    GENUINE_EARN_ENTRY_TYPE_SET.has(entryType)
  );
}

/**
 * Returns the authoritative change to cached lifetime-earned points.
 *
 * Invalid backfill and explicitly identified invalid review awards reduce this
 * metric. Ordinary refunds and manual balance corrections intentionally do not
 * erase otherwise valid lifetime earnings.
 */
export function getLifetimeEarnedPointsDelta(
  entryType: WeleticPointsLedgerEntryType,
  pointsDelta: bigint | number,
  referenceType?: string | null,
): bigint {
  const delta = BigInt(pointsDelta);

  if (delta > BigInt(0) && GENUINE_EARN_ENTRY_TYPE_SET.has(entryType)) {
    return delta;
  }

  if (
    (entryType === WeleticPointsLedgerEntryType.BACKFILL_CORRECTION ||
      (entryType === WeleticPointsLedgerEntryType.REFUND_REVERSAL &&
        referenceType === REVIEW_INCENTIVE_REVERSAL_REFERENCE)) &&
    delta < BigInt(0)
  ) {
    return delta;
  }

  return BigInt(0);
}
