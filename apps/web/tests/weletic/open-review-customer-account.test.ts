import { verifyWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { action } from "../../../../packages/shopify-app/app/routes/api.customer-account.$";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
  cors: vi.fn(),
}));
vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  authenticate: { public: { customerAccount: mocks.auth } },
}));
const input = {
  rating: 1,
  title: "Honest feedback",
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
};
const run = (
  endpoint = "open-submit",
  content: unknown = input,
  method = "POST",
) =>
  action({
    request: new Request(
      `https://app.example.test/api/customer-account/reviews/${endpoint}?shop=forged.myshopify.com&customerId=999&source=app_proxy`,
      {
        method,
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer synthetic-session",
        },
        body: JSON.stringify(content),
      },
    ),
    params: { "*": `reviews/${endpoint}` },
    context: {},
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_API_URL", "https://backend.example.test");
  vi.stubEnv(
    "WELETIC_SHOPIFY_SERVICE_SECRET",
    "customer-account-test-secret-at-least-32",
  );
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue(
    Response.json({ status: "received", duplicate: false }),
  );
  mocks.cors.mockImplementation((response: Response) => {
    response.headers.set("x-test-cors", "applied");
    return response;
  });
  mocks.auth.mockResolvedValue({
    sessionToken: {
      dest: "https://verified.myshopify.com",
      sub: "gid://shopify/Customer/123",
    },
    cors: mocks.cors,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each(["open-prepare", "open-submit", "open-upload"])(
  "signs %s using SDK identity and fixed account source",
  async (endpoint) => {
    const content =
      endpoint === "open-prepare" ? { productId: input.productId } : input;
    const response = await run(endpoint, content);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test-cors")).toBe("applied");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    const [url, options] = mocks.fetch.mock.calls[0];
    const request = new Request(url, options);
    const query = new URL(request.url).searchParams;
    expect(query.get("shop")).toBe("verified.myshopify.com");
    expect(query.get("customerId")).toBe("123");
    expect(query.get("source")).toBe("customer_account");
    expect(
      verifyWeleticShopifyRequest({ request, body: String(options.body) }),
    ).toBe(true);
    expect(options.body).toBe(JSON.stringify(content));
  },
);
it("never dispatches rejected authentication", async () => {
  mocks.auth.mockRejectedValue(new Response(null, { status: 401 }));
  await expect(run()).rejects.toMatchObject({ status: 401 });
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("rejects unsupported methods even with a verified session", async () => {
  expect((await run("open-submit", input, "PUT")).status).toBe(404);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("rejects a token without its destination", async () => {
  mocks.auth.mockResolvedValue({
    sessionToken: { sub: "gid://shopify/Customer/123" },
    cors: mocks.cors,
  });
  expect((await run()).status).toBe(401);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each(["", "0", "01", "-1", "gid://shopify/Order/123", "1".repeat(21)])(
  "rejects invalid token subject %s",
  async (sub) => {
    mocks.auth.mockResolvedValue({
      sessionToken: { dest: "https://verified.myshopify.com", sub },
      cors: mocks.cors,
    });
    expect((await run()).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it.each(["submit", "upload", "open-write", "health"])(
  "does not expose %s through the account gateway",
  async (endpoint) => {
    expect((await run(endpoint)).status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it("rejects body identity injection before dispatch", async () => {
  const response = await run("open-submit", {
    ...input,
    shopifyCustomerId: "999",
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("x-test-cors")).toBe("applied");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("preserves CORS and uncertainty on upstream failure", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({ error: "private details" }, { status: 503 }),
  );
  const response = await run();
  expect(response.status).toBe(503);
  expect(response.headers.get("x-test-cors")).toBe("applied");
  expect(await response.text()).not.toContain("private details");
});
