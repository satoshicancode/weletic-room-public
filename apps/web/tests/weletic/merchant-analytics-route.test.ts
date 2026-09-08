import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/analytics/route";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("../../lib/weletic/shopify/merchant-analytics", () => ({
  readShopifyMerchantAnalyticsInTransaction: mocks.query,
}));
vi.mock("../../lib/weletic/shopify/service-auth", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/service-auth")
  >()),
  verifyWeleticShopifyRequest: mocks.verify,
}));
const actor = {
  version: 1,
  appId: "test-app",
  shop: "staff-fixture.myshopify.com",
  storeId: "store-fixture",
  installationGeneration: "generation-fixture",
  userId: "123",
  sessionId: "staff-fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1_000_000,
  requestId: "b".repeat(64),
};
const input = {
  actor,
  request: { operation: "read", filter: { startAt: null, endAt: null } },
};
const request = (body: unknown) =>
  new Request(
    "https://backend.example/api/internal/shopify/merchant/analytics",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
const tx = { fixture: "transaction" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.transaction.mockImplementation(async (operation) => operation(tx));
  mocks.query.mockResolvedValue({ snapshot: "fixture" });
});
it("verifies the complete actor/request body before a single repeatable-read transaction", async () => {
  const response = await POST(request(input));
  expect(response.status).toBe(200);
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(input) }),
  );
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
  });
  expect(mocks.query).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    request: input.request,
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
it("rejects unverified requests without any database access", async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(request(input))).status).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it.each([
  { ...input, storeId: "other-store" },
  { ...input, request: { ...input.request, storeId: "other-store" } },
  { ...input, actor: { ...actor, owner: true } },
])("rejects injected scope/authority %j", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("bounds the body and masks unknown database failures", async () => {
  expect((await POST(request({ padding: "x".repeat(17 * 1024) }))).status).toBe(
    400,
  );
  expect(mocks.transaction).not.toHaveBeenCalled();
  mocks.query.mockRejectedValue(new Error("private database detail"));
  const response = await POST(request(input));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "analytics_unavailable" });
});
