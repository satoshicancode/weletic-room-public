import { reviewIncentivePolicyDigest } from "@/lib/weletic/reviews/incentive-policy";
import { activateShopifyMerchantReviewIncentive as activate } from "@/lib/weletic/shopify/merchant-review-incentive-activation";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  settings: vi.fn(),
  policy: vi.fn(),
  history: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  clock: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.auth,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.mutate,
}));
const tx = {
  weleticReviewSettings: {
    findUnique: mocks.settings,
    updateMany: mocks.update,
  },
  weleticReviewIncentivePolicy: { findUnique: mocks.policy },
  weleticReviewIncentiveActivation: {
    findFirst: mocks.history,
    create: mocks.create,
  },
  $queryRaw: mocks.clock,
};
const actor = {
  version: 1,
  storeId: "store",
  appId: "app",
  shop: "test.myshopify.com",
  installationGeneration: "g1",
  userId: "123",
  sessionId: "test.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
const snapshot = { version: 1, award: { kind: "none" } };
const contentDigest = reviewIncentivePolicyDigest(snapshot);
const input = {
  expectedRevision: 1,
  expectedInstallationGeneration: "g1",
  expectedActivePolicyId: null,
  policyId: "policy",
  contentDigest,
};
const run = (patch: object = {}) =>
  activate({ envelope: actor, input: { ...input, ...patch } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.mutate.mockImplementation(async (_id, fn) => fn(tx, "g1"));
  mocks.auth.mockResolvedValue({
    storeId: "store",
    appId: "app",
    installationGeneration: "g1",
    shopifyUserId: "123",
    actionId: "c".repeat(64),
  });
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: null,
  });
  mocks.policy.mockResolvedValue({
    id: "policy",
    storeId: "store",
    revision: 1,
    contentDigest,
    snapshot,
  });
  mocks.history.mockResolvedValue(null);
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.clock.mockResolvedValue([{ now: new Date("2026-09-20T00:00:00Z") }]);
});
it("records explicit none activation with actor provenance and only changes the active pointer", async () => {
  expect(await run()).toMatchObject({
    policyId: "policy",
    revision: 1,
    effectiveAt: "2026-09-20T00:00:00.000Z",
  });
  expect(mocks.auth).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    permission: "reviews.configure",
  });
  expect(mocks.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      storeId: "store",
      policyId: "policy",
      previousPolicyId: null,
      contentDigest,
      installationGeneration: "g1",
      shopifyUserId: "123",
      merchantActionId: "c".repeat(64),
    }),
  });
  expect(mocks.update).toHaveBeenCalledWith({
    where: {
      storeId: "store",
      incentivePolicyRevision: 1,
      activeIncentivePolicyId: null,
    },
    data: { activeIncentivePolicyId: "policy" },
  });
  expect(mocks.mutate).toHaveBeenCalledWith(
    "store",
    expect.any(Function),
    "g1",
  );
});
it.each([
  { expectedRevision: 2 },
  { expectedInstallationGeneration: "g2" },
  { expectedActivePolicyId: "different" },
  { contentDigest: "0".repeat(64) },
])("rejects stale activation input", async (patch) => {
  await expect(run(patch)).rejects.toThrow("policy changed");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("rejects an activation CAS loss", async () => {
  mocks.update.mockResolvedValue({ count: 0 });
  await expect(run()).rejects.toThrow("policy changed");
});
it("rejects the already active draft", async () => {
  mocks.settings.mockResolvedValue({
    incentivePolicyRevision: 1,
    activeIncentivePolicyId: "policy",
  });
  await expect(run({ expectedActivePolicyId: "policy" })).rejects.toThrow(
    "policy changed",
  );
  expect(mocks.create).not.toHaveBeenCalled();
});
it("rejects a clock moving behind history", async () => {
  mocks.history.mockResolvedValue({
    policyId: null,
    policyRevision: 0,
    effectiveAt: new Date("2026-09-21T00:00:00Z"),
  });
  await expect(run()).rejects.toThrow("clock requires reconciliation");
  expect(mocks.create).not.toHaveBeenCalled();
});
