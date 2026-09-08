import { processOrderPointsEarn } from "@/lib/weletic/loyalty/earn";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  orderFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
    weleticCommerceOrder: { findUnique: mocks.orderFindUnique },
  };
  return {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    },
  };
});

describe("frozen Shopify store loyalty earn guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["frozen", "redacted"] as const)(
    "does not create an order earn grant after the store becomes %s",
    async (complianceState) => {
      mocks.storeFindUnique.mockResolvedValueOnce({
        id: "store_closed",
        complianceState,
      });

      await expect(
        processOrderPointsEarn({
          storeId: "store_closed",
          orderId: "order_delayed",
        }),
      ).rejects.toMatchObject({
        name: "ShopifyStoreOperationalWritesBlockedError",
        complianceState,
      });
      expect(mocks.storeFindUnique).toHaveBeenCalledWith({
        where: { id: "store_closed" },
        select: {
          id: true,
          complianceState: true,
          shopCurrency: true,
          currencyVerifiedAt: true,
          installationGeneration: true,
        },
      });
      expect(mocks.orderFindUnique).not.toHaveBeenCalled();
    },
  );
});
