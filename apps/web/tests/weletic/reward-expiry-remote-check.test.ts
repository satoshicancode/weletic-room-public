import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRewardExpiryCommunication } from "../../lib/weletic/loyalty/reward-expiry-communication-contract";
import { isRewardExpiryDiscountCurrentlyUsable } from "../../lib/weletic/loyalty/reward-expiry-remote-check";
import { rewardExpiryCommunicationFixture } from "./reward-expiry-communication-fixture";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  fence: vi.fn(),
  credentials: vi.fn(),
  lookup: vi.fn(),
  compare: vi.fn(),
}));
vi.mock("../../lib/weletic/loyalty/reward-expiry-communication-source", () => ({
  readCurrentRewardExpiryReceipt: mocks.source,
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("../../lib/weletic/loyalty/shopify-discounts", () => ({
  lookupDiscountByCode: mocks.lookup,
  resolveShopifyOfflineCredentials: mocks.credentials,
}));
vi.mock("../../lib/weletic/loyalty/reward-expiry-discount-evidence", () => ({
  matchesRewardExpiryDiscountEvidence: mocks.compare,
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  mocks.credentials.mockResolvedValue({
    shopDomain: "synthetic.myshopify.com",
    accessToken: "synthetic-token",
  });
  mocks.lookup.mockResolvedValue({ id: "synthetic-remote" });
  mocks.compare.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());
function fixture(kind: "redemption" | "referral_coupon" = "redemption") {
  const evidence = rewardExpiryCommunicationFixture(kind);
  mocks.source.mockResolvedValue(evidence.receipt);
  return {
    db: {} as Parameters<typeof isRewardExpiryDiscountCurrentlyUsable>[0]["db"],
    event: createRewardExpiryCommunication(evidence),
    shopifyCustomerId: "gid://shopify/Customer/private-customer",
  };
}
it.each(["redemption", "referral_coupon"] as const)(
  "fences original generation around fresh %s credentials and lookup on every attempt",
  async (kind) => {
    const args = fixture(kind);
    expect(await isRewardExpiryDiscountCurrentlyUsable(args)).toBe(true);
    expect(await isRewardExpiryDiscountCurrentlyUsable(args)).toBe(true);
    expect(mocks.credentials).toHaveBeenCalledTimes(2);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.fence).toHaveBeenCalledTimes(6);
    expect(mocks.credentials).toHaveBeenCalledWith({
      storeId: args.event.storeId,
    });
    expect(mocks.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: args.event.storeId,
        expectedInstallationGeneration: args.event.installationGeneration,
      }),
    );
    const calls = [
      mocks.source,
      mocks.fence,
      mocks.credentials,
      mocks.fence,
      mocks.lookup,
      mocks.fence,
      mocks.compare,
    ];
    const sequence = [
      calls[0].mock.invocationCallOrder[0],
      calls[1].mock.invocationCallOrder[0],
      calls[2].mock.invocationCallOrder[0],
      calls[3].mock.invocationCallOrder[1],
      calls[4].mock.invocationCallOrder[0],
      calls[5].mock.invocationCallOrder[2],
      calls[6].mock.invocationCallOrder[0],
    ];
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  },
);
it("skips credentials and lookup when local receipt evidence is unavailable", async () => {
  const args = fixture();
  mocks.source.mockResolvedValue(null);
  expect(await isRewardExpiryDiscountCurrentlyUsable(args)).toBe(false);
  expect(mocks.credentials).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it.each([1, 2, 3])(
  "rejects generation changes at fence %s",
  async (position) => {
    const args = fixture();
    for (let index = 1; index < position; index++)
      mocks.fence.mockResolvedValueOnce(undefined);
    mocks.fence.mockRejectedValueOnce(new Error("synthetic stale generation"));
    await expect(isRewardExpiryDiscountCurrentlyUsable(args)).rejects.toThrow(
      "stale generation",
    );
    expect(mocks.lookup).toHaveBeenCalledTimes(position === 3 ? 1 : 0);
    expect(mocks.compare).not.toHaveBeenCalled();
  },
);
it("propagates lookup failure instead of treating an unknown outcome as usable", async () => {
  const args = fixture();
  mocks.lookup.mockRejectedValue(new Error("synthetic network failure"));
  await expect(isRewardExpiryDiscountCurrentlyUsable(args)).rejects.toThrow(
    "network failure",
  );
  expect(mocks.compare).not.toHaveBeenCalled();
});
it("compares at the post-network clock and suppresses rejected observations", async () => {
  const args = fixture();
  const later = new Date("2026-10-13T00:00:00Z");
  mocks.lookup.mockImplementation(async () => {
    vi.setSystemTime(later);
    return null;
  });
  mocks.compare.mockReturnValue(false);
  expect(await isRewardExpiryDiscountCurrentlyUsable(args)).toBe(false);
  expect(mocks.compare).toHaveBeenCalledWith(
    expect.objectContaining({ remote: null, now: later }),
  );
});
