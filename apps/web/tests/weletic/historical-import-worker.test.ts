import { HistoricalImportLeasePendingError } from "@/lib/weletic/loyalty/historical-import-job-contract";
import { executeHistoricalImportCommitJob } from "@/lib/weletic/loyalty/historical-import-worker";
import type { WeleticLoyaltyOutboxJob } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  terminal: vi.fn(),
  recover: vi.fn(),
  batch: vi.fn(),
  continuation: vi.fn(),
  paused: new Error("maintenance paused"),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  verifyHistoricalImportCommitCompletionInTransaction: mocks.terminal,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-recovery", () => ({
  recoverHistoricalImportCommitFromOutbox: mocks.recover,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-commit-batch", () => ({
  processHistoricalImportCommitBatch: mocks.batch,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-continuation", () => ({
  continueHistoricalImportCommit: mocks.continuation,
}));
vi.mock("@/lib/weletic/loyalty/maintenance-write-fence", () => ({
  isLoyaltyMaintenanceBlockedError: (error: unknown) => error === mocks.paused,
}));
const payload = {
  sourceId: "source",
  programId: "program",
  installationGeneration: "g1",
  sourceRevision: 1,
};
const job = {
  id: "job",
  storeId: "store",
  jobType: "HISTORICAL_IMPORT_COMMIT",
  payload,
} as unknown as WeleticLoyaltyOutboxJob;
const queueClaim = {
  ownerToken: "private-owner",
  claimedAt: new Date(),
  attempt: 1,
};
const lease = { private: "lease" };
const tx = {};
const run = () => executeHistoricalImportCommitJob({ job, queueClaim });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.terminal.mockResolvedValue(false);
  mocks.recover.mockResolvedValue({ lease });
  mocks.batch.mockResolvedValue({ completed: true, processed: 1, lease: null });
});
it("passes the exact queue binding through recovery into a bounded batch", async () => {
  await expect(run()).resolves.toEqual({
    historicalImportOutcome: "completed",
  });
  const scope = {
    storeId: "store",
    sourceId: "source",
    programId: "program",
    installationGeneration: "g1",
  };
  const claim = { ...queueClaim, jobId: "job", sourceRevision: 1 };
  expect(mocks.terminal).toHaveBeenCalledWith({ tx, scope, claim });
  expect(mocks.recover).toHaveBeenCalledWith({ scope, claim });
  expect(mocks.batch).toHaveBeenCalledWith({ lease, maxRows: 50 });
  expect(mocks.continuation).not.toHaveBeenCalled();
});
it("acknowledges verified terminal replay without recovering or posting again", async () => {
  mocks.terminal.mockResolvedValue(true);
  await expect(run()).resolves.toEqual({
    historicalImportOutcome: "completed",
  });
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(mocks.batch).not.toHaveBeenCalled();
});
it.each([1, 2, 49, 50])(
  "returns continuation after durable requeue for %s rows",
  async (processed) => {
    const renewed = { private: "new lease" };
    mocks.batch.mockResolvedValue({
      completed: false,
      processed,
      lease: renewed,
    });
    await expect(run()).resolves.toEqual({
      historicalImportOutcome: "continued",
    });
    expect(mocks.continuation).toHaveBeenCalledWith({ lease: renewed });
  },
);
it.each([
  { processed: 0, lease },
  { processed: 50, lease: null },
])(
  "refuses incomplete work without valid progress/ownership: %j",
  async (batch) => {
    mocks.batch.mockResolvedValue({ completed: false, ...batch });
    await expect(run()).rejects.toThrow(
      "Historical import commit execution failed",
    );
    expect(mocks.continuation).not.toHaveBeenCalled();
  },
);
it.each([
  undefined,
  { ...queueClaim, attempt: 0 },
  { ...queueClaim, privateData: "forbidden" },
])(
  "rejects invalid private queue authority before database work",
  async (claim) => {
    await expect(
      executeHistoricalImportCommitJob({ job, queueClaim: claim }),
    ).rejects.toThrow("Historical import commit execution failed");
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);
it.each(["terminal", "recover", "batch", "continuation"] as const)(
  "sanitizes %s failures before they enter durable error logs",
  async (stage) => {
    mocks.batch.mockResolvedValue({ completed: false, processed: 1, lease });
    mocks[stage].mockRejectedValue(
      new Error("private customer identifier and SQL input"),
    );
    await expect(run()).rejects.toThrow(
      /^Historical import commit execution failed; reconcile the source before redrive\.$/,
    );
  },
);
it("preserves maintenance deferral rather than consuming retry budget", async () => {
  mocks.recover.mockRejectedValue(mocks.paused);
  await expect(run()).rejects.toBe(mocks.paused);
});
it("preserves verified source-expiry deferral without attempting recovery", async () => {
  const waiting = new HistoricalImportLeasePendingError(new Date());
  mocks.terminal.mockRejectedValue(waiting);
  await expect(run()).rejects.toBe(waiting);
  expect(mocks.recover).not.toHaveBeenCalled();
});
