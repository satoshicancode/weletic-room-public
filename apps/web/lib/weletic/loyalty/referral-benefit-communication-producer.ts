import type { Prisma } from "@prisma/client";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import {
  createReferralBenefitCommunication,
  referralCommunicationKey,
} from "./referral-benefit-communication-contract";
import type { ReferralCommunicationIdentity } from "./referral-communication-origin";
import {
  assertReferralCommunicationOrigin,
  ReferralCommunicationOriginBlockedError,
} from "./referral-communication-origin-fence";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

/** Caller owns the store/program lock and winning benefit transition in this
 * transaction. A queue failure rolls back that transition. No provider I/O. */
export async function enqueueReferralBenefitCommunication({
  tx,
  identity,
  expectedInstallationGeneration,
  receipt,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  identity: ReferralCommunicationIdentity;
  expectedInstallationGeneration: string;
  receipt: { created: boolean; kind: "points" | "coupon"; id: string };
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!receipt.created) return null;
  const referral = await tx.weleticLoyaltyReferral.findFirst({
    where: { id: identity.referralId, storeId: identity.storeId },
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
  if (!referral) throw new Error("Referral communication source unavailable");
  const origin = await assertReferralCommunicationOrigin({
    tx,
    metadata: referral.metadata,
    identity,
    loyaltyMaintenancePermit,
  });
  if (!origin) return null;
  if (
    origin.installationGeneration !== expectedInstallationGeneration ||
    origin.kind !== receipt.kind
  )
    throw new ReferralCommunicationOriginBlockedError(
      new Error("Referral communication receipt origin unavailable"),
    );
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId: identity.storeId },
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
    program.id !== identity.programId ||
    program.storeId !== identity.storeId
  )
    throw new Error("Referral communication program unavailable");
  if (program.status !== "active" || program.killSwitchActive) return null;
  const policySnapshot = snapshotLoyaltyCommunicationPolicy({
    storeId: identity.storeId,
    programId: identity.programId,
    metadata: program.metadata,
    journey:
      identity.side === "advocate" ? "referral_advocate" : "referral_friend",
  });
  if (!policySnapshot?.policy.enabled) return null;
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: {
      id: identity.accountId,
      storeId: identity.storeId,
      programId: identity.programId,
      status: "active",
    },
    select: { id: true, metadata: true },
  });
  if (!account || hasShopifyCustomerRedactionTombstone(account.metadata))
    throw new Error("Referral communication account unavailable");
  const where = {
    id: receipt.id,
    storeId: identity.storeId,
    accountId: identity.accountId,
  };
  let benefit;
  if (receipt.kind === "points") {
    const ledger = await tx.weleticPointsLedgerEntry.findFirst({
      where,
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
    if (!ledger)
      throw new Error("Referral communication points receipt unavailable");
    benefit = { kind: "points" as const, ledger };
  } else {
    const redemption = await tx.weleticRewardRedemption.findFirst({
      where,
      select: {
        id: true,
        storeId: true,
        accountId: true,
        rewardDefinitionId: true,
        status: true,
        artifactKind: true,
        pointsSpent: true,
        ledgerEntryId: true,
        shopifyDiscountId: true,
        shopifyDiscountCode: true,
        shopifyDiscountCodeCanonical: true,
        idempotencyKey: true,
        settlementQuarantinedAt: true,
        metadata: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    if (!redemption)
      throw new Error("Referral communication coupon receipt unavailable");
    benefit = { kind: "coupon" as const, redemption };
  }
  const event = createReferralBenefitCommunication({
    identity,
    expectedInstallationGeneration,
    referral,
    receipt: benefit,
    policySnapshot,
  });
  return enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId: identity.storeId,
    jobType: "LOYALTY_COMMUNICATION",
    payload: event,
    idempotencyKey: referralCommunicationKey(event),
    loyaltyMaintenancePermit,
  });
}
