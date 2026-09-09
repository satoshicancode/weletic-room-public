import {
  readHistoricalImportExecutionProofInTransaction,
  readHistoricalImportReconciliationInTransaction,
} from "@/lib/weletic/loyalty/historical-import-reconciliation-service";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/historical-import-integrity", () => ({
  readVerifiedHistoricalImportInTransaction: mocks.read,
  HistoricalImportIntegrityError: class extends Error {},
}));

function fixture() {
  const execution = {
    snapshotId: "snapshot",
    sourceId: "source",
    storeId: "store",
    programId: "program",
    accountId: "account",
    status: "committed",
    ledgerEntryId: "ledger",
    reversalLedgerEntryId: null,
  };
  const entry = {
    id: "ledger",
    storeId: "store",
    accountId: "account",
    sequenceNumber: 1,
    entryType: "MANUAL_ADJUSTMENT",
    referenceType: "LOYALTY_IMPORT_OPENING_BALANCE",
    referenceId: "snapshot",
    pointsDelta: BigInt(10),
    pendingDelta: BigInt(0),
    balanceAfter: BigInt(10),
    grantId: null,
    idempotencyKey: "loyalty_import_opening:source:snapshot",
    metadata: {
      sourceId: "source",
      snapshotId: "snapshot",
      normalizedSha256: "a".repeat(64),
    },
  };
  const tx = {
    weleticShopper: {
      findMany: vi.fn().mockResolvedValue([
        {
          storeId: "store",
          shopifyCustomerId: "123",
          loyaltyAccount: {
            id: "account",
            storeId: "store",
            programId: "program",
          },
        },
      ]),
    },
    weleticLoyaltyImportRowExecution: {
      findMany: vi.fn().mockResolvedValue([execution]),
    },
    weleticPointsLedgerEntry: { findMany: vi.fn().mockResolvedValue([entry]) },
  };
  return {
    execution,
    entry,
    tx,
    run: () =>
      readHistoricalImportReconciliationInTransaction({
        tx: tx as unknown as Prisma.TransactionClient,
        sourceId: "source",
        storeId: "store",
        programId: "program",
      }),
  };
}
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({
    source: { status: "committed", normalizedSha256: "a".repeat(64) },
    snapshots: [
      {
        id: "snapshot",
        openingBalance: BigInt(10),
        shopifyCustomerId: "gid://shopify/Customer/123",
      },
    ],
  });
});
describe("stored import reconciliation", () => {
  it.each([1001, 50_000])(
    "reconciles %i committed rows with bounded queries and linear ownership visits",
    async (count) => {
      const f = fixture();
      let accountReads = 0;
      const points = BigInt("9007199254740993");
      const snapshots = Array.from({ length: count }, (_, index) => ({
        id: `snapshot-${index}`,
        openingBalance: points,
        shopifyCustomerId: `gid://shopify/Customer/${index + 1}`,
      }));
      const executions = snapshots.map((snapshot, index) => ({
        ...f.execution,
        snapshotId: snapshot.id,
        ledgerEntryId: `ledger-${index}`,
        get accountId() {
          accountReads++;
          return `account-${index}`;
        },
      }));
      const entries = snapshots.map((snapshot, index) => ({
        ...f.entry,
        id: `ledger-${index}`,
        accountId: `account-${index}`,
        referenceId: snapshot.id,
        pointsDelta: points,
        balanceAfter: points,
        idempotencyKey: `loyalty_import_opening:source:${snapshot.id}`,
        metadata: { ...f.entry.metadata, snapshotId: snapshot.id },
      }));
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      mocks.read.mockResolvedValue({
        source: { status: "committed", normalizedSha256: "a".repeat(64) },
        snapshots,
      });
      f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue(
        executions,
      );
      f.tx.weleticShopper.findMany.mockImplementation(
        async (query: {
          where: { storeId: string; loyaltyAccount: { id: { in: string[] } } };
        }) => {
          expect(query.where.storeId).toBe("store");
          expect(query.where.loyaltyAccount.id.in.length).toBeLessThanOrEqual(
            1000,
          );
          return query.where.loyaltyAccount.id.in.map((id) => ({
            storeId: "store",
            shopifyCustomerId: String(Number(id.slice("account-".length)) + 1),
            loyaltyAccount: { id, storeId: "store", programId: "program" },
          }));
        },
      );
      f.tx.weleticPointsLedgerEntry.findMany.mockImplementation(
        async (query: {
          where: {
            metadata?: unknown;
            OR?: Array<{
              id?: { in: string[] };
              referenceId?: { in: string[] };
            }>;
          };
        }) => {
          if (query.where.metadata) return entries;
          const clauses = query.where.OR!;
          expect(clauses[0].id!.in.length).toBeLessThanOrEqual(1000);
          expect(clauses[1].referenceId!.in.length).toBeLessThanOrEqual(1000);
          return clauses[0].id!.in.map((id) => byId.get(id)!);
        },
      );
      expect(await f.run()).toMatchObject({
        reconciled: true,
        fullyCommitted: true,
        rowCount: count,
        observedNetPoints: (points * BigInt(count)).toString(),
      });
      expect(f.tx.weleticShopper.findMany).toHaveBeenCalledTimes(
        Math.ceil(count / 1000),
      );
      expect(f.tx.weleticPointsLedgerEntry.findMany).toHaveBeenCalledTimes(
        1 + Math.ceil(count / 1000),
      );
      // Algorithmic bound, not a wall-clock benchmark or database load claim.
      expect(accountReads).toBeLessThanOrEqual(count * 6);
    },
  );
  it("checks every snapshot even when malformed execution rows share an account", async () => {
    const f = fixture();
    mocks.read.mockResolvedValue({
      source: { status: "committed", normalizedSha256: "a".repeat(64) },
      snapshots: [
        {
          id: "snapshot",
          openingBalance: BigInt(10),
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
        {
          id: "snapshot-other",
          openingBalance: BigInt(10),
          shopifyCustomerId: "gid://shopify/Customer/456",
        },
      ],
    });
    f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue([
      f.execution,
      {
        ...f.execution,
        snapshotId: "snapshot-other",
        ledgerEntryId: "ledger-other",
      },
    ]);
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.weleticPointsLedgerEntry.findMany).not.toHaveBeenCalled();
  });
  it("separates completed rows from merchant source completion", async () => {
    const f = fixture();
    mocks.read.mockResolvedValue({
      source: { status: "committing", normalizedSha256: "a".repeat(64) },
      snapshots: [
        {
          id: "snapshot",
          openingBalance: BigInt(10),
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
      ],
    });
    const internal = await readHistoricalImportExecutionProofInTransaction({
      tx: f.tx as unknown as Prisma.TransactionClient,
      sourceId: "source",
      storeId: "store",
      programId: "program",
    });
    expect(internal.rowsFullyCommitted).toBe(true);
    expect(internal.summary.fullyCommitted).toBe(false);
    const merchant = await f.run();
    expect(merchant).not.toHaveProperty("rowsFullyCommitted");
    expect(merchant.fullyCommitted).toBe(false);
  });
  it("bounds reference query lists", async () => {
    const f = fixture();
    mocks.read.mockResolvedValue({
      source: { status: "preview", normalizedSha256: "a".repeat(64) },
      snapshots: Array.from({ length: 2001 }, (_, index) => ({
        id: `snapshot-${index}`,
        openingBalance: BigInt(0),
      })),
    });
    f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue([]);
    f.tx.weleticPointsLedgerEntry.findMany.mockResolvedValue([]);
    expect((await f.run()).reconciled).toBe(true);
    expect(f.tx.weleticPointsLedgerEntry.findMany).toHaveBeenCalledTimes(4);
    for (const [
      query,
    ] of f.tx.weleticPointsLedgerEntry.findMany.mock.calls.slice(1)) {
      expect(query.where.OR[1].referenceId.in.length).toBeLessThanOrEqual(1000);
    }
  });
  it("loads verified source evidence and returns only a summary", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      reconciled: true,
      fullyCommitted: true,
      rowCount: 1,
      observedNetPoints: "10",
    });
    expect(JSON.stringify(result)).not.toMatch(/snapshot|account|Customer/);
    expect(f.tx.weleticPointsLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        where: {
          metadata: { path: "$.sourceId", equals: "source" },
        },
      }),
    );
  });
  it("stops before reading execution or ledger when source verification fails", async () => {
    const f = fixture();
    mocks.read.mockRejectedValue(new Error("unavailable"));
    await expect(f.run()).rejects.toThrow();
    expect(
      f.tx.weleticLoyaltyImportRowExecution.findMany,
    ).not.toHaveBeenCalled();
    expect(f.tx.weleticPointsLedgerEntry.findMany).not.toHaveBeenCalled();
  });
  it.each(["foreign", "orphan", "duplicate"])(
    "rejects %s execution evidence",
    async (kind) => {
      const f = fixture();
      if (kind === "foreign") f.execution.storeId = "other";
      if (kind === "orphan") f.execution.snapshotId = "other";
      if (kind === "duplicate")
        f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue([
          f.execution,
          f.execution,
        ]);
      await expect(f.run()).rejects.toThrow();
      expect(f.tx.weleticPointsLedgerEntry.findMany).not.toHaveBeenCalled();
    },
  );
  it("detects a ledger write lacking an execution claim", async () => {
    const f = fixture();
    f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue([]);
    expect((await f.run()).issues).toContain("unclaimed_ledger_entry");
  });
  it("finds a reference-linked orphan even when its source metadata is absent", async () => {
    const f = fixture();
    f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue([]);
    f.tx.weleticPointsLedgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...f.entry, metadata: {} }]);
    expect((await f.run()).reconciled).toBe(false);
    expect(f.tx.weleticPointsLedgerEntry.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          OR: [
            { id: { in: [] } },
            {
              referenceId: { in: ["snapshot"] },
              referenceType: {
                in: [
                  "LOYALTY_IMPORT_OPENING_BALANCE",
                  "LOYALTY_IMPORT_ROLLBACK",
                ],
              },
            },
          ],
        },
      }),
    );
  });
  it("rejects a claimed ledger entry belonging to another store", async () => {
    const f = fixture();
    f.tx.weleticPointsLedgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...f.entry, storeId: "other" }]);
    await expect(f.run()).rejects.toThrow();
  });
  it("detects an unclaimed foreign write with this source provenance", async () => {
    const f = fixture();
    f.tx.weleticPointsLedgerEntry.findMany.mockResolvedValue([
      f.entry,
      { ...f.entry, id: "foreign-ledger", storeId: "other" },
    ]);
    await expect(f.run()).rejects.toThrow();
  });
  it("fails closed when discovered evidence exceeds two entries per row", async () => {
    const f = fixture();
    f.tx.weleticPointsLedgerEntry.findMany.mockResolvedValue(
      ["one", "two", "three"].map((id) => ({ ...f.entry, id })),
    );
    await expect(f.run()).rejects.toThrow();
  });
  it("does not call partially committed work fully committed", async () => {
    const f = fixture();
    mocks.read.mockResolvedValue({
      source: { status: "committing", normalizedSha256: "a".repeat(64) },
      snapshots: [
        {
          id: "snapshot",
          openingBalance: BigInt(10),
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
      ],
    });
    expect(await f.run()).toMatchObject({
      reconciled: true,
      fullyCommitted: false,
      fullyRolledBack: false,
    });
  });
  it("rejects execution and ledger agreement on the wrong customer account", async () => {
    const f = fixture();
    f.tx.weleticShopper.findMany.mockResolvedValue([
      {
        storeId: "store",
        shopifyCustomerId: "456",
        loyaltyAccount: {
          id: "account",
          storeId: "store",
          programId: "program",
        },
      },
    ]);
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.weleticPointsLedgerEntry.findMany).not.toHaveBeenCalled();
  });
  it("detects a completed source with pending rows", async () => {
    const f = fixture();
    f.tx.weleticLoyaltyImportRowExecution.findMany.mockResolvedValue([]);
    f.tx.weleticPointsLedgerEntry.findMany.mockResolvedValue([]);
    expect(await f.run()).toMatchObject({
      reconciled: false,
      fullyCommitted: false,
      issues: ["source_state_mismatch"],
    });
  });
});
