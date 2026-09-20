import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Keep real withCron and signature verification; replace logging and work only.
vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (handler: unknown) => handler,
  logger: { error: vi.fn(), flush: vi.fn() },
}));
vi.mock("app/(ee)/api/cron/utils", () => ({
  logAndRespond: (message: string, options: ResponseInit) =>
    new Response(message, options),
}));
const points = vi.fn();
const tiers = vi.fn();
const rewards = vi.fn();
const retention = vi.fn();
const reviewRecovery = vi.fn();
const processJobs = vi.fn();
vi.mock("@/lib/weletic/loyalty/points-expiry-scheduler", () => ({
  enqueuePointsExpiryLifecycleJobs: points,
}));
vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  enqueueTierReviewSweepJobs: tiers,
}));
vi.mock("@/lib/weletic/loyalty/reward-expiry-scheduler", () => ({
  enqueueRewardExpiryReminderJobs: rewards,
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  processOutboxJobsBatch: processJobs,
}));
vi.mock("@/lib/weletic/reviews/delivery-retention", () => ({
  clearExpiredReviewDeliveryEvidence: retention,
}));
vi.mock("@/lib/weletic/reviews/points-recovery-sweep", () => ({
  enqueueReviewPointsRecoverySweep: reviewRecovery,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
  vi.stubEnv("CRON_SECRET", "synthetic-outbox-secret");
  points.mockResolvedValue({ points: true });
  tiers.mockResolvedValue({ tiers: true });
  rewards.mockResolvedValue({ rewards: true });
  retention.mockResolvedValue({ scanned: 0, cleared: 0 });
  reviewRecovery.mockResolvedValue({ scanned: 0, enqueued: 0, deferred: 0 });
  processJobs.mockResolvedValue({ processed: 0 });
});
afterEach(() => vi.unstubAllEnvs());

async function run(query = "", authorized = true, method = "GET") {
  const { GET, POST } = await import(
    "../../app/(ee)/api/cron/weletic/loyalty/outbox/route"
  );
  return (method === "POST" ? POST : GET)(
    new NextRequest(
      `https://app.invalid/api/cron/weletic/loyalty/outbox${query}`,
      {
        method,
        headers: authorized
          ? { authorization: "Bearer synthetic-outbox-secret" }
          : {},
      },
    ),
    { params: Promise.resolve({}) },
  );
}

test.each(["GET", "POST"])(
  "rejects unsigned %s before any work",
  async (method) => {
    expect((await run("", false, method)).status).toBe(
      method === "GET" ? 401 : 400,
    );
    for (const work of [
      points,
      tiers,
      rewards,
      retention,
      reviewRecovery,
      processJobs,
    ]) {
      expect(work).not.toHaveBeenCalled();
    }
  },
);

test.each([
  ["", 50],
  ["?batchSize=2", 2],
  ["?batchSize=999", 100],
  ["?batchSize=-5", 1],
  ["?batchSize=NaN", 50],
])(
  "runs all sweeps before dispatch with bounded input %s",
  async (query, size) => {
    processJobs.mockImplementation(async () => {
      for (const sweep of [points, tiers, rewards, retention, reviewRecovery]) {
        expect(sweep).toHaveBeenCalledWith({ batchSize: size });
      }
      return { processed: 0 };
    });
    const response = await run(query as string);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      expirySweep: { points: true },
      tierSweep: { tiers: true },
      rewardExpirySweep: { rewards: true },
      reviewRetention: { scanned: 0, cleared: 0 },
      reviewPointsRecovery: { scanned: 0, enqueued: 0, deferred: 0 },
      outbox: { processed: 0 },
    });
    expect(processJobs).toHaveBeenCalledWith({
      batchSize: size,
      workerId: expect.stringMatching(/^cron_/),
    });
  },
);

test("keeps a failed sweep retryable instead of claiming successful dispatch", async () => {
  rewards.mockRejectedValue(new Error("synthetic sweep failure"));
  expect((await run()).status).toBe(500);
  expect(processJobs).not.toHaveBeenCalled();
});
test("continues unrelated dispatch when review retention defers busy customers", async () => {
  retention.mockResolvedValue({ scanned: 2, cleared: 1, deferred: 1 });
  const response = await run();
  expect(response.status).toBe(200);
  expect(processJobs).toHaveBeenCalledOnce();
  expect((await response.json()).reviewRetention).toEqual({
    scanned: 2,
    cleared: 1,
    deferred: 1,
  });
});
