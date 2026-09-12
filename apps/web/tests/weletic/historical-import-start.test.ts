import {
  startShopifyHistoricalImportCommit,
  startShopifyHistoricalImportRollback,
} from "@/lib/weletic/shopify/historical-import-start";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auth: vi.fn(),
  program: vi.fn(),
  claim: vi.fn(),
  rollback: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.auth,
}));
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRow: mocks.program,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-dispatch", () => ({
  queueHistoricalImportCommitInTransaction: mocks.claim,
  queueHistoricalImportRollbackInTransaction: mocks.rollback,
}));
const request = {
  operation: "commit",
  sourceId: "source",
  expectedInstallationGeneration: "generation",
  expectedRevision: "a".repeat(64),
};
const envelope = { private: "signed actor" };
const tx = { $queryRaw: mocks.raw };
const run = () => startShopifyHistoricalImportCommit({ request, envelope });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.auth.mockResolvedValue({
    storeId: "store",
    installationGeneration: "generation",
  });
  mocks.program.mockResolvedValue({ id: "program", storeId: "store" });
  mocks.raw.mockResolvedValue([{ status: "preview" }]);
  mocks.claim.mockResolvedValue({ sourceId: "source", status: "committing" });
});
it("owns a fresh transaction and authorizes before scoped source proof/claim", async () => {
  await run();
  expect(mocks.transaction.mock.calls[0][1]).toEqual({
    isolationLevel: "RepeatableRead",
    timeout: 30000,
  });
  expect(mocks.auth).toHaveBeenCalledWith({
    tx,
    envelope,
    permission: "loyalty.configure",
  });
  const order = [mocks.auth, mocks.program, mocks.raw, mocks.claim].map(
    (method) => method.mock.invocationCallOrder[0],
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(mocks.raw.mock.calls[0][0].values).toEqual([
    "source",
    "store",
    "program",
  ]);
  expect(mocks.claim).toHaveBeenCalledWith({
    tx,
    request: {
      sourceId: "source",
      storeId: "store",
      programId: "program",
      installationGeneration: "generation",
      expectedRevision: request.expectedRevision,
    },
  });
});
it("authorizes rollback of a committed source and dispatches its distinct job in the same transaction", async () => {
  mocks.raw.mockResolvedValue([{ status: "committed" }]);
  mocks.rollback.mockResolvedValue({
    sourceId: "source",
    status: "rolling_back",
  });
  await expect(
    startShopifyHistoricalImportRollback({
      envelope,
      request: { ...request, operation: "rollback" },
    }),
  ).resolves.toEqual({
    sourceId: "source",
    status: "rolling_back",
    operation: "rollback",
    storeId: "store",
    installationGeneration: "generation",
  });
  expect(mocks.auth).toHaveBeenCalledWith({
    tx,
    envelope,
    permission: "loyalty.configure",
  });
  expect(mocks.rollback).toHaveBeenCalledWith({
    tx,
    request: {
      sourceId: "source",
      storeId: "store",
      programId: "program",
      installationGeneration: "generation",
      expectedRevision: request.expectedRevision,
    },
  });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it.each([
  "preview",
  "committing",
  "rolling_back",
  "rolled_back",
  "contained",
  "cancelled",
])("rejects rollback start from %s", async (status) => {
  mocks.raw.mockResolvedValue([{ status }]);
  await expect(
    startShopifyHistoricalImportRollback({
      envelope,
      request: { ...request, operation: "rollback" },
    }),
  ).rejects.toThrow("state changed");
  expect(mocks.rollback).not.toHaveBeenCalled();
});
it("returns only public state from atomic dispatch", async () => {
  await expect(run()).resolves.toEqual({
    sourceId: "source",
    status: "committing",
    operation: "commit",
    storeId: "store",
    installationGeneration: "generation",
  });
});
it("rejects generations outside the durable job contract before opening a transaction", async () => {
  await expect(
    startShopifyHistoricalImportCommit({
      envelope,
      request: { ...request, expectedInstallationGeneration: "x".repeat(65) },
    }),
  ).rejects.toThrow();
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("does not claim after permission denial or installation mismatch", async () => {
  const error = new Error("access denied");
  mocks.auth.mockRejectedValueOnce(error);
  await expect(run()).rejects.toBe(error);
  mocks.auth.mockResolvedValue({
    storeId: "store",
    installationGeneration: "new",
  });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.claim).not.toHaveBeenCalled();
});
it.each([
  "committing",
  "committed",
  "rolling_back",
  "rolled_back",
  "contained",
  "cancelled",
])(
  "rejects %s sources rather than performing worker recovery",
  async (status) => {
    mocks.raw.mockResolvedValue([{ status }]);
    await expect(run()).rejects.toThrow("state changed");
    expect(mocks.claim).not.toHaveBeenCalled();
  },
);
it("rejects missing source and foreign program scope", async () => {
  mocks.raw.mockResolvedValue([]);
  await expect(run()).rejects.toThrow("state changed");
  mocks.program.mockResolvedValue({ id: "program", storeId: "foreign" });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("rejects injected scope and rollback operations before any transaction", async () => {
  await expect(
    startShopifyHistoricalImportCommit({
      envelope,
      request: { ...request, storeId: "foreign" },
    }),
  ).rejects.toThrow();
  await expect(
    startShopifyHistoricalImportCommit({
      envelope,
      request: { ...request, operation: "rollback" },
    }),
  ).rejects.toThrow();
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("propagates claim failure so the actor action and source changes roll back", async () => {
  const error = new Error("manifest unavailable");
  mocks.claim.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
});
