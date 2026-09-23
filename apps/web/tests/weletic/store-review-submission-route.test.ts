import { storeReviewSubmissionRoute } from "@/lib/weletic/reviews/store-submission-route";
import { signWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  shopper: vi.fn(),
  submit: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    weleticShopper: { findMany: mocks.shopper },
  },
}));
vi.mock("@/lib/upstash", () => ({ ratelimit: () => ({ limit: mocks.limit }) }));
vi.mock("@/lib/weletic/reviews/store-service", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/reviews/store-service")>()),
  submitAuthenticatedStoreReview: mocks.submit,
}));

const secret = "store-submission-route-synthetic-secret-00000";
const input = {
  requestId: "request-a",
  rating: 4,
  title: "Store experience",
  body: "Helpful staff",
  displayName: "Buyer",
  locale: "en",
  publishConsent: true,
};
function signed(
  inputBody: unknown = input,
  query = "shop=verified.myshopify.com&customerId=123&source=customer_account",
) {
  const path = `/api/internal/shopify/reviews/store-submit?${query}`;
  const body = JSON.stringify(inputBody);
  const timestamp = String(Date.now());
  return new Request(`https://backend.example.test${path}`, {
    method: "POST",
    body,
    headers: {
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        secret,
      }),
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  mocks.store.mockResolvedValue({
    id: "store-a",
    installationGeneration: "generation-a",
    complianceState: "active",
    storeAccessState: "active",
  });
  mocks.shopper.mockResolvedValue([{ id: "shopper-a" }]);
  mocks.limit.mockResolvedValue({ success: true });
  mocks.submit.mockResolvedValue({ status: "received", duplicate: false });
});
afterEach(() => vi.unstubAllEnvs());

it("derives store and shopper from signed account context and owned mapping", async () => {
  const response = await storeReviewSubmissionRoute(signed());
  expect(response.status).toBe(201);
  expect(mocks.store).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { shopDomain: "verified.myshopify.com" },
    }),
  );
  expect(mocks.shopper).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        storeId: "store-a",
        shopifyCustomerId: { in: ["123", "gid://shopify/Customer/123"] },
      },
    }),
  );
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith({
    storeId: "store-a",
    shopperId: "shopper-a",
    expectedInstallationGeneration: "generation-a",
    input,
  });
});

it("rejects forged body identity and ambiguous or unknown owner mappings", async () => {
  expect(
    (
      await storeReviewSubmissionRoute(
        signed({ ...input, shopperId: "attacker" }),
      )
    ).status,
  ).toBe(400);
  expect(mocks.submit).not.toHaveBeenCalled();
  mocks.shopper.mockResolvedValueOnce([]);
  expect((await storeReviewSubmissionRoute(signed())).status).toBe(404);
  mocks.shopper.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
  expect((await storeReviewSubmissionRoute(signed())).status).toBe(503);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("requires the customer-account source and rejects duplicate context keys", async () => {
  expect(
    (
      await storeReviewSubmissionRoute(
        signed(
          input,
          "shop=verified.myshopify.com&customerId=123&source=app_proxy",
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await storeReviewSubmissionRoute(
        signed(
          input,
          "shop=verified.myshopify.com&customerId=123&customerId=999&source=customer_account",
        ),
      )
    ).status,
  ).toBe(400);
  expect(mocks.submit).not.toHaveBeenCalled();
});
