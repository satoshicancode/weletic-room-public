import { beforeEach, expect, it, vi } from "vitest";
import { loader } from "../../../../packages/shopify-app/app/routes/apps.proxy.$";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), api: vi.fn() }));
vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  authenticate: { public: { appProxy: mocks.auth } },
}));
vi.mock(
  "../../../../packages/shopify-app/app/weletic-api.server",
  async (original) => ({
    ...(await original<
      typeof import("../../../../packages/shopify-app/app/weletic-api.server")
    >()),
    weleticApiJson: mocks.api,
  }),
);
function load(query: string) {
  return loader({
    request: new Request(
      "https://fixture.example/apps/loyalty/customer/nudge-collections?shop=fixture.myshopify.com&" +
        query,
    ),
    params: { "*": "loyalty/customer/nudge-collections" },
    context: {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ session: { shop: "fixture.myshopify.com" } });
  mocks.api.mockResolvedValue({ data: { membership: null } });
});
it("uses signed shopper identity and drops caller identity/scope fields", async () => {
  const response = await load(
    "logged_in_customer_id=123&productIds=1,2&customerId=999&collectionIds=9",
  );
  expect(response.status).toBe(200);
  const target = new URL(mocks.api.mock.calls[0][0], "https://backend.example");
  expect(target.searchParams.get("customerId")).toBe("123");
  expect(target.searchParams.get("collectionIds")).toBeNull();
  expect(target.searchParams.get("productIds")).toBe("1,2");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it.each([
  "productIds=1",
  "logged_in_customer_id=0&productIds=1",
  "logged_in_customer_id=123&productIds=1&productIds=2",
])("rejects invalid shopper query %s", async (query) => {
  expect((await load(query)).status).toBeGreaterThanOrEqual(400);
  expect(mocks.api).not.toHaveBeenCalled();
});
it("does not forward a shop/session mismatch", async () => {
  mocks.auth.mockResolvedValue({ session: { shop: "other.myshopify.com" } });
  expect((await load("logged_in_customer_id=123&productIds=1")).status).toBe(
    401,
  );
  expect(mocks.api).not.toHaveBeenCalled();
});
it("sanitizes upstream failure", async () => {
  mocks.api.mockRejectedValue(new Error("sensitive upstream"));
  const response = await load("logged_in_customer_id=123&productIds=1");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("sensitive upstream");
});
