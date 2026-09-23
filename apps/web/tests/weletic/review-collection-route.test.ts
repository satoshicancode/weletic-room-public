import { defaultReviewCollectionPolicy } from "@/lib/weletic/reviews/collection-contract";
import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { POST as read } from "../../app/api/internal/shopify/merchant/reviews/collection/read/route";
import { POST as write } from "../../app/api/internal/shopify/merchant/reviews/collection/write/route";
const m = vi.hoisted(() => ({
  verify: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: m.transaction } }));
vi.mock("@/lib/weletic/shopify/merchant-review-collection", () => ({
  readShopifyMerchantReviewCollectionInTransaction: m.read,
  writeShopifyMerchantReviewCollection: m.write,
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  ShopifyStaffAuthorizationError: class extends Error {},
}));
vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  verifyWeleticShopifyRequest: m.verify,
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
const patch = {
  expectedRevision: 0,
  expectedInstallationGeneration: "g1",
  policy: defaultReviewCollectionPolicy(),
};
const request = (input: unknown, method = "POST") =>
  new Request("http://localhost/api", {
    method,
    ...(method === "POST" ? { body: JSON.stringify({ actor, input }) } : {}),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.verify.mockReturnValue(true);
  m.transaction.mockImplementation((fn) => fn({ fixture: true }));
  m.read.mockResolvedValue({ revision: 0 });
  m.write.mockResolvedValue({ revision: 1 });
});
it("verifies the exact envelope bytes before reading in an authorized transaction", async () => {
  const response = await read(request({}));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(m.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify({ actor, input: {} }) }),
  );
  expect(m.read).toHaveBeenCalledWith({
    tx: { fixture: true },
    envelope: actor,
    input: {},
  });
});
it("passes a validated revision-fenced write to the lifecycle service", async () => {
  expect((await write(request(patch))).status).toBe(200);
  expect(m.write).toHaveBeenCalledWith({ envelope: actor, input: patch });
  expect(m.transaction).not.toHaveBeenCalled();
});
it.each([read, write])(
  "rejects unsigned traffic before invoking services",
  async (route) => {
    m.verify.mockReturnValue(false);
    expect((await route(request(patch))).status).toBe(401);
    expect(m.read).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  },
);
it.each([read, write])(
  "rejects GET, oversized and malformed envelopes",
  async (route) => {
    expect((await route(request({}, "GET"))).status).toBe(405);
    expect((await route(request({ data: "x".repeat(17000) }))).status).toBe(
      400,
    );
    expect(
      (
        await route(
          new Request("http://localhost/api", { method: "POST", body: "{" }),
        )
      ).status,
    ).toBe(400);
    expect(m.read).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  },
);
it.each([
  { ...patch, storeId: "foreign" },
  { ...patch, policy: { ...patch.policy, enabled: true } },
  { ...patch, expectedRevision: -1 },
])("rejects authority injection or malformed write", async (value) => {
  expect((await write(request(value))).status).toBe(400);
  expect(m.write).not.toHaveBeenCalled();
});
it("maps stale state without exposing service details", async () => {
  m.write.mockRejectedValue(new ReviewError("conflict", "private details"));
  const response = await write(request(patch));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "state_changed" });
});
it("contains unknown failures without leaking data", async () => {
  m.read.mockRejectedValue(new Error("private recipient"));
  const response = await read(request({}));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "reviews_unavailable" });
});
