import { discoverHistoricalImportCommitRecovery } from "@/lib/weletic/loyalty/historical-import-recovery-discovery";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  store: vi.fn(),
  program: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.store,
}));
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRow: mocks.program,
}));
const scope = {
  storeId: "store",
  programId: "program",
  installationGeneration: "g1",
};
const now = new Date("2026-09-09T00:00:00Z");
const candidate = (id = "source-a") => ({
  id,
  ...scope,
  status: "committing",
  leaseExpiresAt: now,
});
const tx = { $queryRaw: mocks.raw };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.program.mockResolvedValue({ id: "program", storeId: "store" });
  mocks.raw.mockResolvedValueOnce([{ now }]).mockResolvedValue([candidate()]);
});
it("fences store/program before a database-clock bounded exact-scope read", async () => {
  await expect(discoverHistoricalImportCommitRecovery(scope)).resolves.toEqual({
    candidates: [{ ...scope, sourceId: "source-a" }],
    nextCursor: null,
  });
  expect(mocks.store).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    expectedInstallationGeneration: "g1",
    action: "loyalty_import_recovery_discovery",
  });
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
    timeout: 30000,
  });
  const query = mocks.raw.mock.calls[1][0] as Prisma.Sql;
  expect(query.values).toEqual(["store", "program", "g1", now, 11]);
  expect(query.sql).toContain("status = 'committing' AND leaseId IS NOT NULL");
  expect(query.sql).toContain("leaseExpiresAt <= ?");
  const order = [mocks.store, mocks.program, mocks.raw].map(
    (fn) => fn.mock.invocationCallOrder[0],
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
});
it("paginates with binary IDs and hides the extra candidate and private fields", async () => {
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValue([candidate("b"), candidate("c")]);
  await expect(
    discoverHistoricalImportCommitRecovery({
      ...scope,
      afterSourceId: "a",
      limit: 1,
    }),
  ).resolves.toEqual({
    candidates: [{ ...scope, sourceId: "b" }],
    nextCursor: "b",
  });
  const query = mocks.raw.mock.calls[1][0] as Prisma.Sql;
  expect(query.sql).toContain("BINARY id > BINARY ?");
  expect(query.values).toEqual(["store", "program", "g1", now, "a", 2]);
});
it.each([
  { storeId: "foreign" },
  { programId: "foreign" },
  { installationGeneration: "stale" },
  { status: "preview" },
  { leaseExpiresAt: new Date(now.getTime() + 1) },
  { leaseExpiresAt: new Date("invalid") },
])("rejects malformed or foreign candidate %#", async (change) => {
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValue([{ ...candidate(), ...change }]);
  await expect(discoverHistoricalImportCommitRecovery(scope)).rejects.toThrow(
    "state changed",
  );
});
it.each([
  { rows: [candidate("b"), candidate("a")] },
  { rows: [candidate("a"), candidate("a")] },
])("rejects non-increasing or duplicate IDs", async ({ rows }) => {
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValue(rows);
  await expect(discoverHistoricalImportCommitRecovery(scope)).rejects.toThrow(
    "state changed",
  );
});
it("rejects a cursor regression and an overlarge database result", async () => {
  await expect(
    discoverHistoricalImportCommitRecovery({ ...scope, afterSourceId: "z" }),
  ).rejects.toThrow("state changed");
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValue([candidate("a"), candidate("b"), candidate("c")]);
  await expect(
    discoverHistoricalImportCommitRecovery({ ...scope, limit: 1 }),
  ).rejects.toThrow("state changed");
});
it("returns an empty terminal page", async () => {
  mocks.raw.mockReset().mockResolvedValueOnce([{ now }]).mockResolvedValue([]);
  await expect(discoverHistoricalImportCommitRecovery(scope)).resolves.toEqual({
    candidates: [],
    nextCursor: null,
  });
});
it("fails before discovery for an inactive store or foreign program", async () => {
  mocks.store.mockRejectedValueOnce(new Error("frozen"));
  await expect(discoverHistoricalImportCommitRecovery(scope)).rejects.toThrow(
    "frozen",
  );
  mocks.program.mockResolvedValue({ id: "foreign", storeId: "store" });
  await expect(discoverHistoricalImportCommitRecovery(scope)).rejects.toThrow(
    "state changed",
  );
  expect(mocks.raw).not.toHaveBeenCalled();
});
it.each([
  { limit: 0 },
  { limit: 26 },
  { installationGeneration: "" },
  { phase: "rolling_back" },
  { afterSourceId: "" },
])("rejects invalid input before opening a transaction %#", async (change) => {
  await expect(
    discoverHistoricalImportCommitRecovery({ ...scope, ...change }),
  ).rejects.toThrow();
  expect(mocks.transaction).not.toHaveBeenCalled();
});
