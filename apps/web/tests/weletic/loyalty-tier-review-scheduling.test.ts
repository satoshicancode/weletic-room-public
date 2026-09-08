import {
  enqueueTierReviewSweepJobs,
  scheduleTierReviewAfterQualifyingActivity,
} from "@/lib/weletic/loyalty/tier-review-scheduling";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueOutboxJob: vi.fn(),
  enqueueOutboxJobFromProgramTransaction: vi.fn(),
  programFindMany: vi.fn(),
  accountFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyProgram: {
      findMany: mocks.programFindMany,
    },
    weleticLoyaltyAccount: {
      findMany: mocks.accountFindMany,
    },
  },
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(async ({ operation }) => {
    const tx = {
      weleticLoyaltyAccount: {
        findMany: mocks.accountFindMany,
      },
    };
    return operation(tx);
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction:
    mocks.enqueueOutboxJobFromProgramTransaction,
}));

describe("VIP tier review scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueOutboxJob.mockResolvedValue({
      job: { id: "woutbox_1" },
      created: true,
    });
    mocks.enqueueOutboxJobFromProgramTransaction.mockResolvedValue({
      job: { id: "woutbox_sweep_1" },
      created: true,
    });
  });

  it("creates a durable, event-idempotent high-priority review", async () => {
    const tx = {} as never;

    await scheduleTierReviewAfterQualifyingActivity({
      storeId: "wstore_1",
      accountId: "waccount_1",
      activityKey: "activity:instagram_follow:waccount_1:claim_1",
      reason: "instagram_follow_points_earned",
      tx,
    });

    expect(mocks.enqueueOutboxJob).toHaveBeenCalledWith({
      storeId: "wstore_1",
      jobType: "TIER_REVIEW",
      payload: {
        accountId: "waccount_1",
        reason: "instagram_follow_points_earned",
      },
      idempotencyKey:
        "tier_review:waccount_1:activity:instagram_follow:waccount_1:claim_1",
      priority: 5,
      loyaltyMaintenancePermit: undefined,
      tx,
    });
  });

  it("sweeps active programs and enqueues tier review jobs for expired accounts", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const expiredAt = new Date("2026-09-01T10:00:00.000Z");

    mocks.programFindMany.mockResolvedValueOnce([
      {
        storeId: "wstore_1",
        vipTimeframe: "rolling_12m",
        vipDowngradeGraceDays: 30,
      },
    ]);

    mocks.accountFindMany.mockResolvedValueOnce([
      {
        id: "waccount_expired_1",
        tierExpiresAt: expiredAt,
      },
    ]);

    const result = await enqueueTierReviewSweepJobs({ now, batchSize: 50 });

    expect(result).toEqual({
      programsScanned: 1,
      programsSkipped: 0,
      accountsEvaluated: 1,
      jobsEnqueued: 1,
      programFailures: [],
    });

    expect(mocks.enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledWith({
      storeId: "wstore_1",
      jobType: "TIER_REVIEW",
      payload: {
        accountId: "waccount_expired_1",
        reviewPeriod: "rolling_12m",
        gracePeriodDays: 30,
        reason: "sweep_tier_expiry",
      },
      idempotencyKey: `tier_review_sweep:waccount_expired_1:${expiredAt.getTime()}`,
      priority: 5,
      tx: expect.anything(),
    });
  });

  it("handles empty programs or accounts gracefully without enqueueing", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");

    mocks.programFindMany.mockResolvedValueOnce([]);

    const result = await enqueueTierReviewSweepJobs({ now, batchSize: 50 });

    expect(result).toEqual({
      programsScanned: 0,
      programsSkipped: 0,
      accountsEvaluated: 0,
      jobsEnqueued: 0,
      programFailures: [],
    });

    expect(mocks.enqueueOutboxJobFromProgramTransaction).not.toHaveBeenCalled();
  });

  it("does not consume sweep capacity for an existing idempotent job", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const expiredAt = new Date("2026-09-01T10:00:00.000Z");
    mocks.programFindMany.mockResolvedValueOnce([
      {
        storeId: "wstore_1",
        vipTimeframe: "rolling_12m",
        vipDowngradeGraceDays: 30,
      },
    ]);
    mocks.accountFindMany.mockResolvedValueOnce([
      { id: "waccount_duplicate", tierExpiresAt: expiredAt },
      { id: "waccount_new", tierExpiresAt: expiredAt },
    ]);
    mocks.enqueueOutboxJobFromProgramTransaction
      .mockResolvedValueOnce({
        job: { id: "woutbox_existing" },
        created: false,
      })
      .mockResolvedValueOnce({
        job: { id: "woutbox_new" },
        created: true,
      });

    const result = await enqueueTierReviewSweepJobs({ now, batchSize: 1 });

    expect(result).toMatchObject({
      accountsEvaluated: 2,
      jobsEnqueued: 1,
      programFailures: [],
    });
    expect(mocks.enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledTimes(
      2,
    );
  });

  it("reports a program failure without retaining rolled-back counters", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const expiredAt = new Date("2026-09-01T10:00:00.000Z");
    mocks.programFindMany.mockResolvedValueOnce([
      {
        storeId: "wstore_failed",
        vipTimeframe: "rolling_12m",
        vipDowngradeGraceDays: 30,
      },
    ]);
    mocks.accountFindMany.mockResolvedValueOnce([
      { id: "waccount_first", tierExpiresAt: expiredAt },
      { id: "waccount_second", tierExpiresAt: expiredAt },
    ]);
    mocks.enqueueOutboxJobFromProgramTransaction
      .mockResolvedValueOnce({
        job: { id: "woutbox_rolled_back" },
        created: true,
      })
      .mockRejectedValueOnce(new Error("program transaction failed"));

    const result = await enqueueTierReviewSweepJobs({ now, batchSize: 2 });

    expect(result).toEqual({
      programsScanned: 1,
      programsSkipped: 1,
      accountsEvaluated: 0,
      jobsEnqueued: 0,
      programFailures: [
        {
          storeId: "wstore_failed",
          error: "program transaction failed",
        },
      ],
    });
  });
});
