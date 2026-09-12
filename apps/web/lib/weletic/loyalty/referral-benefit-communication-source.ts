import type { Prisma } from "@prisma/client";
import {
  matchesReferralBenefitCommunicationEvidence,
  type ReferralBenefitCommunication,
} from "./referral-benefit-communication-contract";

/** Caller proves active account/program, consent and installation generation.
 * Repeat this check under the retained-delivery transaction fence on retries. */
export async function isCurrentReferralBenefit({
  db,
  event,
  now = new Date(),
}: {
  db: Pick<
    Prisma.TransactionClient,
    | "weleticLoyaltyReferral"
    | "weleticPointsLedgerEntry"
    | "weleticRewardRedemption"
  > & {
    // A narrow read capability supports both Prisma's configured omit client
    // and transaction clients without exposing unrelated fluent relations.
    weleticCommerceOrder: {
      findFirst(args: {
        where: { id: string; storeId: string };
        select: { status: true };
      }): Promise<{ status: string } | null>;
    };
  };
  event: ReferralBenefitCommunication;
  now?: Date;
}) {
  if (
    !Number.isFinite(now.getTime()) ||
    new Date(event.occurredAt).getTime() > now.getTime()
  )
    return false;
  const referral = await db.weleticLoyaltyReferral.findFirst({
    where: { id: event.origin.referralId, storeId: event.storeId },
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
  if (!referral) return false;
  const order = await db.weleticCommerceOrder.findFirst({
    where: { id: event.origin.qualificationOrderId, storeId: event.storeId },
    select: { status: true },
  });
  if (!order || !["paid", "partially_refunded"].includes(order.status))
    return false;
  if (event.benefitKind === "points") {
    const ledger = await db.weleticPointsLedgerEntry.findFirst({
      where: {
        id: event.receiptId,
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
        idempotencyKey: true,
        pointsDelta: true,
        grantId: true,
        metadata: true,
        createdAt: true,
      },
    });
    if (
      !ledger ||
      !matchesReferralBenefitCommunicationEvidence({
        event,
        referral,
        receipt: { kind: "points", ledger },
      })
    )
      return false;
    const clawback = await db.weleticPointsLedgerEntry.findFirst({
      where: {
        storeId: event.storeId,
        accountId: event.accountId,
        entryType: "REFUND_REVERSAL",
        referenceType: "REFERRAL_REFUND_CLAWBACK",
        referenceId: event.origin.referralId,
        pointsDelta: { lt: BigInt(0) },
        // Earlier qualification reversals do not invalidate a later new award.
        // Same-timestamp ambiguity is intentionally suppressed, not reissued.
        createdAt: { gte: ledger.createdAt },
      },
      select: { id: true },
    });
    return !clawback;
  }
  const redemption = await db.weleticRewardRedemption.findFirst({
    where: {
      id: event.receiptId,
      storeId: event.storeId,
      accountId: event.accountId,
    },
    select: {
      id: true,
      storeId: true,
      accountId: true,
      rewardDefinitionId: true,
      idempotencyKey: true,
      shopifyDiscountCode: true,
      shopifyDiscountCodeCanonical: true,
      status: true,
      artifactKind: true,
      pointsSpent: true,
      ledgerEntryId: true,
      shopifyDiscountId: true,
      settlementQuarantinedAt: true,
      metadata: true,
      createdAt: true,
      expiresAt: true,
    },
  });
  if (
    !redemption ||
    (redemption.expiresAt && redemption.expiresAt.getTime() <= now.getTime())
  )
    return false;
  return matchesReferralBenefitCommunicationEvidence({
    event,
    referral,
    receipt: { kind: "coupon", redemption },
  });
}
