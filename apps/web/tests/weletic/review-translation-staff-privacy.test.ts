import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { purgeShopifyStaffPrivacyBatch } from "../../lib/weletic/shopify/staff-privacy";

describe("translation staff actor erasure", () => {
  it("scrubs an exact-store bounded page while preserving revision/audit identity", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "audit-1" }])
      .mockResolvedValue([]);
    const updateMany = vi.fn();
    const tx = {
      weleticShopifyStaffGrant: { findMany: vi.fn().mockResolvedValue([]) },
      weleticShopifyMerchantAction: { findMany: vi.fn().mockResolvedValue([]) },
      weleticReviewTranslationAudit: { findMany, updateMany },
      weleticShopifyFlowPointsGrant: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-1")).resolves.toEqual(
      { pending: true },
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { storeId: "store-1", actorShopifyUserId: { not: null } },
      orderBy: { id: "asc" },
      select: { id: true },
      take: 100,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { storeId: "store-1", id: { in: ["audit-1"] } },
      data: { actorShopifyUserId: null, staffRedactedAt: expect.any(Date) },
    });
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-1")).resolves.toEqual(
      { pending: false },
    );
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
