import { InvalidOpenReviewPhoto } from "@/lib/weletic/reviews/open-media-errors";
import { openReviewSubmissionRoute } from "@/lib/weletic/reviews/open-submission-route";
import { signWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  current: vi.fn(),
  policy: vi.fn(),
  fence: vi.fn(),
  limit: vi.fn(),
  customer: vi.fn(),
  submit: vi.fn(),
  query: vi.fn(),
  upload: vi.fn(),
  storage: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { weleticShopifyStore: { findUnique: mocks.store } },
}));
vi.mock("@/lib/upstash", () => ({ ratelimit: () => ({ limit: mocks.limit }) }));
vi.mock("@/lib/weletic/reviews/open-policy-history", () => ({
  readCurrentOpenReviewPolicy: mocks.policy,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.fence,
}));
vi.mock("@/lib/weletic/reviews/open-submission-customer", () => ({
  readOpenReviewCustomer: mocks.customer,
}));
vi.mock("@/lib/weletic/reviews/open-submission-write", () => ({
  submitOpenReview: mocks.submit,
}));
vi.mock("@/lib/weletic/reviews/open-media-upload", () => ({
  uploadOpenReviewPhoto: mocks.upload,
}));
vi.mock("@/lib/weletic/reviews/media", () => ({
  requireReviewStorage: mocks.storage,
}));
const secret = "open-review-route-test-secret-32-characters";
const query = "shop=verified.myshopify.com&customerId=123&source=app_proxy";
const input = {
  authorBinding: createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "weletic:open-review-author:v1",
        "verified.myshopify.com",
        "123",
        "g1",
      ]),
    )
    .digest("hex"),
  submissionId: "12345678-1234-4123-8123-123456789012",
  productId: "gid://shopify/Product/456",
  expectedInstallationGeneration: "g1",
  expectedSettingsRevision: 1,
  locale: "en",
  disclosureRevision: "open_unverified_unrewarded_v1",
  rating: 1,
  title: "Feedback",
  body: "Honest product feedback",
  displayName: "Author",
  mediaIds: [],
  publishConsent: true,
};
const tx = {
  weleticShopifyStore: { findUnique: mocks.current },
  $queryRaw: mocks.query,
};
const photoInput = {
  authorBinding: input.authorBinding,
  submissionId: input.submissionId,
  uploadId: "22345678-1234-4123-8123-123456789012",
  productId: input.productId,
  expectedInstallationGeneration: "g1",
  expectedSettingsRevision: 1,
  contentType: "image/png",
  base64: Buffer.from("synthetic-image-bytes").toString("base64"),
};
function request(
  value: unknown = input,
  params = query,
  signed = true,
  action = "open-submit",
) {
  const body = JSON.stringify(value);
  const path = `/api/internal/shopify/reviews/${action}?${params}`;
  const timestamp = String(Date.now());
  return new Request(`https://backend.example.test${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signed
        ? signWeleticShopifyRequest({
            timestamp,
            method: "POST",
            path,
            body,
            secret,
          })
        : "invalid",
    },
  });
}
describe("signed open-review submission route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    mocks.store.mockResolvedValue({
      id: "store",
      installationGeneration: "g1",
    });
    mocks.current.mockResolvedValue({
      shopDomain: "verified.myshopify.com",
      installationGeneration: "g1",
    });
    mocks.policy.mockResolvedValue({
      revision: 7,
      policy: { enabled: true },
      installationGeneration: "g1",
    });
    mocks.fence.mockImplementation(async (_store, operation) => operation(tx));
    mocks.query.mockImplementation(async (query: TemplateStringsArray) =>
      query.join("").includes("WeleticReviewSettings")
        ? [{ enabled: true }]
        : [{ id: "product", title: "Product fixture" }],
    );
    mocks.limit.mockResolvedValue({ success: true });
    mocks.customer.mockResolvedValue({
      shopifyCustomerId: "123",
      email: "private@example.invalid",
    });
    mocks.submit.mockImplementation(async ({ authorize }) => {
      await authorize(tx);
      return { status: "received", duplicate: false };
    });
    mocks.upload.mockImplementation(async ({ authorize }) => {
      await authorize(tx);
      return { id: "media-fixture", privateProviderField: "must-not-leak" };
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("exposes only the typed pre-PUT validation error for safe photo correction", async () => {
    mocks.upload.mockRejectedValue(new InvalidOpenReviewPhoto());
    const response = await openReviewSubmissionRoute(
      request(photoInput),
      "upload",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_open_photo" },
    });
  });
  it("advertises photos only with both current policies and configured private storage", async () => {
    mocks.policy.mockResolvedValue({
      revision: 7,
      policy: { enabled: true, photoUploadsEnabled: true },
      installationGeneration: "g1",
    });
    mocks.query.mockImplementation(async (query: TemplateStringsArray) =>
      query.join("").includes("WeleticReviewSettings")
        ? [{ enabled: true, photoUploadsEnabled: true }]
        : [{ id: "product", title: "Product fixture" }],
    );
    const prepare = () =>
      openReviewSubmissionRoute(
        request({ productId: input.productId }),
        "prepare",
      );
    expect(await (await prepare()).json()).toMatchObject({
      photoUploadsAvailable: true,
    });
    mocks.storage.mockImplementation(() => {
      throw new Error("private provider config");
    });
    expect(await (await prepare()).json()).toMatchObject({
      photoUploadsAvailable: false,
    });
  });
  it("passes submitted media ownership to the atomic writer rather than trusting client claims", async () => {
    expect(
      (
        await openReviewSubmissionRoute(
          request({ ...input, mediaIds: ["wrevmedia_fixture"] }),
        )
      ).status,
    ).toBe(201);
    expect(mocks.submit.mock.calls[0][0].input.mediaIds).toEqual([
      "wrevmedia_fixture",
    ]);
  });
  it("uploads only bounded photo bytes with signed identity and a minimal receipt", async () => {
    const result = await openReviewSubmissionRoute(
      request(photoInput, query, true, "open-upload"),
      "upload",
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: "media-fixture" });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    const command = mocks.upload.mock.calls[0][0];
    expect(command.bytes).toEqual(Buffer.from("synthetic-image-bytes"));
    expect(command.input).not.toHaveProperty("base64");
    expect(command.input).not.toHaveProperty("authorBinding");
    expect(await command.authorize(tx)).toMatchObject({
      shopifyCustomerId: "123",
      source: "app_proxy",
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each(["!!!!", "YQ", "YR==", "YQ==\n", "data:image/png;base64,YQ=="])(
    "rejects noncanonical photo encoding %s before customer reads",
    async (base64) => {
      const result = await openReviewSubmissionRoute(
        request({ ...photoInput, base64 }),
        "upload",
      );
      expect(result.status).toBe(400);
      expect(mocks.customer).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
    },
  );
  it.each([
    { authorBinding: "b".repeat(64) },
    { shopifyCustomerId: "999" },
    { source: "customer_account" },
    { expectedInstallationGeneration: "g2" },
  ])("rejects injected or switched photo authority %j", async (changed) => {
    const result = await openReviewSubmissionRoute(
      request({ ...photoInput, ...changed }),
      "upload",
    );
    expect([400, 409]).toContain(result.status);
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("rejects unsigned uploads and oversized photo envelopes", async () => {
    expect(
      (
        await openReviewSubmissionRoute(
          request({
            ...photoInput,
            base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
          }),
          "upload",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await openReviewSubmissionRoute(
          request(photoInput, query, false),
          "upload",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await openReviewSubmissionRoute(
          request({ ...photoInput, base64: "a".repeat(3 * 1024 * 1024) }),
          "upload",
        )
      ).status,
    ).toBe(413);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("does not upload when the signed domain changes during customer lookup", async () => {
    mocks.current.mockResolvedValue({
      shopDomain: "foreign.myshopify.com",
      installationGeneration: "g1",
    });
    expect(
      (await openReviewSubmissionRoute(request(photoInput), "upload")).status,
    ).toBe(409);
  });
  it("passes trusted identity through a transaction-local callback with a private receipt", async () => {
    const result = await openReviewSubmissionRoute(request());
    expect(result.status).toBe(201);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toEqual({
      status: "received",
      duplicate: false,
    });
    expect(mocks.customer).toHaveBeenCalledWith({
      storeId: "store",
      installationGeneration: "g1",
      shopifyCustomerId: "123",
    });
    const command = mocks.submit.mock.calls[0][0];
    expect(await command.authorize(tx)).toEqual({
      shopifyCustomerId: "123",
      email: "private@example.invalid",
      source: "app_proxy",
    });
    expect(mocks.fence.mock.calls[0][2]).toBe("g1");
    expect(mocks.limit.mock.calls[0][0]).not.toContain("123");
  });
  it("prepares current policy without reading or creating customer records", async () => {
    const result = await openReviewSubmissionRoute(
      request({ productId: input.productId }, query, true, "open-prepare"),
      "prepare",
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      productId: input.productId,
      productTitle: "Product fixture",
      expectedInstallationGeneration: "g1",
      expectedSettingsRevision: 7,
      authorBinding: input.authorBinding,
      disclosureRevision: input.disclosureRevision,
      verifiedPurchase: false,
      incentivized: false,
      photoUploadsAvailable: false,
    });
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it.each([{ enabled: false }, null])(
    "refuses prepare for disabled or missing module",
    async (settings) => {
      mocks.query.mockResolvedValue(settings ? [settings] : []);
      expect(
        (
          await openReviewSubmissionRoute(
            request(
              { productId: input.productId },
              query,
              true,
              "open-prepare",
            ),
            "prepare",
          )
        ).status,
      ).toBe(403);
    },
  );
  it("refuses missing or inactive product during preparation", async () => {
    mocks.query
      .mockResolvedValueOnce([{ enabled: true }])
      .mockResolvedValueOnce([]);
    expect(
      (
        await openReviewSubmissionRoute(
          request({ productId: input.productId }, query, true, "open-prepare"),
          "prepare",
        )
      ).status,
    ).toBe(404);
  });
  it("refuses caller-chosen revisions and identity in prepare content", async () => {
    expect(
      (
        await openReviewSubmissionRoute(
          request(
            {
              productId: input.productId,
              expectedSettingsRevision: 9,
              customerId: "999",
            },
            query,
            true,
            "open-prepare",
          ),
          "prepare",
        )
      ).status,
    ).toBe(400);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("refuses changed shop ownership while preparing", async () => {
    mocks.current.mockResolvedValue({ shopDomain: "other.myshopify.com" });
    expect(
      (
        await openReviewSubmissionRoute(
          request({ productId: input.productId }, query, true, "open-prepare"),
          "prepare",
        )
      ).status,
    ).toBe(409);
  });
  it("returns duplicate receipt without claiming new creation", async () => {
    mocks.submit.mockResolvedValue({ status: "received", duplicate: true });
    expect((await openReviewSubmissionRoute(request())).status).toBe(200);
  });
  it("rejects invalid signatures before any identity or database access", async () => {
    expect(
      (await openReviewSubmissionRoute(request(input, query, false))).status,
    ).toBe(401);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("rejects tampering with signed customer identity", async () => {
    const original = request();
    const changed = new Request(
      original.url.replace("customerId=123", "customerId=456"),
      {
        method: "POST",
        headers: original.headers,
        body: await original.text(),
      },
    );
    expect((await openReviewSubmissionRoute(changed)).status).toBe(401);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("rejects an authenticated account switch with the original prepared binding", async () => {
    const result = await openReviewSubmissionRoute(
      request(input, query.replace("customerId=123", "customerId=456")),
    );
    expect(result.status).toBe(409);
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("preserves trusted account attribution while accepting the same prepared shopper binding", async () => {
    const result = await openReviewSubmissionRoute(
      request(input, query.replace("app_proxy", "customer_account")),
    );
    expect(result.status).toBe(201);
    expect(await mocks.submit.mock.calls[0][0].authorize(tx)).toMatchObject({
      shopifyCustomerId: "123",
      source: "customer_account",
    });
  });
  it.each([
    query + "&customerId=456",
    query + "&storeId=other",
    query.replace("app_proxy", "untrusted_source"),
    query.replace("customerId=123", "customerId="),
  ])("rejects ambiguous or unauthorized context %s", async (params) => {
    expect(
      (await openReviewSubmissionRoute(request(input, params))).status,
    ).toBe(400);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it.each([
    "email",
    "shopifyCustomerId",
    "source",
    "verifiedPurchase",
    "rewardStatus",
  ])("rejects shopper-injected %s", async (key) => {
    expect(
      (await openReviewSubmissionRoute(request({ ...input, [key]: "forged" })))
        .status,
    ).toBe(400);
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies before store lookup", async () => {
    expect(
      (
        await openReviewSubmissionRoute(
          request({ ...input, body: "x".repeat(65536) }),
        )
      ).status,
    ).toBe(413);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it.each([
    { policy: { enabled: false }, installationGeneration: "g1" },
    { policy: { enabled: true }, installationGeneration: "g2" },
  ])("checks policy before protected customer read", async (policy) => {
    mocks.policy.mockResolvedValue(policy);
    expect((await openReviewSubmissionRoute(request())).status).toBe(403);
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("contains failed store fencing without reading Shopify", async () => {
    mocks.fence.mockRejectedValue(new Error("private state"));
    expect((await openReviewSubmissionRoute(request())).status).toBe(503);
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("rate limits before protected reads", async () => {
    mocks.limit.mockResolvedValue({ success: false });
    expect((await openReviewSubmissionRoute(request())).status).toBe(429);
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("does not write after a failed trusted read", async () => {
    mocks.customer.mockRejectedValue(new Error("private upstream data"));
    const result = await openReviewSubmissionRoute(request());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private upstream");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each([
    { shopDomain: "other.myshopify.com", installationGeneration: "g1" },
    { shopDomain: "verified.myshopify.com", installationGeneration: "g2" },
  ])("rejects ownership changes in writer callback", async (current) => {
    mocks.current.mockResolvedValue(current);
    expect((await openReviewSubmissionRoute(request())).status).toBe(409);
  });
});
