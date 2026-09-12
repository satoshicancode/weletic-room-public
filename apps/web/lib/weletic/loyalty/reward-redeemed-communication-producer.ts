import type { Prisma } from "@prisma/client";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import {
  createRewardRedeemedCommunication,
  rewardRedeemedCommunicationKey,
} from "./reward-redeemed-communication-contract";

/** Only the winner of provisioning -> issued may call this in that same
 * store/program-fenced transaction. Existing issued rows/replays are not receipts.
 * Queue errors must roll back the transition; no provider I/O happens here. */
export async function enqueueRewardRedeemedCommunication({
  tx,
  storeId,
  accountId,
  expectedInstallationGeneration,
  receipt,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  accountId: string;
  expectedInstallationGeneration: string;
  receipt: { transitioned: boolean; redemptionId: string; occurredAt: Date };
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!receipt.transitioned) return null;
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
  if (!program || program.storeId !== storeId)
    throw new Error("Reward communication program unavailable");
  if (program.status !== "active" || program.killSwitchActive) return null;
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId: program.id,
    metadata: program.metadata,
    journey: "reward_redeemed",
  });
  if (!policySnapshot?.policy.enabled) return null;
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      installationGeneration: true,
      storeAccessState: true,
      complianceState: true,
    },
  });
  if (
    !store?.installationGeneration ||
    store.installationGeneration !== expectedInstallationGeneration ||
    store.storeAccessState !== "active" ||
    store.complianceState !== "active"
  )
    throw new Error("Reward communication installation unavailable");
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId, programId: program.id, status: "active" },
    select: { id: true },
  });
  if (!account) throw new Error("Reward communication account unavailable");
  const redemption = await tx.weleticRewardRedemption.findFirst({
    where: { id: receipt.redemptionId, storeId, accountId },
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
    },
  });
  if (!redemption?.ledgerEntryId)
    throw new Error("Reward communication source unavailable");
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
  if (!ledger) throw new Error("Reward communication debit unavailable");
  const event = createRewardRedeemedCommunication({
    storeId,
    programId: program.id,
    accountId,
    installationGeneration: expectedInstallationGeneration,
    occurredAt: receipt.occurredAt,
    redemption,
    ledger,
    policySnapshot,
  });
  return enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: rewardRedeemedCommunicationKey(event),
    loyaltyMaintenancePermit,
  });
}
