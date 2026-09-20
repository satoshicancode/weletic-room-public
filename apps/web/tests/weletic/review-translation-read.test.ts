import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readReviewTranslationsInTransaction } from "../../lib/weletic/reviews/translation-read";
import { reviewTranslationSourceDigest } from "../../lib/weletic/reviews/translation-source";

const privacy = vi.hoisted(() => vi.fn());
const ownerGuard = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/reviews/translation-owner", () => ({
  assertReviewTranslationOwnerAvailable: ownerGuard,
}));
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: privacy,
}));

describe("private translation editor projection", () => {
  const findFirst = vi.fn();
  const tx = {
    weleticProductReview: { findFirst },
  } as unknown as Prisma.TransactionClient;
  const source = {
    id: "review_1",
    shopperId: "shopper_1",
    version: 4,
    title: "Original",
    body: "Original content",
    status: "hidden",
    shopper: { shopifyCustomerId: "42", email: "shopper@example.com" },
  };
  const row = {
    locale: "ja",
    revision: 2,
    status: "active",
    sourceLocale: "en",
    redactedAt: null,
    sourceReviewVersion: 3,
    title: "翻訳",
    body: "翻訳文",
    sourceDigest: reviewTranslationSourceDigest({
      storeId: "store_1",
      reviewId: source.id,
      title: source.title,
      body: source.body,
    }),
  };
  const run = () =>
    readReviewTranslationsInTransaction({
      tx,
      storeId: "store_1",
      reviewId: "review_1",
      generation: "generation_1",
    });
  beforeEach(() => {
    vi.resetAllMocks();
    privacy.mockResolvedValue(false);
    ownerGuard.mockResolvedValue(undefined);
    findFirst.mockResolvedValue({ ...source, translations: [{ ...row }] });
  });
  it("returns hidden original for authorized editing without shopper or digest metadata", async () => {
    const result = await run();
    expect(result).toEqual({
      reviewId: "review_1",
      installationGeneration: "generation_1",
      reviewVersion: 4,
      original: { title: source.title, body: source.body, status: "hidden" },
      translations: [
        {
          locale: "ja",
          revision: 2,
          status: "active",
          sourceLocale: "en",
          title: row.title,
          body: row.body,
        },
      ],
    });
    expect(privacy).toHaveBeenCalledWith({
      tx,
      storeId: "store_1",
      ...source.shopper,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store_1",
          id: "review_1",
          redactedAt: null,
          status: { not: "redacted" },
          product: { storeId: "store_1" },
          shopper: { storeId: "store_1", privacyTombstones: { none: {} } },
        },
      }),
    );
  });
  it.each([
    { sourceDigest: "outdated" },
    { sourceReviewVersion: 5 },
    { sourceReviewVersion: 0 },
    { status: "stale" },
  ])(
    "reports stale saved content without silently overwriting it",
    async (override) => {
      findFirst.mockResolvedValue({
        ...source,
        translations: [{ ...row, ...override }],
      });
      expect((await run()).translations[0]).toMatchObject({
        status: "stale",
        title: row.title,
        revision: 2,
      });
    },
  );
  it.each([
    { status: "removed" },
    { status: "redacted" },
    { redactedAt: new Date() },
  ])(
    "never returns leftover content for removed/redacted rows",
    async (override) => {
      findFirst.mockResolvedValue({
        ...source,
        translations: [{ ...row, ...override }],
      });
      expect((await run()).translations[0]).toMatchObject({
        title: null,
        body: null,
        sourceLocale: null,
        revision: 2,
      });
    },
  );
  it("rejects missing or privacy-filtered originals", async () => {
    findFirst.mockResolvedValue(null);
    await expect(run()).rejects.toThrow("Review unavailable");
    expect(privacy).not.toHaveBeenCalled();
  });
  it("rejects unlinked identity tombstones", async () => {
    privacy.mockResolvedValue(true);
    await expect(run()).rejects.toThrow("Review unavailable");
  });
  it("checks retained owner privacy before returning any content", async () => {
    ownerGuard.mockRejectedValue(new Error("Review unavailable"));
    await expect(run()).rejects.toThrow("Review unavailable");
    expect(ownerGuard).toHaveBeenCalledWith({
      tx,
      storeId: "store_1",
      shopperId: "shopper_1",
      installationGeneration: "generation_1",
    });
  });
  it("does not disguise privacy storage failure as absent data", async () => {
    privacy.mockRejectedValue(new Error("privacy storage unavailable"));
    await expect(run()).rejects.toThrow("privacy storage unavailable");
  });
  it("rejects corrupt persisted states", async () => {
    findFirst.mockResolvedValue({
      ...source,
      translations: [{ ...row, status: "unknown" }],
    });
    await expect(run()).rejects.toThrow();
  });
  it.each([
    { title: null },
    { title: "  " },
    { body: null },
    { body: "\n" },
    { sourceLocale: "ja" },
  ])(
    "does not label malformed content active when storefront would reject it",
    async (override) => {
      findFirst.mockResolvedValue({
        ...source,
        translations: [{ ...row, ...override }],
      });
      await expect(run()).rejects.toThrow(
        "Translation requires reconciliation",
      );
    },
  );
});
