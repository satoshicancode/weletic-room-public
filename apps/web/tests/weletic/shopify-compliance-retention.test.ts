import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customerFindMany: vi.fn(),
  customerDeleteMany: vi.fn(),
  shopFindMany: vi.fn(),
  shopDeleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
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
  beforeEach(() => {
    vi.clearAllMocks();
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
});
