import { createHash } from "node:crypto";
import { z } from "zod";
import { loyaltyCommunicationPolicySchema } from "./communications-contract";
import { readLoyaltyRedemptionProvisioningSnapshot } from "./redemption-provisioning-snapshot";
import { readRewardCommunicationOrigin } from "./reward-communication-origin";

const identifier = z.string().min(1).max(191);
const points = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );
const base = z
  .object({
    version: z.literal(1),
    journey: z.literal("reward_redeemed"),
    source: z.literal("reward_issuance_confirmed"),
    storeId: identifier,
    programId: identifier,
    accountId: identifier,
    installationGeneration: z.string().min(1).max(64),
    redemptionId: identifier,
    ledgerEntryId: identifier,
    ledgerCreatedAt: z.string().datetime(),
    pointsSpent: points,
    provisioningDigest: z.string().regex(/^[A-F0-9]{64}$/),
    reward: z
      .object({
        name: z
          .string()
          .min(1)
          .max(191)
          .refine(
            (value) =>
              value.trim().length > 0 &&
              !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value),
          ),
        type: z.enum([
          "amount_off",
          "percentage_off",
          "free_shipping",
          "free_product",
          "gift_card",
          "store_credit",
        ]),
        value: z
          .string()
          .regex(/^\d+(?:\.\d+)?$/)
          .nullable(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    occurredAt: z.string().datetime(),
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: loyaltyCommunicationPolicySchema.refine(
      (policy) => policy.journey === "reward_redeemed",
    ),
  })
  .strict();

export const rewardRedeemedCommunicationSchema = base;
export const rewardReceiptEvidenceSchema = base.pick({
  storeId: true,
  programId: true,
  accountId: true,
  installationGeneration: true,
  redemptionId: true,
  ledgerEntryId: true,
  ledgerCreatedAt: true,
  pointsSpent: true,
  provisioningDigest: true,
  reward: true,
});
export const rewardRedeemedCommunicationJobSchema = base
  .extend({
    communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
  })
  .strict();
export type RewardRedeemedCommunication = z.infer<typeof base>;

/** Construct only after the caller wins provisioning -> issued in the same
 * fenced transaction. A reserved debit alone is not successful redemption.
 * This validates source evidence, not staff authority or permission to send. */
export type RewardCommunicationInput = {
  storeId: string;
  programId: string;
  accountId: string;
  installationGeneration: string;
  occurredAt: Date;
  redemption: {
    id: string;
    storeId: string;
    accountId: string | null;
    rewardDefinitionId: string;
    status: string;
    artifactKind: string;
    pointsSpent: bigint;
    ledgerEntryId: string | null;
    fulfillmentSource: string | null;
    settlementQuarantinedAt: Date | null;
    shopifyDiscountId: string | null;
    shopifyGiftCardId: string | null;
    shopifyStoreCreditTransactionId: string | null;
    metadata: unknown;
  };
  ledger: {
    id: string;
    storeId: string;
    accountId: string;
    entryType: string;
    referenceType: string | null;
    referenceId: string | null;
    pointsDelta: bigint;
    createdAt: Date;
  };
  policySnapshot: {
    storeId: string;
    programId: string;
    revision: string;
    policy: unknown;
  };
};

export function createRewardRedeemedCommunication(
  input: RewardCommunicationInput,
): RewardRedeemedCommunication {
  return projectRewardCommunication(input, ["issued"]);
}

function projectRewardCommunication(
  input: RewardCommunicationInput,
  acceptedStatuses: readonly string[],
): RewardRedeemedCommunication {
  const evidence = projectRewardReceiptEvidence(input, acceptedStatuses);
  if (
    input.policySnapshot.storeId !== input.storeId ||
    input.policySnapshot.programId !== input.programId
  )
    throw new Error("Reward communication evidence unavailable");
  return base.parse({
    version: 1,
    journey: "reward_redeemed",
    source: "reward_issuance_confirmed",
    ...evidence,
    occurredAt: input.occurredAt.toISOString(),
    policyRevision: input.policySnapshot.revision,
    policy: input.policySnapshot.policy,
  });
}

/** Policy-independent receipt projection. Validates economic provenance, not
 * permission to notify. Other journeys must provide their own event/policy and
 * current eligibility checks rather than fabricate an issuance notification. */
export function projectRewardReceiptEvidence(
  input: Omit<RewardCommunicationInput, "policySnapshot">,
  acceptedStatuses: readonly string[],
) {
  const { redemption, ledger } = input;
  const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
    redemption.metadata,
  );
  const origin = snapshot
    ? readRewardCommunicationOrigin({
        metadata: redemption.metadata,
        storeId: input.storeId,
        accountId: input.accountId,
        redemptionId: redemption.id,
        provisioningDigest: snapshot.contentDigest,
      })
    : null;
  const expectedArtifact =
    snapshot?.rewardType === "gift_card"
      ? "gift_card"
      : snapshot?.rewardType === "store_credit"
        ? "store_credit"
        : "discount_code";
  const remoteId =
    expectedArtifact === "gift_card"
      ? redemption.shopifyGiftCardId
      : expectedArtifact === "store_credit"
        ? redemption.shopifyStoreCreditTransactionId
        : redemption.shopifyDiscountId;
  if (
    !snapshot ||
    !origin ||
    origin.installationGeneration !== input.installationGeneration ||
    !remoteId?.trim() ||
    redemption.artifactKind !== expectedArtifact ||
    !acceptedStatuses.includes(redemption.status) ||
    redemption.fulfillmentSource !== null ||
    redemption.settlementQuarantinedAt !== null ||
    redemption.storeId !== input.storeId ||
    redemption.accountId !== input.accountId ||
    ledger.storeId !== input.storeId ||
    ledger.accountId !== input.accountId ||
    ledger.id !== redemption.ledgerEntryId ||
    ledger.entryType !== "REDEEM_REWARD" ||
    ledger.referenceType !== "REWARD_REDEMPTION" ||
    ledger.referenceId !== redemption.id ||
    ledger.pointsDelta !== -redemption.pointsSpent ||
    redemption.pointsSpent <= BigInt(0) ||
    snapshot.rewardDefinitionId !== redemption.rewardDefinitionId ||
    BigInt(snapshot.pointsCost) !== redemption.pointsSpent ||
    !Number.isFinite(input.occurredAt.getTime()) ||
    !Number.isFinite(ledger.createdAt.getTime()) ||
    input.occurredAt.getTime() < ledger.createdAt.getTime()
  )
    throw new Error("Reward communication evidence unavailable");
  // Keep legacy merchant controls out of email headers without modifying the
  // original immutable financial snapshot. No code, URL or remote ID is copied.
  const name =
    snapshot.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim() ||
    "Reward";
  return rewardReceiptEvidenceSchema.parse({
    storeId: input.storeId,
    programId: input.programId,
    accountId: input.accountId,
    installationGeneration: input.installationGeneration,
    redemptionId: redemption.id,
    ledgerEntryId: ledger.id,
    ledgerCreatedAt: ledger.createdAt.toISOString(),
    pointsSpent: redemption.pointsSpent.toString(),
    provisioningDigest: snapshot.contentDigest,
    reward: {
      name,
      type: snapshot.rewardType,
      value: snapshot.discountValue,
      currency: snapshot.shopCurrency,
    },
  });
}

/** Compare retained issuance evidence, never create a new notice on later use.
 * Caller separately proves account/program/generation and current eligibility. */
export function matchesRewardCommunicationEvidence({
  event,
  redemption,
  ledger,
}: {
  event: RewardRedeemedCommunication & {
    communicationDeliverySnapshot?: string;
  };
  redemption: RewardCommunicationInput["redemption"];
  ledger: RewardCommunicationInput["ledger"];
}) {
  try {
    const { communicationDeliverySnapshot: _retained, ...frozen } = event;
    const expected = base.parse(frozen);
    const observed = projectRewardCommunication(
      {
        storeId: event.storeId,
        programId: event.programId,
        accountId: event.accountId,
        installationGeneration: event.installationGeneration,
        occurredAt: new Date(event.occurredAt),
        redemption,
        ledger,
        policySnapshot: {
          storeId: event.storeId,
          programId: event.programId,
          revision: event.policyRevision,
          policy: event.policy,
        },
      },
      ["issued", "active", "used"],
    );
    return JSON.stringify(expected) === JSON.stringify(observed);
  } catch {
    return false;
  }
}

export function rewardRedeemedCommunicationKey(
  event: RewardRedeemedCommunication,
) {
  const value = base.parse(event);
  return `reward-redeemed:${createHash("sha256")
    .update(
      JSON.stringify([
        value.storeId,
        value.installationGeneration,
        value.accountId,
        value.redemptionId,
      ]),
    )
    .digest("hex")}`;
}
