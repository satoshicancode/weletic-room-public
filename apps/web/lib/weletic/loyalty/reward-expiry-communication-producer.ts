import type { Prisma } from "@prisma/client";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import {
  createRewardExpiryCommunication,
  rewardExpiryCommunicationKey,
  type RewardExpiryCommunication,
  type RewardExpiryReceiptInput,
} from "./reward-expiry-communication-contract";
import { isCurrentRewardExpiryReceipt } from "./reward-expiry-communication-source";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

/** Called under the original-generation store -> program lock. No provider I/O,
 * schema changes, fabricated issuance, balance changes or legacy backfill.
 * Queue failures must roll back the caller's sweep checkpoint as well. */
export async function enqueueDueRewardExpiryCommunication({
  tx,
  storeId,
  redemptionId,
  expectedInstallationGeneration,
  now,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  redemptionId: string;
  expectedInstallationGeneration: string;
  now: Date;
}): Promise<"enqueued" | "existing" | "ineligible"> {
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select: {
      id: true,
      storeId: true,
      status: true,
      killSwitchActive: true,
      metadata: true,
    },
  });
  if (
    !program ||
    program.storeId !== storeId ||
    program.status !== "active" ||
    program.killSwitchActive
  )
    return "ineligible";
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      installationGeneration: true,
      storeAccessState: true,
      complianceState: true,
    },
  });
  if (
    store?.installationGeneration !== expectedInstallationGeneration ||
    store.storeAccessState !== "active" ||
    store.complianceState !== "active"
  )
    throw new Error("Reward expiry installation changed");
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId: program.id,
    metadata: program.metadata,
    journey: "reward_expiry",
  });
  if (!policySnapshot?.policy.enabled) return "ineligible";
  const redemption = await tx.weleticRewardRedemption.findFirst({
    where: { id: redemptionId, storeId },
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
  if (
    !redemption?.accountId ||
    redemption.artifactKind !== "discount_code" ||
    !["issued", "active"].includes(redemption.status)
  )
    return "ineligible";
  const accountId = redemption.accountId;
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId, programId: program.id, status: "active" },
    select: {
      id: true,
      metadata: true,
      shopper: { select: { acceptsMarketing: true } },
    },
  });
  if (
    !account ||
    hasShopifyCustomerRedactionTombstone(account.metadata) ||
    !account.shopper.acceptsMarketing
  )
    return "ineligible";
  let receipt: RewardExpiryReceiptInput;
  if (redemption.pointsSpent > BigInt(0)) {
    if (!redemption.ledgerEntryId) return "ineligible";
    const ledger = await tx.weleticPointsLedgerEntry.findFirst({
      where: { id: redemption.ledgerEntryId, storeId, accountId },
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
    if (!ledger) return "ineligible";
    receipt = {
      kind: "redemption",
      input: {
        storeId,
        programId: program.id,
        accountId,
        installationGeneration: expectedInstallationGeneration,
        redemption,
        ledger,
      },
    };
  } else {
    const metadata = redemption.metadata as Prisma.JsonObject | null;
    if (
      !metadata ||
      typeof metadata.referralId !== "string" ||
      typeof metadata.qualificationOrderId !== "string" ||
      (metadata.referralSide !== "advocate" &&
        metadata.referralSide !== "referee")
    )
      return "ineligible";
    const referral = await tx.weleticLoyaltyReferral.findFirst({
      where: { id: metadata.referralId, storeId },
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
    if (!referral) return "ineligible";
    receipt = {
      kind: "referral_coupon",
      input: {
        identity: {
          storeId,
          programId: program.id,
          accountId,
          referralId: metadata.referralId,
          qualificationOrderId: metadata.qualificationOrderId,
          side: metadata.referralSide,
        },
        expectedInstallationGeneration,
        referral,
        receipt: { kind: "coupon", redemption },
      },
    };
  }
  let event: RewardExpiryCommunication;
  try {
    event = createRewardExpiryCommunication({ receipt, policySnapshot, now });
  } catch {
    // Invalid/missing legacy evidence is a row disposition, never permission to
    // reconstruct provenance. Database and queue errors are NOT swallowed here.
    return "ineligible";
  }
  if (!(await isCurrentRewardExpiryReceipt({ db: tx, event, now })))
    return "ineligible";
  const queued = await enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: rewardExpiryCommunicationKey(event),
    scheduledFor: now,
  });
  return queued.created ? "enqueued" : "existing";
}
