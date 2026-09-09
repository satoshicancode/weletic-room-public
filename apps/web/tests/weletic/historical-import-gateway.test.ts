import {
  prepareShopifyHistoricalImportInTransaction,
  readShopifyImportContextInTransaction,
  readShopifyImportHistoryInTransaction,
  readShopifyImportStatusInTransaction,
  reconcileShopifyHistoricalImportInTransaction,
} from "@/lib/weletic/shopify/historical-imports";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fence: vi.fn(),
  inspect: vi.fn(),
  stage: vi.fn(),
  store: vi.fn(),
  source: vi.fn(),
  program: vi.fn(),
  history: vi.fn(),
  programs: vi.fn(),
  raw: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<object>()),
  authorizeShopifyMerchantInTransaction: mocks.auth,
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock(
  "@/lib/weletic/loyalty/historical-import-reconciliation-service",
  () => ({
    readHistoricalImportReconciliationInTransaction: mocks.reconcile,
  }),
);
vi.mock(
  "@/lib/weletic/loyalty/historical-import-persistence",
  async (original) => ({
    ...(await original<object>()),
    inspectHistoricalImportSourceInTransaction: mocks.inspect,
    stageHistoricalImportInTransaction: mocks.stage,
  }),
);
const actor = {
  storeId: "store",
  projectId: "project",
  installationGeneration: "generation",
  shopifyUserId: "staff",
};
const tx = {
  $queryRaw: mocks.raw,
  weleticShopifyStore: { findUnique: mocks.store },
  weleticLoyaltyImportSource: {
    findFirst: mocks.source,
    findMany: mocks.history,
  },
  weleticLoyaltyProgram: { findFirst: mocks.program, findMany: mocks.programs },
};
const statusRequest = {
  operation: "status",
  sourceId: "source",
  expectedInstallationGeneration: "generation",
};
const history = (before?: { sourceId: string; createdAt: string }) =>
  readShopifyImportHistoryInTransaction({
    tx: tx as unknown as Prisma.TransactionClient,
    envelope: { verified: true },
    request: {
      operation: "history",
      expectedInstallationGeneration: "generation",
      ...(before ? { before } : {}),
    },
  });
const status = () =>
  readShopifyImportStatusInTransaction({
    tx: tx as unknown as Prisma.TransactionClient,
    envelope: { verified: true },
    request: statusRequest,
  });
const bytes = new Uint8Array([1, 2, 3]);
const inspect = {
  operation: "inspect",
  expectedInstallationGeneration: "generation",
  source: { format: "json", sha256: "a".repeat(64) },
};
const stage = {
  ...inspect,
  operation: "stage",
  expectedRevision: "b".repeat(64),
};
const run = (request: unknown) =>
  prepareShopifyHistoricalImportInTransaction({
    tx: tx as unknown as Prisma.TransactionClient,
    envelope: { verified: true },
    request,
    bytes,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(actor);
  mocks.store.mockResolvedValue({ projectId: "project" });
  mocks.inspect.mockResolvedValue({ valid: true });
  mocks.stage.mockResolvedValue({ status: "preview" });
  mocks.program.mockResolvedValue({ id: "program" });
  mocks.programs.mockResolvedValue([{ id: "program" }]);
  mocks.history.mockResolvedValue([]);
  mocks.reconcile.mockResolvedValue({
    sourceStatus: "contained",
    rowCount: 2,
    reconciled: true,
    fullyCommitted: false,
    fullyRolledBack: false,
    issues: [],
    importedPoints: "0",
    reversedPoints: "0",
    expectedNetPoints: "0",
    observedNetPoints: "0",
  });
  mocks.raw.mockImplementation(async () =>
    (await mocks.history()).map((row: { id: string }) => ({ id: row.id })),
  );
  mocks.source.mockResolvedValue({
    id: "source",
    storeId: "store",
    programId: "program",
    installationGeneration: "previous-generation",
    normalizedSha256: "c".repeat(64),
    revision: 3,
    status: "contained",
    rowCount: 2,
    totalOpeningBalance: new Prisma.Decimal("18446744073709551614"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    completedAt: null,
  });
});
it("fences reconciliation to the observed revision and invokes independent evidence checks", async () => {
  const current = await status();
  const result = await reconcileShopifyHistoricalImportInTransaction({
    tx: tx as unknown as Prisma.TransactionClient,
    envelope: { verified: true },
    request: {
      operation: "reconcile",
      sourceId: "source",
      expectedInstallationGeneration: "generation",
      expectedRevision: current.revision,
    },
  });
  expect(mocks.reconcile).toHaveBeenCalledWith({
    tx,
    sourceId: "source",
    storeId: "store",
    programId: "program",
  });
  expect(result).toMatchObject({
    verification: "ledger_provenance",
    reconciled: true,
    fullyCommitted: false,
  });
  expect(result).not.toHaveProperty("sourceStatus");
  expect(mocks.stage).not.toHaveBeenCalled();
});
it("rejects a stale reconciliation revision before reading ledger evidence", async () => {
  await expect(
    reconcileShopifyHistoricalImportInTransaction({
      tx: tx as unknown as Prisma.TransactionClient,
      envelope: {},
      request: {
        operation: "reconcile",
        sourceId: "source",
        expectedInstallationGeneration: "generation",
        expectedRevision: "f".repeat(64),
      },
    }),
  ).rejects.toThrow("state changed");
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
it.each([
  { rowCount: 1 },
  { sourceStatus: "committed" },
  { issues: ["private customer identity"] },
])("rejects inconsistent reconciliation evidence %j", async (change) => {
  const current = await status();
  const evidence = await mocks.reconcile();
  mocks.reconcile.mockResolvedValue({ ...evidence, ...change });
  await expect(
    reconcileShopifyHistoricalImportInTransaction({
      tx: tx as unknown as Prisma.TransactionClient,
      envelope: {},
      request: {
        operation: "reconcile",
        sourceId: "source",
        expectedInstallationGeneration: "generation",
        expectedRevision: current.revision,
      },
    }),
  ).rejects.toThrow();
});
it("returns bounded history with a last-visible-record cursor and exact totals", async () => {
  const source = await mocks.source();
  mocks.history.mockResolvedValue(
    Array.from({ length: 21 }, (_, index) => ({
      ...source,
      id: `source-${String(21 - index).padStart(2, "0")}`,
    })),
  );
  const result = await history();
  expect(result.sources).toHaveLength(20);
  expect(result.nextCursor).toEqual({
    sourceId: "source-02",
    createdAt: source.createdAt.toISOString(),
  });
  expect(result.sources[0].totalOpeningBalance).toBe("18446744073709551614");
  expect(mocks.history).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { storeId: "store", id: { in: expect.any(Array) } },
      take: 21,
    }),
  );
  expect(mocks.raw.mock.calls[0][0].sql).toContain(
    "ORDER BY createdAt DESC, BINARY id DESC",
  );
  expect(mocks.raw.mock.calls[0][0].values).toEqual(["store", 21]);
  expect(mocks.programs).toHaveBeenCalledTimes(1);
  expect(mocks.source).toHaveBeenCalledTimes(1); // Fixture only; no per-row reads.
  expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.history.mock.invocationCallOrder[0],
  );
});
it("applies the cursor within the authenticated store including timestamp ties", async () => {
  const before = { sourceId: "cursor", createdAt: "2026-09-01T00:00:00.000Z" };
  expect(await history(before)).toMatchObject({
    sources: [],
    nextCursor: null,
  });
  expect(mocks.raw.mock.calls[0][0].sql).toContain("BINARY id < BINARY ?");
  expect(mocks.raw.mock.calls[0][0].values).toEqual([
    "store",
    new Date(before.createdAt),
    new Date(before.createdAt),
    "cursor",
    21,
  ]);
  expect(mocks.programs).not.toHaveBeenCalled();
});
it.each(["permission", "generation", "project", "frozen"])(
  "rejects history %s failure before lookup",
  async (kind) => {
    if (kind === "permission")
      mocks.auth.mockRejectedValue(new Error("denied"));
    if (kind === "generation")
      mocks.auth.mockResolvedValue({ ...actor, installationGeneration: "new" });
    if (kind === "project")
      mocks.store.mockResolvedValue({ projectId: "other" });
    if (kind === "frozen") mocks.fence.mockRejectedValue(new Error("frozen"));
    await expect(history()).rejects.toThrow();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  },
);
it("rejects foreign sources or programs instead of leaking partial history", async () => {
  const source = await mocks.source();
  mocks.history.mockResolvedValue([{ ...source, storeId: "other" }]);
  await expect(history()).rejects.toThrow("state changed");
  mocks.history.mockResolvedValue([source]);
  mocks.programs.mockResolvedValue([]);
  await expect(history()).rejects.toThrow("state changed");
});
it("reads owned historical status with exact totals and no shopper or worker data", async () => {
  const result = await status();
  expect(result).toMatchObject({
    storeId: "store",
    installationGeneration: "generation",
    sourceInstallationGeneration: "previous-generation",
    sourceId: "source",
    status: "contained",
    totalOpeningBalance: "18446744073709551614",
    verification: "source_record_only",
  });
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "loyalty.configure" }),
  );
  expect(mocks.source).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "source", storeId: "store" } }),
  );
  expect(mocks.program).toHaveBeenCalledWith({
    where: { id: "program", storeId: "store" },
    select: { id: true },
  });
  expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.source.mock.invocationCallOrder[0],
  );
  expect(JSON.stringify(result)).not.toMatch(
    /normalizedSha256|staff|lease|Customer|birthday/,
  );
  expect(mocks.stage).not.toHaveBeenCalled();
});
it.each(["permission", "project", "generation", "frozen"])(
  "blocks status source access for %s failure",
  async (kind) => {
    if (kind === "permission")
      mocks.auth.mockRejectedValue(new Error("denied"));
    if (kind === "project")
      mocks.store.mockResolvedValue({ projectId: "other" });
    if (kind === "generation")
      mocks.auth.mockResolvedValue({ ...actor, installationGeneration: "new" });
    if (kind === "frozen") mocks.fence.mockRejectedValue(new Error("frozen"));
    await expect(status()).rejects.toThrow();
    expect(mocks.source).not.toHaveBeenCalled();
  },
);
it.each([null, { storeId: "other" }, { id: "other" }])(
  "fails closed for unavailable status source %j",
  async (change) => {
    mocks.source.mockResolvedValue(change);
    await expect(status()).rejects.toThrow("state changed");
    expect(mocks.program).not.toHaveBeenCalled();
  },
);
it("rejects another store's program and malformed persisted totals", async () => {
  mocks.program.mockResolvedValue(null);
  await expect(status()).rejects.toThrow("state changed");
  mocks.program.mockResolvedValue({ id: "program" });
  const original = await mocks.source();
  mocks.source.mockResolvedValue({
    ...original,
    totalOpeningBalance: new Prisma.Decimal("1.5"),
  });
  await expect(status()).rejects.toThrow();
});
it("uses actor-owned scope and forwards the original upload bytes after authorization", async () => {
  expect(await run(inspect)).toMatchObject({
    storeId: "store",
    installationGeneration: "generation",
    valid: true,
  });
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "loyalty.configure" }),
  );
  expect(mocks.inspect).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    installationGeneration: "generation",
    request: inspect,
    bytes,
  });
  expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.inspect.mock.invocationCallOrder[0],
  );
  expect(mocks.stage).not.toHaveBeenCalled();
});
it("bootstraps with exactly the same configure authority as import preparation", async () => {
  expect(
    await readShopifyImportContextInTransaction({
      tx: tx as unknown as Prisma.TransactionClient,
      envelope: { verified: true },
    }),
  ).toEqual({
    storeId: "store",
    installationGeneration: "generation",
    configure: true,
  });
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "loyalty.configure" }),
  );
  expect(mocks.fence).toHaveBeenCalledWith(
    expect.objectContaining({ expectedInstallationGeneration: "generation" }),
  );
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.stage).not.toHaveBeenCalled();
});
it("derives immutable upload staff provenance from the actor", async () => {
  await run(stage);
  expect(mocks.stage).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    installationGeneration: "generation",
    request: stage,
    bytes,
    staffId: "staff",
  });
  expect(mocks.inspect).not.toHaveBeenCalled();
});
it.each(["storeId", "staffId", "rows"])(
  "rejects caller-supplied %s before authorization",
  async (key) => {
    await expect(run({ ...stage, [key]: "forged" })).rejects.toThrow();
    expect(mocks.auth).not.toHaveBeenCalled();
  },
);
it.each(["generation", "project", "permission", "frozen"])(
  "rejects %s failure before source access",
  async (kind) => {
    if (kind === "generation")
      mocks.auth.mockResolvedValue({ ...actor, installationGeneration: "new" });
    if (kind === "project")
      mocks.store.mockResolvedValue({ projectId: "other" });
    if (kind === "permission")
      mocks.auth.mockRejectedValue(new Error("denied"));
    if (kind === "frozen") mocks.fence.mockRejectedValue(new Error("frozen"));
    await expect(run(stage)).rejects.toThrow();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  },
);
