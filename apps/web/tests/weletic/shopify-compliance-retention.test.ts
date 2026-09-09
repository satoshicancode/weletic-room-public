import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  customerFindMany: vi.fn(),
  customerDeleteMany: vi.fn(),
  shopFindMany: vi.fn(),
  shopDeleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRaw: mocks.executeRaw,
    weleticShopifyCustomerPrivacyTombstone: {
      findMany: mocks.customerFindMany,
      deleteMany: mocks.customerDeleteMany,
    },
    weleticShopifyShopPrivacyTombstone: {
      findMany: mocks.shopFindMany,
      deleteMany: mocks.shopDeleteMany,
    },
  },
}));

import { deleteExpiredShopifyPrivacyTombstonesBatch } from "../../lib/weletic/shopify/compliance-retention";

describe("Shopify privacy tombstone retention", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.executeRaw.mockResolvedValue(0);
    mocks.customerFindMany.mockResolvedValue([]);
    mocks.shopFindMany.mockResolvedValue([]);
    mocks.customerDeleteMany.mockResolvedValue({ count: 0 });
    mocks.shopDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("physically deletes only a bounded page of expired HMAC tombstones", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    mocks.customerFindMany.mockResolvedValue([
      { id: "customer_tomb_1", expiresAt, updatedAt },
    ]);
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop_tomb_1", expiresAt, updatedAt },
    ]);
    mocks.customerDeleteMany.mockResolvedValue({ count: 1 });
    mocks.shopDeleteMany.mockResolvedValue({ count: 1 });
    const now = new Date("2026-08-30T00:00:00.000Z");

    await expect(
      deleteExpiredShopifyPrivacyTombstonesBatch({ batchSize: 1, now }),
    ).resolves.toEqual({
      referralSnapshots: { deleted: 0 },
      customer: { selected: 1, deleted: 1 },
      shop: { selected: 1, deleted: 1 },
    });
    expect(mocks.customerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { expiresAt: { lte: now } }, take: 1 }),
    );
    expect(mocks.customerDeleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
        OR: [{ id: "customer_tomb_1", expiresAt, updatedAt }],
      },
    });
    expect(mocks.shopDeleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
        OR: [{ id: "shop_tomb_1", expiresAt, updatedAt }],
      },
    });
  });

  it("does not delete customer or shop tombstones extended after selection", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const selectedUpdatedAt = new Date("2026-08-29T01:00:00.000Z");
    const now = new Date("2026-08-30T00:00:00.000Z");
    mocks.customerFindMany.mockResolvedValue([
      {
        id: "customer_extended",
        expiresAt,
        updatedAt: selectedUpdatedAt,
      },
    ]);
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop_extended", expiresAt, updatedAt: selectedUpdatedAt },
    ]);
    // A concurrent privacy request extended both rows, so the selected
    // expiry/update generation no longer matches the delete CAS.
    mocks.customerDeleteMany.mockResolvedValue({ count: 0 });
    mocks.shopDeleteMany.mockResolvedValue({ count: 0 });

    await expect(
      deleteExpiredShopifyPrivacyTombstonesBatch({ now }),
    ).resolves.toEqual({
      referralSnapshots: { deleted: 0 },
      customer: { selected: 1, deleted: 0 },
      shop: { selected: 1, deleted: 0 },
    });

    expect(mocks.customerDeleteMany.mock.calls[0][0].where.OR).toEqual([
      {
        id: "customer_extended",
        expiresAt,
        updatedAt: selectedUpdatedAt,
      },
    ]);
    expect(mocks.shopDeleteMany.mock.calls[0][0].where.OR).toEqual([
      { id: "shop_extended", expiresAt, updatedAt: selectedUpdatedAt },
    ]);
  });

  it("atomically removes only the expired snapshot with bounded writes", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS", "30");
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "10");
    mocks.executeRaw.mockResolvedValue(2);
    const result = await deleteExpiredShopifyPrivacyTombstonesBatch({
      batchSize: 999,
      now: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(result.referralSnapshots).toEqual({ deleted: 2 });
    const [strings, ...values] = mocks.executeRaw.mock.calls[0];
    expect(values).toEqual([
      "2026-09-09T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
      100,
    ]);
    const sql = strings.join("?");
    expect(sql).toContain("JSON_REMOVE(metadata, '$.friendPrivacySnapshot')");
    expect(sql).toContain("$.friendPrivacySnapshot.retainUntil");
    expect(sql).toContain("$.friendPrivacySnapshot.capturedAt");
    expect(sql).toContain("JSON_CONTAINS_PATH");
    expect(sql).toContain("<> 'OBJECT', TRUE");
    expect(sql.match(/NOT REGEXP/g)).toHaveLength(2);
    expect(sql.match(/<> 24/g)).toHaveLength(2);
    expect(sql).toContain("ORDER BY id ASC");
    expect(sql).not.toMatch(/DELETE FROM|storeAccessState|status =/);
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.customerFindMany.mock.invocationCallOrder[0],
    );
  });

  it("uses a shortened customer retention policy too", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS", "1");
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "10");
    await deleteExpiredShopifyPrivacyTombstonesBatch({
      batchSize: 0,
      now: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(mocks.executeRaw.mock.calls[0].slice(1)).toEqual([
      "2026-09-09T00:00:00.000Z",
      "2026-09-08T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
      1,
    ]);
  });

  it("does not discard tombstones when snapshot cleanup fails", async () => {
    mocks.executeRaw.mockRejectedValue(new Error("database unavailable"));
    await expect(deleteExpiredShopifyPrivacyTombstonesBatch()).rejects.toThrow(
      "database unavailable",
    );
    expect(mocks.customerDeleteMany).not.toHaveBeenCalled();
    expect(mocks.shopDeleteMany).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects invalid batch size %s",
    async (batchSize) => {
      await expect(
        deleteExpiredShopifyPrivacyTombstonesBatch({ batchSize }),
      ).rejects.toThrow("Invalid privacy retention batch parameters");
      expect(mocks.executeRaw).not.toHaveBeenCalled();
    },
  );
});
