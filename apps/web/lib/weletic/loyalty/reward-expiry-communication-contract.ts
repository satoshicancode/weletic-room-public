import { createHash } from "node:crypto";
import { z } from "zod";
import { loyaltyCommunicationPolicySchema } from "./communications-contract";
import {
  canonicalizeLoyaltyDiscountCode,
  getPersistedLoyaltyDiscountProvisioningIdentity,
} from "./redemption-discount-identity";
import { readLoyaltyRedemptionProvisioningSnapshot } from "./redemption-provisioning-snapshot";
import {
  projectReferralBenefitReceiptEvidence,
  referralBenefitReceiptEvidenceSchema,
  type ReferralBenefitCommunicationInput,
} from "./referral-benefit-communication-contract";
import { rewardExpiryReminderWindow } from "./reward-expiry-window";
import {
  projectRewardReceiptEvidence,
  rewardReceiptEvidenceSchema,
  type RewardCommunicationInput,
} from "./reward-redeemed-communication-contract";

const identifier = z.string().min(1).max(191);
const receiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("redemption"),
      evidence: rewardReceiptEvidenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("referral_coupon"),
      evidence: referralBenefitReceiptEvidenceSchema.refine(
        (evidence) => evidence.benefitKind === "coupon",
      ),
    })
    .strict(),
]);
const base = z
  .object({
    version: z.literal(1),
    source: z.literal("reward_expiry_due"),
    journey: z.literal("reward_expiry"),
    storeId: identifier,
    programId: identifier,
    accountId: identifier,
    installationGeneration: z.string().min(1).max(64),
    redemptionId: identifier,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    dueAt: z.string().datetime(),
    occurredAt: z.string().datetime(),
    receipt: receiptSchema,
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: loyaltyCommunicationPolicySchema.refine(
      (policy) => policy.journey === "reward_expiry" && policy.enabled,
    ),
  })
  .strict();

function consistent(event: z.infer<typeof base>) {
  const evidence = event.receipt.evidence;
  const window = rewardExpiryReminderWindow({
    issuedAt: new Date(event.issuedAt),
    expiresAt: new Date(event.expiresAt),
  });
  return (
    !!window &&
    window.dueAt.toISOString() === event.dueAt &&
    new Date(event.occurredAt).getTime() >= window.dueAt.getTime() &&
    new Date(event.occurredAt).getTime() < window.expiresAt.getTime() &&
    event.storeId === evidence.storeId &&
    event.programId === evidence.programId &&
    event.accountId === evidence.accountId &&
    event.installationGeneration === evidence.installationGeneration &&
    (event.receipt.kind === "redemption"
      ? event.redemptionId === event.receipt.evidence.redemptionId &&
        !["gift_card", "store_credit"].includes(
          event.receipt.evidence.reward.type,
        ) &&
        new Date(event.issuedAt).getTime() >=
          new Date(event.receipt.evidence.ledgerCreatedAt).getTime()
      : event.redemptionId === event.receipt.evidence.receiptId &&
        event.issuedAt === event.receipt.evidence.occurredAt)
  );
}
export const rewardExpiryCommunicationSchema = base.refine(consistent);
export const rewardExpiryCommunicationJobSchema = base
  .extend({
    communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
  })
  .strict()
  .refine(consistent);
export type RewardExpiryCommunication = z.infer<
  typeof rewardExpiryCommunicationSchema
>;

export type RewardExpiryReceiptInput =
  | {
      kind: "redemption";
      input: Omit<
        RewardCommunicationInput,
        "policySnapshot" | "occurredAt" | "redemption"
      > & {
        redemption: RewardCommunicationInput["redemption"] & {
          expiresAt: Date | null;
          shopifyDiscountCode: string | null;
          shopifyDiscountCodeCanonical: string | null;
        };
      };
    }
  | {
      kind: "referral_coupon";
      input: Omit<ReferralBenefitCommunicationInput, "policySnapshot">;
    };

function unavailable(): never {
  throw new Error("Reward expiry communication evidence unavailable");
}

/** Local immutable receipt proof only. The sender must additionally establish
 * current remote usability, consent, privacy, admission and generation fences.
 * Stored-value artifacts require separate authoritative expiry/balance evidence. */
export function createRewardExpiryCommunication({
  receipt,
  policySnapshot,
  now,
}: {
  receipt: RewardExpiryReceiptInput;
  policySnapshot: RewardCommunicationInput["policySnapshot"];
  now: Date;
}): RewardExpiryCommunication {
  let projected: z.infer<typeof receiptSchema>;
  let issuedAt: string;
  let expiresAt: Date | null;
  let redemptionId: string;
  let artifactDigest: string;
  if (receipt.kind === "redemption") {
    const { input } = receipt;
    const { redemption } = input;
    const metadata = redemption.metadata as Record<string, unknown> | null;
    const issuance = z
      .string()
      .datetime()
      .safeParse(metadata?.rewardCommunicationIssuedAt);
    const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
      redemption.metadata,
    );
    if (
      !issuance.success ||
      !snapshot ||
      (metadata?.rewardSnapshot as Record<string, unknown> | undefined)
        ?.name !== snapshot.name ||
      redemption.artifactKind !== "discount_code" ||
      !redemption.shopifyDiscountCode ||
      !redemption.expiresAt ||
      snapshot.expiresAt !== redemption.expiresAt.toISOString() ||
      new Date(snapshot.startsAt).getTime() >
        new Date(issuance.data).getTime() ||
      redemption.shopifyDiscountCodeCanonical !==
        canonicalizeLoyaltyDiscountCode(redemption.shopifyDiscountCode) ||
      !getPersistedLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId: input.storeId,
          accountId: input.accountId,
          redemptionId: redemption.id,
          rewardDefinitionId: redemption.rewardDefinitionId,
          discountCode: redemption.shopifyDiscountCode,
        },
        metadata: redemption.metadata,
      })
    )
      unavailable();
    issuedAt = issuance.data;
    expiresAt = redemption.expiresAt;
    redemptionId = redemption.id;
    artifactDigest = discountArtifactDigest(
      redemption.shopifyDiscountId,
      redemption.shopifyDiscountCodeCanonical,
    );
    projected = {
      kind: "redemption",
      evidence: projectRewardReceiptEvidence(
        { ...input, occurredAt: new Date(issuedAt) },
        ["issued", "active"],
      ),
    };
  } else {
    const { input } = receipt;
    if (input.receipt.kind !== "coupon") unavailable();
    const evidence = projectReferralBenefitReceiptEvidence(input, [
      "issued",
      "active",
    ]);
    if (evidence.benefitKind !== "coupon") unavailable();
    issuedAt = evidence.occurredAt;
    expiresAt = input.receipt.redemption.expiresAt;
    redemptionId = evidence.receiptId;
    artifactDigest = discountArtifactDigest(
      input.receipt.redemption.shopifyDiscountId,
      input.receipt.redemption.shopifyDiscountCodeCanonical,
    );
    projected = { kind: "referral_coupon", evidence };
  }
  const window = rewardExpiryReminderWindow({
    issuedAt: new Date(issuedAt),
    expiresAt,
  });
  const evidence = projected.evidence;
  if (
    !window ||
    policySnapshot.storeId !== evidence.storeId ||
    policySnapshot.programId !== evidence.programId
  )
    unavailable();
  return rewardExpiryCommunicationSchema.parse({
    version: 1,
    source: "reward_expiry_due",
    journey: "reward_expiry",
    storeId: evidence.storeId,
    programId: evidence.programId,
    accountId: evidence.accountId,
    installationGeneration: evidence.installationGeneration,
    redemptionId,
    artifactDigest,
    issuedAt,
    expiresAt: window.expiresAt.toISOString(),
    dueAt: window.dueAt.toISOString(),
    occurredAt: now.toISOString(),
    receipt: projected,
    policyRevision: policySnapshot.revision,
    policy: policySnapshot.policy,
  });
}

function discountArtifactDigest(
  remoteId: string | null,
  canonicalCode: string | null,
) {
  if (!remoteId?.trim() || !canonicalCode) unavailable();
  return createHash("sha256")
    .update(JSON.stringify([remoteId, canonicalCode]))
    .digest("hex");
}

/** Content edits or retry timestamps cannot create another reminder occurrence. */
export function rewardExpiryCommunicationKey(event: RewardExpiryCommunication) {
  const parsed = rewardExpiryCommunicationSchema.parse(event);
  return `reward_expiry:${createHash("sha256")
    .update(
      JSON.stringify([
        parsed.storeId,
        parsed.installationGeneration,
        parsed.redemptionId,
        parsed.expiresAt,
      ]),
    )
    .digest("hex")}`;
}

export function matchesRewardExpiryCommunicationEvidence({
  event,
  receipt,
  now,
}: {
  event: RewardExpiryCommunication & { communicationDeliverySnapshot?: string };
  receipt: RewardExpiryReceiptInput;
  now: Date;
}) {
  try {
    const { communicationDeliverySnapshot: _retained, ...frozen } = event;
    const expected = rewardExpiryCommunicationSchema.parse(frozen);
    if (
      !Number.isFinite(now.getTime()) ||
      now.getTime() < new Date(event.occurredAt).getTime() ||
      now.getTime() >= new Date(event.expiresAt).getTime()
    )
      return false;
    const observed = createRewardExpiryCommunication({
      receipt,
      now: new Date(event.occurredAt),
      policySnapshot: {
        storeId: event.storeId,
        programId: event.programId,
        revision: event.policyRevision,
        policy: event.policy,
      },
    });
    return JSON.stringify(expected) === JSON.stringify(observed);
  } catch {
    return false;
  }
}
