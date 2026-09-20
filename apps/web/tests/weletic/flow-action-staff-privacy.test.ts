import { purgeShopifyStaffPrivacyBatch } from "@/lib/weletic/shopify/staff-privacy";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

function fixture(ids: string[]) {
  const staff = {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn(),
  };
  const actions = {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn(),
  };
  const automation = {
    findMany: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    updateMany: vi.fn().mockResolvedValue({ count: ids.length }),
  };
  const tx = {
    weleticShopifyStaffGrant: staff,
    weleticShopifyMerchantAction: actions,
    weleticShopifyFlowPointsGrant: automation,
  } as unknown as Prisma.TransactionClient;
  return { tx, automation };
}

describe("Flow grant staff privacy retention", () => {
  it("redacts only bounded exact-store actor fields and retains financial authority", async () => {
    const { tx, automation } = fixture(["grant-a", "grant-b"]);
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-a")).resolves.toEqual(
      {
        pending: true,
      },
    );
    expect(automation.findMany).toHaveBeenCalledWith({
      where: {
        storeId: "store-a",
        OR: [
          { approvedByShopifyUserId: { not: null } },
          { revokedByShopifyUserId: { not: null } },
        ],
      },
      orderBy: { id: "asc" },
      select: { id: true },
      take: 100,
    });
    expect(automation.updateMany).toHaveBeenCalledWith({
      where: { storeId: "store-a", id: { in: ["grant-a", "grant-b"] } },
      data: {
        approvedByShopifyUserId: null,
        revokedByShopifyUserId: null,
        staffRedactedAt: expect.any(Date),
      },
    });
  });

  it("requires an empty reread even after a full page", async () => {
    const { tx, automation } = fixture(
      Array.from({ length: 100 }, (_, index) => `grant-${index}`),
    );
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-a")).resolves.toEqual(
      {
        pending: true,
      },
    );
    automation.findMany.mockResolvedValueOnce([]);
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-a")).resolves.toEqual(
      {
        pending: false,
      },
    );
    expect(automation.updateMany).toHaveBeenCalledTimes(1);
  });

  it("propagates erasure failure so the caller cannot finalize privacy", async () => {
    const { tx, automation } = fixture(["grant-a"]);
    automation.updateMany.mockRejectedValueOnce(new Error("synthetic failure"));
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-a")).rejects.toThrow(
      "synthetic failure",
    );
  });

  it("never treats an unavailable grant table as completed cleanup", async () => {
    const { tx, automation } = fixture([]);
    automation.findMany.mockRejectedValueOnce(new Error("table unavailable"));
    await expect(purgeShopifyStaffPrivacyBatch(tx, "store-a")).rejects.toThrow(
      "table unavailable",
    );
    expect(automation.updateMany).not.toHaveBeenCalled();
  });
});
