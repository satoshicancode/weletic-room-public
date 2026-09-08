import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  graphql: vi.fn(),
  redis: { hget: vi.fn(), hset: vi.fn(), expire: vi.fn() },
  storeFindUnique: vi.fn(),
  segmentCacheWrite: vi.fn(),
  hasPrivacyTombstone: vi.fn(),
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: mocks.graphql,
}));
vi.mock("@/lib/upstash", () => ({ redis: mocks.redis }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
  },
}));
vi.mock("@/lib/weletic/shopify/privacy-cache", () => ({
  writeShopifyCustomerSegmentCache: mocks.segmentCacheWrite,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: mocks.hasPrivacyTombstone,
}));
vi.mock("@/lib/weletic/shopify/get-installation", () => ({
  getWeleticShopifyInstallation: vi.fn().mockResolvedValue({
    shopDomain: "store.myshopify.com",
    accessToken: "token",
  }),
}));

import {
  getShopifyCustomerSegmentIds,
  setShopifyCustomerSegmentMembership,
} from "@/lib/weletic/shopify/customer-segments";

describe("Shopify customer segment settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFindUnique.mockResolvedValue({ id: "store_1" });
    mocks.segmentCacheWrite.mockResolvedValue(undefined);
    mocks.hasPrivacyTombstone.mockResolvedValue(false);
  });

  it("uses live membership even when Redis contains a stale positive value", async () => {
    mocks.redis.hget.mockResolvedValue("1");
    mocks.graphql.mockResolvedValue({
      customerSegmentMembership: {
        memberships: [
          { segmentId: "gid://shopify/Segment/1", isMember: false },
        ],
      },
    });

    await expect(
      getShopifyCustomerSegmentIds({
        workspaceId: "workspace_1",
        customerId: "gid://shopify/Customer/1",
        segmentIds: ["gid://shopify/Segment/1"],
      }),
    ).resolves.toEqual([]);
    expect(mocks.graphql).toHaveBeenCalledOnce();
    expect(mocks.redis.hget).not.toHaveBeenCalled();
  });

  it("canonicalizes numeric IDs and ignores malformed segment IDs", async () => {
    mocks.graphql.mockResolvedValue({
      customerSegmentMembership: {
        memberships: [{ segmentId: "gid://shopify/Segment/1", isMember: true }],
      },
    });

    await expect(
      getShopifyCustomerSegmentIds({
        workspaceId: "workspace_1",
        customerId: "gid://shopify/Customer/1",
        segmentIds: ["1", "not-a-shopify-segment"],
      }),
    ).resolves.toEqual(["1"]);
    expect(mocks.graphql.mock.calls[0][0].variables.segmentIds).toEqual([
      "gid://shopify/Segment/1",
    ]);
  });

  it("does not call Shopify when every segment ID is malformed", async () => {
    await expect(
      getShopifyCustomerSegmentIds({
        workspaceId: "workspace_1",
        customerId: "gid://shopify/Customer/1",
        segmentIds: ["bad"],
      }),
    ).resolves.toEqual([]);
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("rejects future cache writes for an independently tombstoned customer", async () => {
    mocks.hasPrivacyTombstone.mockResolvedValue(true);

    await setShopifyCustomerSegmentMembership({
      workspaceId: "workspace_1",
      customerId: "gid://shopify/Customer/42",
      segmentId: "gid://shopify/Segment/1",
      member: true,
    });

    expect(mocks.hasPrivacyTombstone).toHaveBeenCalledWith({
      storeId: "store_1",
      shopifyCustomerId: "gid://shopify/Customer/42",
      tx: expect.anything(),
    });
    expect(mocks.segmentCacheWrite).not.toHaveBeenCalled();
  });

  it("does not publish a segment cache mutation when freeze wins after claim", async () => {
    mocks.storeFindUnique.mockResolvedValue({
      id: "store_1",
      complianceState: "frozen",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      installationGeneration: "sgen_current",
    });

    await expect(
      setShopifyCustomerSegmentMembership({
        workspaceId: "workspace_1",
        storeId: "store_1",
        customerId: "gid://shopify/Customer/42",
        segmentId: "gid://shopify/Segment/1",
        member: true,
        expectedInstallationGeneration: "sgen_current",
      }),
    ).rejects.toThrow("is frozen");
    expect(mocks.segmentCacheWrite).not.toHaveBeenCalled();
  });
});
