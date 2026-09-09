import { continueHistoricalImportCommit } from "@/lib/weletic/loyalty/historical-import-continuation";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  assert: vi.fn(),
  source: vi.fn(),
  job: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  assertHistoricalImportExecutionLeaseInTransaction: mocks.assert,
}));
const claim = {
  jobId: "job",
  ownerToken: "owner",
  claimedAt: new Date("2026-09-09T00:00:00Z"),
  attempt: 2,
  sourceRevision: 1,
};
const lease = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  installationGeneration: "g1",
  phase: "committing",
  revision: 3,
  leaseId: "private",
  outboxClaim: claim,
};
const now = new Date("2026-09-09T00:00:30Z");
const source = { leaseExpiresAt: new Date("2026-09-09T00:01:00Z") };
const tx = {
  weleticLoyaltyImportSource: { updateMany: mocks.source },
  weleticLoyaltyOutboxJob: { updateMany: mocks.job },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.assert.mockResolvedValue({ lease, source, now });
  mocks.source.mockResolvedValue({ count: 1 });
  mocks.job.mockResolvedValue({ count: 1 });
});
it("rotates source ownership and requeues the same job in one fresh transaction", async () => {
  await expect(continueHistoricalImportCommit({ lease })).resolves.toEqual({
    continued: true,
  });
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
    timeout: 30000,
  });
  expect(mocks.assert).toHaveBeenCalledWith({ tx, lease });
  expect(mocks.source.mock.calls[0][0].data).toEqual({
    revision: { increment: 1 },
    leaseExpiresAt: now,
  });
  expect(mocks.job).toHaveBeenCalledWith({
    where: {
      id: "job",
      storeId: "store",
      jobType: "HISTORICAL_IMPORT_COMMIT",
      status: "processing",
      lockedBy: "owner",
      lockedAt: claim.claimedAt,
      attempts: 2,
    },
    data: {
      status: "pending",
      scheduledFor: now,
      nextRetryAt: null,
      lockedBy: null,
      lockedAt: null,
      attempts: 0,
      lastError: null,
    },
  });
});
it.each([
  { outboxClaim: undefined },
  { phase: "rolling_back" },
  { revision: 2147483647 },
])("refuses unsupported handoff %j before writes", async (changed) => {
  mocks.assert.mockResolvedValue({
    lease: { ...lease, ...changed },
    source,
    now,
  });
  await expect(continueHistoricalImportCommit({ lease })).rejects.toThrow(
    "state changed",
  );
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.job).not.toHaveBeenCalled();
});
it.each(["source", "job"] as const)(
  "aborts all changes when %s ownership CAS loses",
  async (target) => {
    mocks[target].mockResolvedValue({ count: 0 });
    await expect(continueHistoricalImportCommit({ lease })).rejects.toThrow(
      "state changed",
    );
    if (target === "source") expect(mocks.job).not.toHaveBeenCalled();
  },
);
it("does not swallow assertion or persistence failures", async () => {
  const failure = new Error("ownership lost");
  mocks.assert.mockRejectedValueOnce(failure);
  await expect(continueHistoricalImportCommit({ lease })).rejects.toBe(failure);
  expect(mocks.source).not.toHaveBeenCalled();
  mocks.job.mockRejectedValueOnce(failure);
  await expect(continueHistoricalImportCommit({ lease })).rejects.toBe(failure);
});
