import { HistoricalImportConflictError } from "@/lib/weletic/loyalty/historical-import-persistence";
import { processHistoricalImportRecoveryPage } from "@/lib/weletic/loyalty/historical-import-recovery-page";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  recover: vi.fn(),
  batch: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/historical-import-recovery-discovery", () => ({
  discoverHistoricalImportCommitRecovery: mocks.discover,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-recovery", () => ({
  recoverHistoricalImportCommit: mocks.recover,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-commit-batch", () => ({
  processHistoricalImportCommitBatch: mocks.batch,
}));
const scope = {
  storeId: "store",
  programId: "program",
  installationGeneration: "g1",
};
const candidate = (sourceId: string) => ({ ...scope, sourceId });
const lease = {
  ...candidate("a"),
  phase: "committing",
  revision: 2,
  leaseId: "00000000-0000-4000-8000-000000000001",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.discover.mockResolvedValue({
    candidates: [candidate("a")],
    nextCursor: null,
  });
  mocks.recover.mockResolvedValue({ lease });
  mocks.batch.mockResolvedValue({ processed: 1, completed: true, lease: null });
});
it("runs discovery then verified recovery before bounded row execution", async () => {
  await expect(
    processHistoricalImportRecoveryPage({ request: scope }),
  ).resolves.toEqual({
    outcomes: [{ sourceId: "a", status: "completed", processed: 1 }],
    nextCursor: null,
  });
  expect(mocks.discover).toHaveBeenCalledWith(scope);
  expect(mocks.recover).toHaveBeenCalledWith({ scope: candidate("a") });
  expect(mocks.batch).toHaveBeenCalledWith({ lease, maxRows: 50 });
  const order = [mocks.discover, mocks.recover, mocks.batch].map(
    (fn) => fn.mock.invocationCallOrder[0],
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
});
it("returns the latest private continuation token, never the pre-batch token", async () => {
  const renewed = { ...lease, revision: 5 };
  mocks.batch.mockResolvedValue({
    processed: 3,
    completed: false,
    lease: renewed,
  });
  await expect(
    processHistoricalImportRecoveryPage({
      request: scope,
      maxRowsPerSource: 3,
    }),
  ).resolves.toEqual({
    outcomes: [
      { sourceId: "a", status: "continuation", processed: 3, lease: renewed },
    ],
    nextCursor: null,
  });
  expect(mocks.batch).toHaveBeenCalledWith({ lease, maxRows: 3 });
});
it("continues after a recovery conflict and preserves the next-page cursor", async () => {
  mocks.discover.mockResolvedValue({
    candidates: [candidate("a"), candidate("b")],
    nextCursor: "b",
  });
  mocks.recover
    .mockRejectedValueOnce(new HistoricalImportConflictError())
    .mockResolvedValueOnce({ lease: { ...lease, sourceId: "b" } });
  await expect(
    processHistoricalImportRecoveryPage({ request: scope }),
  ).resolves.toEqual({
    outcomes: [
      {
        sourceId: "a",
        status: "conflict",
        stage: "recovery",
        progress: "unknown",
      },
      { sourceId: "b", status: "completed", processed: 1 },
    ],
    nextCursor: "b",
  });
  expect(mocks.recover).toHaveBeenCalledTimes(2);
  expect(mocks.batch).toHaveBeenCalledTimes(1);
});
it.each([
  new Error("private database and shopper detail"),
  new HistoricalImportConflictError(),
])(
  "does not claim zero progress or retry after an uncertain execution failure",
  async (error) => {
    mocks.batch.mockRejectedValue(error);
    const result = await processHistoricalImportRecoveryPage({
      request: scope,
    });
    expect(result.outcomes).toEqual([
      {
        sourceId: "a",
        status:
          error instanceof HistoricalImportConflictError
            ? "conflict"
            : "failed",
        stage: "execution",
        progress: "unknown",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(error.message);
    expect(JSON.stringify(result)).not.toContain(lease.leaseId);
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.recover).toHaveBeenCalledTimes(1);
  },
);
it("records an unknown recovery error without exposing its message", async () => {
  mocks.recover.mockRejectedValue(new Error("secret"));
  await expect(
    processHistoricalImportRecoveryPage({ request: scope }),
  ).resolves.toEqual({
    outcomes: [
      {
        sourceId: "a",
        status: "failed",
        stage: "recovery",
        progress: "unknown",
      },
    ],
    nextCursor: null,
  });
  expect(mocks.batch).not.toHaveBeenCalled();
});
it("propagates discovery failures instead of claiming an empty success", async () => {
  const error = new Error("paused store");
  mocks.discover.mockRejectedValue(error);
  await expect(
    processHistoricalImportRecoveryPage({ request: scope }),
  ).rejects.toBe(error);
  expect(mocks.recover).not.toHaveBeenCalled();
});
it("returns an empty page without recovering or executing", async () => {
  mocks.discover.mockResolvedValue({ candidates: [], nextCursor: null });
  await expect(
    processHistoricalImportRecoveryPage({ request: scope }),
  ).resolves.toEqual({ outcomes: [], nextCursor: null });
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(mocks.batch).not.toHaveBeenCalled();
});
it.each([0, 101, 1.5, NaN])(
  "rejects invalid row bound %s before discovery",
  async (maxRowsPerSource) => {
    await expect(
      processHistoricalImportRecoveryPage({ request: scope, maxRowsPerSource }),
    ).rejects.toThrow();
    expect(mocks.discover).not.toHaveBeenCalled();
  },
);
