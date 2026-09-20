import {
  redactReviewContentBatch,
  reviewContentRedactionWhere,
} from "@/lib/weletic/reviews/content-privacy";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueue,
}));

describe("review-owned content privacy", () => {
  beforeEach(() => vi.resetAllMocks());

  function fixture() {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "review", productId: "product", version: 3, redactedAt: null },
      ]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      weleticProductReview: { findMany, updateMany },
    } as unknown as Prisma.TransactionClient;
    return { tx, findMany, updateMany };
  }

  it("discovers bounded content using store/shopper, independent of invitation", async () => {
    const { tx, findMany, updateMany } = fixture();
    await redactReviewContentBatch(tx, "store", "shopper");
    expect(findMany).toHaveBeenCalledWith({
      where: reviewContentRedactionWhere("store", "shopper"),
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true, productId: true, version: true, redactedAt: true },
    });
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      storeId: "store",
      shopperId: "shopper",
      id: "review",
      version: 3,
    });
    expect(where).not.toHaveProperty("request");
    expect(data).toEqual({
      status: "redacted",
      version: 4,
      title: "",
      body: "",
      displayName: "Redacted customer",
      merchantReply: null,
      moderatedByUserId: null,
      participationStatus: "privacy_redacted",
      participationValidatedAt: null,
      participationValidationRevision: null,
      participationContentDigest: null,
      redactedAt: expect.any(Date),
    });
    // No reward status, ledger reference, purchase proof or invitation mutation.
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store",
      jobType: "REVIEW_SUMMARY_SYNC",
      payload: { productId: "product" },
      idempotencyKey: "review_privacy_content:review:3",
    });
  });

  it("repairs leftovers even when status already says redacted", () => {
    const where = reviewContentRedactionWhere("store", "shopper");
    for (const condition of [
      { title: { not: "" } },
      { body: { not: "" } },
      { merchantReply: { not: null } },
      { participationValidationRevision: { not: null } },
      { moderatedByUserId: { not: null } },
      { redactedAt: null },
    ])
      expect(where.OR).toContainEqual(condition);
  });

  it("preserves the first erasure timestamp when repairing leftover content", async () => {
    const { tx, findMany, updateMany } = fixture();
    const redactedAt = new Date("2026-09-01T00:00:00Z");
    findMany.mockResolvedValue([
      { id: "review", productId: "product", version: 4, redactedAt },
    ]);
    await redactReviewContentBatch(tx, "store", "shopper");
    expect(updateMany.mock.calls[0][0].data.redactedAt).toBe(redactedAt);
  });

  it("has no write or projection replay for a clean page", async () => {
    const { tx, findMany, updateMany } = fixture();
    findMany.mockResolvedValue([]);
    await redactReviewContentBatch(tx, "store", "shopper");
    expect(updateMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("saturates a terminal signed-Int version instead of overflowing erasure", async () => {
    const { tx, findMany, updateMany } = fixture();
    findMany.mockResolvedValue([
      {
        id: "review",
        productId: "product",
        version: 2147483647,
        redactedAt: null,
      },
    ]);
    await redactReviewContentBatch(tx, "store", "shopper");
    expect(updateMany.mock.calls[0][0].data.version).toBe(2147483647);
    expect(updateMany.mock.calls[0][0].data.status).toBe("redacted");
  });

  it.each([0, -1, 1.5, 2147483648, NaN])(
    "rejects corrupt version %s",
    async (version) => {
      const { tx, findMany, updateMany } = fixture();
      findMany.mockResolvedValue([
        { id: "review", productId: "product", version, redactedAt: null },
      ]);
      await expect(
        redactReviewContentBatch(tx, "store", "shopper"),
      ).rejects.toThrow("Invalid review version");
      expect(updateMany).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it("fails closed on version loss instead of certifying erasure", async () => {
    const { tx, updateMany } = fixture();
    updateMany.mockResolvedValue({ count: 0 });
    await expect(
      redactReviewContentBatch(tx, "store", "shopper"),
    ).rejects.toThrow("changed during privacy");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("propagates outbox failure so the caller transaction rolls back", async () => {
    const { tx } = fixture();
    mocks.enqueue.mockRejectedValue(new Error("outbox unavailable"));
    await expect(
      redactReviewContentBatch(tx, "store", "shopper"),
    ).rejects.toThrow("outbox unavailable");
  });

  it("retains exact tenant scope for frozen whole-store cleanup", () => {
    const where = reviewContentRedactionWhere("store");
    expect(where.storeId).toBe("store");
    expect(where).not.toHaveProperty("shopperId");
  });
});
