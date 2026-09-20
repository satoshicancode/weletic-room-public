import {
  exportReviewMediaFile,
  reviewMediaFileExportWhere,
} from "@/lib/weletic/reviews/media-file-export";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  owned: vi.fn(),
  read: vi.fn(),
  product: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticReviewMedia: { findFirst: mocks.owned },
    weleticShopifyProduct: { findFirst: mocks.product },
  },
}));
vi.mock("@/lib/storage", () => ({
  storage: { readPrivateR2Object: mocks.read },
}));

const record = {
  id: "photo_1",
  requestId: null,
  reviewId: null,
  objectKey: "weletic/reviews/store_1/photo_1.webp",
  contentType: "image/webp",
  sizeBytes: 5,
  createdAt: new Date(0),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.owned.mockResolvedValue({
    ...record,
    storeId: "store_1",
    status: "uploaded",
    review: null,
    request: null,
    openOwnership: {
      storeId: "store_1",
      mediaId: record.id,
      shopperId: "shopper_1",
      productId: "product_1",
      installationGeneration: "generation_1",
      source: "app_proxy",
      submissionKey: "a".repeat(64),
      settingsRevision: 1,
      redactedAt: null,
      contentDigest: "b".repeat(64),
      storageWriteState: "confirmed",
    },
  });
  mocks.product.mockResolvedValue({ id: "product_1" });
  mocks.read.mockResolvedValue(Buffer.from("photo"));
});
it("uses exclusive same-store ownership, never inclusive erasure ownership", () => {
  expect(reviewMediaFileExportWhere("store_1", "shopper_1")).toEqual({
    storeId: "store_1",
    status: "uploaded",
    OR: [
      {
        requestId: { not: null },
        request: { storeId: "store_1", shopperId: "shopper_1" },
        openOwnership: null,
      },
      {
        requestId: null,
        openOwnership: {
          storeId: "store_1",
          shopperId: "shopper_1",
          redactedAt: null,
          storageWriteState: "confirmed",
        },
      },
    ],
  });
});
it("exports bytes with no raw key, URL or submission authority and rechecks ownership", async () => {
  const result = await exportReviewMediaFile("store_1", "shopper_1", record);
  expect(result.data).toBe(Buffer.from("photo").toString("base64"));
  expect(result).not.toHaveProperty("objectKey");
  expect(result).not.toHaveProperty("downloadUrl");
  expect(result).not.toHaveProperty("requestId");
  expect(mocks.owned).toHaveBeenCalledTimes(2);
  expect(mocks.owned.mock.calls[0]).toEqual(mocks.owned.mock.calls[1]);
});
it("does not fetch another owner's photo", async () => {
  mocks.owned.mockResolvedValue(null);
  await expect(
    exportReviewMediaFile("store_1", "shopper_2", record),
  ).rejects.toThrow("ownership changed");
  expect(mocks.read).not.toHaveBeenCalled();
});
it("rejects corrupt attached ownership before reading any bytes", async () => {
  const current = await mocks.owned();
  mocks.owned.mockResolvedValue({
    ...current,
    reviewId: "foreign_review",
    review: {
      id: "foreign_review",
      storeId: "foreign",
      shopperId: "shopper_1",
    },
  });
  await expect(
    exportReviewMediaFile("store_1", "shopper_1", {
      ...record,
      reviewId: "foreign_review",
    }),
  ).rejects.toThrow("attached photo ownership invalid");
  expect(mocks.read).not.toHaveBeenCalled();
});
it("rejects a reservation whose product no longer has same-store ownership", async () => {
  mocks.product.mockResolvedValue(null);
  await expect(
    exportReviewMediaFile("store_1", "shopper_1", record),
  ).rejects.toThrow("product ownership invalid");
  expect(mocks.read).not.toHaveBeenCalled();
});
it.each(["invitation", "open"])(
  "rejects attached %s photos whose matching product belongs to another store",
  async (kind) => {
    const current = await mocks.owned();
    const review = {
      id: "review_1",
      storeId: "store_1",
      shopperId: "shopper_1",
      productId: "foreign_product",
      requestId: kind === "invitation" ? "request_1" : null,
      openSubmission:
        kind === "invitation"
          ? null
          : {
              storeId: "store_1",
              reviewId: "review_1",
              shopperId: "shopper_1",
              redactedAt: null,
              contentDigest: "a".repeat(64),
              installationGeneration: "generation_1",
              source: "app_proxy",
              idempotencyKey: "a".repeat(64),
              settingsRevision: 1,
            },
    };
    mocks.owned.mockResolvedValue({
      ...current,
      reviewId: review.id,
      review,
      requestId: review.requestId,
      request:
        kind === "invitation"
          ? {
              id: "request_1",
              storeId: "store_1",
              shopperId: "shopper_1",
              productId: "foreign_product",
            }
          : null,
      openOwnership:
        kind === "invitation"
          ? null
          : { ...current.openOwnership, productId: "foreign_product" },
    });
    mocks.product.mockResolvedValue(null);
    await expect(
      exportReviewMediaFile("store_1", "shopper_1", {
        ...record,
        reviewId: review.id,
        requestId: review.requestId,
      }),
    ).rejects.toThrow("product ownership invalid");
    expect(mocks.product).toHaveBeenCalledWith({
      where: { id: "foreign_product", storeId: "store_1" },
      select: { id: true },
    });
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
it("withholds bytes when an otherwise eligible ownership snapshot changes", async () => {
  const current = await mocks.owned();
  mocks.owned.mockResolvedValueOnce(current).mockResolvedValueOnce({
    ...current,
    openOwnership: { ...current.openOwnership, settingsRevision: 2 },
  });
  await expect(
    exportReviewMediaFile("store_1", "shopper_1", record),
  ).rejects.toThrow("ownership changed");
});
it("withholds bytes if ownership or privacy changes during the read", async () => {
  const initial = await mocks.owned();
  mocks.owned.mockClear();
  mocks.owned.mockResolvedValueOnce(initial).mockResolvedValueOnce(null);
  await expect(
    exportReviewMediaFile("store_1", "shopper_1", record),
  ).rejects.toThrow("ownership changed");
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
it.each([
  { objectKey: "weletic/reviews/foreign/photo_1.webp" },
  { contentType: "image/svg+xml" },
  { sizeBytes: 0 },
  { sizeBytes: 2 * 1024 * 1024 + 1 },
])("fails closed for invalid metadata %j", async (override) => {
  await expect(
    exportReviewMediaFile("store_1", "shopper_1", { ...record, ...override }),
  ).rejects.toThrow("metadata is invalid");
  expect(mocks.read).not.toHaveBeenCalled();
});
