import { scheduleReviewPointsRecovery } from "@/lib/weletic/reviews/points-recovery-scheduling";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
const tx = { weleticReviewIncentiveClaim: { findFirst: mocks.find } } as any;
const payload = {
  claimId: "claim",
  shopperId: "shopper",
  installationGeneration: "generation",
};
const source = {
  subjectType: "product",
  awardSnapshot: { kind: "points", points: "100" },
  validationSnapshot: { installationGeneration: "generation" },
};
const job = {
  storeId: "store",
  jobType: "REVIEW_POINTS_RECOVERY",
  payload,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue(source);
  mocks.enqueue.mockResolvedValue({ job, created: true });
});
describe("review recovery scheduling", () => {
  it.each(["product", "store"])(
    "creates one %s identity under the existing transaction fence",
    async (subjectType) => {
      mocks.find.mockResolvedValue({ ...source, subjectType });
      await scheduleReviewPointsRecovery({ tx, storeId: "store", ...payload });
      expect(mocks.find).toHaveBeenCalledWith({
        where: {
          id: "claim",
          storeId: "store",
          shopperId: "shopper",
          status: "reserved",
        },
        select: {
          subjectType: true,
          awardSnapshot: true,
          validationSnapshot: true,
        },
      });
      expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
        tx,
        storeId: "store",
        jobType: "REVIEW_POINTS_RECOVERY",
        payload,
        idempotencyKey: "review_points_recovery:claim",
        priority: -5,
      });
    },
  );
  it.each(["completed", "cancelled", "dead_letter", "processing"])(
    "does not reset an existing %s job",
    async (status) => {
      const result = { job: { ...job, status }, created: false };
      mocks.enqueue.mockResolvedValue(result);
      expect(
        await scheduleReviewPointsRecovery({
          tx,
          storeId: "store",
          ...payload,
        }),
      ).toBe(result);
    },
  );
  it.each([
    null,
    { ...source, subjectType: "unknown" },
    { ...source, awardSnapshot: { kind: "coupon" } },
    { ...source, validationSnapshot: { installationGeneration: "retired" } },
  ])("rejects unsupported, missing or stale source %#", async (claim) => {
    mocks.find.mockResolvedValue(claim);
    await expect(
      scheduleReviewPointsRecovery({ tx, storeId: "store", ...payload }),
    ).rejects.toThrow("source requires reconciliation");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { ...job, storeId: "foreign" },
    { ...job, jobType: "REVIEW_REQUEST_EMAIL" },
    { ...job, payload: { ...payload, shopperId: "foreign" } },
    { ...job, payload: { ...payload, claimId: "foreign" } },
    { ...job, payload: { ...payload, installationGeneration: "retired" } },
  ])("rejects conflicting idempotency ownership %#", async (persisted) => {
    mocks.enqueue.mockResolvedValue({ job: persisted, created: false });
    await expect(
      scheduleReviewPointsRecovery({ tx, storeId: "store", ...payload }),
    ).rejects.toThrow("queue identity conflicts");
  });
});
