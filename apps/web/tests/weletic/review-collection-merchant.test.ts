import { defaultReviewCollectionPolicy } from "@/lib/weletic/reviews/collection-contract";
import {
  readShopifyMerchantReviewCollectionInTransaction as read,
  writeShopifyMerchantReviewCollection as write,
} from "@/lib/weletic/shopify/merchant-review-collection";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  find: vi.fn(),
  mutate: vi.fn(),
  fence: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("@/lib/weletic/reviews/service", () => ({
  updateReviewCollectionInTransaction: mocks.mutate,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.fence,
}));
const tx = { weleticReviewSettings: { findUnique: mocks.find } } as any;
const actor = {
  version: 1,
  storeId: "store",
  appId: "app",
  shop: "test.myshopify.com",
  installationGeneration: "generation",
  userId: "123",
  sessionId: "test.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
const input = {
  expectedRevision: 0,
  expectedInstallationGeneration: "generation",
  policy: defaultReviewCollectionPolicy(),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.find.mockResolvedValue(null);
  mocks.fence.mockImplementation(async (_store, operation) => operation(tx));
});
it("reads defaults without creating settings and requires configure authority", async () => {
  expect(await read({ tx, envelope: actor, input: {} })).toEqual({
    revision: 0,
    installationGeneration: "generation",
    moduleEnabled: false,
    policy: defaultReviewCollectionPolicy(),
  });
  expect(mocks.authorize).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    permission: "reviews.configure",
  });
  expect(mocks.find).toHaveBeenCalledWith({ where: { storeId: "store" } });
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("commits authorization and collection changes within the same generation fence", async () => {
  await write({ envelope: actor, input });
  expect(mocks.fence).toHaveBeenCalledWith(
    "store",
    expect.any(Function),
    "generation",
  );
  expect(mocks.authorize).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    permission: "reviews.configure",
  });
  expect(mocks.mutate).toHaveBeenCalledWith(tx, "store", input);
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.mutate.mock.invocationCallOrder[0],
  );
});
it.each(["invalid_actor", "access_denied", "request_replayed"])(
  "does not reach settings for authorization rejection %s",
  async (reason) => {
    mocks.authorize.mockRejectedValue(new Error(reason));
    await expect(write({ envelope: actor, input })).rejects.toThrow(reason);
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  },
);
it("rejects foreign installation before transaction or authorization", async () => {
  await expect(
    write({
      envelope: actor,
      input: { ...input, expectedInstallationGeneration: "retired" },
    }),
  ).rejects.toThrow("Installation changed");
  expect(mocks.fence).not.toHaveBeenCalled();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("rejects tenant overrides on read and write before authorization", async () => {
  await expect(
    read({ tx, envelope: actor, input: { storeId: "foreign" } }),
  ).rejects.toThrow();
  await expect(
    write({ envelope: actor, input: { ...input, storeId: "foreign" } }),
  ).rejects.toThrow();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it.each([
  { reminderAfterDays: [7, 3] },
  { collectionRevision: -1 },
  { sendAfterDays: 61 },
])(
  "fails closed on corrupted persisted collection settings %j",
  async (patch) => {
    mocks.find.mockResolvedValue({
      ...defaultReviewCollectionPolicy(),
      enabled: false,
      collectionRevision: 1,
      ...patch,
    });
    await expect(read({ tx, envelope: actor, input: {} })).rejects.toThrow();
  },
);
it("does not serialize unrelated persisted secrets or incentive identifiers", async () => {
  mocks.find.mockResolvedValue({
    ...defaultReviewCollectionPolicy(),
    enabled: true,
    collectionRevision: 1,
    activeIncentivePolicyId: "private-policy",
    token: "private-token",
  });
  const result = await read({ tx, envelope: actor, input: {} });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result).toMatchObject({ revision: 1, moduleEnabled: true });
});
