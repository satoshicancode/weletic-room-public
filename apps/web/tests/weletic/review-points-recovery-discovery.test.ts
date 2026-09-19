import { enqueueReviewPointsRecoverySweep } from "@/lib/weletic/reviews/points-recovery-sweep";
import { wakeReviewPointsAfterEnrollment } from "@/lib/weletic/reviews/points-recovery-wakeup";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  schedule: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.query,
    weleticReviewIncentiveClaim: { updateMany: mocks.rotate },
  },
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.mutation,
}));
vi.mock("@/lib/weletic/reviews/points-recovery-scheduling", () => ({
  scheduleReviewPointsRecovery: mocks.schedule,
}));
const tx = {
  weleticLoyaltyOutboxJob: { findMany: mocks.find, updateMany: mocks.update },
} as any;
const identity = {
  storeId: "store",
  shopperId: "shopper",
  installationGeneration: "generation",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue([
    { id: "claim", ...identity, recoveryDiscoveryCheckedAt: null },
  ]);
  mocks.rotate.mockResolvedValue({ count: 1 });
  mocks.mutation.mockImplementation((_store, fn) => fn(tx));
  mocks.schedule.mockResolvedValue({ created: true });
  mocks.find.mockResolvedValue([{ id: "job" }]);
  mocks.update.mockResolvedValue({ count: 1 });
});

describe("missed review enrollment discovery", () => {
  it("rotates a fully blocked first page so the next page can schedule", async () => {
    const rows = ["a", "b", "c"].map((id) => ({
      id,
      ...identity,
      recoveryDiscoveryCheckedAt: null as Date | null,
    }));
    mocks.query.mockImplementation(async (sql, limit) => {
      expect(sql.join(" ")).toContain(
        "ORDER BY c.recoveryDiscoveryCheckedAt ASC, c.id ASC",
      );
      return [...rows]
        .sort(
          (a, b) =>
            (a.recoveryDiscoveryCheckedAt?.getTime() ?? 0) -
              (b.recoveryDiscoveryCheckedAt?.getTime() ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    });
    mocks.rotate.mockImplementation(async ({ where, data }) => {
      expect(where).toMatchObject({
        storeId: "store",
        shopperId: "shopper",
        status: "reserved",
        subjectType: "product",
        validationSnapshot: {
          path: "$.installationGeneration",
          equals: "generation",
        },
      });
      expect(Object.keys(data)).toEqual(["recoveryDiscoveryCheckedAt"]);
      rows.find((row) => row.id === where.id)!.recoveryDiscoveryCheckedAt =
        data.recoveryDiscoveryCheckedAt;
      return { count: 1 };
    });
    mocks.schedule.mockImplementation(async ({ claimId }) => {
      if (claimId !== "c") throw new Error("maintenance pending");
      return { created: true };
    });
    expect(await enqueueReviewPointsRecoverySweep({ batchSize: 2 })).toEqual({
      scanned: 2,
      enqueued: 0,
      deferred: 2,
    });
    expect(await enqueueReviewPointsRecoverySweep({ batchSize: 2 })).toEqual({
      scanned: 2,
      enqueued: 1,
      deferred: 1,
    });
  });
  it("does not schedule after another discovery or privacy writer changes the source", async () => {
    mocks.rotate.mockResolvedValue({ count: 0 });
    expect(await enqueueReviewPointsRecoverySweep()).toEqual({
      scanned: 1,
      enqueued: 0,
      deferred: 1,
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("fences each source before scheduling and exposes counts only", async () => {
    expect(await enqueueReviewPointsRecoverySweep({ batchSize: 2 })).toEqual({
      scanned: 1,
      enqueued: 1,
      deferred: 0,
    });
    expect(mocks.mutation).toHaveBeenCalledWith(
      "store",
      expect.any(Function),
      "generation",
    );
    expect(mocks.schedule).toHaveBeenCalledWith({
      tx,
      claimId: "claim",
      ...identity,
    });
    const [sql, limit] = mocks.query.mock.calls[0];
    expect(sql.join(" ")).toContain("NOT EXISTS");
    expect(sql.join(" ")).toContain(
      "j.idempotencyKey = CONCAT('review_points_recovery:', c.id)",
    );
    expect(sql.join(" ")).toContain("s.storeAccessState = 'active'");
    expect(limit).toBe(2);
  });
  it("continues the bounded page when privacy, maintenance or reinstall wins a race", async () => {
    mocks.query.mockResolvedValue([
      { id: "first", ...identity },
      { id: "second", ...identity },
    ]);
    mocks.schedule.mockRejectedValueOnce(
      new Error("private details must not escape"),
    );
    expect(await enqueueReviewPointsRecoverySweep()).toEqual({
      scanned: 2,
      enqueued: 1,
      deferred: 1,
    });
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
  });
  it("does not claim a concurrent enqueue as new work", async () => {
    mocks.schedule.mockResolvedValue({ created: false });
    expect(await enqueueReviewPointsRecoverySweep()).toEqual({
      scanned: 1,
      enqueued: 0,
      deferred: 0,
    });
  });
  it.each([0, -1, 101, 1.5, NaN, Infinity])(
    "rejects unbounded input %s before SQL",
    async (batchSize) => {
      await expect(
        enqueueReviewPointsRecoverySweep({ batchSize }),
      ).rejects.toThrow("batch size");
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
  it("propagates a failed discovery query rather than claiming success", async () => {
    mocks.query.mockRejectedValue(new Error("SQL unavailable"));
    await expect(enqueueReviewPointsRecoverySweep()).rejects.toThrow(
      "SQL unavailable",
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe("same-transaction enrollment wake-up", () => {
  it("only accelerates a bounded set of pending unleased jobs owned by this shopper/generation", async () => {
    expect(await wakeReviewPointsAfterEnrollment({ tx, ...identity })).toBe(1);
    const query = mocks.find.mock.calls[0][0];
    expect(query).toMatchObject({
      take: 100,
      orderBy: { id: "asc" },
      where: {
        storeId: "store",
        jobType: "REVIEW_POINTS_RECOVERY",
        status: "pending",
        lockedAt: null,
        lockedBy: null,
        AND: [
          { payload: { path: "$.shopperId", equals: "shopper" } },
          {
            payload: { path: "$.installationGeneration", equals: "generation" },
          },
        ],
      },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { ...query.where, id: { in: ["job"] } },
      data: { scheduledFor: expect.any(Date), nextRetryAt: null },
    });
  });
  it("does not create work or accounts when no owned pending job exists", async () => {
    mocks.find.mockResolvedValue([]);
    expect(await wakeReviewPointsAfterEnrollment({ tx, ...identity })).toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(65)])(
    "requires bounded installation identity",
    async (installationGeneration) => {
      await expect(
        wakeReviewPointsAfterEnrollment({
          tx,
          ...identity,
          installationGeneration,
        }),
      ).rejects.toThrow("installation identity");
      expect(mocks.find).not.toHaveBeenCalled();
    },
  );
});
