import { redactReviewOwnerPrivacyProjection } from "@/lib/weletic/reviews/privacy-owner-redact";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

function fixture() {
  const db = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: "store-a", installationGeneration: "g2" }])
      .mockResolvedValueOnce([{ id: "owner-a", storeId: "store-a" }])
      .mockResolvedValueOnce([]),
    weleticReviewOwnerPrivacyCoverage: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    weleticReviewOwnerPrivacyIdentity: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const input = {
    tx: db as unknown as Prisma.TransactionClient,
    storeId: "store-a",
    shopperId: "owner-a",
    redactedAt: new Date("2026-09-20T00:00:00Z"),
  };
  return { db, input, run: () => redactReviewOwnerPrivacyProjection(input) };
}

describe("review owner privacy erasure", () => {
  it("erases legacy owners without inventing an installation generation", async () => {
    const { db, run } = fixture();
    db.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: "store-a", installationGeneration: null }])
      .mockResolvedValueOnce([{ id: "owner-a", storeId: "store-a" }])
      .mockResolvedValueOnce([]);
    await run();
    expect(
      db.weleticReviewOwnerPrivacyCoverage.upsert.mock.calls[0][0].update,
    ).toMatchObject({ state: "redacted", installationGeneration: null });
  });
  it("locks exact store/owner and erases private proofs without deleting coverage", async () => {
    const { db, input, run } = fixture();
    await run();
    for (const call of db.$queryRaw.mock.calls)
      expect(call[0].join("?")).toContain("FOR UPDATE");
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual(["store-a"]);
    expect(db.$queryRaw.mock.calls[1].slice(1)).toEqual(["store-a", "owner-a"]);
    expect(db.weleticReviewOwnerPrivacyCoverage.upsert).toHaveBeenCalledWith({
      where: {
        storeId_shopperId: { storeId: "store-a", shopperId: "owner-a" },
      },
      create: expect.objectContaining({
        storeId: "store-a",
        shopperId: "owner-a",
        state: "redacted",
        installationGeneration: "g2",
      }),
      update: {
        state: "redacted",
        installationGeneration: "g2",
        keySetDigest: null,
        sourceDigest: null,
        identityCount: 0,
        redactedAt: input.redactedAt,
      },
    });
    expect(
      db.weleticReviewOwnerPrivacyIdentity.deleteMany,
    ).toHaveBeenCalledWith({
      where: { storeId: "store-a", shopperId: "owner-a" },
    });
  });
  it("retains the first redaction timestamp on a retry", async () => {
    const { db, run } = fixture();
    const earlier = new Date("2026-09-19T00:00:00Z");
    db.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: "store-a", installationGeneration: "g2" }])
      .mockResolvedValueOnce([{ id: "owner-a", storeId: "store-a" }])
      .mockResolvedValueOnce([{ redactedAt: earlier }]);
    await run();
    expect(
      db.weleticReviewOwnerPrivacyCoverage.upsert.mock.calls[0][0].update
        .redactedAt,
    ).toEqual(earlier);
  });
  it.each(["missing_store", "foreign_owner"])(
    "fails closed for %s",
    async (kind) => {
      const { db, run } = fixture();
      db.$queryRaw.mockReset();
      if (kind === "missing_store") db.$queryRaw.mockResolvedValueOnce([]);
      else
        db.$queryRaw
          .mockResolvedValueOnce([
            { id: "store-a", installationGeneration: "g2" },
          ])
          .mockResolvedValueOnce([{ id: "owner-a", storeId: "foreign" }]);
      await expect(run()).rejects.toThrow();
      expect(
        db.weleticReviewOwnerPrivacyCoverage.upsert,
      ).not.toHaveBeenCalled();
      expect(
        db.weleticReviewOwnerPrivacyIdentity.deleteMany,
      ).not.toHaveBeenCalled();
    },
  );
  it("propagates erasure failure for transaction rollback", async () => {
    const { db, run } = fixture();
    db.weleticReviewOwnerPrivacyIdentity.deleteMany.mockRejectedValueOnce(
      new Error("synthetic failure"),
    );
    await expect(run()).rejects.toThrow("synthetic failure");
  });
});
