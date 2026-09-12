import { createLoyaltyDiscountProvisioningIdentity } from "../../lib/weletic/loyalty/redemption-discount-identity";
import { getShopifyCustomerSelectionDigest } from "../../lib/weletic/loyalty/redemption-provisioning-snapshot";
import type { RewardExpiryReceiptInput } from "../../lib/weletic/loyalty/reward-expiry-communication-contract";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";
import { referralBenefitFixture } from "./referral-benefit-communication-fixture";
import { rewardCommunicationFixture } from "./reward-communication-fixture";

export function rewardExpiryCommunicationFixture(
  kind: RewardExpiryReceiptInput["kind"] = "redemption",
) {
  let receipt: RewardExpiryReceiptInput;
  if (kind === "redemption") {
    const expiry = new Date("2026-10-13T00:00:00.000Z");
    const {
      policySnapshot: _policy,
      occurredAt,
      ...input
    } = rewardCommunicationFixture(
      "amount_off",
      "Original reward",
      "9007199254740993",
      expiry,
      getShopifyCustomerSelectionDigest({
        storeId: "store",
        shopifyCustomerId: "gid://shopify/Customer/private-customer",
      }),
    );
    const code = "PRIVATE-REWARD-CODE";
    receipt = {
      kind,
      input: {
        ...input,
        redemption: {
          ...input.redemption,
          expiresAt: expiry,
          shopifyDiscountCode: code,
          shopifyDiscountCodeCanonical: code,
          metadata: {
            ...(input.redemption.metadata as Record<string, unknown>),
            rewardCommunicationIssuedAt: occurredAt.toISOString(),
            rewardSnapshot: { name: "Original reward" },
            shopifyDiscountOwnership: createLoyaltyDiscountProvisioningIdentity(
              {
                identity: {
                  storeId: input.storeId,
                  accountId: input.accountId,
                  redemptionId: input.redemption.id,
                  rewardDefinitionId: input.redemption.rewardDefinitionId,
                  discountCode: code,
                },
                rewardName: "Original reward",
              },
            ),
          },
        },
      },
    };
  } else {
    const { policySnapshot: _policy, ...input } =
      referralBenefitFixture("coupon");
    receipt = { kind, input };
  }
  return {
    receipt,
    now: new Date("2026-10-10T00:00:00.000Z"),
    policySnapshot: {
      storeId: "store",
      programId: "program",
      revision: "a".repeat(64),
      policy: {
        ...createDefaultLoyaltyCommunicationPolicy("reward_expiry"),
        enabled: true,
      },
    },
  };
}
