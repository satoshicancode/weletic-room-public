import { cleanupReviewPhoto } from "@/lib/weletic/reviews/media";
import {
  purgeNativeReviewsBatch,
  redactNativeReviewsBatch,
} from "@/lib/weletic/reviews/privacy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeRedact: vi.fn(),
  storePurge: vi.fn(),
  openMediaList: vi.fn(),
  openMediaUpdate: vi.fn(),
  openMediaCount: vi.fn(),
  openMediaDelete: vi.fn(),
  mediaList: vi.fn(),
  mediaUpdate: vi.fn(),
  query: vi.fn(),
  openPolicyList: vi.fn(),
  openPolicyDelete: vi.fn(),
  contentList: vi.fn(),
  contentCount: vi.fn(),
  sourceList: vi.fn(),
  sourceCount: vi.fn(),
  sourceUpdate: vi.fn(),
  sourceDelete: vi.fn(),
  contentDelete: vi.fn(),
  mediaCount: vi.fn(),
  mediaDelete: vi.fn(),
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
vi.mock("@/lib/weletic/reviews/store-privacy", () => ({
  redactStoreReviewsBatch: mocks.storeRedact,
  purgeStoreReviewsBatch: mocks.storePurge,
}));
vi.mock("@/lib/prisma", () => {
  const db = {
    $queryRaw: mocks.query,
    weleticOpenReviewMediaOwnership: {
      findMany: mocks.openMediaList,
      updateMany: mocks.openMediaUpdate,
      count: mocks.openMediaCount,
      deleteMany: mocks.openMediaDelete,
    },
    weleticOpenReviewPolicy: {
      findMany: mocks.openPolicyList,
      deleteMany: mocks.openPolicyDelete,
    },
    weleticOpenReviewSubmission: {
      findMany: mocks.sourceList,
      count: mocks.sourceCount,
      updateMany: mocks.sourceUpdate,
      deleteMany: mocks.sourceDelete,
    },
    weleticProductReview: {
      findMany: mocks.contentList,
      count: mocks.contentCount,
      deleteMany: mocks.contentDelete,
    },
    weleticReviewMedia: {
      findMany: mocks.mediaList,
      updateMany: mocks.mediaUpdate,
      count: mocks.mediaCount,
      deleteMany: mocks.mediaDelete,
    },
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
  it("keeps source erasure incomplete while store-review batches remain", async () => {
    mocks.storeRedact.mockResolvedValue({ hasMore: true });
    expect(await redactNativeReviewsBatch("store-1", "shopper-1")).toEqual({
      hasMore: true,
    });
    expect(mocks.storeRedact).toHaveBeenCalledWith(expect.anything(), {
      kind: "customer",
      storeId: "store-1",
      shopperId: "shopper-1",
    });
  });
  it("uses explicit frozen-store scope for whole-shop source erasure", async () => {
    await redactNativeReviewsBatch("store-1");
    expect(mocks.storeRedact).toHaveBeenCalledWith(expect.anything(), {
      kind: "frozen_store",
      storeId: "store-1",
    });
  });
  it("propagates store-review schema failures rather than completing privacy", async () => {
    mocks.storeRedact.mockRejectedValue(
      new Error("store review schema missing"),
    );
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).rejects.toThrow("schema missing");
    expect(mocks.contentList).not.toHaveBeenCalled();
  });
  it("drains store-review children before native policy or catalog purge", async () => {
    mocks.storePurge.mockResolvedValue({ hasMore: true });
    expect(await purgeNativeReviewsBatch("store-1")).toEqual({ hasMore: true });
    expect(mocks.storePurge).toHaveBeenCalledWith(expect.anything(), "store-1");
    expect(mocks.openPolicyList).not.toHaveBeenCalled();
  });
  it("refuses frozen purge of abandoned media until actual deletion", async () => {
    mocks.mediaList.mockResolvedValue([
      { id: "abandoned", status: "deletion_pending" },
    ]);
    await expect(purgeNativeReviewsBatch("store-1")).rejects.toThrow(
      "must be erased",
    );
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
  });
  it("purges exact-store deleted media even with dangling parents after ownership is drained", async () => {
    mocks.mediaList.mockResolvedValue([{ id: "abandoned", status: "deleted" }]);
    expect(await purgeNativeReviewsBatch("store-1")).toEqual({ hasMore: true });
    expect(mocks.mediaDelete).toHaveBeenCalledWith({
      where: {
        storeId: "store-1",
        status: "deleted",
        id: { in: ["abandoned"] },
      },
    });
    expect(mocks.contentDelete).not.toHaveBeenCalled();
  });
  it("cleans review-owned photos without invitation work and waits for storage deletion", async () => {
    mocks.mediaList.mockResolvedValue([
      { id: "owned-photo", status: "uploaded" },
    ]);
    mocks.mediaCount.mockResolvedValue(1);
    expect(await redactNativeReviewsBatch("store-1", "shopper-1")).toEqual({
      hasMore: true,
    });
    expect(cleanupReviewPhoto).toHaveBeenCalledWith("store-1", "owned-photo");
    expect(mocks.mediaCount).toHaveBeenCalledWith({
      where: {
        storeId: "store-1",
        status: { not: "deleted" },
        OR: [
          { review: { storeId: "store-1", shopperId: "shopper-1" } },
          { openOwnership: { storeId: "store-1", shopperId: "shopper-1" } },
        ],
      },
    });
  });
  it("does not acknowledge erasure when private object cleanup fails", async () => {
    mocks.mediaList.mockResolvedValue([
      { id: "owned-photo", status: "deletion_pending" },
    ]);
    vi.mocked(cleanupReviewPhoto).mockRejectedValue(
      new Error("storage unavailable"),
    );
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).rejects.toThrow("storage unavailable");
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.storeRedact.mockResolvedValue({ hasMore: false });
    mocks.storePurge.mockResolvedValue({ hasMore: false });
    mocks.openMediaList.mockResolvedValue([]);
    mocks.openMediaCount.mockResolvedValue(0);
    mocks.openMediaUpdate.mockResolvedValue({ count: 1 });
    mocks.query.mockResolvedValue([{ complianceState: "frozen" }]);
    mocks.openPolicyList.mockResolvedValue([]);
    mocks.contentList.mockResolvedValue([]);
    mocks.contentCount.mockResolvedValue(0);
    mocks.sourceList.mockResolvedValue([]);
    mocks.sourceCount.mockResolvedValue(0);
    mocks.mediaCount.mockResolvedValue(0);
    mocks.mediaList.mockResolvedValue([]);
    mocks.mediaUpdate.mockResolvedValue({ count: 1 });
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
  it("purges only a bounded owned policy page after freezing the store", async () => {
    mocks.openPolicyList.mockResolvedValue([{ id: "policy-1" }]);
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.openPolicyList).toHaveBeenCalledWith({
      where: { storeId: "store-1" },
      orderBy: { revision: "asc" },
      take: 20,
      select: { id: true },
    });
    expect(mocks.openPolicyDelete).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["policy-1"] } },
    });
    expect(mocks.auditList).not.toHaveBeenCalled();
  });
  it("never deletes policy attribution from an operational store", async () => {
    mocks.query.mockResolvedValue([{ complianceState: "active" }]);
    await expect(purgeNativeReviewsBatch("store-1")).rejects.toThrow(
      "frozen store",
    );
    expect(mocks.openPolicyList).not.toHaveBeenCalled();
    expect(mocks.openPolicyDelete).not.toHaveBeenCalled();
  });
  it("keeps policy history on individual customer redaction", async () => {
    await redactNativeReviewsBatch("store-1", "shopper-1");
    expect(mocks.openPolicyList).not.toHaveBeenCalled();
    expect(mocks.openPolicyDelete).not.toHaveBeenCalled();
  });
  it("does not report progress when policy deletion fails", async () => {
    mocks.openPolicyList.mockResolvedValue([{ id: "policy-1" }]);
    mocks.openPolicyDelete.mockRejectedValue(new Error("database failure"));
    await expect(purgeNativeReviewsBatch("store-1")).rejects.toThrow(
      "database failure",
    );
    expect(mocks.auditList).not.toHaveBeenCalled();
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
  it("keeps privacy pending for review-owned content without invitation work", async () => {
    mocks.contentCount.mockResolvedValue(1);
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).resolves.toEqual({ hasMore: true });
    expect(mocks.contentList.mock.calls[0][0].where).toMatchObject({
      storeId: "store-1",
      shopperId: "shopper-1",
    });
    expect(mocks.contentList.mock.calls[0][0].where).not.toHaveProperty(
      "request",
    );
  });
  it("clears private provenance evidence but retains the scoped retry marker", async () => {
    const firstErasure = new Date("2026-09-01T00:00:00Z");
    mocks.sourceList.mockResolvedValue([
      { id: "source", redactedAt: firstErasure },
    ]);
    await redactNativeReviewsBatch("store-1", "shopper-1");
    expect(mocks.sourceUpdate).toHaveBeenCalledWith({
      where: expect.objectContaining({
        storeId: "store-1",
        id: "source",
        AND: [
          {
            OR: [
              { shopperId: "shopper-1" },
              { review: { storeId: "store-1", shopperId: "shopper-1" } },
            ],
          },
        ],
      }),
      data: { contentDigest: null, redactedAt: firstErasure },
    });
    expect(mocks.sourceDelete).not.toHaveBeenCalled();
  });
  it("keeps completion pending while provenance evidence remains", async () => {
    mocks.sourceCount.mockResolvedValue(1);
    await expect(
      redactNativeReviewsBatch("store-1", "shopper-1"),
    ).resolves.toEqual({ hasMore: true });
    expect(mocks.sourceCount.mock.calls[0][0].where).toEqual(
      mocks.sourceList.mock.calls[0][0].where,
    );
  });
  it("purges source children before deleting original reviews", async () => {
    mocks.sourceList.mockResolvedValue([{ id: "source" }]);
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.sourceDelete).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["source"] } },
    });
    expect(mocks.contentDelete).not.toHaveBeenCalled();
    expect(mocks.requestList).not.toHaveBeenCalled();
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
  it("purges requestless originals only after their media is deleted", async () => {
    mocks.auditList.mockResolvedValue([]);
    mocks.contentList.mockResolvedValue([{ id: "requestless" }]);
    await expect(purgeNativeReviewsBatch("store-1")).resolves.toEqual({
      hasMore: true,
    });
    expect(mocks.contentList).toHaveBeenCalledWith({
      where: { storeId: "store-1", requestId: null },
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true },
    });
    expect(mocks.contentDelete).toHaveBeenCalledWith({
      where: {
        storeId: "store-1",
        requestId: null,
        id: { in: ["requestless"] },
      },
    });
    expect(mocks.requestList).not.toHaveBeenCalled();
  });
  it("refuses requestless purge when private media cleanup is pending", async () => {
    mocks.auditList.mockResolvedValue([]);
    mocks.contentList.mockResolvedValue([{ id: "requestless" }]);
    mocks.mediaCount.mockResolvedValue(1);
    await expect(purgeNativeReviewsBatch("store-1")).rejects.toThrow(
      "photos must be erased",
    );
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(mocks.contentDelete).not.toHaveBeenCalled();
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
