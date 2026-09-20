import { readOpenReviewCustomer } from "@/lib/weletic/reviews/open-submission-customer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  settings: vi.fn(),
  token: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    weleticReviewSettings: { findUnique: mocks.settings },
  },
}));
vi.mock("@/lib/weletic/shopify/token-authority", () => ({
  fetchShopifyTokenAuthorityCredential: mocks.token,
}));
const store = {
  shopDomain: "test.myshopify.com",
  installationGeneration: "g1",
  storeAccessState: "active",
  complianceState: "active",
  uninstalledAt: null,
  redactedAt: null,
};
const customer = {
  id: "gid://shopify/Customer/123",
  defaultEmailAddress: { emailAddress: "author@example.invalid" },
};
const run = (shopifyCustomerId = "123") =>
  readOpenReviewCustomer({
    storeId: "store",
    installationGeneration: "g1",
    shopifyCustomerId,
  });
const unavailable = {
  code: "unavailable",
  message: "Review identity unavailable",
};

describe("trusted open-review customer read", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.store.mockResolvedValue(store);
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.token.mockResolvedValue({
      shopDomain: store.shopDomain,
      accessToken: "test-only-token",
      scope: "read_customers",
    });
    mocks.fetch.mockImplementation(async () =>
      Response.json({ data: { customer } }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses generation-bound credentials, minimal GraphQL fields and no loyalty dependency", async () => {
    expect(await run(customer.id)).toEqual({
      shopifyCustomerId: "123",
      email: "author@example.invalid",
    });
    expect(mocks.token).toHaveBeenCalledWith({
      shopDomain: store.shopDomain,
      installationGeneration: "g1",
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toMatch(
      /^https:\/\/test\.myshopify\.com\/admin\/api\/.+\/graphql\.json$/,
    );
    expect(options).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(options.body).variables).toEqual({ id: customer.id });
    expect(mocks.store).toHaveBeenCalledTimes(2);
    expect(mocks.settings).toHaveBeenCalledTimes(2);
  });
  it("accepts only explicit null as known absence", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        data: { customer: { ...customer, defaultEmailAddress: null } },
      }),
    );
    expect(await run()).toEqual({ shopifyCustomerId: "123", email: null });
  });
  it.each([
    "0",
    "01",
    "-1",
    "1.2",
    "gid://shopify/Order/123",
    "123 OR 1",
    "1".repeat(21),
  ])("rejects malformed identity %s before I/O", async (id) => {
    await expect(run(id)).rejects.toMatchObject(unavailable);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { storeAccessState: "pending_approval" },
    { storeAccessState: "suspended" },
    { complianceState: "redacting" },
    { uninstalledAt: new Date() },
    { redactedAt: new Date() },
    { installationGeneration: "g2" },
    { shopDomain: "https://evil.invalid" },
  ])("rejects admission before credential access: %j", async (patch) => {
    mocks.store.mockResolvedValue({ ...store, ...patch });
    await expect(run()).rejects.toMatchObject(unavailable);
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("rejects disabled reviews before credential access", async () => {
    mocks.settings.mockResolvedValue({ enabled: false });
    await expect(run()).rejects.toMatchObject(unavailable);
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it.each([
    { shopDomain: "other.myshopify.com", scope: "read_customers" },
    { shopDomain: store.shopDomain, scope: "read_products" },
  ])(
    "rejects mismatched credentials or missing customer scope",
    async (credential) => {
      mocks.token.mockResolvedValue({
        ...credential,
        accessToken: "test-only-token",
      });
      await expect(run()).rejects.toMatchObject(unavailable);
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { data: { customer: null } },
    { data: { customer: { id: customer.id } } },
    { data: { customer: { ...customer, id: "gid://shopify/Customer/456" } } },
    { data: { customer: { ...customer, defaultEmailAddress: {} } } },
    {
      data: {
        customer: {
          ...customer,
          defaultEmailAddress: { emailAddress: "invalid" },
        },
      },
    },
    {
      data: { customer },
      errors: [{ message: "protected customer data denied" }],
    },
  ])(
    "rejects partial, malformed or mismatched Shopify data",
    async (payload) => {
      mocks.fetch.mockResolvedValue(Response.json(payload));
      await expect(run()).rejects.toMatchObject(unavailable);
    },
  );
  it.each([401, 403, 429, 500])(
    "rejects HTTP %s without retry",
    async (status) => {
      mocks.fetch.mockResolvedValue(
        new Response("sensitive upstream error", { status }),
      );
      await expect(run()).rejects.toMatchObject(unavailable);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("sanitizes network errors", async () => {
    mocks.fetch.mockRejectedValue(new Error("secret or customer details"));
    await expect(run()).rejects.toMatchObject(unavailable);
  });
  it("rejects oversized response bodies", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ data: { customer }, padding: "x".repeat(32 * 1024) }),
    );
    await expect(run()).rejects.toMatchObject(unavailable);
  });
  it("rejects invalid UTF-8 rather than replacing bytes in identity data", async () => {
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([0xff])));
    await expect(run()).rejects.toMatchObject(unavailable);
  });
  it("keeps response body reading under the request deadline", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const canceled = vi.fn();
    mocks.fetch.mockImplementation(async () => {
      const response = new Response(new ReadableStream({ cancel: canceled }));
      queueMicrotask(() => controller.abort());
      return response;
    });
    try {
      await expect(run()).rejects.toMatchObject(unavailable);
      expect(timeout).toHaveBeenCalledWith(5000);
      expect(canceled).toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });
  it.each([
    { installationGeneration: "g2" },
    { storeAccessState: "suspended" },
    { shopDomain: "other.myshopify.com" },
  ])("rejects admission changes during external I/O", async (patch) => {
    mocks.store
      .mockResolvedValueOnce(store)
      .mockResolvedValueOnce({ ...store, ...patch });
    await expect(run()).rejects.toMatchObject(unavailable);
  });
  it("rejects module disable during external I/O", async () => {
    mocks.settings
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ enabled: false });
    await expect(run()).rejects.toMatchObject(unavailable);
  });
});
