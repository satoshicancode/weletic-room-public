import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  shopperFindUnique: vi.fn(),
  hasPrivacyTombstone: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
    weleticShopper: { findUnique: mocks.shopperFindUnique },
  },
}));
vi.mock("@/lib/api/links/cache", () => ({
  linkCache: { invalidateMany: vi.fn() },
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  getShopifyCustomerPrivacyPseudonym: vi.fn(),
  hasShopifyCustomerPrivacyTombstone: mocks.hasPrivacyTombstone,
}));

import { isShopifyCustomerPrivacyTombstonedForWorkspace } from "@/lib/weletic/loyalty/shopper-privacy";

describe("Shopify order privacy workspace guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFindUnique.mockResolvedValue({ id: "store_1" });
    mocks.shopperFindUnique.mockResolvedValue(null);
    mocks.hasPrivacyTombstone.mockResolvedValue(false);
  });

  it("checks identity existence without requiring a retained owner link", async () => {
    mocks.hasPrivacyTombstone.mockResolvedValueOnce(true);

    await expect(
      isShopifyCustomerPrivacyTombstonedForWorkspace({
        workspaceId: "workspace_1",
        shopifyCustomerId: "customer_42",
      }),
    ).resolves.toBe(true);

    expect(mocks.hasPrivacyTombstone).toHaveBeenCalledWith({
      storeId: "store_1",
      shopifyCustomerId: "customer_42",
    });
    expect(mocks.shopperFindUnique).not.toHaveBeenCalled();
  });
});
