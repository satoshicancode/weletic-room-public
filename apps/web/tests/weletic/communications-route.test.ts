import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/communications/route";
import { LoyaltyCommunicationsConflictError } from "../../lib/weletic/loyalty/communications-service";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  manage: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("../../lib/weletic/shopify/communications", () => ({
  manageShopifyCommunicationsInTransaction: mocks.manage,
}));
vi.mock("../../lib/weletic/shopify/service-auth", async (original) => ({
  ...(await original<object>()),
  verifyWeleticShopifyRequest: mocks.verify,
}));
const actor = {
  version: 1,
  appId: "fixture-app",
  shop: "fixture.myshopify.com",
  storeId: "fixture-store",
  installationGeneration: "fixture-generation",
  userId: "123",
  sessionId: "fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1_000_000,
  requestId: "b".repeat(64),
};
const input = { actor, request: { operation: "read" } };
const tx = { fixture: true };
const request = (body: unknown) =>
  new Request(
    "https://backend.example/api/internal/shopify/merchant/communications",
    { method: "POST", body: JSON.stringify(body) },
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.transaction.mockImplementation(async (operation) => operation(tx));
  mocks.manage.mockResolvedValue({ fixture: "response" });
});
it("binds actor and request into signature verification before one transaction", async () => {
  const result = await POST(request(input));
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(input) }),
  );
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
  });
  expect(mocks.manage).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    request: input.request,
  });
});
it.each([
  { ...input, storeId: "other" },
  { ...input, actor: { ...actor, owner: true } },
  { ...input, request: { operation: "read", recipient: "other@example.test" } },
])("rejects injected authority or recipient fields", async (value) => {
  expect((await POST(request(value))).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("rejects unsigned and oversized bodies without database access", async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(request(input))).status).toBe(401);
  expect(
    (await POST(request({ padding: "x".repeat(129 * 1024) }))).status,
  ).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("maps revision conflicts and sanitizes unknown failures", async () => {
  mocks.manage.mockRejectedValue(new LoyaltyCommunicationsConflictError());
  expect((await POST(request(input))).status).toBe(409);
  mocks.manage.mockRejectedValue(new Error("private storage detail"));
  const response = await POST(request(input));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "communications_unavailable",
  });
});
