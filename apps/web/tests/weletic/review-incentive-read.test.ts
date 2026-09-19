import { reviewIncentivePolicyDigest } from "@/lib/weletic/reviews/incentive-policy";
import { readShopifyMerchantReviewIncentivesInTransaction as read } from "@/lib/weletic/shopify/merchant-review-incentive-read";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  settings: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.auth,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));
const tx = {
  weleticReviewSettings: { findUnique: mocks.settings },
  weleticReviewIncentivePolicy: { findUnique: mocks.policy },
} as unknown as Prisma.TransactionClient;
const run = (input: unknown = {}) =>
  read({ tx, envelope: { signed: true }, input });
const snapshot = { version: 1, award: { kind: "none" } };
const row = {
  id: "policy",
  storeId: "store",
  revision: 1,
  snapshot,
  contentDigest: reviewIncentivePolicyDigest(snapshot),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({
    storeId: "store",
    installationGeneration: "g1",
  });
  mocks.settings.mockResolvedValue(null);
  mocks.policy.mockResolvedValue(row);
});
it("reads an uninitialized store without creating defaults or calling the catalog", async () => {
  expect(await run()).toEqual({
    revision: 0,
    installationGeneration: "g1",
    mode: "legacy",
    activePolicy: null,
    latestPolicy: null,
  });
  expect(mocks.policy).not.toHaveBeenCalled();
  expect(mocks.auth).toHaveBeenCalledWith({
    tx,
    envelope: { signed: true },
    permission: "reviews.configure",
  });
});
it("distinguishes saved none from historical legacy and returns localized disclosure", async () => {
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: "policy",
  });
  const result = await run();
  expect(result.mode).toBe("versioned");
  expect(result.latestPolicy).toEqual(result.activePolicy);
  expect(result.activePolicy).toMatchObject({
    draft: { kind: "none" },
    disclosureState: "available",
  });
  expect(result.activePolicy?.disclosure?.ja.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain('"snapshot"');
  expect(mocks.policy).toHaveBeenCalledWith({
    where: { storeId_id: { storeId: "store", id: "policy" } },
  });
});
it("does not mistake a draft for activation", async () => {
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: null,
  });
  expect(await run()).toMatchObject({
    mode: "legacy",
    activePolicy: null,
    latestPolicy: { policyId: "policy" },
  });
});
it.each([
  { ...row, storeId: "foreign" },
  { ...row, contentDigest: "0".repeat(64) },
  { ...row, snapshot: { version: 1, award: { kind: "points" } } },
  null,
])("fails closed on missing, foreign or corrupt policy", async (policy) => {
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: "policy",
  });
  mocks.policy.mockResolvedValue(policy);
  await expect(run()).rejects.toThrow();
});
it("rejects caller-supplied store or policy selectors", async () => {
  await expect(run({ storeId: "foreign" })).rejects.toThrow();
  expect(mocks.auth).not.toHaveBeenCalled();
});
it("does not read policies before permission checks", async () => {
  mocks.auth.mockRejectedValue(new Error("access_denied"));
  await expect(run()).rejects.toThrow("access_denied");
  expect(mocks.settings).not.toHaveBeenCalled();
});

it("keeps an older active promise distinct from the latest draft", async () => {
  const older = { ...row, id: "older" };
  const latest = { ...row, revision: 2 };
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 2,
    activeIncentivePolicyId: "older",
  });
  mocks.policy.mockImplementation(async ({ where }) =>
    where.storeId_id?.id === "older" ? older : latest,
  );
  const result = await run();
  expect(result.activePolicy).toMatchObject({ policyId: "older", revision: 1 });
  expect(result.latestPolicy).toMatchObject({
    policyId: "policy",
    revision: 2,
  });
});
it("does not mask a missing active promise behind a valid latest draft", async () => {
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: "missing",
  });
  mocks.policy.mockImplementation(async ({ where }) =>
    where.storeId_id?.id === "missing" ? null : row,
  );
  await expect(run()).rejects.toThrow("require reconciliation");
});
it("labels intact historical targeted coupons unavailable without fabricating names", async () => {
  const coupon = {
    version: 1,
    award: {
      kind: "coupon",
      terms: {
        rewardDefinitionId: "reward",
        name: "Coupon",
        description: null,
        rewardType: "amount_off",
        salesChannel: "online_store",
        exchangeType: "fixed",
        discountValue: "100",
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: "specific_items",
        entitledCollectionIds: [],
        entitledProductIds: ["gid://shopify/Product/1"],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
        expiresInDays: 30,
        shopCurrency: "JPY",
      },
    },
  };
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: "policy",
  });
  mocks.policy.mockResolvedValue({
    ...row,
    snapshot: coupon,
    contentDigest: reviewIncentivePolicyDigest(coupon),
  });
  const result = await run();
  expect(result.activePolicy).toMatchObject({
    draft: { kind: "coupon", rewardDefinitionId: "reward" },
    disclosure: null,
    disclosureState: "unavailable",
  });
  expect(JSON.stringify(result)).not.toContain("gid://");
});
