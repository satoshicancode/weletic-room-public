import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ graphql: vi.fn() }));

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: mocks.graphql,
}));
vi.mock("@/lib/weletic/shopify/get-installation", () => ({
  getWeleticShopifyInstallation: vi.fn().mockResolvedValue({
    shopDomain: "store.myshopify.com",
    accessToken: "token",
  }),
}));

import { getShopifyOrderLineContext } from "@/lib/weletic/shopify/order-context";

describe("Shopify order settlement context", () => {
  beforeEach(() => {
    mocks.graphql.mockReset();
  });

  it("batches exact collection membership and captures subscription series", async () => {
    mocks.graphql
      .mockResolvedValueOnce({
        order: {
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/10",
                product: {
                  id: "gid://shopify/Product/20",
                  tags: ["VIP"],
                },
                variant: { id: "gid://shopify/ProductVariant/40" },
                sellingPlan: {
                  sellingPlanId: "gid://shopify/SellingPlan/50",
                  name: "Monthly",
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "gid://shopify/SellingPlan/50",
            category: "SUBSCRIPTION",
          },
        ],
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "gid://shopify/Product/20",
            collection0: true,
          },
        ],
      });

    const context = await getShopifyOrderLineContext({
      workspaceId: "workspace_1",
      orderId: 1,
      relevantCollectionIds: ["30"],
    });

    expect(mocks.graphql).toHaveBeenCalledTimes(3);
    expect(mocks.graphql.mock.calls[0][0].query).not.toContain("collections(");
    expect(mocks.graphql.mock.calls[0][0].query).not.toContain("contract");
    expect(mocks.graphql.mock.calls[1][0].query).toContain(
      "WeleticSellingPlanCategories",
    );
    expect(mocks.graphql.mock.calls[2][0].query).toContain(
      "collection0: inCollection",
    );
    expect(mocks.graphql.mock.calls[2][0].variables.collectionId0).toBe(
      "gid://shopify/Collection/30",
    );
    expect(context.get("10")?.collectionExternalIds).toEqual([
      "gid://shopify/Collection/30",
    ]);
    expect(context.get("10")?.subscriptionSeriesKey).toBe(
      "selling-plan:gid://shopify/SellingPlan/50:item:gid://shopify/ProductVariant/40",
    );
    expect(context.get("10")?.productTags).toEqual(["VIP"]);
  });

  it("bounds request size and concurrency for large product/collection sets", async () => {
    const productIds = Array.from(
      { length: 250 },
      (_, index) => `gid://shopify/Product/${index + 1}`,
    );
    let activeMembershipRequests = 0;
    let maxActiveMembershipRequests = 0;
    mocks.graphql.mockImplementation(async ({ query, variables }) => {
      if (query.includes("WeleticOrderLineContext")) {
        return {
          order: {
            lineItems: {
              nodes: productIds.map((productId, index) => ({
                id: `gid://shopify/LineItem/${index + 1}`,
                product: { id: productId, tags: [] },
                variant: null,
                sellingPlan: null,
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      activeMembershipRequests += 1;
      maxActiveMembershipRequests = Math.max(
        maxActiveMembershipRequests,
        activeMembershipRequests,
      );
      await Promise.resolve();
      activeMembershipRequests -= 1;
      return {
        nodes: variables.productIds.map((id: string) => ({ id })),
      };
    });

    await getShopifyOrderLineContext({
      workspaceId: "workspace_1",
      orderId: 1,
      relevantCollectionIds: Array.from({ length: 250 }, (_, index) =>
        String(index + 1),
      ),
    });

    expect(mocks.graphql).toHaveBeenCalledTimes(16);
    expect(maxActiveMembershipRequests).toBeLessThanOrEqual(3);
    for (const [{ query, variables }] of mocks.graphql.mock.calls.slice(1)) {
      expect(query).toContain("inCollection");
      expect(variables.productIds.length).toBeLessThanOrEqual(100);
      expect(
        Object.keys(variables).filter((key) => key.startsWith("collectionId")),
      ).toHaveLength(50);
    }
  });

  it("ignores malformed collection IDs instead of failing the order", async () => {
    mocks.graphql.mockResolvedValueOnce({
      order: {
        lineItems: {
          nodes: [
            {
              id: "gid://shopify/LineItem/10",
              product: { id: "gid://shopify/Product/20", tags: [] },
              variant: null,
              sellingPlan: null,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    const context = await getShopifyOrderLineContext({
      workspaceId: "workspace_1",
      orderId: 1,
      relevantCollectionIds: ["not-a-shopify-id"],
    });

    expect(mocks.graphql).toHaveBeenCalledTimes(1);
    expect(context.get("10")?.collectionExternalIds).toEqual([]);
  });

  it("retries when selling-plan metadata lookup fails", async () => {
    mocks.graphql
      .mockResolvedValueOnce({
        order: {
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/10",
                product: { id: "gid://shopify/Product/20", tags: [] },
                variant: null,
                sellingPlan: {
                  sellingPlanId: "gid://shopify/SellingPlan/50",
                  name: "Monthly",
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockRejectedValueOnce(new Error("Shopify unavailable"));

    await expect(
      getShopifyOrderLineContext({ workspaceId: "workspace_1", orderId: 1 }),
    ).rejects.toThrow("Shopify unavailable");
  });

  it("keeps inaccessible selling plans explicitly unknown", async () => {
    mocks.graphql
      .mockResolvedValueOnce({
        order: {
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/10",
                product: { id: "gid://shopify/Product/20", tags: [] },
                variant: null,
                sellingPlan: {
                  sellingPlanId: "gid://shopify/SellingPlan/50",
                  name: "Unknown plan",
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockResolvedValueOnce({ nodes: [null] });

    const context = await getShopifyOrderLineContext({
      workspaceId: "workspace_1",
      orderId: 1,
    });

    expect(context.get("10")).toMatchObject({
      sellingPlanCategory: null,
      subscriptionSeriesKey: null,
    });
  });
});
