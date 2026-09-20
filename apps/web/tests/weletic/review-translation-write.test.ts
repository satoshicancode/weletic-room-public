import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeReviewTranslationInTransaction } from "../../lib/weletic/reviews/translation-write";

const privacy = vi.hoisted(() => vi.fn());
const ownerGuard = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/reviews/translation-owner", () => ({
  assertReviewTranslationOwnerAvailable: ownerGuard,
}));
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: privacy,
}));

describe("transactional manual review translation", () => {
  const tx = {
    $queryRaw: vi.fn(),
    weleticProductReview: { findFirst: vi.fn() },
    weleticProductReviewTranslation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticReviewTranslationAudit: { create: vi.fn() },
  };
  const input = {
    action: "save",
    reviewId: "review_1",
    locale: "ja",
    sourceLocale: "en",
    title: "翻訳",
    body: "手動翻訳です。",
    expectedInstallationGeneration: "generation_1",
    expectedReviewVersion: 4,
    expectedTranslationRevision: 0,
  };
  const actor = {
    kind: "shopify",
    userId: "42",
    appId: "app_1",
    installationGeneration: "generation_1",
    merchantActionId: "a".repeat(64),
  };
  const run = (patch: unknown = input, actorInput: unknown = actor) =>
    writeReviewTranslationInTransaction({
      tx: tx as unknown as Prisma.TransactionClient,
      storeId: "store_1",
      generation: "generation_1",
      actor: actorInput,
      input: patch,
    });
  beforeEach(() => {
    vi.resetAllMocks();
    privacy.mockResolvedValue(false);
    ownerGuard.mockResolvedValue(undefined);
    tx.weleticProductReview.findFirst.mockResolvedValue({
      id: "review_1",
      shopperId: "shopper_1",
      version: 4,
      title: "Original",
      body: "Original text",
      shopper: { shopifyCustomerId: "42", email: "shopper@example.com" },
    });
    tx.weleticProductReviewTranslation.findUnique.mockResolvedValue(null);
    tx.weleticProductReviewTranslation.updateMany.mockResolvedValue({
      count: 1,
    });
  });

  it("creates linked text and a content-free audit without changing original/rewards", async () => {
    expect(await run()).toEqual({
      reviewId: "review_1",
      locale: "ja",
      revision: 1,
      status: "active",
    });
    expect(tx.weleticProductReview.findFirst).toHaveBeenCalledWith(
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
    const data =
      tx.weleticProductReviewTranslation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      storeId: "store_1",
      reviewId: "review_1",
      title: input.title,
      revision: 1,
    });
    expect(data.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    const audit = tx.weleticReviewTranslationAudit.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      fromRevision: 0,
      toRevision: 1,
      merchantActionId: actor.merchantActionId,
    });
    for (const key of [
      "title",
      "body",
      "sourceDigest",
      "rating",
      "rewardStatus",
    ])
      expect(audit).not.toHaveProperty(key);
  });

  it.each(["generation_2", ""])(
    "rejects stale/invalid input generation %s",
    async (generation) => {
      await expect(
        run({ ...input, expectedInstallationGeneration: generation }),
      ).rejects.toThrow();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it("rejects workspace actor authority", async () => {
    await expect(
      run(input, { kind: "workspace", userId: "user_1" }),
    ).rejects.toThrow("Installation changed");
  });
  it("rejects missing, foreign or privacy-filtered originals", async () => {
    tx.weleticProductReview.findFirst.mockResolvedValue(null);
    await expect(run()).rejects.toThrow("Review unavailable");
    expect(tx.weleticProductReviewTranslation.create).not.toHaveBeenCalled();
  });
  it("rejects stale source version", async () => {
    await expect(run({ ...input, expectedReviewVersion: 3 })).rejects.toThrow(
      "Review changed",
    );
  });
  it("checks retained owner privacy before content or audit writes", async () => {
    ownerGuard.mockRejectedValue(new Error("Review unavailable"));
    await expect(run()).rejects.toThrow("Review unavailable");
    expect(ownerGuard).toHaveBeenCalledWith({
      tx,
      storeId: "store_1",
      shopperId: "shopper_1",
      installationGeneration: "generation_1",
    });
    expect(tx.weleticProductReviewTranslation.create).not.toHaveBeenCalled();
    expect(tx.weleticReviewTranslationAudit.create).not.toHaveBeenCalled();
  });
  it.each(["customer-ID-only", "email-only"])(
    "rejects an unlinked %s privacy tombstone",
    async () => {
      privacy.mockResolvedValue(true);
      await expect(run()).rejects.toThrow("Review unavailable");
      expect(privacy).toHaveBeenCalledWith({
        tx,
        storeId: "store_1",
        shopifyCustomerId: "42",
        email: "shopper@example.com",
      });
      expect(tx.weleticProductReviewTranslation.create).not.toHaveBeenCalled();
      expect(tx.weleticReviewTranslationAudit.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: "redacted", redactedAt: null },
    { status: "active", redactedAt: new Date() },
  ])("does not resurrect a privacy tombstone", async (row) => {
    tx.weleticProductReviewTranslation.findUnique.mockResolvedValue({
      id: "translation_1",
      revision: 1,
      ...row,
    });
    await expect(
      run({ ...input, expectedTranslationRevision: 1 }),
    ).rejects.toThrow("Translation unavailable");
  });
  it("rejects stale translation revision", async () => {
    tx.weleticProductReviewTranslation.findUnique.mockResolvedValue({
      id: "translation_1",
      revision: 2,
    });
    await expect(run()).rejects.toThrow("Translation changed");
  });
  it("fences a concurrent update and does not append a success audit", async () => {
    tx.weleticProductReviewTranslation.findUnique.mockResolvedValue({
      id: "translation_1",
      revision: 2,
    });
    tx.weleticProductReviewTranslation.updateMany.mockResolvedValue({
      count: 0,
    });
    await expect(
      run({ ...input, expectedTranslationRevision: 2 }),
    ).rejects.toThrow("Translation changed");
    expect(tx.weleticReviewTranslationAudit.create).not.toHaveBeenCalled();
  });
  it("keeps a revision tombstone even when removing an absent locale", async () => {
    const { title, body, sourceLocale, ...identity } = input;
    await run({ ...identity, action: "remove" });
    expect(tx.weleticProductReviewTranslation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "removed",
        revision: 1,
        title: null,
        body: null,
        sourceDigest: null,
        sourceLocale: null,
      }),
    });
  });
  it("propagates audit failure to the enclosing transaction", async () => {
    tx.weleticReviewTranslationAudit.create.mockRejectedValue(
      new Error("audit unavailable"),
    );
    await expect(run()).rejects.toThrow("audit unavailable");
  });
});
