import type { Prisma } from "@prisma/client";
import {
  birthdayCommunicationKey,
  createBirthdayCommunication,
} from "./birthday-communication-contract";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";

/** Caller owns the existing store/program-fenced birthday award transaction.
 * Only its actual ledger receipt can establish that this is a fresh award. */
export async function enqueueBirthdayCommunication({
  tx,
  storeId,
  calendarYear,
  receipt,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  calendarYear: number;
  receipt: {
    created: boolean;
    entry: Parameters<typeof createBirthdayCommunication>[0]["ledger"];
  };
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!receipt.created) return null;
  const ledger = receipt.entry;
  if (
    ledger.storeId !== storeId ||
    ledger.entryType !== "EARN_BONUS" ||
    ledger.referenceType !== "BIRTHDAY_REWARD" ||
    ledger.referenceId !== String(calendarYear) ||
    ledger.idempotencyKey !== `birthday:${ledger.accountId}:${calendarYear}` ||
    ledger.grantId
  )
    throw new Error("Birthday communication source unavailable");
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
    throw new Error("Birthday communication program unavailable");
  if (program.status !== "active" || program.killSwitchActive) return null;
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId,
    programId: program.id,
    metadata: program.metadata,
    journey: "birthday",
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
  if (!account) throw new Error("Birthday communication account unavailable");
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
    throw new Error("Birthday communication installation unavailable");
  const event = createBirthdayCommunication({
    storeId,
    programId: program.id,
    accountId: account.id,
    installationGeneration: store.installationGeneration,
    calendarYear,
    ledger,
    policySnapshot,
  });
  return enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: birthdayCommunicationKey(event),
    loyaltyMaintenancePermit,
  });
}
