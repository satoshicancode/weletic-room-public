import { createLoyaltyRedemptionProvisioningSnapshot } from "../../lib/weletic/loyalty/redemption-provisioning-snapshot";
import { createRewardCommunicationOrigin } from "../../lib/weletic/loyalty/reward-communication-origin";
import type { createRewardRedeemedCommunication } from "../../lib/weletic/loyalty/reward-redeemed-communication-contract";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

type Input = Parameters<typeof createRewardRedeemedCommunication>[0];
export function rewardCommunicationFixture(
  type = "amount_off",
  name = "Original reward",
  points = "9007199254740993",
): Input & {
  policySnapshot: Input["policySnapshot"] & {
    policy: ReturnType<typeof createDefaultLoyaltyCommunicationPolicy>;
  };
} {
  const cost = BigInt(points);
  const createdAt = new Date("2026-09-12T00:00:00Z");
  const snapshot = createLoyaltyRedemptionProvisioningSnapshot({
    reward: { id: "reward", name, rewardType: type },
    pointsCost: cost,
    discountValue:
      type === "free_product" || type === "free_shipping"
        ? null
        : type === "percentage_off"
          ? "12.34"
          : "1234",
    expiresInDays: null,
    shopCurrency: "USD",
    currencyVerifiedAt: createdAt,
    customerSelectionDigest: "A".repeat(64),
    startsAt: createdAt,
    expiresAt: null,
  });
  return {
    storeId: "store",
    programId: "program",
    accountId: "account",
    installationGeneration: "generation",
    occurredAt: new Date("2026-09-12T00:01:00Z"),
    redemption: {
      id: "redemption",
      storeId: "store",
      accountId: "account",
      rewardDefinitionId: "reward",
      status: "issued",
      artifactKind:
        type === "gift_card"
          ? "gift_card"
          : type === "store_credit"
            ? "store_credit"
            : "discount_code",
      pointsSpent: cost,
      ledgerEntryId: "ledger",
      fulfillmentSource: null,
      settlementQuarantinedAt: null,
      shopifyDiscountId:
        type === "gift_card" || type === "store_credit"
          ? null
          : "private-discount-id",
      shopifyGiftCardId: type === "gift_card" ? "private-gift-id" : null,
      shopifyStoreCreditTransactionId:
        type === "store_credit" ? "private-credit-id" : null,
      metadata: {
        provisioningSnapshot: snapshot,
        rewardCommunicationOrigin: createRewardCommunicationOrigin({
          storeId: "store",
          accountId: "account",
          redemptionId: "redemption",
          installationGeneration: "generation",
          provisioningDigest: snapshot.contentDigest,
        }),
      },
    },
    ledger: {
      id: "ledger",
      storeId: "store",
      accountId: "account",
      entryType: "REDEEM_REWARD",
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption",
      pointsDelta: -cost,
      createdAt,
    },
    policySnapshot: {
      storeId: "store",
      programId: "program",
      revision: "a".repeat(64),
      policy: {
        ...createDefaultLoyaltyCommunicationPolicy("reward_redeemed"),
        enabled: true,
      },
    },
  } satisfies Input;
}
