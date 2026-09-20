import { beforeEach, expect, it, vi } from "vitest";
import {
  action,
  loader,
} from "../../../../packages/shopify-app/app/routes/apps.proxy.$";
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
function run(
  query = "shop=verified.myshopify.com&logged_in_customer_id=123",
  method = "POST",
  endpoint = "open-submit",
) {
  const request = new Request(
    `https://fixture.example/apps/weletic/reviews/${endpoint}?${query}`,
    {
      method,
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              rating: 1,
              title: "Honest review",
              body: "This product did not meet expectations.",
              displayName: "Reviewer",
              mediaIds: [],
              publishConsent: true,
              submissionId: "12345678-1234-4123-8123-123456789012",
              productId: "gid://shopify/Product/456",
              expectedInstallationGeneration: "g1",
              expectedSettingsRevision: 1,
              disclosureRevision: "open_unverified_unrewarded_v1",
              locale: "en",
              authorBinding: "a".repeat(64),
            }),
            headers: { "content-type": "application/json" },
          }
        : {}),
    },
  );
  return (method === "POST" ? action : loader)({
    request,
    params: { "*": `reviews/${endpoint}` },
    context: {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ session: { shop: "verified.myshopify.com" } });
  mocks.api.mockResolvedValue({ status: "received", duplicate: false });
});
it("forwards identity only after successful SDK authentication", async () => {
  expect((await run()).status).toBe(200);
  expect(mocks.auth).toHaveBeenCalledTimes(1);
  expect(mocks.api.mock.calls[0][0]).toContain(
    "customerId=123&source=app_proxy",
  );
});
it("does not dispatch when authentication rejects", async () => {
  mocks.auth.mockRejectedValue(new Response(null, { status: 401 }));
  await expect(run()).rejects.toMatchObject({ status: 401 });
  expect(mocks.api).not.toHaveBeenCalled();
});
it.each(["GET", "POST"])(
  "rejects duplicate authority before SDK authentication for %s",
  async (method) => {
    for (const duplicate of [
      "shop=other.myshopify.com",
      "logged_in_customer_id=999",
      "signature=a&signature=b",
    ]) {
      const result = await run(
        `shop=verified.myshopify.com&logged_in_customer_id=123&${duplicate}`,
        method,
      );
      expect(result.status).toBe(400);
    }
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  },
);
it("rejects a verified query/session shop mismatch", async () => {
  mocks.auth.mockResolvedValue({ session: { shop: "other.myshopify.com" } });
  expect((await run()).status).toBe(401);
  expect(mocks.api).not.toHaveBeenCalled();
});
it("does not turn a caller customerId into authenticated identity", async () => {
  expect((await run("shop=verified.myshopify.com&customerId=123")).status).toBe(
    401,
  );
  expect(mocks.api).not.toHaveBeenCalled();
});
it.each(["open-prepare", "open-upload"])(
  "protects %s with verified identity and ambiguity checks",
  async (endpoint) => {
    expect((await run(undefined, "POST", endpoint)).status).toBe(200);
    expect(mocks.api.mock.calls[0][0]).toContain(
      `/reviews/${endpoint}?shop=verified.myshopify.com&customerId=123&source=app_proxy`,
    );
    mocks.auth.mockClear();
    mocks.api.mockClear();
    expect(
      (
        await run(
          "shop=verified.myshopify.com&logged_in_customer_id=123&logged_in_customer_id=999",
          "POST",
          endpoint,
        )
      ).status,
    ).toBe(400);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(
      (await run("shop=verified.myshopify.com", "POST", endpoint)).status,
    ).toBe(401);
    expect(mocks.api).not.toHaveBeenCalled();
  },
);
