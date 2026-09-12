import {
  purgeHistoricalImportStoreBatch,
  redactHistoricalImportCustomerBatch,
} from "@/lib/weletic/loyalty/historical-import-privacy";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

function fixture() {
  const snapshots = {
    findMany: vi
      .fn()
      .mockResolvedValue([{ id: "snapshot", sourceId: "source" }]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const executions = {
    findMany: vi
      .fn()
      .mockResolvedValue([
        { id: "execution", sourceId: "source", snapshotId: "snapshot" },
      ]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const sources = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  const tx = {
    weleticLoyaltyImportRowSnapshot: snapshots,
    weleticLoyaltyImportRowExecution: executions,
    weleticLoyaltyImportSource: sources,
  };
  return {
    snapshots,
    executions,
    sources,
    run: (shopifyCustomerId?: string, accountId?: string) =>
      redactHistoricalImportCustomerBatch({
        tx: tx as unknown as Prisma.TransactionClient,
        storeId: "store",
        shopifyCustomerId,
        accountId,
      }),
  };
}
describe("historical import shop erasure", () => {
  function storeFixture() {
    const delegate = () => ({
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    });
    const executions = delegate(),
      snapshots = delegate(),
      sources = delegate();
    const tx = {
      weleticLoyaltyImportRowExecution: executions,
      weleticLoyaltyImportRowSnapshot: snapshots,
      weleticLoyaltyImportSource: sources,
    };
    return {
      executions,
      snapshots,
      sources,
      run: () =>
        purgeHistoricalImportStoreBatch({
          tx: tx as unknown as Prisma.TransactionClient,
          storeId: "store",
        }),
    };
  }
  it.each(["executions", "snapshots", "sources"] as const)(
    "boundedly purges only selected %s",
    async (kind) => {
      const f = storeFixture();
      f[kind].findMany.mockResolvedValue([{ id: "record" }]);
      expect(await f.run()).toEqual({ kind, count: 1 });
      expect(f[kind].findMany).toHaveBeenCalledWith({
        where: { storeId: "store" },
        take: 100,
        orderBy: { id: "asc" },
        select: { id: true },
      });
      expect(f[kind].deleteMany).toHaveBeenCalledWith({
        where: { storeId: "store", id: { in: ["record"] } },
      });
      for (const other of ["executions", "snapshots", "sources"] as const) {
        if (other !== kind) expect(f[other].deleteMany).not.toHaveBeenCalled();
      }
      if (kind === "executions")
        expect(f.snapshots.findMany).not.toHaveBeenCalled();
      if (kind !== "sources") expect(f.sources.findMany).not.toHaveBeenCalled();
    },
  );
  it("reports completion only after every collection is empty", async () => {
    const f = storeFixture();
    expect(await f.run()).toEqual({ kind: "completed", count: 0 });
    expect(f.sources.findMany).toHaveBeenCalledOnce();
    expect(f.sources.deleteMany).not.toHaveBeenCalled();
  });
  it("fails closed on partial deletion instead of reporting progress", async () => {
    const f = storeFixture();
    f.executions.findMany.mockResolvedValue([{ id: "record" }]);
    f.executions.deleteMany.mockResolvedValue({ count: 0 });
    await expect(f.run()).rejects.toThrow("cleanup conflict");
    expect(f.snapshots.findMany).not.toHaveBeenCalled();
  });
});

describe("historical import customer erasure", () => {
  it.each(["42", "gid://shopify/Customer/42"])(
    "contains and scrubs %s without ledger mutation",
    async (id) => {
      const f = fixture();
      expect(await f.run(id, "account")).toEqual({
        snapshotsRedacted: 1,
        executionsRedacted: 1,
      });
      expect(f.snapshots.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          where: {
            storeId: "store",
            shopifyCustomerId: { in: ["42", "gid://shopify/Customer/42"] },
            redactedAt: null,
          },
        }),
      );
      expect(f.sources.updateMany).toHaveBeenCalledWith({
        where: { id: "source", storeId: "store" },
        data: {
          status: "contained",
          revision: { increment: 1 },
          leaseId: null,
          leaseExpiresAt: null,
        },
      });
      expect(f.sources.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        f.snapshots.updateMany.mock.invocationCallOrder[0],
      );
      expect(f.snapshots.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            shopifyCustomerId: "redacted:snapshot",
            birthdayMonth: null,
            birthdayDay: null,
            tierId: null,
            redactedAt: expect.any(Date),
          },
        }),
      );
      expect(f.executions.updateMany).toHaveBeenCalledWith({
        where: { storeId: "store", id: { in: ["execution"] } },
        data: {
          fieldStateBefore: Prisma.DbNull,
          fieldStateAfter: Prisma.DbNull,
          status: "contained",
          containmentCode: "privacy_redacted",
        },
      });
    },
  );
  it("finds pending executions whose nullable containment code is unset", async () => {
    const f = fixture();
    await f.run(undefined, "account");
    expect(f.snapshots.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store", id: { in: ["snapshot"] }, redactedAt: null },
      }),
    );
    expect(f.executions.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store",
          AND: [
            { OR: [{ accountId: "account" }] },
            {
              OR: [
                { containmentCode: null },
                { containmentCode: { not: "privacy_redacted" } },
              ],
            },
          ],
        },
      }),
    );
  });
  it("does not query without an exact owner", async () => {
    const f = fixture();
    expect(await f.run("not-a-customer")).toEqual({
      snapshotsRedacted: 0,
      executionsRedacted: 0,
    });
    expect(f.snapshots.findMany).not.toHaveBeenCalled();
    expect(f.executions.findMany).not.toHaveBeenCalled();
    expect(f.sources.updateMany).not.toHaveBeenCalled();
  });
  it("scrubs account-linked snapshots before execution completion and then converges", async () => {
    const f = fixture();
    expect(await f.run(undefined, "account")).toEqual({
      snapshotsRedacted: 1,
      executionsRedacted: 1,
    });
    expect(f.snapshots.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      f.executions.updateMany.mock.invocationCallOrder[0],
    );
    f.executions.findMany.mockResolvedValue([]);
    expect(await f.run(undefined, "account")).toEqual({
      snapshotsRedacted: 0,
      executionsRedacted: 0,
    });
    expect(f.snapshots.updateMany).toHaveBeenCalledTimes(1);
    expect(f.executions.updateMany).toHaveBeenCalledTimes(1);
  });
  it("makes no writes once eligible rows are exhausted", async () => {
    const f = fixture();
    f.snapshots.findMany.mockResolvedValue([]);
    f.executions.findMany.mockResolvedValue([]);
    expect(await f.run("42", "account")).toEqual({
      snapshotsRedacted: 0,
      executionsRedacted: 0,
    });
    expect(f.sources.updateMany).not.toHaveBeenCalled();
    expect(f.executions.updateMany).not.toHaveBeenCalled();
  });
  it("does not scrub fields when source containment fails", async () => {
    const f = fixture();
    f.sources.updateMany.mockRejectedValue(new Error("database failure"));
    await expect(f.run("42")).rejects.toThrow("database failure");
    expect(f.snapshots.updateMany).not.toHaveBeenCalled();
    expect(f.executions.updateMany).not.toHaveBeenCalled();
  });
});
