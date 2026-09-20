import { beforeEach, expect, it, vi } from "vitest";
import { getPublicProductReviews } from "../../lib/weletic/reviews/public";
import { reviewTranslationSourceDigest } from "../../lib/weletic/reviews/translation-source";
const mocks = vi.hoisted(() => ({
  product: vi.fn(),
  rows: vi.fn(),
  aggregate: vi.fn(),
  groups: vi.fn(),
  privacy: vi.fn(),
  query: vi.fn(),
  store: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: {
    weleticShopifyProduct: { findFirst: mocks.product },
    $transaction: async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: mocks.query,
        weleticShopifyStore: { findUnique: mocks.store },
        weleticProductReview: {
          findMany: mocks.rows,
          aggregate: mocks.aggregate,
          groupBy: mocks.groups,
        },
      }),
  },
}));
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: mocks.privacy,
  loadShopifyPrivacyHmacKeyring: () => {
    const key = { identityKeyId: "fixture", secret: Buffer.alloc(32, 7) };
    return { current: key, all: [key] };
  },
}));
const source = {
  id: "review_1",
  storeId: "store_1",
  version: 2,
  status: "published",
  redactedAt: null,
  title: "Original",
  body: "Original body",
  rating: 2,
  displayName: "Public name",
  merchantReply: null,
  verifiedPurchase: true,
  incentivized: false,
  createdAt: new Date("2026-09-20T00:00:00Z"),
  media: [],
  shopper: {
    email: "private@example.test",
    shopifyCustomerId: "private-customer",
  },
};
const translation = {
  storeId: source.storeId,
  reviewId: source.id,
  locale: "ja",
  status: "active",
  redactedAt: null,
  sourceReviewVersion: 1,
  sourceLocale: "en",
  sourceDigest: reviewTranslationSourceDigest({
    ...source,
    reviewId: source.id,
  }),
  title: "日本語",
  body: "日本語のレビュー",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.product.mockResolvedValue({ id: "product_1" });
  mocks.rows.mockResolvedValue([{ ...source, translations: [translation] }]);
  mocks.aggregate.mockResolvedValue({
    _count: { rating: 1 },
    _sum: { rating: 2 },
  });
  mocks.groups.mockResolvedValue([{ rating: 2, _count: { _all: 1 } }]);
  mocks.privacy.mockResolvedValue(false);
  mocks.store.mockResolvedValue({
    installationGeneration: "g1",
    complianceState: "active",
    storeAccessState: "active",
  });
  mocks.query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ rating: 2, count: BigInt(1) }])
    .mockResolvedValue([{ id: "review_1" }]);
});
it("returns matching translated text and original without internal privacy/source fields", async () => {
  const result = await getPublicProductReviews("store_1", {
    productId: "123",
    locale: "ja",
  });
  expect(result.items[0]).toMatchObject({
    title: translation.title,
    body: translation.body,
    rating: 2,
    translation: {
      locale: "ja",
      original: { title: source.title, body: source.body },
    },
  });
  const serialized = JSON.stringify(result.items);
  for (const field of [
    "private@example.test",
    "private-customer",
    "sourceDigest",
    "sourceReviewVersion",
    "storeId",
    "shopper",
    "redactedAt",
  ])
    expect(serialized).not.toContain(field);
  expect(mocks.rows).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        storeId: "store_1",
        redactedAt: null,
        shopper: { storeId: "store_1", privacyTombstones: { none: {} } },
      }),
      select: expect.objectContaining({
        translations: expect.objectContaining({
          where: {
            storeId: "store_1",
            locale: "ja",
            status: "active",
            redactedAt: null,
          },
          take: 1,
        }),
      }),
    }),
  );
});
it.each([
  { sourceDigest: "stale" },
  { storeId: "foreign" },
  { reviewId: "foreign" },
  { status: "removed" },
  { redactedAt: new Date() },
  { locale: "vi" },
])("falls back to the original for invalid translation %j", async (patch) => {
  mocks.rows.mockResolvedValue([
    { ...source, translations: [{ ...translation, ...patch }] },
  ]);
  const result = await getPublicProductReviews("store_1", {
    productId: "123",
    locale: "ja",
  });
  expect(result.items[0]).toMatchObject({
    title: source.title,
    body: source.body,
  });
  expect(result.items[0]).not.toHaveProperty("translation");
});
it("preserves original-only responses for callers without a locale", async () => {
  const result = await getPublicProductReviews("store_1", { productId: "123" });
  expect(result.items[0]).toMatchObject({ title: source.title });
  expect(result.items[0]).not.toHaveProperty("translation");
});
it("fails closed on an unlinked privacy identity without returning summary or cursor", async () => {
  mocks.privacy.mockResolvedValue(true);
  mocks.rows.mockResolvedValue([
    { ...source, translations: [translation] },
    { ...source, id: "review_2", translations: [] },
  ]);
  await expect(
    getPublicProductReviews("store_1", {
      productId: "123",
      locale: "ja",
      limit: 1,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
});
it("binds pagination to the requested translation locale", async () => {
  mocks.rows.mockResolvedValue([
    { ...source, translations: [translation] },
    { ...source, id: "review_2", translations: [] },
  ]);
  const result = await getPublicProductReviews("store_1", {
    productId: "123",
    locale: "ja",
    limit: 1,
  });
  expect(result.nextCursor).not.toBeNull();
  await expect(
    getPublicProductReviews("store_1", {
      productId: "123",
      locale: "vi",
      cursor: result.nextCursor,
    }),
  ).rejects.toMatchObject({ code: "bad_request" });
});
