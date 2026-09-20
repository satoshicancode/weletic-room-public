import {
  purgeOpenReviewMediaOwnershipBatch,
  redactOpenReviewMediaOwnershipBatch,
  redactReviewOwnedMediaBatch,
  reviewMediaCleanupCandidateWhere,
  reviewOwnedMediaRedactionWhere,
} from "@/lib/weletic/reviews/media-privacy";
import {
  openReviewMediaExportSelect,
  openReviewMediaExportWhere,
} from "@/lib/weletic/reviews/open-media-export";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueue,
}));
beforeEach(() => vi.resetAllMocks());
function fixture(status = "uploaded") {
  const findMany = vi.fn().mockResolvedValue([{ id: "media", status }]);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    findMany,
    updateMany,
    tx: {
      weleticReviewMedia: { findMany, updateMany },
    } as unknown as Prisma.TransactionClient,
  };
}
it("discovers bounded owned photos without an invitation join", async () => {
  const { tx, findMany, updateMany } = fixture();
  expect(await redactReviewOwnedMediaBatch(tx, "store", "shopper")).toEqual([
    "media",
  ]);
  const where = reviewMediaCleanupCandidateWhere("store", "shopper");
  expect(reviewOwnedMediaRedactionWhere("store", "shopper")).toEqual({
    storeId: "store",
    status: { not: "deleted" },
    OR: [
      { review: { storeId: "store", shopperId: "shopper" } },
      { openOwnership: { storeId: "store", shopperId: "shopper" } },
    ],
  });
  expect(findMany).toHaveBeenCalledWith({
    where,
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, status: true },
  });
  expect(updateMany).toHaveBeenCalledWith({
    where: { ...where, id: "media", status: "uploaded" },
    data: { status: "deletion_pending" },
  });
  expect(mocks.enqueue).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    jobType: "REVIEW_MEDIA_CLEANUP",
    payload: { mediaId: "media" },
    idempotencyKey: "review_privacy_media:media",
  });
});
it("includes orphaned media during whole-store erasure", () => {
  expect(reviewOwnedMediaRedactionWhere("store")).toEqual({
    storeId: "store",
    status: { not: "deleted" },
  });
});
it("retries pending cleanup using the same outbox identity", async () => {
  const { tx } = fixture("deletion_pending");
  await redactReviewOwnedMediaBatch(tx, "store", "shopper");
  await redactReviewOwnedMediaBatch(tx, "store", "shopper");
  expect(mocks.enqueue.mock.calls.map(([job]) => job.idempotencyKey)).toEqual([
    "review_privacy_media:media",
    "review_privacy_media:media",
  ]);
});
it("does not acknowledge ownership/status changes", async () => {
  const { tx, updateMany } = fixture();
  updateMany.mockResolvedValue({ count: 0 });
  await expect(
    redactReviewOwnedMediaBatch(tx, "store", "shopper"),
  ).rejects.toThrow("changed");
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("propagates outbox failure so the caller rolls back", async () => {
  const { tx } = fixture();
  mocks.enqueue.mockRejectedValue(new Error("outbox failed"));
  await expect(
    redactReviewOwnedMediaBatch(tx, "store", "shopper"),
  ).rejects.toThrow("outbox failed");
});
it("does nothing when all owned media is already deleted", async () => {
  const { tx, findMany, updateMany } = fixture();
  findMany.mockResolvedValue([]);
  expect(await redactReviewOwnedMediaBatch(tx, "store", "shopper")).toEqual([]);
  expect(updateMany).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("exports metadata only for the exact customer and media store", () => {
  expect(openReviewMediaExportWhere("store", "shopper")).toEqual({
    storeId: "store",
    shopperId: "shopper",
    media: { storeId: "store", requestId: null },
  });
  const projection = JSON.stringify(openReviewMediaExportSelect);
  for (const key of [
    "objectKey",
    "contentDigest",
    "idempotencyKey",
    "submissionKey",
    "installationGeneration",
    "shopperId",
  ])
    expect(projection).not.toContain(key);
});

it("scrubs content hashes but preserves the first terminal timestamp and retry markers", async () => {
  const redactedAt = new Date("2026-09-20T00:00:00Z");
  const findMany = vi.fn().mockResolvedValue([{ id: "owner", redactedAt }]);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    weleticOpenReviewMediaOwnership: { findMany, updateMany },
  } as unknown as Prisma.TransactionClient;
  await redactOpenReviewMediaOwnershipBatch(tx, "store", "shopper");
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        storeId: "store",
        AND: [
          {
            OR: [
              { shopperId: "shopper" },
              {
                media: {
                  storeId: "store",
                  OR: [
                    { review: { storeId: "store", shopperId: "shopper" } },
                    { request: { storeId: "store", shopperId: "shopper" } },
                  ],
                },
              },
            ],
          },
        ],
        OR: [{ redactedAt: null }, { contentDigest: { not: null } }],
      },
      take: 20,
    }),
  );
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: { contentDigest: null, redactedAt } }),
  );
  updateMany.mockResolvedValue({ count: 0 });
  await expect(
    redactOpenReviewMediaOwnershipBatch(tx, "store", "shopper"),
  ).rejects.toThrow("changed");
});

it("keeps ownership until private media is actually deleted during frozen purge", async () => {
  const findMany = vi
    .fn()
    .mockResolvedValue([{ id: "owner", mediaId: "media" }]);
  const deleteMany = vi.fn();
  const count = vi.fn().mockResolvedValue(1);
  const tx = {
    weleticOpenReviewMediaOwnership: {
      findMany,
      deleteMany,
      count: vi.fn().mockResolvedValue(0),
    },
    weleticReviewMedia: { count },
  } as unknown as Prisma.TransactionClient;
  await expect(purgeOpenReviewMediaOwnershipBatch(tx, "store")).rejects.toThrow(
    "must be erased",
  );
  expect(deleteMany).not.toHaveBeenCalled();
  count.mockResolvedValue(0);
  expect(await purgeOpenReviewMediaOwnershipBatch(tx, "store")).toBe(true);
  expect(deleteMany).toHaveBeenCalledWith({
    where: { storeId: "store", id: { in: ["owner"] } },
  });
});
