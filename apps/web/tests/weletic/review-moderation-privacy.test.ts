import {
  purgeNativeReviewsBatch,
  redactNativeReviewsBatch,
} from "@/lib/weletic/reviews/privacy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  auditList: vi.fn(),
  auditUpdate: vi.fn(),
  auditDelete: vi.fn(),
  auditCount: vi.fn(),
  requestList: vi.fn(),
  requestCount: vi.fn(),
  claimList: vi.fn(),
  claimCount: vi.fn(),
  activationList: vi.fn(),
  activationDelete: vi.fn(),
  translationList: vi.fn(),
  translationUpdate: vi.fn(),
  translationDelete: vi.fn(),
  translationCount: vi.fn(),
  translationAuditList: vi.fn(),
  translationAuditDelete: vi.fn(),
}));
vi.mock("@/lib/prisma", () => {
  const db = {
    $queryRaw: mocks.query,
    weleticProductReviewTranslation: {
      findMany: mocks.translationList,
      updateMany: mocks.translationUpdate,
      deleteMany: mocks.translationDelete,
      count: mocks.translationCount,
    },
    weleticReviewTranslationAudit: {
      findMany: mocks.translationAuditList,
      deleteMany: mocks.translationAuditDelete,
    },
    weleticReviewIncentiveActivation: {
      findMany: mocks.activationList,
      deleteMany: mocks.activationDelete,
    },
    weleticReviewModerationAudit: {
      findMany: mocks.auditList,
      updateMany: mocks.auditUpdate,
      deleteMany: mocks.auditDelete,
      count: mocks.auditCount,
    },
    weleticReviewRequest: {
      findMany: mocks.requestList,
      count: mocks.requestCount,
    },
    weleticReviewIncentiveClaim: {
      findMany: mocks.claimList,
      count: mocks.claimCount,
    },
  };
  return {
    prisma: {
      ...db,
      $transaction: (callback: (tx: typeof db) => unknown) => callback(db),
    },
  };
});
vi.mock("@/lib/weletic/reviews/media", () => ({ cleanupReviewPhoto: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({ enqueueOutboxJob: vi.fn() }));

describe("review moderation audit privacy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.query.mockResolvedValue([{ complianceState: "frozen" }]);
    mocks.auditList.mockResolvedValue([{ id: "audit-1" }]);
    mocks.auditCount.mockResolvedValue(0);
    mocks.requestList.mockResolvedValue([]);
    mocks.requestCount.mockResolvedValue(0);
    mocks.claimList.mockResolvedValue([]);
    mocks.claimCount.mockResolvedValue(0);
    mocks.activationList.mockResolvedValue([]);
    mocks.translationList.mockResolvedValue([]);
    mocks.translationCount.mockResolvedValue(0);
    mocks.translationAuditList.mockResolvedValue([]);
  });
  it("scrubs only the bounded store/shopper audit page", async () => {
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).resolves.toEqual({ hasMore: false });
    expect(mocks.auditList).toHaveBeenCalledWith({
      where: {
        storeId: "store-1",
        redactedAt: null,
        review: { storeId: "store-1", shopperId: "shopper-1" },
      },
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true },
    });
    expect(mocks.auditUpdate).toHaveBeenCalledWith({
      where: {
        storeId: "store-1",
        redactedAt: null,
        review: { storeId: "store-1", shopperId: "shopper-1" },
        id: { in: ["audit-1"] },
      },
      data: {
        reasonDetails: null,
        actorUserId: null,
        merchantActionId: null,
        redactedAt: expect.any(Date),
      },
    });
  });
  it("keeps privacy pending when audits remain even after reviews are redacted", async () => {
    mocks.auditCount.mockResolvedValue(1);
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).resolves.toEqual({ hasMore: true });
  });
  it("purges audit pages before touching review parents", async () => {
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.auditDelete).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["audit-1"] } },
    });
    expect(mocks.requestList).not.toHaveBeenCalled();
    expect(mocks.claimList).not.toHaveBeenCalled();
  });
  it("refuses purge before a store is frozen", async () => {
    mocks.query.mockResolvedValue([{ complianceState: "active" }]);
    await expect(purgeNativeReviewsBatch("store-1")).rejects.toThrow(
      "frozen store",
    );
    expect(mocks.auditList).not.toHaveBeenCalled();
    expect(mocks.auditDelete).not.toHaveBeenCalled();
    expect(mocks.activationList).not.toHaveBeenCalled();
  });
  it("erases only a bounded owned activation page before financial parents", async () => {
    mocks.auditList.mockResolvedValue([]);
    mocks.activationList.mockResolvedValue([{ id: "activation-1" }]);
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.activationList).toHaveBeenCalledWith({
      where: { storeId: "store-1" },
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true },
    });
    expect(mocks.activationDelete).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["activation-1"] } },
    });
    expect(mocks.requestList).not.toHaveBeenCalled();
    expect(mocks.claimList).not.toHaveBeenCalled();
  });
  it("does not erase store activation history for individual customer privacy", async () => {
    await redactNativeReviewsBatch("store-1", "shopper-1");
    expect(mocks.activationList).not.toHaveBeenCalled();
    expect(mocks.activationDelete).not.toHaveBeenCalled();
  });
  it("erases leftover translation content without requiring an unredacted parent", async () => {
    mocks.translationList.mockResolvedValue([{ id: "translation-1" }]);
    await redactNativeReviewsBatch("store-1", "shopper-1");
    const where = mocks.translationList.mock.calls[0][0].where;
    expect(where.review).toEqual({
      storeId: "store-1",
      shopperId: "shopper-1",
    });
    expect(where.OR).toContainEqual({ sourceDigest: { not: null } });
    expect(mocks.translationList).toHaveBeenCalledWith({
      where,
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true },
    });
    expect(mocks.translationUpdate).toHaveBeenCalledWith({
      where: { ...where, id: { in: ["translation-1"] } },
      data: {
        status: "redacted",
        title: null,
        body: null,
        sourceDigest: null,
        sourceLocale: null,
        redactedAt: expect.any(Date),
      },
    });
    expect(mocks.translationDelete).not.toHaveBeenCalled();
    expect(mocks.translationAuditDelete).not.toHaveBeenCalled();
  });
  it("keeps privacy pending for translations after all original work is gone", async () => {
    mocks.translationCount.mockResolvedValue(1);
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).resolves.toEqual({ hasMore: true });
    expect(mocks.translationCount.mock.calls[0][0].where.review).toEqual({
      storeId: "store-1",
      shopperId: "shopper-1",
    });
  });
  it("drains translation audits before translation or original deletion", async () => {
    mocks.translationAuditList.mockResolvedValue([
      { id: "translation-audit-1" },
    ]);
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.translationAuditDelete).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["translation-audit-1"] } },
    });
    expect(mocks.translationList).not.toHaveBeenCalled();
    expect(mocks.auditList).not.toHaveBeenCalled();
    expect(mocks.requestList).not.toHaveBeenCalled();
  });
  it("drains translations before original review deletion", async () => {
    mocks.translationList.mockResolvedValue([{ id: "translation-1" }]);
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.translationDelete).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["translation-1"] } },
    });
    expect(mocks.requestList).not.toHaveBeenCalled();
  });
  it("does not finish erasure if translation storage is unavailable", async () => {
    mocks.translationList.mockRejectedValue(
      new Error("synthetic storage failure"),
    );
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).rejects.toThrow("synthetic storage failure");
    expect(mocks.requestList).not.toHaveBeenCalled();
  });
});
