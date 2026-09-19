import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { activateShopifyMerchantReviewIncentive } from "@/lib/weletic/shopify/merchant-review-incentive-activation";
import { verifyWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/reviews/incentives/activate/route";

vi.mock("@/lib/weletic/shopify/merchant-review-incentive-activation", () => ({
  activateShopifyMerchantReviewIncentive: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  ShopifyStaffAuthorizationError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBodyBytes: async (
    request: Request,
    { maxBytes }: { maxBytes: number },
  ) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return bytes.length > maxBytes ? null : bytes;
  },
  verifyWeleticShopifyRequest: vi.fn(),
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
const input = {
  expectedRevision: 1,
  expectedInstallationGeneration: "g1",
  expectedActivePolicyId: null,
  policyId: "policy",
  contentDigest: "c".repeat(64),
};
const run = (body: unknown = { actor, input }) =>
  POST(
    new Request("http://localhost/activate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyWeleticShopifyRequest).mockReturnValue(true);
  vi.mocked(activateShopifyMerchantReviewIncentive).mockResolvedValue({
    activationId: "activation",
    policyId: "policy",
    revision: 1,
    effectiveAt: "2026-09-20T00:00:00.000Z",
  });
});
it("authenticates the full actor and fenced input before returning a private response", async () => {
  const response = await run();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(verifyWeleticShopifyRequest).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify({ actor, input }) }),
  );
  expect(activateShopifyMerchantReviewIncentive).toHaveBeenCalledWith({
    envelope: actor,
    input,
  });
});
it("rejects unsigned activation", async () => {
  vi.mocked(verifyWeleticShopifyRequest).mockReturnValue(false);
  expect((await run()).status).toBe(401);
  expect(activateShopifyMerchantReviewIncentive).not.toHaveBeenCalled();
});
it.each([
  { actor, input, storeId: "foreign" },
  { actor, input: { ...input, expectedRevision: 0 } },
  { actor, input: { ...input, contentDigest: "bad" } },
  { actor, input: { ...input, recordAction: false } },
])("rejects malformed or extra authority fields", async (body) => {
  expect((await run(body)).status).toBe(400);
  expect(activateShopifyMerchantReviewIncentive).not.toHaveBeenCalled();
});
it("bounds payloads before signature work", async () => {
  expect((await run({ padding: "x".repeat(17000) })).status).toBe(400);
  expect(verifyWeleticShopifyRequest).not.toHaveBeenCalled();
});
it("redacts transaction conflicts and unknown failures", async () => {
  vi.mocked(activateShopifyMerchantReviewIncentive).mockRejectedValueOnce(
    new ReviewError("conflict", "private"),
  );
  const conflict = await run();
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "state_changed" });
  vi.mocked(activateShopifyMerchantReviewIncentive).mockRejectedValueOnce(
    new Error("private"),
  );
  const unavailable = await run();
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "reviews_unavailable" });
});
it.each([
  ["access_denied", 403],
  ["invalid_actor", 401],
  ["request_replayed", 409],
] as const)(
  "maps authorization failure %s without exposing details",
  async (code, status) => {
    vi.mocked(activateShopifyMerchantReviewIncentive).mockRejectedValueOnce(
      new ShopifyStaffAuthorizationError(code),
    );
    const response = await run();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  },
);
it("does not report malformed service output as successful activation", async () => {
  vi.mocked(activateShopifyMerchantReviewIncentive).mockResolvedValueOnce({
    activationId: "activation",
    policyId: "policy",
    revision: 1,
    effectiveAt: "invalid",
  });
  const response = await run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "reviews_unavailable" });
  expect(activateShopifyMerchantReviewIncentive).toHaveBeenCalledTimes(1);
});
