import {
  readVerifiedHistoricalImportInTransaction,
  verifyHistoricalImportSnapshots,
} from "@/lib/weletic/loyalty/historical-import-integrity";
import { proveHistoricalImportRows } from "@/lib/weletic/loyalty/historical-import-source";
import {
  Prisma,
  type WeleticLoyaltyImportRowSnapshot,
  type WeleticLoyaltyImportSource,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

function fixture() {
  const proof = proveHistoricalImportRows([
    {
      shopifyCustomerId: "gid://shopify/Customer/123",
      openingBalance: "9007199254740993",
      birthday: { month: 2, day: 29 },
      tierId: "tier",
    },
  ]);
  const now = new Date();
  const source: WeleticLoyaltyImportSource = {
    id: "source",
    storeId: "store",
    programId: "program",
    installationGeneration: "generation",
    sourceSha256: "b".repeat(64),
    normalizedSha256: proof.normalizedSha256,
    sourceFormat: "json",
    sourceVersion: 1,
    rowCount: 1,
    totalOpeningBalance: new Prisma.Decimal(proof.totalOpeningBalance),
    createdByStaffId: "staff",
    status: "preview",
    revision: 0,
    leaseId: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  const snapshots: WeleticLoyaltyImportRowSnapshot[] = [
    {
      id: "snapshot",
      sourceId: "source",
      storeId: "store",
      programId: "program",
      rowNumber: 1,
      shopifyCustomerId: "gid://shopify/Customer/123",
      openingBalance: BigInt("9007199254740993"),
      birthdayMonth: 2,
      birthdayDay: 29,
      tierId: "tier",
      createdAt: now,
      redactedAt: null,
    },
  ];
  return { source, snapshots, storeId: "store", programId: "program" };
}
describe("historical import snapshot integrity", () => {
  it("reconstructs the upload's exact canonical evidence", () => {
    const data = fixture();
    expect(verifyHistoricalImportSnapshots(data).normalizedSha256).toBe(
      data.source.normalizedSha256,
    );
    expect(verifyHistoricalImportSnapshots(data).totalOpeningBalance).toBe(
      "9007199254740993",
    );
  });
  it.each([
    { storeId: "other" },
    { programId: "other" },
    { sourceVersion: 2 },
    { rowCount: 2 },
    { normalizedSha256: "0".repeat(64) },
    { sourceFormat: "xml" },
    { totalOpeningBalance: new Prisma.Decimal("1.5") },
  ])("rejects corrupted source %j", (change) => {
    const data = fixture();
    Object.assign(data.source, change);
    expect(() => verifyHistoricalImportSnapshots(data)).toThrow(
      "evidence is unavailable or inconsistent",
    );
  });
  it.each([
    { storeId: "other" },
    { programId: "other" },
    { sourceId: "other" },
    { rowNumber: 2 },
    { redactedAt: new Date() },
    { openingBalance: BigInt(1) },
    { birthdayDay: 28 },
    { birthdayDay: null },
    { tierId: "other" },
    { shopifyCustomerId: "gid://shopify/Customer/456" },
  ])("rejects altered snapshot case %#", (change) => {
    const data = fixture();
    Object.assign(data.snapshots[0], change);
    expect(() => verifyHistoricalImportSnapshots(data)).toThrow(
      "evidence is unavailable or inconsistent",
    );
  });
  it("rejects missing or additional rows", () => {
    const data = fixture();
    expect(() =>
      verifyHistoricalImportSnapshots({ ...data, snapshots: [] }),
    ).toThrow();
    expect(() =>
      verifyHistoricalImportSnapshots({
        ...data,
        snapshots: [...data.snapshots, data.snapshots[0]],
      }),
    ).toThrow();
  });
  it.each(["snapshot_id", "customer_id", "row_number"])(
    "rejects duplicate %s even when row counts match",
    (kind) => {
      const data = fixture();
      data.source.rowCount = 2;
      data.snapshots.push({
        ...data.snapshots[0],
        id: "second",
        rowNumber: 2,
        shopifyCustomerId: "gid://shopify/Customer/456",
      });
      if (kind === "snapshot_id") data.snapshots[1].id = data.snapshots[0].id;
      if (kind === "customer_id")
        data.snapshots[1].shopifyCustomerId =
          data.snapshots[0].shopifyCustomerId;
      if (kind === "row_number") data.snapshots[1].rowNumber = 1;
      expect(() => verifyHistoricalImportSnapshots(data)).toThrow(
        "evidence is unavailable or inconsistent",
      );
    },
  );
  it("loads bounded source rows only after proving source ownership", async () => {
    const data = fixture();
    const tx = {
      weleticLoyaltyImportSource: {
        findFirst: vi.fn().mockResolvedValue(data.source),
      },
      weleticLoyaltyImportRowSnapshot: {
        findMany: vi.fn().mockResolvedValue(data.snapshots),
      },
    };
    const result = await readVerifiedHistoricalImportInTransaction({
      tx: tx as unknown as Prisma.TransactionClient,
      sourceId: "source",
      storeId: "store",
      programId: "program",
    });
    expect(result.proof.totalOpeningBalance).toBe("9007199254740993");
    expect(tx.weleticLoyaltyImportSource.findFirst).toHaveBeenCalledWith({
      where: { id: "source", storeId: "store", programId: "program" },
    });
    expect(tx.weleticLoyaltyImportRowSnapshot.findMany).toHaveBeenCalledWith({
      where: { sourceId: "source" },
      orderBy: { rowNumber: "asc" },
      take: 50001,
    });
    tx.weleticLoyaltyImportSource.findFirst.mockResolvedValue(null);
    tx.weleticLoyaltyImportRowSnapshot.findMany.mockClear();
    await expect(
      readVerifiedHistoricalImportInTransaction({
        tx: tx as unknown as Prisma.TransactionClient,
        sourceId: "source",
        storeId: "store",
        programId: "program",
      }),
    ).rejects.toThrow();
    expect(tx.weleticLoyaltyImportRowSnapshot.findMany).not.toHaveBeenCalled();
  });
});
