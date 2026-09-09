import {
  historicalImportRevision,
  inspectHistoricalImportSourceInTransaction,
  stageHistoricalImportInTransaction,
} from "@/lib/weletic/loyalty/historical-import-persistence";
import { parseHistoricalImportSource } from "@/lib/weletic/loyalty/historical-import-source";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lock: vi.fn(), preview: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRow: mocks.lock,
}));
vi.mock("@/lib/weletic/loyalty/historical-import-preview", () => ({
  inspectHistoricalImportPreview: mocks.preview,
}));

function fixture() {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      {
        shopifyCustomerId: "gid://shopify/Customer/123",
        openingBalance: "9007199254740993",
        birthday: { month: 2, day: 29 },
      },
    ]),
  );
  const source = {
    format: "json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const parsed = parseHistoricalImportSource({ bytes, source });
  const request = {
    operation: "stage",
    expectedInstallationGeneration: "generation",
    expectedRevision: historicalImportRevision({
      storeId: "store",
      programId: "program",
      installationGeneration: "generation",
      normalizedSha256: parsed.normalizedSha256,
      source: null,
    }),
    source,
  };
  const tx = {
    weleticLoyaltyImportSource: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => data),
    },
    weleticLoyaltyImportRowSnapshot: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    bytes,
    source,
    parsed,
    request,
    tx,
    run: () =>
      stageHistoricalImportInTransaction({
        tx: tx as unknown as Prisma.TransactionClient,
        storeId: "store",
        installationGeneration: "generation",
        staffId: "staff",
        request,
        bytes,
      }),
  };
}
beforeEach(() => {
  mocks.lock.mockReset().mockResolvedValue({ id: "program", storeId: "store" });
  mocks.preview.mockReset().mockResolvedValue({ valid: true });
});
describe("historical import staging", () => {
  it("refuses to persist a source when authoritative preview finds a birthday conflict", async () => {
    const f = fixture();
    mocks.preview.mockResolvedValue({
      valid: false,
      rows: [
        {
          rowNumber: 1,
          issues: ["birthday_conflict"],
          wouldEnroll: false,
          balanceBefore: null,
          balanceAfter: null,
        },
      ],
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.weleticLoyaltyImportSource.create).not.toHaveBeenCalled();
    expect(
      f.tx.weleticLoyaltyImportRowSnapshot.createMany,
    ).not.toHaveBeenCalled();
  });
  it("prepares a byte-derived preview and the exact revision accepted by staging", async () => {
    const f = fixture();
    mocks.preview.mockResolvedValue({
      valid: true,
      rows: [
        {
          rowNumber: 1,
          issues: [],
          wouldEnroll: false,
          balanceBefore: "0",
          balanceAfter: "9007199254740993",
        },
      ],
    });
    const result = await inspectHistoricalImportSourceInTransaction({
      tx: f.tx as unknown as Prisma.TransactionClient,
      storeId: "store",
      installationGeneration: "generation",
      request: {
        operation: "inspect",
        expectedInstallationGeneration: "generation",
        source: f.source,
      },
      bytes: f.bytes,
    });
    expect(result).toMatchObject({
      revision: f.request.expectedRevision,
      valid: true,
      rowCount: 1,
      totalOpeningBalance: "9007199254740993",
    });
    expect(JSON.stringify(result)).not.toMatch(/Customer|birthday|staff/);
    expect(f.tx.weleticLoyaltyImportSource.create).not.toHaveBeenCalled();
    expect(
      f.tx.weleticLoyaltyImportRowSnapshot.createMany,
    ).not.toHaveBeenCalled();
    await expect(f.run()).resolves.toMatchObject({ status: "preview" });
  });
  it("preserves global row numbers across preview batches", async () => {
    const f = fixture();
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        Array.from({ length: 1001 }, (_, index) => ({
          shopifyCustomerId: `gid://shopify/Customer/${index + 1}`,
          openingBalance: "0",
        })),
      ),
    );
    mocks.preview.mockImplementation(async ({ request }) => ({
      valid: true,
      rows: request.rows.map((_: unknown, index: number) => ({
        rowNumber: index + 1,
        issues: [],
        wouldEnroll: true,
        balanceBefore: "0",
        balanceAfter: "0",
      })),
    }));
    const result = await inspectHistoricalImportSourceInTransaction({
      tx: f.tx as unknown as Prisma.TransactionClient,
      storeId: "store",
      installationGeneration: "generation",
      request: {
        operation: "inspect",
        expectedInstallationGeneration: "generation",
        source: {
          format: "json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
      bytes,
    });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(result.rows[1000].rowNumber).toBe(1001);
  });
  it("rejects stale-generation inspection before any database access", async () => {
    const f = fixture();
    await expect(
      inspectHistoricalImportSourceInTransaction({
        tx: f.tx as unknown as Prisma.TransactionClient,
        storeId: "store",
        installationGeneration: "generation",
        request: {
          operation: "inspect",
          expectedInstallationGeneration: "old",
          source: f.source,
        },
        bytes: f.bytes,
      }),
    ).rejects.toThrow("state changed");
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("stores byte-derived provenance and exact rows without ledger or account writes", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.status).toBe("preview");
    expect(result.revision).not.toBe(f.request.expectedRevision);
    expect(f.tx.weleticLoyaltyImportSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceSha256: f.source.sha256,
        normalizedSha256: f.parsed.normalizedSha256,
        createdByStaffId: "staff",
        totalOpeningBalance: "9007199254740993",
      }),
    });
    expect(
      f.tx.weleticLoyaltyImportRowSnapshot.createMany,
    ).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          storeId: "store",
          programId: "program",
          rowNumber: 1,
          openingBalance: BigInt("9007199254740993"),
          birthdayMonth: 2,
          birthdayDay: 29,
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Customer");
  });
  it("rejects stale installation before locking or writing", async () => {
    const f = fixture();
    f.request.expectedInstallationGeneration = "old";
    await expect(f.run()).rejects.toThrow("state changed");
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("rejects a stale revision before storing rows", async () => {
    const f = fixture();
    f.request.expectedRevision = "0".repeat(64);
    await expect(f.run()).rejects.toThrow("state changed");
    expect(f.tx.weleticLoyaltyImportSource.create).not.toHaveBeenCalled();
  });
  it("does not overwrite a prior upload", async () => {
    const f = fixture();
    f.tx.weleticLoyaltyImportSource.findUnique.mockResolvedValue({
      id: "old",
      revision: 0,
      status: "preview",
      installationGeneration: "generation",
    });
    await expect(f.run()).rejects.toThrow("state changed");
    expect(f.tx.weleticLoyaltyImportSource.create).not.toHaveBeenCalled();
  });
  it("rejects unavailable or privacy-excluded rows before persistence", async () => {
    const f = fixture();
    mocks.preview.mockResolvedValue({ valid: false });
    await expect(f.run()).rejects.toThrow("unavailable rows");
    expect(f.tx.weleticLoyaltyImportSource.create).not.toHaveBeenCalled();
  });
  it("propagates incomplete snapshot writes so the caller rolls back", async () => {
    const f = fixture();
    f.tx.weleticLoyaltyImportRowSnapshot.createMany.mockResolvedValue({
      count: 0,
    });
    await expect(f.run()).rejects.toThrow("snapshot incomplete");
  });
  it("rejects extra browser-provided rows in a stage request", async () => {
    const f = fixture();
    Object.assign(f.request, { rows: [] });
    await expect(f.run()).rejects.toThrow();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("binds revision to tenant, program and installation", () => {
    const data = {
      storeId: "store",
      programId: "program",
      installationGeneration: "generation",
      normalizedSha256: "a".repeat(64),
      source: null,
    };
    for (const key of [
      "storeId",
      "programId",
      "installationGeneration",
    ] as const) {
      expect(historicalImportRevision({ ...data, [key]: "other" })).not.toBe(
        historicalImportRevision(data),
      );
    }
  });
});
