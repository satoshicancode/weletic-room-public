import { storeAccountInvitationsRoute } from "@/lib/weletic/reviews/store-account-invitations-route";
import { signWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  shopper: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    weleticShopper: { findMany: mocks.shopper },
  },
}));
vi.mock(
  "@/lib/weletic/reviews/store-account-invitations",
  async (original) => ({
    ...(await original<
      typeof import("@/lib/weletic/reviews/store-account-invitations")
    >()),
    listStoreAccountInvitations: mocks.list,
  }),
);

const secret = "store-invitations-route-synthetic-secret-00000";
function signed(
  query = "shop=verified.myshopify.com&customerId=123&source=customer_account&limit=10",
) {
  const path = `/api/internal/shopify/reviews/store-invitations?${query}`;
  const timestamp = String(Date.now());
  return new Request(`https://backend.example.test${path}`, {
    method: "GET",
    headers: {
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signWeleticShopifyRequest({
        timestamp,
        method: "GET",
        path,
        body: "",
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
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => vi.unstubAllEnvs());

it("derives active store and shopper only from a signed account session", async () => {
  const response = await storeAccountInvitationsRoute(signed());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], nextCursor: null });
  expect(mocks.list).toHaveBeenCalledWith({
    storeId: "store-a",
    shopperId: "shopper-a",
    expectedInstallationGeneration: "generation-a",
    query: { limit: 10 },
  });
});

it("rejects forged source, duplicate identity and unknown account mappings", async () => {
  expect(
    (
      await storeAccountInvitationsRoute(
        signed("shop=verified.myshopify.com&customerId=123&source=app_proxy"),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await storeAccountInvitationsRoute(
        signed(
          "shop=verified.myshopify.com&customerId=123&customerId=999&source=customer_account",
        ),
      )
    ).status,
  ).toBe(400);
  mocks.shopper.mockResolvedValueOnce([]);
  expect((await storeAccountInvitationsRoute(signed())).status).toBe(404);
  mocks.shopper.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
  expect((await storeAccountInvitationsRoute(signed())).status).toBe(503);
  expect(mocks.list).not.toHaveBeenCalled();
});

it("rejects an unsigned request and unknown query parameters", async () => {
  const unsigned = new Request(
    "https://backend.example.test/api/internal/shopify/reviews/store-invitations?shop=verified.myshopify.com&customerId=123&source=customer_account",
  );
  expect((await storeAccountInvitationsRoute(unsigned)).status).toBe(401);
  expect(
    (
      await storeAccountInvitationsRoute(
        signed(
          "shop=verified.myshopify.com&customerId=123&source=customer_account&shopperId=attacker",
        ),
      )
    ).status,
  ).toBe(400);
  expect(mocks.list).not.toHaveBeenCalled();
});
