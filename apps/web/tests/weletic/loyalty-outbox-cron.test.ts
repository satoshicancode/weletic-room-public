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

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
  vi.stubEnv("CRON_SECRET", "synthetic-outbox-secret");
  points.mockResolvedValue({ points: true });
  tiers.mockResolvedValue({ tiers: true });
  rewards.mockResolvedValue({ rewards: true });
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
    for (const work of [points, tiers, rewards, processJobs]) {
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
      for (const sweep of [points, tiers, rewards]) {
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
