import type { createReferralBenefitCommunication } from "../../lib/weletic/loyalty/referral-benefit-communication-contract";
import { createReferralCommunicationOrigin } from "../../lib/weletic/loyalty/referral-communication-origin";
import { getReferralCouponIdempotencyKey } from "../../lib/weletic/loyalty/referral-coupon-idempotency";
import { createReferralCouponRewardSnapshot } from "../../lib/weletic/loyalty/referral-coupon-snapshot";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

type Input = Parameters<typeof createReferralBenefitCommunication>[0];
export function referralBenefitFixture(
  kind: "points" | "coupon" = "points",
  side: "advocate" | "referee" = "advocate",
  path: "account_referral" | "preissued_friend_claim" = "account_referral",
): Input {
  const identity = {
    storeId: "store",
    programId: "program",
    referralId: "referral",
    qualificationOrderId: "order",
    accountId: "account",
    side,
  };
  const qualifiedAt = new Date("2026-09-13T00:00:00.000Z");
  const createdAt = new Date("2026-09-13T00:00:01.000Z");
  const issuedAt = "2026-09-13T00:00:02.000Z";
  const points = BigInt("9007199254740993");
  const snapshot = createReferralCouponRewardSnapshot({
    identity: { ...identity, rewardDefinitionId: "reward" },
    reward: {
      id: "reward",
      name: "Original referral reward",
      description: null,
      rewardType: "amount_off",
      discountValue: "1234",
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: "entire_order",
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: 1,
      usageLimitPerCustomer: 1,
      expiresInDays: 30,
    },
    qualifiedAt,
    shopCurrency: "USD",
    currencyVerifiedAt: qualifiedAt,
    shopifyCustomerId: "gid://shopify/Customer/private-customer",
  });
  const origin = createReferralCommunicationOrigin({
    ...identity,
    installationGeneration: "generation",
    qualificationPath: path,
    qualifiedAt: qualifiedAt.toISOString(),
    ...(kind === "points"
      ? { kind, points: points.toString() }
      : {
          kind,
          rewardDefinitionId: "reward",
          rewardSnapshotDigest: snapshot.contentDigest,
        }),
  });
  return {
    identity,
    expectedInstallationGeneration: "generation",
    referral: {
      id: "referral",
      storeId: "store",
      status: "qualified",
      qualifyingOrderId: "order",
      advocateAccountId:
        side === "advocate" ? "account" : "private-other-account",
      refereeAccountId:
        side === "referee" ? "account" : "private-other-account",
      advocatePointsAwarded:
        kind === "points" && side === "advocate" ? points : BigInt(0),
      refereePointsAwarded:
        kind === "points" && side === "referee" ? points : BigInt(0),
      metadata: {
        qualificationOrderId: "order",
        referralCommunicationOrigins: { [side]: origin },
        referralCouponRewardSnapshots:
          kind === "coupon" ? { [side]: snapshot } : {},
      },
    },
    policySnapshot: {
      storeId: "store",
      programId: "program",
      revision: "a".repeat(64),
      policy: {
        ...createDefaultLoyaltyCommunicationPolicy(
          side === "advocate" ? "referral_advocate" : "referral_friend",
        ),
        enabled: true,
      },
    },
    receipt:
      kind === "points"
        ? {
            kind,
            ledger: {
              id: "ledger",
              storeId: "store",
              accountId: "account",
              entryType: "EARN_REFERRAL",
              referenceType:
                path === "preissued_friend_claim"
                  ? "referral_friend_claim"
                  : "referral",
              referenceId: "referral",
              idempotencyKey: `referral_${path === "preissued_friend_claim" ? "friend_advocate" : side}:referral:order`,
              pointsDelta: points,
              grantId: null,
              createdAt,
              metadata: {
                referralId: "referral",
                orderId: "order",
                otherAccountId: "private-other-account",
              },
            },
          }
        : {
            kind,
            redemption: {
              id: "redemption",
              storeId: "store",
              accountId: "account",
              rewardDefinitionId: "reward",
              idempotencyKey: getReferralCouponIdempotencyKey(identity),
              shopifyDiscountCode: snapshot.discountCode,
              shopifyDiscountCodeCanonical: snapshot.discountCode,
              status: "issued",
              artifactKind: "discount_code",
              pointsSpent: BigInt(0),
              ledgerEntryId: null,
              shopifyDiscountId: "private-remote-id",
              settlementQuarantinedAt: null,
              createdAt,
              expiresAt: new Date(snapshot.expiresAt!),
              metadata: {
                referralId: "referral",
                qualificationOrderId: "order",
                referralSide: side,
                rewardSnapshot: snapshot,
                referralCommunicationIssuedAt: issuedAt,
                shopifyDiscountOwnershipFingerprint:
                  snapshot.ownershipFingerprint,
                shopifyDiscountProvisioningName: snapshot.provisioningName,
                shopifyDiscountExpectedTitle: snapshot.expectedTitle,
              },
            },
          },
  };
}
