import {
  assertReviewPhotoStorageSettled,
  claimOpenPhotoStorageWrite,
  recordOpenPhotoStorageOutcome,
} from "@/lib/weletic/reviews/open-media-write-state";
import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
function fixture() {
  const query = vi.fn().mockResolvedValue([{ id: "media" }]);
  const update = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: query,
    weleticOpenReviewMediaOwnership: { updateMany: update },
  } as unknown as Prisma.TransactionClient;
  return { tx, query, update };
}
it("claims a durable one-shot PUT only from unstarted, unredacted ownership", async () => {
  const { tx, query, update } = fixture();
  await claimOpenPhotoStorageWrite(tx, "store", "media", "token");
  expect(query.mock.calls[0][0].strings.join("?")).toContain("FOR UPDATE");
  expect(update).toHaveBeenCalledWith({
    where: {
      storeId: "store",
      mediaId: "media",
      storageWriteState: "not_started",
      storageWriteToken: null,
      redactedAt: null,
    },
    data: { storageWriteState: "in_flight", storageWriteToken: "token" },
  });
  update.mockResolvedValue({ count: 0 });
  await expect(
    claimOpenPhotoStorageWrite(tx, "store", "media", "token"),
  ).rejects.toThrow("reconciliation");
  query.mockResolvedValue([]);
  await expect(
    claimOpenPhotoStorageWrite(tx, "store", "media", "token"),
  ).rejects.toThrow("changed");
});
it.each(["confirmed", "ambiguous"] as const)(
  "records %s only for the exact in-flight write token",
  async (outcome) => {
    const { tx, update } = fixture();
    await recordOpenPhotoStorageOutcome(tx, "store", "media", "token", outcome);
    expect(update).toHaveBeenCalledWith({
      where: {
        storeId: "store",
        mediaId: "media",
        storageWriteToken: "token",
        storageWriteState: "in_flight",
      },
      data: { storageWriteState: outcome },
    });
    update.mockResolvedValue({ count: 0 });
    await expect(
      recordOpenPhotoStorageOutcome(tx, "store", "media", "other", outcome),
    ).rejects.toThrow("reconciliation");
  },
);
it.each(["in_flight", "ambiguous", "invalid"])(
  "does not interpret %s as safe erasure even after a lease expires",
  async (state) => {
    const { tx, query } = fixture();
    query.mockResolvedValue([{ storageWriteState: state }]);
    await expect(
      assertReviewPhotoStorageSettled(tx, "store", "media", null),
    ).rejects.toThrow("reconciliation");
  },
);
it("permits settled exclusive ownership but rejects missing and mixed sources", async () => {
  const { tx, query } = fixture();
  for (const state of ["not_started", "confirmed"]) {
    query.mockResolvedValue([{ storageWriteState: state }]);
    await expect(
      assertReviewPhotoStorageSettled(tx, "store", "media", null),
    ).resolves.toBeUndefined();
    await expect(
      assertReviewPhotoStorageSettled(tx, "store", "media", "invitation"),
    ).rejects.toThrow("reconciliation");
  }
  query.mockResolvedValue([]);
  await expect(
    assertReviewPhotoStorageSettled(tx, "store", "media", null),
  ).rejects.toThrow("reconciliation");
  await expect(
    assertReviewPhotoStorageSettled(tx, "store", "media", "invitation"),
  ).resolves.toBeUndefined();
});
