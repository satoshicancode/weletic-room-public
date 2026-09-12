import { queueHistoricalImportCommitInTransaction } from "@/lib/weletic/loyalty/historical-import-dispatch";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  claimHistoricalImportExecutionLeaseInTransaction: mocks.claim,
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
const tx = {} as Prisma.TransactionClient;
const request = {
  storeId: "store",
  programId: "program",
  sourceId: "source",
  installationGeneration: "g1",
  expectedRevision: "a".repeat(64),
};
const lease = {
  ...request,
  phase: "committing",
  revision: 1,
  leaseId: "a65cf016-761c-42b7-8c18-93f73291fc60",
};
const expiresAt = new Date("2026-09-09T00:01:00.000Z");
const run = () => queueHistoricalImportCommitInTransaction({ tx, request });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue({ lease, expiresAt });
  mocks.enqueue.mockResolvedValue({ created: true, job: {} });
});
it("uses the claim transaction, database expiry and reference-only payload", async () => {
  await expect(run()).resolves.toEqual({
    sourceId: "source",
    status: "committing",
  });
  expect(mocks.claim).toHaveBeenCalledWith({
    tx,
    request: { ...request, phase: "committing" },
  });
  expect(mocks.enqueue).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    jobType: "HISTORICAL_IMPORT_COMMIT",
    payload: {
      sourceId: "source",
      programId: "program",
      installationGeneration: "g1",
      sourceRevision: 1,
    },
    scheduledFor: expiresAt,
    idempotencyKey: expect.stringMatching(
      /^historical-import-commit:[a-f0-9]{64}$/,
    ),
  });
  expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.enqueue.mock.invocationCallOrder[0],
  );
  expect(JSON.stringify(mocks.enqueue.mock.calls)).not.toContain(lease.leaseId);
});
it("does not enqueue after failed proof/claim", async () => {
  const error = new Error("proof failed");
  mocks.claim.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("propagates queue failure to abort the caller transaction", async () => {
  const error = new Error("outbox unavailable");
  mocks.enqueue.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
});
it("fails closed on every pre-existing job instead of accepting generic idempotency", async () => {
  mocks.enqueue.mockResolvedValue({
    created: false,
    job: { status: "completed" },
  });
  await expect(run()).rejects.toThrow("state changed");
});
it.each([
  "storeId",
  "programId",
  "sourceId",
  "installationGeneration",
  "revision",
] as const)("separates durable keys when claimed %s changes", async (field) => {
  await run();
  const first = mocks.enqueue.mock.calls[0][0].idempotencyKey;
  mocks.claim.mockResolvedValue({
    lease: { ...lease, [field]: field === "revision" ? 2 : "other" },
    expiresAt,
  });
  await run();
  expect(mocks.enqueue.mock.calls[1][0].idempotencyKey).not.toBe(first);
});
