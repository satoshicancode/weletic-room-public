import { finalizeHistoricalImportExecution } from "@/lib/weletic/loyalty/historical-import-finalization";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lease: vi.fn(),
  proof: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  assertHistoricalImportExecutionLeaseInTransaction: mocks.lease,
}));
vi.mock(
  "@/lib/weletic/loyalty/historical-import-reconciliation-service",
  () => ({ readHistoricalImportExecutionProofInTransaction: mocks.proof }),
);
const lease = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  installationGeneration: "generation",
  phase: "committing",
  revision: 4,
  leaseId: "lease",
};
const now = new Date("2026-09-09T00:00:00.000Z");
const source = {
  leaseExpiresAt: new Date(now.getTime() + 60000),
  normalizedSha256: "a".repeat(64),
};
const proof = {
  rowsFullyCommitted: true,
  rowsFullyRolledBack: false,
  summary: {
    reconciled: true,
    issues: [],
    sourceStatus: "committing",
    rowCount: 1,
  },
};
const tx = { weleticLoyaltyImportSource: { updateMany: mocks.update } };
const run = () => finalizeHistoricalImportExecution({ lease });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.lease.mockResolvedValue({ lease, source, now });
  mocks.proof.mockResolvedValue(proof);
  mocks.update.mockResolvedValue({ count: 1 });
});
it("proves all rows before terminal CAS and clears the lease", async () => {
  expect(await run()).toEqual({ finalized: true, status: "committed" });
  expect(mocks.transaction.mock.calls[0][1]).toEqual({
    isolationLevel: "RepeatableRead",
    timeout: 30000,
  });
  expect(mocks.lease).toHaveBeenCalledTimes(2);
  expect(mocks.proof).toHaveBeenCalledWith({
    tx,
    sourceId: "source",
    storeId: "store",
    programId: "program",
  });
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    where: {
      id: "source",
      storeId: "store",
      programId: "program",
      installationGeneration: "generation",
      status: "committing",
      revision: 4,
      leaseId: "lease",
      leaseExpiresAt: source.leaseExpiresAt,
      normalizedSha256: source.normalizedSha256,
    },
    data: {
      status: "committed",
      revision: { increment: 1 },
      leaseId: null,
      leaseExpiresAt: null,
      completedAt: now,
    },
  });
  expect(mocks.lease.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.proof.mock.invocationCallOrder[0],
  );
  expect(mocks.proof.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.lease.mock.invocationCallOrder[1],
  );
});
it("leaves a reconciled but incomplete source in progress", async () => {
  mocks.proof.mockResolvedValue({ ...proof, rowsFullyCommitted: false });
  expect(await run()).toEqual({ finalized: false });
  expect(mocks.update).not.toHaveBeenCalled();
});
it("requires all rollback rows before the rolled_back transition", async () => {
  mocks.lease.mockResolvedValue({
    lease: { ...lease, phase: "rolling_back" },
    source,
    now,
  });
  mocks.proof.mockResolvedValue({
    ...proof,
    rowsFullyCommitted: false,
    rowsFullyRolledBack: true,
    summary: { ...proof.summary, sourceStatus: "rolling_back" },
  });
  expect(await run()).toEqual({ finalized: true, status: "rolled_back" });
  expect(mocks.update.mock.calls[0][0].where.status).toBe("rolling_back");
});
it.each([
  { reconciled: false },
  { issues: ["unclaimed_ledger_entry"] },
  { sourceStatus: "contained" },
  { rowCount: 0 },
])("rejects invalid proof case %#", async (change) => {
  mocks.proof.mockResolvedValue({
    ...proof,
    summary: { ...proof.summary, ...change },
  });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.update).not.toHaveBeenCalled();
});
it("rejects expiry during proof before any terminal write", async () => {
  mocks.lease
    .mockResolvedValueOnce({ lease, source, now })
    .mockRejectedValueOnce(new Error("expired"));
  await expect(run()).rejects.toThrow("expired");
  expect(mocks.update).not.toHaveBeenCalled();
});
it("rejects exhausted revisions and failed CAS", async () => {
  mocks.lease.mockResolvedValue({
    lease: { ...lease, revision: 2147483647 },
    source,
    now,
  });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.update).not.toHaveBeenCalled();
  mocks.lease.mockResolvedValue({ lease, source, now });
  mocks.update.mockResolvedValue({ count: 0 });
  await expect(run()).rejects.toThrow("state changed");
});
