import type { Prisma } from "@prisma/client";
import {
  matchesRewardExpiryCommunicationEvidence,
  rewardExpiryCommunicationJobSchema,
  type RewardExpiryCommunication,
  type RewardExpiryReceiptInput,
} from "./reward-expiry-communication-contract";

type Database = Pick<
  Prisma.TransactionClient,
  | "weleticRewardRedemption"
  | "weleticPointsLedgerEntry"
  | "weleticLoyaltyReferral"
> & {
  weleticCommerceOrder: {
    findFirst(args: {
      where: { id: string; storeId: string };
      select: { status: true };
    }): Promise<{ status: string } | null>;
  };
};
/** Local source check, not a substitute for remote discount usability. The
 * caller owns active account/program, privacy, consent and generation fences.
 * Re-read on preparation and retained retries under the same write fence. */
export async function readCurrentRewardExpiryReceipt({
  db,
  event,
  now = new Date(),
}: {
  db: Database;
  event: RewardExpiryCommunication;
  now?: Date;
}): Promise<RewardExpiryReceiptInput | null> {
  const parsed = rewardExpiryCommunicationJobSchema.safeParse(event);
  if (
    !parsed.success ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() < new Date(event.occurredAt).getTime() ||
    now.getTime() >= new Date(event.expiresAt).getTime()
  )
    return null;
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
      shopifyDiscountCode: true,
      shopifyDiscountCodeCanonical: true,
      idempotencyKey: true,
      createdAt: true,
    },
  });
  if (!redemption) return null;
  let receipt: RewardExpiryReceiptInput;
  if (event.receipt.kind === "redemption") {
    const ledger = await db.weleticPointsLedgerEntry.findFirst({
      where: {
        id: event.receipt.evidence.ledgerEntryId,
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
    if (!ledger) return null;
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
    if (compensation) return null;
    receipt = {
      kind: "redemption",
      input: {
        storeId: event.storeId,
        programId: event.programId,
        accountId: event.accountId,
        installationGeneration: event.installationGeneration,
        redemption,
        ledger,
      },
    };
  } else {
    const { origin } = event.receipt.evidence;
    const referral = await db.weleticLoyaltyReferral.findFirst({
      where: { id: origin.referralId, storeId: event.storeId },
      select: {
        id: true,
        storeId: true,
        advocateAccountId: true,
        refereeAccountId: true,
        status: true,
        qualifyingOrderId: true,
        advocatePointsAwarded: true,
        refereePointsAwarded: true,
        metadata: true,
      },
    });
    if (!referral) return null;
    const order = await db.weleticCommerceOrder.findFirst({
      where: { id: origin.qualificationOrderId, storeId: event.storeId },
      select: { status: true },
    });
    if (!order || !["paid", "partially_refunded"].includes(order.status))
      return null;
    receipt = {
      kind: "referral_coupon",
      input: {
        identity: origin,
        expectedInstallationGeneration: event.installationGeneration,
        referral,
        receipt: { kind: "coupon", redemption },
      },
    };
  }
  return matchesRewardExpiryCommunicationEvidence({
    event: parsed.data,
    receipt,
    now,
  })
    ? receipt
    : null;
}

export async function isCurrentRewardExpiryReceipt(
  input: Parameters<typeof readCurrentRewardExpiryReceipt>[0],
) {
  return (await readCurrentRewardExpiryReceipt(input)) !== null;
}
