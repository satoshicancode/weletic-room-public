import { z } from "zod";
import { loyaltyCommunicationPolicySchema } from "./communications-contract";
import { canonicalizeLoyaltyDiscountCode } from "./redemption-discount-identity";
import {
  readReferralCommunicationOrigin,
  referralBenefitCommunicationKey,
  referralCommunicationOriginSchema,
  type ReferralCommunicationIdentity,
} from "./referral-communication-origin";
import { getReferralCouponIdempotencyKey } from "./referral-coupon-idempotency";
import { parseReferralCouponRewardSnapshotForIdentity } from "./referral-coupon-snapshot";

const identifier = z.string().min(1).max(191);
const common = z.object({
  version: z.literal(1),
  source: z.literal("referral_benefit_confirmed"),
  journey: z.enum(["referral_friend", "referral_advocate"]),
  storeId: identifier,
  programId: identifier,
  accountId: identifier,
  installationGeneration: z.string().min(1).max(64),
  origin: referralCommunicationOriginSchema,
  receiptId: identifier,
  receiptCreatedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
  policy: loyaltyCommunicationPolicySchema,
});
const points = common.extend({
  benefitKind: z.literal("points"),
  points: z.string().regex(/^[1-9][0-9]{0,18}$/),
});
const coupon = common.extend({
  benefitKind: z.literal("coupon"),
  reward: z
    .object({
      name: z.string().min(1).max(191),
      type: z.enum([
        "amount_off",
        "percentage_off",
        "free_shipping",
        "free_product",
      ]),
      value: z
        .string()
        .regex(/^\d+(?:\.\d+)?$/)
        .nullable(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict(),
});
const receiptPoints = points.omit({ policyRevision: true, policy: true });
const receiptCoupon = coupon.omit({ policyRevision: true, policy: true });
function consistentReceipt(
  event: z.infer<typeof receiptPoints> | z.infer<typeof receiptCoupon>,
) {
  const { origin } = event;
  return (
    event.storeId === origin.storeId &&
    event.programId === origin.programId &&
    event.accountId === origin.accountId &&
    event.installationGeneration === origin.installationGeneration &&
    event.benefitKind === origin.kind &&
    event.journey ===
      (origin.side === "advocate" ? "referral_advocate" : "referral_friend") &&
    new Date(event.receiptCreatedAt).getTime() >=
      new Date(origin.qualifiedAt).getTime() &&
    new Date(event.occurredAt).getTime() >=
      new Date(event.receiptCreatedAt).getTime() &&
    (event.benefitKind !== "points" ||
      (origin.kind === "points" &&
        event.points === origin.points &&
        event.occurredAt === event.receiptCreatedAt))
  );
}
export const referralBenefitReceiptEvidenceSchema = z
  .discriminatedUnion("benefitKind", [
    receiptPoints.strict(),
    receiptCoupon.strict(),
  ])
  .refine(consistentReceipt);
function consistent(event: z.infer<typeof points> | z.infer<typeof coupon>) {
  return consistentReceipt(event) && event.policy.journey === event.journey;
}
export const referralBenefitCommunicationSchema = z
  .discriminatedUnion("benefitKind", [points.strict(), coupon.strict()])
  .refine(consistent);
export const referralBenefitCommunicationJobSchema = z
  .discriminatedUnion("benefitKind", [
    points
      .extend({
        communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
      })
      .strict(),
    coupon
      .extend({
        communicationDeliverySnapshot: z.string().max(1_000_000).optional(),
      })
      .strict(),
  ])
  .refine(consistent);
export type ReferralBenefitCommunication = z.infer<
  typeof referralBenefitCommunicationSchema
>;

export type ReferralBenefitRecord = {
  id: string;
  storeId: string;
  advocateAccountId: string;
  refereeAccountId: string | null;
  status: string;
  qualifyingOrderId: string | null;
  advocatePointsAwarded: bigint;
  refereePointsAwarded: bigint;
  metadata: unknown;
};
export type ReferralPointsReceipt = {
  id: string;
  storeId: string;
  accountId: string;
  entryType: string;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  pointsDelta: bigint;
  grantId: string | null;
  metadata: unknown;
  createdAt: Date;
};
export type ReferralCouponReceipt = {
  id: string;
  storeId: string;
  accountId: string | null;
  rewardDefinitionId: string;
  idempotencyKey: string | null;
  shopifyDiscountCode: string | null;
  shopifyDiscountCodeCanonical: string | null;
  status: string;
  artifactKind: string;
  pointsSpent: bigint;
  ledgerEntryId: string | null;
  shopifyDiscountId: string | null;
  settlementQuarantinedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  expiresAt: Date | null;
};
export type ReferralBenefitCommunicationInput = {
  identity: ReferralCommunicationIdentity;
  expectedInstallationGeneration: string;
  referral: ReferralBenefitRecord;
  policySnapshot: {
    storeId: string;
    programId: string;
    revision: string;
    policy: unknown;
  };
  receipt:
    | { kind: "points"; ledger: ReferralPointsReceipt }
    | { kind: "coupon"; redemption: ReferralCouponReceipt };
};
type Input = ReferralBenefitCommunicationInput;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function unavailable(): never {
  throw new Error("Referral communication benefit evidence unavailable");
}

/** Only the winning ledger award / coupon issuance transition may call this.
 * This validates persisted benefit evidence, not authorization to send mail. */
export function createReferralBenefitCommunication(
  input: Input,
): ReferralBenefitCommunication {
  return project(input, ["issued"]);
}
function project(
  input: Input,
  couponStatuses: readonly string[],
): ReferralBenefitCommunication {
  const { identity, policySnapshot } = input;
  if (
    policySnapshot.storeId !== identity.storeId ||
    policySnapshot.programId !== identity.programId
  )
    unavailable();
  return referralBenefitCommunicationSchema.parse({
    ...projectReferralBenefitReceiptEvidence(input, couponStatuses),
    policyRevision: policySnapshot.revision,
    policy: policySnapshot.policy,
  });
}

/** Validates original benefit evidence independently of notification policy.
 * Callers must separately authorize the journey and current delivery eligibility. */
export function projectReferralBenefitReceiptEvidence(
  input: Omit<Input, "policySnapshot">,
  couponStatuses: readonly string[],
) {
  const { identity, referral, receipt } = input;
  const metadata = object(referral.metadata);
  const invalidatedOrders = metadata.invalidatedQualificationOrderIds;
  if (
    invalidatedOrders !== undefined &&
    (!Array.isArray(invalidatedOrders) ||
      invalidatedOrders.some((value) => typeof value !== "string") ||
      invalidatedOrders.includes(identity.qualificationOrderId))
  )
    unavailable();
  const origin = readReferralCommunicationOrigin({
    metadata: referral.metadata,
    identity,
  });
  if (
    !origin ||
    origin.installationGeneration !== input.expectedInstallationGeneration ||
    origin.kind !== receipt.kind ||
    referral.id !== identity.referralId ||
    referral.storeId !== identity.storeId ||
    referral.qualifyingOrderId !== identity.qualificationOrderId ||
    metadata.qualificationOrderId !== identity.qualificationOrderId ||
    !["qualified", "rewarded"].includes(referral.status) ||
    (origin.side === "advocate"
      ? referral.advocateAccountId
      : referral.refereeAccountId) !== identity.accountId
  )
    unavailable();
  const frozen = {
    version: 1,
    source: "referral_benefit_confirmed",
    journey:
      origin.side === "advocate" ? "referral_advocate" : "referral_friend",
    storeId: origin.storeId,
    programId: origin.programId,
    accountId: origin.accountId,
    installationGeneration: origin.installationGeneration,
    origin,
  };
  if (receipt.kind === "points") {
    if (origin.kind !== "points") unavailable();
    const ledger = receipt.ledger;
    const ledgerMetadata = object(ledger.metadata);
    const friendClaim = origin.qualificationPath === "preissued_friend_claim";
    const key = friendClaim
      ? `referral_friend_advocate:${origin.referralId}:${origin.qualificationOrderId}`
      : `referral_${origin.side}:${origin.referralId}:${origin.qualificationOrderId}`;
    if (
      ledger.storeId !== origin.storeId ||
      ledger.accountId !== origin.accountId ||
      ledger.entryType !== "EARN_REFERRAL" ||
      ledger.referenceType !==
        (friendClaim ? "referral_friend_claim" : "referral") ||
      ledger.referenceId !== origin.referralId ||
      ledger.idempotencyKey !== key ||
      ledger.grantId !== null ||
      ledger.pointsDelta !== BigInt(origin.points) ||
      (origin.side === "advocate"
        ? referral.advocatePointsAwarded
        : referral.refereePointsAwarded) !== ledger.pointsDelta ||
      ledgerMetadata.referralId !== origin.referralId ||
      ledgerMetadata.orderId !== origin.qualificationOrderId
    )
      unavailable();
    return referralBenefitReceiptEvidenceSchema.parse({
      ...frozen,
      benefitKind: "points",
      points: origin.points,
      receiptId: ledger.id,
      receiptCreatedAt: ledger.createdAt.toISOString(),
      occurredAt: ledger.createdAt.toISOString(),
    });
  }
  if (origin.kind !== "coupon") unavailable();
  const redemption = receipt.redemption;
  const redemptionMetadata = object(redemption.metadata);
  const snapshotIdentity = {
    ...identity,
    rewardDefinitionId: origin.rewardDefinitionId,
  };
  const snapshot = parseReferralCouponRewardSnapshotForIdentity(
    redemptionMetadata.rewardSnapshot,
    snapshotIdentity,
  );
  const authoritative = parseReferralCouponRewardSnapshotForIdentity(
    object(metadata.referralCouponRewardSnapshots)[origin.side],
    snapshotIdentity,
  );
  const issuedAt = z
    .string()
    .datetime()
    .safeParse(redemptionMetadata.referralCommunicationIssuedAt);
  if (
    !issuedAt.success ||
    redemption.storeId !== origin.storeId ||
    redemption.accountId !== origin.accountId ||
    redemption.rewardDefinitionId !== origin.rewardDefinitionId ||
    redemption.idempotencyKey !== getReferralCouponIdempotencyKey(origin) ||
    redemption.shopifyDiscountCode !== snapshot.discountCode ||
    redemption.shopifyDiscountCodeCanonical !==
      canonicalizeLoyaltyDiscountCode(snapshot.discountCode) ||
    redemptionMetadata.shopifyDiscountOwnershipFingerprint !==
      snapshot.ownershipFingerprint ||
    redemptionMetadata.shopifyDiscountProvisioningName !==
      snapshot.provisioningName ||
    redemptionMetadata.shopifyDiscountExpectedTitle !==
      snapshot.expectedTitle ||
    !couponStatuses.includes(redemption.status) ||
    redemption.artifactKind !== "discount_code" ||
    redemption.pointsSpent !== BigInt(0) ||
    redemption.ledgerEntryId !== null ||
    !redemption.shopifyDiscountId?.trim() ||
    redemption.settlementQuarantinedAt !== null ||
    redemptionMetadata.referralId !== origin.referralId ||
    redemptionMetadata.qualificationOrderId !== origin.qualificationOrderId ||
    redemptionMetadata.referralSide !== origin.side ||
    snapshot.contentDigest !== origin.rewardSnapshotDigest ||
    authoritative.contentDigest !== snapshot.contentDigest ||
    snapshot.qualifiedAt !== origin.qualifiedAt ||
    (redemption.expiresAt?.toISOString() ?? null) !== snapshot.expiresAt ||
    (redemption.expiresAt &&
      redemption.expiresAt.getTime() <= new Date(issuedAt.data).getTime())
  )
    unavailable();
  const name =
    snapshot.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim() ||
    "Reward";
  return referralBenefitReceiptEvidenceSchema.parse({
    ...frozen,
    benefitKind: "coupon",
    receiptId: redemption.id,
    receiptCreatedAt: redemption.createdAt.toISOString(),
    occurredAt: issuedAt.data,
    reward: {
      name,
      type: snapshot.rewardType,
      value: snapshot.discountValue,
      currency: snapshot.shopCurrency,
    },
  });
}

/** Retained content is compared to original receipts, never today's policy. */
export function matchesReferralBenefitCommunicationEvidence({
  event,
  referral,
  receipt,
}: {
  event: ReferralBenefitCommunication & {
    communicationDeliverySnapshot?: string;
  };
  referral: ReferralBenefitRecord;
  receipt: Input["receipt"];
}) {
  try {
    const { communicationDeliverySnapshot: _retained, ...frozen } = event;
    const expected = referralBenefitCommunicationSchema.parse(frozen);
    const observed = project(
      {
        identity: event.origin,
        expectedInstallationGeneration: event.installationGeneration,
        referral,
        receipt,
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
export function referralCommunicationKey(event: ReferralBenefitCommunication) {
  const parsed = referralBenefitCommunicationSchema.parse(event);
  return referralBenefitCommunicationKey(parsed.origin, parsed.receiptId);
}
