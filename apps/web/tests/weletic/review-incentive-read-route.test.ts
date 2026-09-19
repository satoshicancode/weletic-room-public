import { beforeEach, expect, it, vi } from "vitest";
import { POST as coupons } from "../../app/api/internal/shopify/merchant/reviews/incentives/coupons/route";
import { POST } from "../../app/api/internal/shopify/merchant/reviews/incentives/read/route";
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  read: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/merchant-review-incentive-read", () => ({
  readShopifyMerchantReviewIncentivesInTransaction: mocks.read,
}));
vi.mock("@/lib/weletic/shopify/merchant-review-coupons", () => ({
  listShopifyMerchantReviewCouponsInTransaction: mocks.read,
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  ShopifyStaffAuthorizationError: class extends Error {},
}));
vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  verifyWeleticShopifyRequest: mocks.verify,
  readWeleticShopifyRequestBodyBytes: async (
    request: Request,
    { maxBytes }: { maxBytes: number },
  ) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return bytes.length <= maxBytes ? bytes : null;
  },
}));
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
const run = (input: unknown = {}) =>
  POST(
    new Request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ actor, input }),
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.transaction.mockImplementation((fn) => fn({ fixtureTx: true }));
  mocks.read.mockResolvedValue({ revision: 0 });
});
it("checks full-body signature then performs the read on one transaction", async () => {
  const response = await run();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify({ actor, input: {} }) }),
  );
  expect(mocks.read).toHaveBeenCalledWith({
    tx: { fixtureTx: true },
    envelope: actor,
    input: {},
  });
});
it("rejects unsigned reads before any transaction", async () => {
  mocks.verify.mockReturnValue(false);
  expect((await run()).status).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it.each([
  { storeId: "foreign" },
  { policyId: "foreign" },
  { data: "x".repeat(17000) },
])("rejects caller selectors and oversized input", async (input) => {
  expect((await run(input)).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("does not expose internal errors", async () => {
  mocks.read.mockRejectedValue(new Error("private-secret"));
  const response = await run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "reviews_unavailable" });
});
it("authorizes signed coupon queries and denies unsigned requests without dispatch", async () => {
  const make = () =>
    new Request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ actor, input: { query: "gift" } }),
    });
  expect((await coupons(make())).status).toBe(200);
  expect(mocks.read).toHaveBeenCalledWith({
    tx: { fixtureTx: true },
    envelope: actor,
    input: { query: "gift" },
  });
  mocks.read.mockClear();
  mocks.verify.mockReturnValue(false);
  expect((await coupons(make())).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled();
});
