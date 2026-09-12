import {
  HistoricalImportExecutionContainedError,
  HistoricalImportLeasePendingError,
} from "@/lib/weletic/loyalty/historical-import-job-contract";
import { executeHistoricalImportRollbackJob } from "@/lib/weletic/loyalty/historical-import-rollback-worker";
import type { WeleticLoyaltyOutboxJob } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  terminal: vi.fn(),
  recover: vi.fn(),
  batch: vi.fn(),
  continuation: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  verifyHistoricalImportRollbackCompletionInTransaction: mocks.terminal,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-recovery", () => ({
  recoverHistoricalImportRollbackFromOutbox: mocks.recover,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-rollback-batch", () => ({
  processHistoricalImportRollbackBatch: mocks.batch,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-continuation", () => ({
  continueHistoricalImportRollback: mocks.continuation,
}));
const job = {
  id: "job",
  storeId: "store",
  jobType: "HISTORICAL_IMPORT_ROLLBACK",
  payload: {
    sourceId: "source",
    programId: "program",
    installationGeneration: "g1",
    sourceRevision: 3,
  },
} as unknown as WeleticLoyaltyOutboxJob;
const queueClaim = { ownerToken: "owner", claimedAt: new Date(), attempt: 1 };
const lease = { private: "rollback ownership" };
const tx = {};
const run = () => executeHistoricalImportRollbackJob({ job, queueClaim });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.terminal.mockResolvedValue(false);
  mocks.recover.mockResolvedValue({ lease });
  mocks.batch.mockResolvedValue({
    completed: true,
    contained: false,
    processed: 1,
    lease: null,
  });
});
it("binds only the rollback source and exact acquired queue claim", async () => {
  await expect(run()).resolves.toEqual({
    historicalImportOutcome: "completed",
  });
  expect(mocks.recover).toHaveBeenCalledWith({
    scope: {
      storeId: "store",
      sourceId: "source",
      programId: "program",
      installationGeneration: "g1",
    },
    claim: { ...queueClaim, jobId: "job", sourceRevision: 3 },
  });
  expect(mocks.batch).toHaveBeenCalledWith({ lease, maxRows: 50 });
});
it("does not recover or correct again after verified terminal replay", async () => {
  mocks.terminal.mockResolvedValue(true);
  await expect(run()).resolves.toEqual({
    historicalImportOutcome: "completed",
  });
  expect(mocks.recover).not.toHaveBeenCalled();
});
it("dispatches a full outbox claim through the strict rollback claim parser", async () => {
  const { executeOutboxJob } = await import(
    "../../lib/weletic/loyalty/outbox-worker"
  );
  await expect(
    executeOutboxJob(job, new Date(), undefined, {
      ...queueClaim,
      candidate: job,
    }),
  ).resolves.toEqual({ historicalImportOutcome: "completed" });
  expect(mocks.recover).toHaveBeenCalledWith(
    expect.objectContaining({
      claim: { ...queueClaim, jobId: job.id, sourceRevision: 3 },
    }),
  );
});
it.each([1, 2, 49, 50])(
  "continues %s rows only after durable successful-progress handoff",
  async (processed) => {
    mocks.batch.mockResolvedValue({
      completed: false,
      contained: false,
      processed,
      lease,
    });
    await expect(run()).resolves.toEqual({
      historicalImportOutcome: "continued",
    });
    expect(mocks.continuation).toHaveBeenCalledWith({ lease });
  },
);
it("stops containment instead of completing or requeuing it", async () => {
  mocks.batch.mockResolvedValue({
    completed: false,
    contained: true,
    processed: 0,
    lease: null,
  });
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportExecutionContainedError,
  );
  expect(mocks.continuation).not.toHaveBeenCalled();
});
it("refuses a no-progress continuation", async () => {
  mocks.batch.mockResolvedValue({
    completed: false,
    contained: false,
    processed: 0,
    lease,
  });
  await expect(run()).rejects.toThrow("rollback execution failed");
  expect(mocks.continuation).not.toHaveBeenCalled();
});
it.each([
  new HistoricalImportExecutionContainedError(),
  new HistoricalImportLeasePendingError(new Date()),
])("preserves terminal/expiry semantics: %s", async (error) => {
  mocks.terminal.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(mocks.recover).not.toHaveBeenCalled();
});
it.each([undefined, { ...queueClaim, attempt: 0 }])(
  "refuses invalid queue ownership before database work",
  async (claim) => {
    await expect(
      executeHistoricalImportRollbackJob({ job, queueClaim: claim }),
    ).rejects.toThrow("rollback execution failed");
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);
it("does not accept a commit job through the rollback entry point", async () => {
  await expect(
    executeHistoricalImportRollbackJob({
      job: { ...job, jobType: "HISTORICAL_IMPORT_COMMIT" },
      queueClaim,
    }),
  ).rejects.toThrow("rollback execution failed");
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it.each(["terminal", "recover", "batch", "continuation"] as const)(
  "sanitizes %s persistence errors",
  async (stage) => {
    mocks.batch.mockResolvedValue({
      completed: false,
      contained: false,
      processed: 1,
      lease,
    });
    mocks[stage].mockRejectedValue(
      new Error("private shopper SQL and worker token"),
    );
    await expect(run()).rejects.toThrow(
      /^Historical import rollback execution failed; reconcile the source before redrive\.$/,
    );
  },
);
