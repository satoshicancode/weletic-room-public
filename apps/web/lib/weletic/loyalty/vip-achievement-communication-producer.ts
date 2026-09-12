import type { Prisma } from "@prisma/client";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import {
  createVipAchievementCommunication,
  vipAchievementCommunicationKey,
} from "./vip-achievement-communication-contract";

/** Only the transaction creating a fresh threshold-promotion history may call
 * this producer, after acquiring operational store/program fences. Never use
 * historical/imported placement as a receipt or opt an old transition in. */
export async function enqueueVipAchievementCommunication({
  tx,
  storeId,
  programId,
  accountId,
  expectedInstallationGeneration,
  receipt,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  accountId: string;
  expectedInstallationGeneration: string;
  receipt: {
    created: boolean;
    history: Parameters<typeof createVipAchievementCommunication>[0]["history"];
  };
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!receipt.created) return null;
  const history = receipt.history;
  if (
    history.accountId !== accountId ||
    history.changeReason !== "threshold_reached" ||
    !history.fromTierId ||
    !history.sequenceNumber
  )
    throw new Error("VIP communication source unavailable");
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
  if (!program || program.id !== programId || program.storeId !== storeId)
    throw new Error("VIP communication program unavailable");
  if (program.status !== "active" || program.killSwitchActive) return null;
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId,
    metadata: program.metadata,
    journey: "vip_achieved",
  });
  if (!policySnapshot?.policy.enabled) return null;
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId, programId, status: "active" },
    select: { id: true, currentTierId: true },
  });
  if (!account || account.currentTierId !== history.toTierId)
    throw new Error("VIP communication account unavailable");
  const latest = await tx.weleticLoyaltyTierHistory.findFirst({
    where: { accountId },
    orderBy: { sequenceNumber: "desc" },
    select: {
      id: true,
      accountId: true,
      sequenceNumber: true,
      fromTierId: true,
      toTierId: true,
      changeReason: true,
      effectiveAt: true,
    },
  });
  if (
    !latest ||
    !latest.toTierId ||
    latest.id !== history.id ||
    latest.sequenceNumber !== history.sequenceNumber ||
    latest.fromTierId !== history.fromTierId ||
    latest.toTierId !== history.toTierId ||
    latest.changeReason !== history.changeReason ||
    latest.effectiveAt.getTime() !== history.effectiveAt.getTime()
  )
    throw new Error("VIP communication history unavailable");
  const tiers = await tx.weleticLoyaltyTier.findMany({
    where: {
      programId,
      program: { storeId },
      id: { in: [history.fromTierId, history.toTierId] },
      deletedAt: null,
    },
    select: { id: true, programId: true, tierOrder: true, name: true },
  });
  const fromTier = tiers.find((tier) => tier.id === history.fromTierId);
  const toTier = tiers.find((tier) => tier.id === history.toTierId);
  if (!fromTier || !toTier)
    throw new Error("VIP communication tiers unavailable");
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      installationGeneration: true,
      storeAccessState: true,
      complianceState: true,
    },
  });
  if (
    !expectedInstallationGeneration ||
    store?.installationGeneration !== expectedInstallationGeneration ||
    store.storeAccessState !== "active" ||
    store.complianceState !== "active"
  )
    throw new Error("VIP communication installation unavailable");
  const event = createVipAchievementCommunication({
    storeId,
    programId,
    accountId,
    installationGeneration: expectedInstallationGeneration,
    history: { ...latest, toTierId: latest.toTierId },
    fromTier: { ...fromTier, storeId, rank: fromTier.tierOrder },
    toTier: { ...toTier, storeId, rank: toTier.tierOrder },
    policySnapshot,
  });
  return enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: vipAchievementCommunicationKey(event),
    loyaltyMaintenancePermit,
  });
}
