import { processHistoricalImportCommitBatch } from "@/lib/weletic/loyalty/historical-import-commit-batch";
import { processHistoricalImportRollbackBatch } from "@/lib/weletic/loyalty/historical-import-rollback-batch";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  raw: vi.fn(),
  assert: vi.fn(),
  renew: vi.fn(),
  finalize: vi.fn(),
  row: vi.fn(),
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
  executeHistoricalImportRow: mocks.row,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-rollback-row", () => ({
  HISTORICAL_IMPORT_ROLLBACK_TRANSACTION_ROWS: 10,
  rollbackHistoricalImportRows: mocks.row,
}));
const modes = [
  { phase: "committing", run: processHistoricalImportCommitBatch },
  { phase: "rolling_back", run: processHistoricalImportRollbackBatch },
];
const scope = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  revision: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) =>
    callback({ $queryRaw: mocks.raw }),
  );
  mocks.assert.mockImplementation(async ({ lease }) => ({ lease }));
  mocks.renew.mockImplementation(async ({ lease }) => ({
    lease: { ...lease, revision: lease.revision + 1 },
  }));
  mocks.raw
    .mockResolvedValueOnce([{ id: "row1", rowNumber: 1 }])
    .mockResolvedValueOnce([{ id: "row2", rowNumber: 2 }])
    .mockResolvedValue([]);
  mocks.finalize.mockResolvedValue({ finalized: true });
});
it.each(modes)(
  "$phase yields after a slow atomic row, not in the middle of it",
  async ({ phase, run }) => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      mocks.row.mockImplementation(async () => {
        now = 30_000;
        return { contained: false };
      });
      expect(
        await run({ lease: { ...scope, phase }, maxRows: 50 }),
      ).toMatchObject({
        processed: 1,
        completed: false,
        lease: { ...scope, phase, revision: 2 },
      });
      expect(mocks.row).toHaveBeenCalledTimes(1);
      expect(mocks.raw).toHaveBeenCalledTimes(1);
      expect(mocks.finalize).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);
it.each(modes)(
  "$phase counts selection time but makes atomic progress before yielding",
  async ({ phase, run }) => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      mocks.raw.mockReset().mockImplementation(async () => {
        now = 31_000;
        return [{ id: "row1", rowNumber: 1 }];
      });
      mocks.row.mockResolvedValue({ contained: false });
      expect(await run({ lease: { ...scope, phase } })).toMatchObject({
        processed: 1,
        completed: false,
      });
      expect(mocks.row).toHaveBeenCalledTimes(1);
      expect(mocks.raw).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  },
);
it.each(modes)(
  "$phase preserves the row cap below the time budget",
  async ({ phase, run }) => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      mocks.row.mockImplementation(async () => {
        now += 10_000;
        return { contained: false };
      });
      expect(
        await run({ lease: { ...scope, phase }, maxRows: 2 }),
      ).toMatchObject({ processed: 2, completed: false });
      expect(mocks.row).toHaveBeenCalledTimes(2);
      expect(mocks.finalize).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);
it.each(modes)(
  "$phase does not turn a slow failed row into successful continuation",
  async ({ phase, run }) => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      mocks.row.mockImplementation(async () => {
        now = 60_000;
        throw new Error("row aborted");
      });
      await expect(run({ lease: { ...scope, phase } })).rejects.toThrow(
        "row aborted",
      );
      expect(mocks.raw).toHaveBeenCalledTimes(1);
      expect(mocks.finalize).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);
it("rollback containment wins over the elapsed-time continuation", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    mocks.row.mockImplementation(async () => {
      now = 60_000;
      return { contained: true };
    });
    expect(
      await processHistoricalImportRollbackBatch({
        lease: { ...scope, phase: "rolling_back" },
      }),
    ).toEqual({ processed: 0, completed: false, contained: true, lease: null });
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it("rollback groups at most ten rows and respects a smaller remaining delivery cap", async () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({
    id: `row${index + 1}`,
    rowNumber: index + 1,
  }));
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce(rows.slice(0, 10))
    .mockResolvedValueOnce(rows.slice(10));
  mocks.row.mockResolvedValue({ contained: false });
  const result = await processHistoricalImportRollbackBatch({
    lease: { ...scope, phase: "rolling_back" },
    maxRows: 13,
  });
  expect(result.processed).toBe(13);
  expect(result.completed).toBe(false);
  expect(mocks.row.mock.calls.map(([args]) => args.snapshotIds.length)).toEqual(
    [10, 3],
  );
  expect(mocks.raw.mock.calls.map(([query]) => query.values.at(-1))).toEqual([
    10, 3,
  ]);
});

it.each([
  [
    { id: "row1", rowNumber: 1 },
    { id: "row1", rowNumber: 2 },
  ],
  [
    { id: "row2", rowNumber: 2 },
    { id: "row1", rowNumber: 1 },
  ],
  Array.from({ length: 11 }, (_, index) => ({
    id: `row${index}`,
    rowNumber: index + 1,
  })),
])(
  "rejects malformed bounded rollback selection %# before correction",
  async (...rows) => {
    mocks.raw.mockReset().mockResolvedValue(rows);
    await expect(
      processHistoricalImportRollbackBatch({
        lease: { ...scope, phase: "rolling_back" },
      }),
    ).rejects.toThrow();
    expect(mocks.row).not.toHaveBeenCalled();
  },
);
