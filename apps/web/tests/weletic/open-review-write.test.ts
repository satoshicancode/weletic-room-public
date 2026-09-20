import {
  OPEN_REVIEW_DISCLOSURE_REVISION,
  openReviewSubmissionEvidence,
} from "@/lib/weletic/reviews/open-submission-contract";
import { submitOpenReview } from "@/lib/weletic/reviews/open-submission-write";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  policy: vi.fn(),
  author: vi.fn(),
  query: vi.fn(),
  review: vi.fn(),
  source: vi.fn(),
  authorize: vi.fn(),
  flow: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/flow-producer", () => ({
  enqueueReviewFlowEvent: mocks.flow,
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.fence,
}));
vi.mock("@/lib/weletic/reviews/open-policy-history", () => ({
  readCurrentOpenReviewPolicy: mocks.policy,
}));
vi.mock("@/lib/weletic/reviews/open-submission-author", () => ({
  ensureOpenReviewAuthorInTransaction: mocks.author,
}));
const tx = {
  $queryRaw: mocks.query,
  weleticProductReview: { create: mocks.review },
  weleticOpenReviewSubmission: { create: mocks.source },
};
const input = {
  submissionId: "12345678-1234-4123-8123-123456789012",
  productId: "gid://shopify/Product/123",
  expectedInstallationGeneration: "g1",
  expectedSettingsRevision: 1,
  locale: "en",
  disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
  rating: 1,
  title: "Honest feedback",
  body: "This product did not meet my expectations.",
  displayName: "Shopper",
  mediaIds: [],
  publishConsent: true,
};
const scope = {
  storeId: "store",
  shopperId: "shopper",
  installationGeneration: "g1",
  source: "app_proxy" as const,
};
let replay: object[];
let products: object[];
let recent: object[];
const now = new Date("2026-09-20T12:00:00Z");
const run = (patch = {}) =>
  submitOpenReview({
    storeId: "store",
    installationGeneration: "g1",
    input: { ...input, ...patch },
    authorize: mocks.authorize,
  });
describe("internal open review submission transaction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    replay = [];
    products = [{ id: "owned-product" }];
    recent = [];
    mocks.fence.mockImplementation((_store, operation) => operation(tx));
    mocks.authorize.mockResolvedValue({
      shopifyCustomerId: "123",
      email: null,
      source: "app_proxy",
    });
    mocks.author.mockResolvedValue({ shopperId: "shopper" });
    mocks.policy.mockResolvedValue({
      revision: 1,
      installationGeneration: "g1",
      policy: {
        enabled: true,
        photoUploadsEnabled: false,
        maxSubmissionsPer24Hours: 3,
      },
    });
    mocks.query.mockImplementation((sql: Prisma.Sql) => {
      const query = sql.strings.join("?");
      if (query.includes("INNER JOIN")) return replay;
      if (query.includes("FROM WeleticShopifyProduct")) return products;
      if (query.includes("CURRENT_TIMESTAMP")) return [{ now }];
      if (query.includes("createdAt >")) return recent;
      throw new Error("Unexpected query");
    });
  });
  it("creates pending unverified/unrewarded content and immutable provenance", async () => {
    expect(await run()).toEqual({ status: "received", duplicate: false });
    expect(mocks.fence).toHaveBeenCalledWith(
      "store",
      expect.any(Function),
      "g1",
    );
    expect(mocks.authorize).toHaveBeenCalledWith(tx);
    expect(mocks.review).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: "store",
        shopperId: "shopper",
        productId: "owned-product",
        requestId: null,
        rating: 1,
        status: "pending",
        verifiedPurchase: false,
        incentivized: false,
        rewardStatus: "ineligible",
        createdAt: now,
      }),
    });
    expect(mocks.source).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settingsRevision: 1,
        source: "app_proxy",
        ...openReviewSubmissionEvidence(scope, input),
        createdAt: now,
      }),
    });
    expect(mocks.source.mock.calls[0][0].data).not.toHaveProperty(
      "submissionId",
    );
    expect(mocks.flow).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store",
      generation: "g1",
      event: {
        handle: "weletic-review-submitted",
        reviewId: mocks.review.mock.calls[0][0].data.id,
        version: 1,
        occurredAt: now.toISOString(),
        rating: 1,
        verifiedPurchase: false,
      },
    });
  });
  it("returns exact replay before rate checks without creating new content", async () => {
    replay = [
      {
        ...openReviewSubmissionEvidence(scope, input),
        redactedAt: null,
        shopperId: "shopper",
        ownerId: "shopper",
        installationGeneration: "g1",
        reviewStatus: "hidden",
      },
    ];
    recent = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(await run()).toEqual({ status: "received", duplicate: true });
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.flow).not.toHaveBeenCalled();
  });
  it.each([
    { ownerId: "foreign" },
    { shopperId: "foreign" },
    { installationGeneration: "old" },
    { redactedAt: now },
    { contentDigest: null },
    { reviewStatus: "redacted" },
  ])("rejects suppressed or foreign replay %j", async (patch) => {
    replay = [
      {
        ...openReviewSubmissionEvidence(scope, input),
        redactedAt: null,
        shopperId: "shopper",
        ownerId: "shopper",
        installationGeneration: "g1",
        reviewStatus: "pending",
        ...patch,
      },
    ];
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("rejects changed content under an accepted operation", async () => {
    replay = [
      {
        ...openReviewSubmissionEvidence(scope, input),
        redactedAt: null,
        shopperId: "shopper",
        ownerId: "shopper",
        installationGeneration: "g1",
        reviewStatus: "pending",
      },
    ];
    await expect(run({ title: "Changed" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("refuses stale policy and foreign/inactive products", async () => {
    await expect(run({ expectedSettingsRevision: 2 })).rejects.toMatchObject({
      code: "conflict",
    });
    products = [];
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("enforces bounded current-read rate counting before writing", async () => {
    recent = [{ id: "1" }, { id: "2" }, { id: "3" }];
    await expect(run()).rejects.toMatchObject({ code: "unavailable" });
    const rate = mocks.query.mock.calls.at(-1)![0] as Prisma.Sql;
    expect(rate.strings.join("?")).toContain("FOR UPDATE");
    expect(rate.values).toEqual([
      "store",
      "shopper",
      new Date(now.getTime() - 86400000),
      3,
    ]);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("denied authentication or old installation policy cannot create an author", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("denied"));
    await expect(run()).rejects.toThrow("denied");
    expect(mocks.author).not.toHaveBeenCalled();
    mocks.policy.mockResolvedValue({
      revision: 1,
      installationGeneration: "old",
      policy: { enabled: true },
    });
    await expect(run()).rejects.toMatchObject({ code: "disabled" });
    expect(mocks.author).not.toHaveBeenCalled();
  });
  it("keeps disabled photos fail-closed before creating a review", async () => {
    await expect(run({ mediaIds: ["wrevmedia_photo"] })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("propagates provenance failure rather than acknowledging a partial transaction", async () => {
    mocks.source.mockRejectedValue(new Error("rollback required"));
    await expect(run()).rejects.toThrow("rollback required");
  });
});
