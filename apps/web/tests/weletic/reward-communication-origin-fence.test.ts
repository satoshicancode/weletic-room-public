import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { createLoyaltyRedemptionProvisioningSnapshot } from "../../lib/weletic/loyalty/redemption-provisioning-snapshot";
import { createRewardCommunicationOrigin } from "../../lib/weletic/loyalty/reward-communication-origin";
import { assertRewardCommunicationOrigin } from "../../lib/weletic/loyalty/reward-communication-origin-fence";

const guard = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: guard,
}));
const tx = {} as Prisma.TransactionClient;
function fixture() {
  const time = new Date("2026-09-12T00:00:00Z");
  const snapshot = createLoyaltyRedemptionProvisioningSnapshot({
    reward: { id: "reward", name: "Reward", rewardType: "amount_off" },
    pointsCost: BigInt(100),
    discountValue: "500",
    expiresInDays: null,
    shopCurrency: "JPY",
    currencyVerifiedAt: time,
    customerSelectionDigest: "A".repeat(64),
    startsAt: time,
    expiresAt: null,
  });
  return {
    tx,
    storeId: "store",
    accountId: "account",
    redemptionId: "redemption",
    metadata: {
      provisioningSnapshot: snapshot,
      rewardCommunicationOrigin: createRewardCommunicationOrigin({
        storeId: "store",
        accountId: "account",
        redemptionId: "redemption",
        installationGeneration: "original-generation",
        provisioningDigest: snapshot.contentDigest,
      }),
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  guard.mockResolvedValue({ installationGeneration: "original-generation" });
});
it("fences the persisted original generation in the caller transaction", async () => {
  const result = await assertRewardCommunicationOrigin(fixture());
  expect(result?.installationGeneration).toBe("original-generation");
  expect(guard).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    expectedInstallationGeneration: "original-generation",
    action: "loyalty_reward_communication_origin",
    loyaltyMaintenancePermit: undefined,
  });
});
it("propagates stale-generation rejection without producing a replacement origin", async () => {
  const input = fixture();
  const before = JSON.stringify(input.metadata);
  guard.mockRejectedValue(new Error("stale generation"));
  await expect(assertRewardCommunicationOrigin(input)).rejects.toThrow(
    "stale generation",
  );
  expect(JSON.stringify(input.metadata)).toBe(before);
});
it("does not read current generation to retrofit a legacy reservation", async () => {
  await expect(
    assertRewardCommunicationOrigin({
      ...fixture(),
      metadata: { historical: true },
    }),
  ).resolves.toBeNull();
  expect(guard).not.toHaveBeenCalled();
});
it.each(["storeId", "accountId", "redemptionId"] as const)(
  "rejects foreign %s before the operational guard",
  async (field) => {
    await expect(
      assertRewardCommunicationOrigin({ ...fixture(), [field]: "foreign" }),
    ).rejects.toThrow("origin unavailable");
    expect(guard).not.toHaveBeenCalled();
  },
);
it("rejects a corrupt snapshot instead of relabeling it with a fresh generation", async () => {
  const input = fixture();
  input.metadata.provisioningSnapshot.discountValue = "999";
  await expect(assertRewardCommunicationOrigin(input)).rejects.toThrow();
  expect(guard).not.toHaveBeenCalled();
});
it("rejects present malformed origin, not treating it as missing legacy evidence", async () => {
  await expect(
    assertRewardCommunicationOrigin({
      ...fixture(),
      metadata: { ...fixture().metadata, rewardCommunicationOrigin: null },
    }),
  ).rejects.toThrow("origin unavailable");
  expect(guard).not.toHaveBeenCalled();
});
