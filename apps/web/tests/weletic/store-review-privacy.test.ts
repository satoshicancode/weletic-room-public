import {
  purgeStoreReviewsBatch,
  redactStoreReviewsBatch,
} from "@/lib/weletic/reviews/store-privacy";
import {
  storeReviewAuditRedactionWhere,
  storeReviewContentRedactionWhere,
  storeReviewRequestRedactionWhere,
} from "@/lib/weletic/reviews/store-privacy-contract";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

const scope = {
  kind: "customer" as const,
  storeId: "store",
  shopperId: "shopper",
};
function fixture() {
  const delegate = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    findFirst: vi.fn().mockResolvedValue(null),
  });
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ complianceState: "frozen" }]),
    weleticStoreReview: delegate(),
    weleticStoreReviewRequest: delegate(),
    weleticStoreReviewModerationAudit: delegate(),
    weleticStoreReviewRequestLine: delegate(),
    weleticStoreReviewSettings: delegate(),
  };
  return { db, tx: db as unknown as Prisma.TransactionClient };
}

describe("store-review source privacy batches (mock database)", () => {
  it("locks first, repairs bounded pages and checks all source residues", async () => {
    const { db, tx } = fixture();
    db.weleticStoreReview.findMany.mockResolvedValue([
      { id: "review", version: 2, redactedAt: null },
    ]);
    db.weleticStoreReviewRequest.findMany.mockResolvedValue([
      { id: "request", cancelledAt: null },
    ]);
    db.weleticStoreReviewModerationAudit.findMany.mockResolvedValue([
      { id: "audit", redactedAt: null },
    ]);
    expect(await redactStoreReviewsBatch(tx, scope)).toEqual({
      hasMore: false,
    });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.weleticStoreReview.findMany.mock.invocationCallOrder[0],
    );
    const cases = [
      [
        db.weleticStoreReview,
        storeReviewContentRedactionWhere(scope),
        "review",
      ],
      [
        db.weleticStoreReviewRequest,
        storeReviewRequestRedactionWhere(scope),
        "request",
      ],
      [
        db.weleticStoreReviewModerationAudit,
        storeReviewAuditRedactionWhere(scope),
        "audit",
      ],
    ] as const;
    for (const [delegate, where, id] of cases) {
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where, take: 20, orderBy: { id: "asc" } }),
      );
      expect(delegate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ...where, id }),
        }),
      );
      expect(delegate.findFirst).toHaveBeenCalledExactlyOnceWith({
        where,
        select: { id: true },
      });
    }
    expect(db.weleticStoreReview.updateMany.mock.calls[0][0]).toMatchObject({
      where: { version: 2 },
      data: { version: 3, status: "redacted" },
    });
    expect(db.weleticStoreReviewRequestLine.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    "weleticStoreReview",
    "weleticStoreReviewRequest",
    "weleticStoreReviewModerationAudit",
  ] as const)("keeps completion open for %s residues", async (table) => {
    const { db, tx } = fixture();
    db[table].findFirst.mockResolvedValue({ id: "residue" });
    expect(await redactStoreReviewsBatch(tx, scope)).toEqual({ hasMore: true });
  });

  it.each([
    "weleticStoreReview",
    "weleticStoreReviewRequest",
    "weleticStoreReviewModerationAudit",
  ] as const)("fails closed on %s update loss", async (table) => {
    const { db, tx } = fixture();
    db[table].findMany.mockResolvedValue([
      { id: "row", version: 2, redactedAt: null, cancelledAt: null },
    ]);
    db[table].updateMany.mockResolvedValue({ count: 0 });
    await expect(redactStoreReviewsBatch(tx, scope)).rejects.toThrow(
      "changed during privacy",
    );
  });

  it("does not treat missing schema as completed erasure", async () => {
    const { db, tx } = fixture();
    db.weleticStoreReview.findMany.mockRejectedValue(
      new Error("table unavailable"),
    );
    await expect(redactStoreReviewsBatch(tx, scope)).rejects.toThrow(
      "table unavailable",
    );
  });

  it("rejects missing stores and unfrozen whole-store erasure before reading content", async () => {
    const { db, tx } = fixture();
    db.$queryRaw.mockResolvedValue([]);
    await expect(redactStoreReviewsBatch(tx, scope)).rejects.toThrow(
      "unavailable",
    );
    db.$queryRaw.mockResolvedValue([{ complianceState: "active" }]);
    await expect(
      redactStoreReviewsBatch(tx, { kind: "frozen_store", storeId: "store" }),
    ).rejects.toThrow("frozen store");
    expect(db.weleticStoreReview.findMany).not.toHaveBeenCalled();
  });

  it("does not query with an ambiguous customer identity", async () => {
    const { db, tx } = fixture();
    await expect(
      redactStoreReviewsBatch(tx, { ...scope, shopperId: "" }),
    ).rejects.toThrow("identity");
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("requires frozen lifecycle for purge", async () => {
    const { db, tx } = fixture();
    db.$queryRaw.mockResolvedValue([{ complianceState: "active" }]);
    await expect(purgeStoreReviewsBatch(tx, "store")).rejects.toThrow(
      "frozen store",
    );
    expect(db.weleticStoreReview.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    "weleticStoreReview",
    "weleticStoreReviewRequest",
    "weleticStoreReviewModerationAudit",
  ] as const)("does not purge before %s redaction", async (table) => {
    const { db, tx } = fixture();
    db[table].findFirst.mockResolvedValue({ id: "residue" });
    await expect(purgeStoreReviewsBatch(tx, "store")).rejects.toThrow(
      "redacted before purge",
    );
    expect(
      db.weleticStoreReviewModerationAudit.findMany,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["weleticStoreReviewModerationAudit", "weleticStoreReview"],
    ["weleticStoreReview", "weleticStoreReviewRequestLine"],
    ["weleticStoreReviewRequestLine", "weleticStoreReviewRequest"],
    ["weleticStoreReviewRequest", "weleticStoreReviewSettings"],
  ] as const)("purges bounded %s children before %s", async (table, next) => {
    const { db, tx } = fixture();
    db[table].findMany.mockResolvedValue([{ id: "row" }]);
    expect(await purgeStoreReviewsBatch(tx, "store")).toEqual({
      hasMore: true,
    });
    expect(db[table].deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { storeId: "store", id: { in: ["row"] } },
    });
    expect(db[next].deleteMany).not.toHaveBeenCalled();
    expect(db[next].findMany).not.toHaveBeenCalled();
  });

  it("removes settings only after draining all source children", async () => {
    const { db, tx } = fixture();
    expect(await purgeStoreReviewsBatch(tx, "store")).toEqual({
      hasMore: false,
    });
    expect(
      db.weleticStoreReviewSettings.deleteMany,
    ).toHaveBeenCalledExactlyOnceWith({ where: { storeId: "store" } });
  });
});
