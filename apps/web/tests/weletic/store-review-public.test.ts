import { getPublicStoreReviews } from "@/lib/weletic/reviews/store-public";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  raw: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  loadShopifyPrivacyHmacKeyring: () => {
    const key = { identityKeyId: "fixture", secret: Buffer.alloc(32, 7) };
    return { current: key, all: [key] };
  },
}));
const store = {
  installationGeneration: "g1",
  complianceState: "active",
  storeAccessState: "active",
  reviewSettings: { enabled: true },
  storeReviewSettings: { enabled: true },
};
const row = {
  id: "review-1",
  rating: 1,
  title: "Critical feedback",
  body: "Unhappy with delivery",
  displayName: "Buyer",
  merchantReply: null,
  locale: "ja",
  createdAt: new Date("2026-01-01"),
  source: "open",
  requestId: null,
  verifiedPurchase: 1,
  incentivized: 1,
  shopperId: "private-owner",
  customerDigest: "private-digest",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((fn) =>
    fn({
      weleticShopifyStore: { findUnique: mocks.store },
      $queryRaw: mocks.raw,
    }),
  );
  mocks.store.mockResolvedValue(store);
  mocks.raw
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ rating: 1, count: BigInt(1) }])
    .mockResolvedValueOnce([row]);
});
it("uses one snapshot and returns explicit content without granting open-review labels", async () => {
  const value = await getPublicStoreReviews("store-a", {});
  expect(value.summary).toEqual({
    count: 1,
    average: 1,
    distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 },
  });
  expect(value.items[0]).toMatchObject({
    rating: 1,
    verifiedPurchase: false,
    incentivized: false,
  });
  expect(JSON.stringify(value)).not.toContain("private-");
  expect(value.items[0]).not.toHaveProperty("requestId");
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
  });
  expect(mocks.raw.mock.calls[1][0].sql).toContain(
    "t.customerDigest = i.customerDigest",
  );
  expect(mocks.raw.mock.calls[2][0].sql).toContain(
    "t.customerDigest = i.customerDigest",
  );
});
it.each([
  null,
  { ...store, installationGeneration: null },
  { ...store, complianceState: "frozen" },
  { ...store, storeAccessState: "pending_approval" },
  { ...store, reviewSettings: { enabled: false } },
  { ...store, storeReviewSettings: { enabled: false } },
])(
  "rejects unavailable store/module before content reads: %j",
  async (value) => {
    mocks.store.mockResolvedValue(value);
    await expect(getPublicStoreReviews("store-a", {})).rejects.toThrow(
      "unavailable",
    );
    expect(mocks.raw).not.toHaveBeenCalled();
  },
);
it("does not expose misleading totals when owner coverage is unknown", async () => {
  mocks.raw.mockReset().mockResolvedValue([{ id: "unknown" }]);
  await expect(getPublicStoreReviews("store-a", {})).rejects.toThrow(
    "unavailable",
  );
  expect(mocks.raw).toHaveBeenCalledTimes(1);
});
it.each([BigInt(-1), BigInt("9007199254740992")])(
  "rejects unsafe aggregate counts %s",
  async (count) => {
    mocks.raw
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ rating: 1, count }]);
    await expect(getPublicStoreReviews("store-a", {})).rejects.toThrow(
      "totals unavailable",
    );
    expect(mocks.raw).toHaveBeenCalledTimes(2);
  },
);
it("binds pagination to store, installation and rating filter", async () => {
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ rating: 1, count: BigInt(2) }])
    .mockResolvedValueOnce([row, { ...row, id: "review-0" }]);
  const first = await getPublicStoreReviews("store-a", { limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  mocks.raw.mockClear();
  await expect(
    getPublicStoreReviews("store-b", { cursor: first.nextCursor }),
  ).rejects.toThrow("Invalid store review cursor");
  await expect(
    getPublicStoreReviews("store-a", { rating: 2, cursor: first.nextCursor }),
  ).rejects.toThrow("Invalid store review cursor");
  mocks.store.mockResolvedValue({ ...store, installationGeneration: "g2" });
  await expect(
    getPublicStoreReviews("store-a", { cursor: first.nextCursor }),
  ).rejects.toThrow("Invalid store review cursor");
  expect(mocks.raw).not.toHaveBeenCalled();
});
