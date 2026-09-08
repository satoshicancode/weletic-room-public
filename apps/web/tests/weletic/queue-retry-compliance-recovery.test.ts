import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  batchJSON: vi.fn(),
  buildReplayRequest: vi.fn(),
  complianceBatch: vi.fn(),
  isPublishSuccess: vi.fn(),
  jobDeleteMany: vi.fn(),
  jobFindMany: vi.fn(),
  jobUpdateMany: vi.fn(),
  loggerError: vi.fn(),
  loggerFlush: vi.fn(),
  loggerInfo: vi.fn(),
  redisDel: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock("@/lib/axiom/server", () => ({
  logger: {
    error: mocks.loggerError,
    flush: mocks.loggerFlush,
    info: mocks.loggerInfo,
  },
}));

vi.mock("@/lib/cron", () => ({
  qstash: { batchJSON: mocks.batchJSON },
}));

vi.mock("@/lib/cron/with-cron", () => ({
  withCron: (handler: unknown) => handler,
}));

vi.mock("@/lib/jobs", () => ({
  buildReplayRequest: mocks.buildReplayRequest,
  isPublishSuccess: mocks.isPublishSuccess,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    job: {
      deleteMany: mocks.jobDeleteMany,
      findMany: mocks.jobFindMany,
      updateMany: mocks.jobUpdateMany,
    },
  },
}));

vi.mock("@/lib/upstash/redis", () => ({
  redis: {
    del: mocks.redisDel,
    set: mocks.redisSet,
  },
}));

vi.mock("@/lib/weletic/shopify/compliance-worker", () => ({
  processShopifyComplianceBatch: mocks.complianceBatch,
}));

import { GET } from "../../app/(ee)/api/cron/queue/retry/route";

const invokeRoute = GET as unknown as () => Promise<Response>;

describe("minute queue retry compliance recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue("1");
    mocks.redisDel.mockResolvedValue(1);
    mocks.complianceBatch.mockResolvedValue({
      selected: 0,
      processed: 0,
      budgetExhausted: false,
    });
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.jobDeleteMany.mockResolvedValue({ count: 0 });
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("runs the authoritative bounded compliance sweep even when no generic jobs exist", async () => {
    const response = await invokeRoute();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("No background jobs to retry.");
    expect(mocks.complianceBatch).toHaveBeenCalledWith({
      batchSize: 3,
      workerId: expect.stringMatching(/^queue_retry_compliance_/),
    });
    expect(mocks.redisDel).toHaveBeenCalledWith("lock:queue-retry");
  });

  it("continues generic replay when the compliance sweep fails", async () => {
    const job = {
      id: "job_1",
      name: "example",
      attempts: 0,
      createdAt: new Date("2026-08-30T00:00:00.000Z"),
    };
    mocks.complianceBatch.mockRejectedValue(new Error("database unavailable"));
    mocks.jobFindMany.mockResolvedValue([job]);
    mocks.buildReplayRequest.mockReturnValue({ url: "https://queue.invalid" });
    mocks.batchJSON.mockResolvedValue([{ messageId: "q_1" }]);
    mocks.isPublishSuccess.mockReturnValue(true);
    mocks.jobDeleteMany.mockResolvedValue({ count: 1 });

    const response = await invokeRoute();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      "Republished 1 background jobs to QStash.",
    );
    expect(mocks.batchJSON).toHaveBeenCalledOnce();
    expect(mocks.jobDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["job_1"] } },
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "shopify.compliance_recovery_sweep_failed",
      { errorName: "Error" },
    );
  });
});
