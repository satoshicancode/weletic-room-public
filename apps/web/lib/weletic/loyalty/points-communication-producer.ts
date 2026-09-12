import type { Prisma, WeleticPointsLedgerEntry } from "@prisma/client";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import {
  createPurchasePointsCommunication,
  createSignupPointsCommunication,
  purchasePointsCommunicationKey,
  signupPointsCommunicationKey,
} from "./points-communication-contract";

/** Only call with the receipt from a new normal settlement, inside the same
 * store/program-fenced transaction. Never call from legacy adoption/backfill.
 * No external I/O, account creation, program activation or implicit opt-in. */
export async function enqueuePurchasePointsCommunication({
  tx,
  storeId,
  programId,
  receipt,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  receipt: {
    created: boolean;
    entry: Pick<
      WeleticPointsLedgerEntry,
      | "id"
      | "storeId"
      | "accountId"
      | "entryType"
      | "pointsDelta"
      | "referenceType"
      | "referenceId"
      | "createdAt"
      | "grantId"
    >;
  };
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!receipt.created) return null;
  const ledger = receipt.entry;
  if (
    ledger.storeId !== storeId ||
    ledger.entryType !== "EARN_ORDER" ||
    ledger.referenceType !== "COMMERCE_ORDER" ||
    !ledger.referenceId ||
    !ledger.grantId
  )
    throw new Error("Purchase communication source unavailable");
  if (ledger.pointsDelta <= BigInt(0)) return null;
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
    throw new Error("Purchase communication program unavailable");
  if (program.status !== "active" || program.killSwitchActive) return null;
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId,
    metadata: program.metadata,
    journey: "points_earned",
  });
  if (!policySnapshot?.policy.enabled) return null;
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { id: ledger.accountId, storeId, programId, status: "active" },
    select: { id: true },
  });
  if (!account) throw new Error("Purchase communication account unavailable");
  const grant = await tx.weleticLoyaltyEarnGrant.findFirst({
    where: {
      id: ledger.grantId,
      storeId,
      programId,
      accountId: ledger.accountId,
      orderId: ledger.referenceId,
    },
    select: { status: true, settledPoints: true },
  });
  if (!grant) throw new Error("Purchase communication settlement unavailable");
  if (
    !["settled", "partially_reversed"].includes(grant.status) ||
    grant.settledPoints <= BigInt(0)
  )
    return null;
  const order = await tx.weleticCommerceOrder.findFirst({
    where: { id: ledger.referenceId, storeId },
    select: { status: true },
  });
  if (!order) throw new Error("Purchase communication order unavailable");
  if (order.status !== "paid" && order.status !== "partially_refunded")
    return null;
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
    store.storeAccessState !== "active" ||
    store.complianceState !== "active"
  )
    throw new Error("Purchase communication installation unavailable");
  const event = createPurchasePointsCommunication({
    storeId,
    programId,
    accountId: ledger.accountId,
    installationGeneration: store.installationGeneration,
    ledger,
    policySnapshot,
    // Retain original ledger provenance, but do not announce points already
    // reversed by persisted refunds in this transaction. This is not a balance.
    eligiblePoints:
      grant.settledPoints < ledger.pointsDelta
        ? grant.settledPoints
        : ledger.pointsDelta,
  });
  return enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: purchasePointsCommunicationKey(event),
    loyaltyMaintenancePermit,
  });
}

/** The signup award transaction already holds the operational store/program
 * fences. Never call on historical adoption or with a reconstructed receipt. */
export async function enqueueSignupPointsCommunication({
  tx,
  storeId,
  receipt,
  loyaltyMaintenancePermit,
}: Omit<
  Parameters<typeof enqueuePurchasePointsCommunication>[0],
  "programId"
>) {
  if (!receipt.created) return null;
  const ledger = receipt.entry;
  if (
    ledger.storeId !== storeId ||
    ledger.entryType !== "EARN_BONUS" ||
    ledger.referenceType !== "SIGNUP_BONUS" ||
    ledger.referenceId !== ledger.accountId ||
    ledger.grantId
  )
    throw new Error("Signup communication source unavailable");
  if (ledger.pointsDelta <= BigInt(0)) return null;
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
    throw new Error("Signup communication program unavailable");
  if (program.status !== "active" || program.killSwitchActive) return null;
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId: program.id,
    metadata: program.metadata,
    journey: "points_earned",
  });
  if (!policySnapshot?.policy.enabled) return null;
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: {
      id: ledger.accountId,
      storeId,
      programId: program.id,
      status: "active",
    },
    select: { id: true },
  });
  if (!account) throw new Error("Signup communication account unavailable");
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
    store.storeAccessState !== "active" ||
    store.complianceState !== "active"
  )
    throw new Error("Signup communication installation unavailable");
  const event = createSignupPointsCommunication({
    storeId,
    programId: program.id,
    accountId: account.id,
    installationGeneration: store.installationGeneration,
    ledger,
    policySnapshot,
  });
  return enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: signupPointsCommunicationKey(event),
    loyaltyMaintenancePermit,
  });
}
