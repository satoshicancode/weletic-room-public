import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readShopifyMerchantReviewTranslations,
  writeShopifyMerchantReviewTranslation,
} from "../../lib/weletic/shopify/merchant-review-translations";

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  authorize: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../../lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.fence,
}));
vi.mock("../../lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("../../lib/weletic/reviews/translation-write", () => ({
  writeReviewTranslationInTransaction: mocks.write,
}));
vi.mock("../../lib/weletic/reviews/translation-read", () => ({
  readReviewTranslationsInTransaction: mocks.read,
}));

describe("internal signed-envelope translation gateway", () => {
  const tx = {};
  const envelope = {
    version: 1,
    appId: "app_1",
    shop: "test.myshopify.com",
    storeId: "store_1",
    installationGeneration: "generation_1",
    userId: "42",
    sessionId: "test.myshopify.com_42",
    sessionDigest: "a".repeat(64),
    authenticatedAt: 1,
    requestId: "b".repeat(64),
  };
  const input = {
    action: "remove",
    reviewId: "review_1",
    locale: "ja",
    expectedInstallationGeneration: "generation_1",
    expectedReviewVersion: 4,
    expectedTranslationRevision: 0,
  };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fence.mockImplementation((_store, operation) =>
      operation(tx, "generation_1"),
    );
    mocks.authorize.mockResolvedValue({
      storeId: "store_1",
      appId: "app_1",
      installationGeneration: "generation_1",
      shopifyUserId: "42",
      actionId: "c".repeat(64),
    });
    mocks.write.mockResolvedValue({ revision: 1 });
  });
  it("uses one store-fenced transaction for permission, receipt and translation", async () => {
    expect(
      await writeShopifyMerchantReviewTranslation({ envelope, input }),
    ).toEqual({ revision: 1 });
    expect(mocks.fence).toHaveBeenCalledWith(
      "store_1",
      expect.any(Function),
      "generation_1",
    );
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "reviews.moderate",
    });
    expect(mocks.write).toHaveBeenCalledWith({
      tx,
      storeId: "store_1",
      generation: "generation_1",
      input,
      actor: {
        kind: "shopify",
        userId: "42",
        appId: "app_1",
        installationGeneration: "generation_1",
        merchantActionId: "c".repeat(64),
      },
    });
  });
  it("authorizes reads separately and passes only derived ownership to projection", async () => {
    mocks.read.mockResolvedValue({ reviewId: "review_1" });
    expect(
      await readShopifyMerchantReviewTranslations({
        envelope,
        input: { reviewId: "review_1" },
      }),
    ).toEqual({ reviewId: "review_1" });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "reviews.read",
    });
    expect(mocks.read).toHaveBeenCalledWith({
      tx,
      storeId: "store_1",
      reviewId: "review_1",
      generation: "generation_1",
    });
  });
  it("never reads review content after denied authorization", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(
      readShopifyMerchantReviewTranslations({
        envelope,
        input: { reviewId: "review_1" },
      }),
    ).rejects.toThrow("denied");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects store substitution on the read contract", async () => {
    await expect(
      readShopifyMerchantReviewTranslations({
        envelope,
        input: { reviewId: "review_1", storeId: "foreign" },
      }),
    ).rejects.toThrow();
    expect(mocks.fence).not.toHaveBeenCalled();
  });
  it("does not write when current staff authorization fails", async () => {
    mocks.authorize.mockRejectedValue(new Error("access denied"));
    await expect(
      writeShopifyMerchantReviewTranslation({ envelope, input }),
    ).rejects.toThrow("access denied");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects browser-supplied store/actor fields before opening a transaction", async () => {
    await expect(
      writeShopifyMerchantReviewTranslation({
        envelope,
        input: { ...input, storeId: "foreign" },
      }),
    ).rejects.toThrow();
    expect(mocks.fence).not.toHaveBeenCalled();
  });
  it("propagates writer failure instead of recording a successful response", async () => {
    mocks.write.mockRejectedValue(new Error("conflict"));
    await expect(
      writeShopifyMerchantReviewTranslation({ envelope, input }),
    ).rejects.toThrow("conflict");
  });
});
