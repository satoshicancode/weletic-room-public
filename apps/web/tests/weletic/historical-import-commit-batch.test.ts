import { processHistoricalImportCommitBatch } from "@/lib/weletic/loyalty/historical-import-commit-batch";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  assert: vi.fn(),
  renew: vi.fn(),
  finalize: vi.fn(),
  execute: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  assertHistoricalImportExecutionLeaseInTransaction: mocks.assert,
  renewHistoricalImportExecutionLeaseInTransaction: mocks.renew,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-finalization", () => ({
  finalizeHistoricalImportExecution: mocks.finalize,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-row-execution", () => ({
  executeHistoricalImportRow: mocks.execute,
}));
const lease = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  phase: "committing",
  revision: 1,
};
const tx = { $queryRaw: mocks.raw };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.assert.mockImplementation(async ({ lease: token }) => ({
    lease: token,
  }));
  mocks.renew.mockImplementation(async ({ lease: token }) => ({
    lease: { ...token, revision: token.revision + 1 },
  }));
  mocks.raw.mockResolvedValue([]);
  mocks.finalize.mockResolvedValue({ finalized: true, status: "committed" });
});
it("rotates tokens, processes bounded durable rows, then independently finalizes", async () => {
  mocks.raw
    .mockResolvedValueOnce([{ id: "row1", rowNumber: 10 }])
    .mockResolvedValueOnce([{ id: "row2", rowNumber: 11 }])
    .mockResolvedValueOnce([]);
  expect(
    await processHistoricalImportCommitBatch({ lease, maxRows: 3 }),
  ).toEqual({ processed: 2, completed: true, lease: null });
  expect(
    mocks.execute.mock.calls.map(([args]) => [
      args.snapshotId,
      args.lease.revision,
    ]),
  ).toEqual([
    ["row1", 2],
    ["row2", 3],
  ]);
  expect(mocks.finalize).toHaveBeenCalledWith({
    lease: { ...lease, revision: 4 },
  });
  expect(mocks.raw.mock.calls[0][0].values).toEqual([
    "source",
    "store",
    "program",
    0,
  ]);
  expect(mocks.raw.mock.calls[1][0].values.at(-1)).toBe(10);
  expect(mocks.raw.mock.calls[2][0].values.at(-1)).toBe(11);
  expect(mocks.raw.mock.calls[0][0].sql).toContain("FOR UPDATE");
  expect(mocks.raw.mock.calls[0][0].sql).toContain("e.storeId <> s.storeId");
});
it("returns the renewed private token at the cap without claiming completion", async () => {
  mocks.raw.mockResolvedValue([{ id: "row", rowNumber: 1 }]);
  expect(
    await processHistoricalImportCommitBatch({ lease, maxRows: 1 }),
  ).toEqual({
    processed: 1,
    completed: false,
    lease: { ...lease, revision: 2 },
  });
  expect(mocks.finalize).not.toHaveBeenCalled();
});
it("rejects rollback tokens before selecting or renewing", async () => {
  await expect(
    processHistoricalImportCommitBatch({
      lease: { ...lease, phase: "rolling_back" },
    }),
  ).rejects.toThrow("state changed");
  expect(mocks.raw).not.toHaveBeenCalled();
  expect(mocks.renew).not.toHaveBeenCalled();
});
it.each([0, 50001, 1.5, null])(
  "rejects invalid stored row number %s",
  async (rowNumber) => {
    mocks.raw.mockResolvedValue([{ id: "row", rowNumber }]);
    await expect(processHistoricalImportCommitBatch({ lease })).rejects.toThrow(
      "state changed",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.renew).not.toHaveBeenCalled();
  },
);
it.each([0, -1, 101, 1.5, NaN])(
  "rejects invalid batch limit %s before touching the database",
  async (maxRows) => {
    await expect(
      processHistoricalImportCommitBatch({ lease, maxRows }),
    ).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);
it("does not finalize or continue after a failed row transaction", async () => {
  mocks.raw.mockResolvedValue([{ id: "row", rowNumber: 1 }]);
  const error = new Error("stale worker");
  mocks.execute.mockRejectedValue(error);
  await expect(processHistoricalImportCommitBatch({ lease })).rejects.toBe(
    error,
  );
  expect(mocks.raw).toHaveBeenCalledTimes(1);
  expect(mocks.finalize).not.toHaveBeenCalled();
});
it("does not execute if renewal fails and rejects incomplete final proof", async () => {
  mocks.raw.mockResolvedValueOnce([{ id: "row", rowNumber: 1 }]);
  mocks.renew.mockRejectedValueOnce(new Error("expired"));
  await expect(processHistoricalImportCommitBatch({ lease })).rejects.toThrow(
    "expired",
  );
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.finalize.mockResolvedValue({ finalized: false });
  await expect(processHistoricalImportCommitBatch({ lease })).rejects.toThrow(
    "state changed",
  );
});
