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
}));
vi.mock("@/lib/prisma", () => {
  const db = {
    $queryRaw: mocks.query,
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
  });
});
