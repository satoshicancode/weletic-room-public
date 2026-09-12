import type { Prisma } from "@prisma/client";
import {
  matchesRewardCommunicationEvidence,
  type RewardRedeemedCommunication,
} from "./reward-redeemed-communication-contract";

/** Active account/program ownership, consent and generation are established by
 * the caller. Run again under the retained-delivery transaction fence on retries. */
export async function isCurrentRewardRedemption({
  db,
  event,
  now = new Date(),
}: {
  db: Pick<
    Prisma.TransactionClient,
    "weleticRewardRedemption" | "weleticPointsLedgerEntry"
  >;
  event: RewardRedeemedCommunication;
  now?: Date;
}) {
  if (
    !Number.isFinite(now.getTime()) ||
    new Date(event.occurredAt).getTime() > now.getTime()
  )
    return false;
  const redemption = await db.weleticRewardRedemption.findFirst({
    where: {
      id: event.redemptionId,
      storeId: event.storeId,
      accountId: event.accountId,
    },
    select: {
      id: true,
      storeId: true,
      accountId: true,
      rewardDefinitionId: true,
      status: true,
      artifactKind: true,
      pointsSpent: true,
      ledgerEntryId: true,
      fulfillmentSource: true,
      settlementQuarantinedAt: true,
      shopifyDiscountId: true,
      shopifyGiftCardId: true,
      shopifyStoreCreditTransactionId: true,
      metadata: true,
      expiresAt: true,
    },
  });
  if (
    !redemption ||
    (redemption.expiresAt && redemption.expiresAt.getTime() <= now.getTime())
  )
    return false;
  const ledger = await db.weleticPointsLedgerEntry.findFirst({
    where: {
      id: event.ledgerEntryId,
      storeId: event.storeId,
      accountId: event.accountId,
    },
    select: {
      id: true,
      storeId: true,
      accountId: true,
      entryType: true,
      referenceType: true,
      referenceId: true,
      pointsDelta: true,
      createdAt: true,
    },
  });
  if (
    !ledger ||
    !matchesRewardCommunicationEvidence({ event, redemption, ledger })
  )
    return false;
  const compensation = await db.weleticPointsLedgerEntry.findFirst({
    where: {
      storeId: event.storeId,
      accountId: event.accountId,
      referenceType: "REDEMPTION_REFUND",
      referenceId: event.redemptionId,
      pointsDelta: { gt: BigInt(0) },
    },
    select: { id: true },
  });
  return !compensation;
}
