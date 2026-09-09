import {
  recoverHistoricalImportCommit,
  recoverHistoricalImportCommitFromOutbox,
} from "@/lib/weletic/loyalty/historical-import-recovery";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  recover: vi.fn(),
  assert: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  recoverHistoricalImportCommitLeaseInTransaction: mocks.recover,
  assertHistoricalImportExecutionLeaseInTransaction: mocks.assert,
}));
const scope = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  installationGeneration: "generation",
};
const tx = { private: "transaction" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
});
const claim = {
  jobId: "job",
  ownerToken: "owner",
  claimedAt: new Date(),
  attempt: 1,
  sourceRevision: 1,
};
it("binds queue ownership in the same recovery transaction", async () => {
  const recovered = { lease: { ...scope, revision: 2 }, expiresAt: new Date() };
  mocks.recover.mockResolvedValue(recovered);
  await expect(
    recoverHistoricalImportCommitFromOutbox({ scope, claim }),
  ).resolves.toEqual({
    ...recovered,
    lease: { ...recovered.lease, outboxClaim: claim },
  });
  expect(mocks.assert).toHaveBeenCalledWith({
    tx,
    lease: { ...recovered.lease, outboxClaim: claim },
  });
  expect(mocks.recover.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.assert.mock.invocationCallOrder[0],
  );
});
it("aborts recovered ownership when the queue claim is stale", async () => {
  mocks.recover.mockResolvedValue({ lease: { ...scope, revision: 2 } });
  const error = new Error("stale queue claim");
  mocks.assert.mockRejectedValue(error);
  await expect(
    recoverHistoricalImportCommitFromOutbox({ scope, claim }),
  ).rejects.toBe(error);
});
it("rejects incomplete or injected queue claim evidence before any transaction", async () => {
  for (const value of [
    {},
    { ...claim, attempt: 0 },
    { ...claim, claimedAt: "today" },
    { ...claim, storeId: "foreign" },
  ]) {
    await expect(
      recoverHistoricalImportCommitFromOutbox({ scope, claim: value }),
    ).rejects.toThrow();
  }
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("owns a fresh bounded repeatable-read transaction and returns only the checked result", async () => {
  const result = { lease: { private: true }, expiresAt: new Date() };
  mocks.recover.mockResolvedValue(result);
  await expect(recoverHistoricalImportCommit({ scope })).resolves.toBe(result);
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
    timeout: 30000,
  });
  expect(mocks.recover).toHaveBeenCalledWith({ tx, scope });
});
it("propagates recovery failure without retry or swallowing the transaction abort", async () => {
  const error = new Error("source conflict");
  mocks.recover.mockRejectedValue(error);
  await expect(recoverHistoricalImportCommit({ scope })).rejects.toBe(error);
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.recover).toHaveBeenCalledTimes(1);
});
