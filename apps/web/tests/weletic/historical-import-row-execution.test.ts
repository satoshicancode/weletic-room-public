import { executeHistoricalImportRow } from "@/lib/weletic/loyalty/historical-import-row-execution";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lease: vi.fn(),
  enroll: vi.fn(),
  fields: vi.fn(),
  post: vi.fn(),
  reconcile: vi.fn(),
  raw: vi.fn(),
  ledger: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  assertHistoricalImportExecutionLeaseInTransaction: mocks.lease,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-enrollment", () => ({
  enrollHistoricalImportAccountInTransaction: mocks.enroll,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-apply-fields", () => ({
  applyHistoricalImportFieldsInTransaction: mocks.fields,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-ledger", () => ({
  IMPORT_OPENING_BALANCE_REFERENCE: "LOYALTY_IMPORT_OPENING_BALANCE",
  IMPORT_ROLLBACK_REFERENCE: "LOYALTY_IMPORT_ROLLBACK",
  postImportOpeningBalanceInTransaction: mocks.post,
}));
vi.mock(
  "@/lib/weletic/loyalty/historical-import-reconciliation-service",
  () => ({ readHistoricalImportReconciliationInTransaction: mocks.reconcile }),
);
const lease = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  phase: "committing",
};
const account = {
  id: "account",
  storeId: "store",
  programId: "program",
  shopperId: "shopper",
  status: "active",
  ledgerVersion: 4,
  cachedPointsBalance: BigInt(2),
  cachedPendingPoints: BigInt(3),
  lifetimePointsEarned: BigInt(9),
  lifetimePointsRedeemed: BigInt(1),
  metadata: null,
  currentTierId: null,
  tierExpiresAt: null,
  lastQualifyingActivityAt: null,
  nextExpiryDate: null,
  pointsExpiryPolicyVersion: 0,
  pointsExpiryJobsScheduledAt: null,
};
const ledger = {
  id: "ledger",
  storeId: "store",
  accountId: "account",
  sequenceNumber: 5,
  balanceAfter: BigInt("9007199254740995"),
  pointsDelta: BigInt("9007199254740993"),
  pendingDelta: BigInt(0),
  grantId: null,
};
const finalAccount = {
  ...account,
  ledgerVersion: 5,
  cachedPointsBalance: ledger.balanceAfter,
  lastQualifyingActivityAt: new Date("2026-09-09"),
  nextExpiryDate: new Date("2027-09-09"),
  pointsExpiryPolicyVersion: 2,
};
const record = {
  id: "execution",
  snapshotId: "snapshot",
  ...lease,
  accountId: "account",
  status: "committed",
  ledgerEntryId: "ledger",
  reversalLedgerEntryId: null,
  ledgerVersionBefore: 4,
  ledgerVersionAfter: 5,
  committedAt: new Date("2026-09-09"),
  rolledBackAt: null,
  containmentCode: null,
};
const tx = {
  $queryRaw: mocks.raw,
  weleticPointsLedgerEntry: { findFirst: mocks.ledger },
  weleticLoyaltyImportRowExecution: { create: mocks.create },
} as unknown as Prisma.TransactionClient;
const run = () => executeHistoricalImportRow({ lease, snapshotId: "snapshot" });
let records: unknown[];
beforeEach(() => {
  vi.resetAllMocks();
  records = [];
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.lease.mockResolvedValue({
    lease,
    source: { normalizedSha256: "a".repeat(64) },
    now: new Date("2026-09-09"),
  });
  mocks.raw.mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes("WeleticLoyaltyImportRowExecution")
      ? records
      : [finalAccount],
  );
  mocks.ledger.mockResolvedValue(null);
  mocks.enroll.mockResolvedValue({
    account,
    shopper: { id: "shopper" },
    row: { openingBalance: "9007199254740993" },
    balanceAfter: ledger.balanceAfter,
  });
  mocks.fields.mockResolvedValue({
    before: { version: 1 },
    afterFields: { nextExpiryDate: null },
  });
  mocks.post.mockResolvedValue(ledger);
  mocks.reconcile.mockResolvedValue({ reconciled: true });
});
it("composes every row mutation in one owned transaction and captures post-ledger expiry", async () => {
  const result = await run();
  expect(result.replayed).toBe(false);
  expect(mocks.transaction.mock.calls[0][1]).toEqual({
    isolationLevel: "RepeatableRead",
    timeout: 30000,
  });
  for (const method of [mocks.lease, mocks.enroll, mocks.fields, mocks.post])
    expect(method.mock.calls[0][0].tx).toBe(tx);
  const order = [
    mocks.lease,
    mocks.enroll,
    mocks.fields,
    mocks.post,
    mocks.create,
  ].map((method) => method.mock.invocationCallOrder[0]);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(mocks.post.mock.calls[0][0]).toMatchObject({
    openingBalance: ledger.pointsDelta,
    expectedLedgerVersion: 4,
    normalizedSha256: "a".repeat(64),
  });
  expect(mocks.create.mock.calls[0][0].data).toMatchObject({
    sourceId: "source",
    snapshotId: "snapshot",
    ledgerEntryId: "ledger",
    ledgerVersionBefore: 4,
    ledgerVersionAfter: 5,
    fieldStateAfter: {
      nextExpiryDate: "2027-09-09T00:00:00.000Z",
      pointsExpiryPolicyVersion: 2,
    },
  });
});
it("verifies a committed retry without reenrolling or rewriting shopper fields", async () => {
  records = [record];
  mocks.ledger.mockResolvedValue(ledger);
  expect(await run()).toEqual({ executionId: "execution", replayed: true });
  expect(mocks.reconcile).toHaveBeenCalledWith({
    tx,
    sourceId: "source",
    storeId: "store",
    programId: "program",
  });
  expect(mocks.enroll).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
it.each([
  { storeId: "foreign" },
  { programId: "foreign" },
  { sourceId: "foreign" },
  { status: "pending" },
  { status: "contained" },
  { reversalLedgerEntryId: "reversed" },
  { ledgerVersionAfter: 7 },
])(
  "rejects inconsistent execution case %# before mutations",
  async (change) => {
    records = [{ ...record, ...change }];
    await expect(run()).rejects.toThrow("state changed");
    expect(mocks.enroll).not.toHaveBeenCalled();
  },
);
it("rejects a stale or rollback lease before row access", async () => {
  mocks.lease.mockResolvedValue({ lease: { ...lease, phase: "rolling_back" } });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.raw).not.toHaveBeenCalled();
});
it("rejects unclaimed ledger writes instead of adopting them", async () => {
  mocks.ledger.mockResolvedValue({ id: "orphan" });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.enroll).not.toHaveBeenCalled();
});
it.each(["opening_key", "rollback_key", "rollback_reference", "metadata"])(
  "discovers an orphan through its %s marker before mutations",
  async (marker) => {
    mocks.ledger.mockImplementation(async (query) => {
      const predicates = query.where.OR;
      const expected =
        marker === "opening_key"
          ? { idempotencyKey: "loyalty_import_opening:source:snapshot" }
          : marker === "rollback_key"
            ? { idempotencyKey: "loyalty_import_rollback:source:snapshot" }
            : marker === "rollback_reference"
              ? {
                  referenceType: {
                    in: [
                      "LOYALTY_IMPORT_OPENING_BALANCE",
                      "LOYALTY_IMPORT_ROLLBACK",
                    ],
                  },
                  referenceId: "snapshot",
                }
              : {
                  AND: [
                    { metadata: { path: "$.sourceId", equals: "source" } },
                    { metadata: { path: "$.snapshotId", equals: "snapshot" } },
                  ],
                };
      return predicates.some(
        (predicate: unknown) =>
          JSON.stringify(predicate) === JSON.stringify(expected),
      )
        ? { id: "orphan" }
        : null;
    });
    await expect(run()).rejects.toThrow("state changed");
    expect(mocks.enroll).not.toHaveBeenCalled();
  },
);
it("rejects mismatched retry reconciliation and sequence", async () => {
  records = [record];
  mocks.ledger.mockResolvedValue(ledger);
  mocks.reconcile.mockResolvedValue({ reconciled: false });
  await expect(run()).rejects.toThrow("state changed");
  mocks.reconcile.mockResolvedValue({ reconciled: true });
  mocks.ledger.mockResolvedValue({ ...ledger, sequenceNumber: 6 });
  await expect(run()).rejects.toThrow("state changed");
});
it.each(["enroll", "fields", "post", "create"] as const)(
  "propagates %s failure through the owned transaction",
  async (step) => {
    const error = new Error("transaction must abort");
    mocks[step].mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    if (step !== "create") expect(mocks.create).not.toHaveBeenCalled();
  },
);
it("rejects an unexpected ledger result or mutated lifetime totals", async () => {
  mocks.post.mockResolvedValue({ ...ledger, balanceAfter: BigInt(1) });
  await expect(run()).rejects.toThrow("state changed");
  mocks.post.mockResolvedValue(ledger);
  mocks.raw.mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes("WeleticLoyaltyImportRowExecution")
      ? []
      : [{ ...finalAccount, lifetimePointsEarned: BigInt(10) }],
  );
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.create).not.toHaveBeenCalled();
});
