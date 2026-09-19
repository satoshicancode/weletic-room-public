import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { draftShopifyMerchantReviewIncentive } from "@/lib/weletic/shopify/merchant-review-incentive-draft";
import { verifyWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/reviews/incentives/draft/route";

vi.mock("@/lib/weletic/shopify/merchant-review-incentive-draft", () => ({
  draftShopifyMerchantReviewIncentive: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  ShopifyStaffAuthorizationError: class extends Error {},
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
  draft: { kind: "none" },
};
const run = (body: unknown = { actor, input }) =>
  POST(
    new Request(
      "http://localhost/api/internal/shopify/merchant/reviews/incentives/draft",
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyWeleticShopifyRequest).mockReturnValue(true);
  vi.mocked(draftShopifyMerchantReviewIncentive).mockResolvedValue({
    policyId: "policy",
    revision: 1,
    contentDigest: "c".repeat(64),
    activated: false,
  });
});

it("verifies the complete body before dispatch and returns a private draft-only response", async () => {
  const response = await run();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(verifyWeleticShopifyRequest).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify({ actor, input }) }),
  );
  expect(draftShopifyMerchantReviewIncentive).toHaveBeenCalledWith({
    envelope: actor,
    input,
  });
  expect(await response.json()).toMatchObject({ activated: false });
});
it("rejects invalid signatures before invoking the writer", async () => {
  vi.mocked(verifyWeleticShopifyRequest).mockReturnValue(false);
  expect((await run()).status).toBe(401);
  expect(draftShopifyMerchantReviewIncentive).not.toHaveBeenCalled();
});
it.each([
  { actor, input, storeId: "other" },
  { actor, input: { ...input, recordAction: false } },
  { actor, input: { ...input, draft: { kind: "none", activate: true } } },
])("rejects additional authority fields", async (body) => {
  expect((await run(body)).status).toBe(400);
  expect(draftShopifyMerchantReviewIncentive).not.toHaveBeenCalled();
});
it("bounds request bytes", async () => {
  expect((await run({ data: "x".repeat(17000) })).status).toBe(400);
  expect(verifyWeleticShopifyRequest).not.toHaveBeenCalled();
});
it("reports conflicts without leaking internal errors", async () => {
  vi.mocked(draftShopifyMerchantReviewIncentive).mockRejectedValueOnce(
    new ReviewError("conflict", "private"),
  );
  const response = await run();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "state_changed" });
});
