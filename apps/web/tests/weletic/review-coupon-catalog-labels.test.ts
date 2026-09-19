import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { captureReviewCouponCatalogLabels } from "@/lib/weletic/reviews/coupon-catalog-labels";
import { readShopifyCredentialSource } from "@/lib/weletic/shopify/credential-source";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(),
}));
const identity = {
  storeId: "store",
  workspaceId: "workspace",
  shop: "test.myshopify.com",
  installationGeneration: "generation",
};
const product = {
  id: "gid://shopify/Product/1",
  __typename: "Product",
  title: "Shirt",
};
const variant = {
  id: "gid://shopify/ProductVariant/2",
  __typename: "ProductVariant",
  title: "Blue",
  product: { id: product.id, title: product.title },
};
const capture = (ids = [product.id]) =>
  captureReviewCouponCatalogLabels(identity, ids);

describe("store-owned coupon catalog capture", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readShopifyCredentialSource).mockResolvedValue({
      source: "native",
      accessToken: "synthetic",
      scope: "read_products",
      installationGeneration: "generation",
    } as Awaited<ReturnType<typeof readShopifyCredentialSource>>);
    vi.mocked(shopifyAdminGraphql).mockResolvedValue({ nodes: [product] });
  });

  it("captures ordered readable names including the variant parent without fallback", async () => {
    vi.mocked(shopifyAdminGraphql).mockResolvedValue({
      nodes: [variant, product],
    });
    expect(await capture([product.id, variant.id])).toEqual([
      { id: product.id, name: "Shirt" },
      { id: variant.id, name: "Shirt — Blue" },
    ]);
    expect(readShopifyCredentialSource).toHaveBeenCalledWith(identity);
    expect(shopifyAdminGraphql).toHaveBeenCalledWith(
      expect.objectContaining({
        shopifyStoreId: identity.shop,
        allowSdkFallback: false,
        variables: { ids: [product.id, variant.id] },
      }),
    );
  });

  it.each([
    { nodes: [null] },
    { nodes: [] },
    { nodes: [{ ...product, id: "gid://shopify/Product/99" }] },
    { nodes: [{ ...product, __typename: "Collection" }] },
    { nodes: [{ ...product, title: " " }] },
    { nodes: [{ ...product, title: "x".repeat(201) }] },
    { nodes: [product, product] },
    {},
  ])(
    "rejects incomplete, foreign or malformed catalog results",
    async (response) => {
      vi.mocked(shopifyAdminGraphql).mockResolvedValue(response);
      await expect(capture()).rejects.toThrow(
        "Verified coupon catalog labels are unavailable",
      );
    },
  );

  it.each([
    { ...variant, product: undefined },
    {
      ...variant,
      product: { id: "gid://shopify/Collection/1", title: "Shirt" },
    },
    { ...variant, title: "x".repeat(200) },
  ])(
    "rejects missing/invalid parent or an oversized combined variant name",
    async (item) => {
      vi.mocked(shopifyAdminGraphql).mockResolvedValue({ nodes: [item] });
      await expect(capture([variant.id])).rejects.toThrow();
    },
  );

  it.each([
    { source: "legacy" },
    {
      source: "native",
      scope: "read_orders",
      installationGeneration: "generation",
    },
    {
      source: "native",
      scope: "read_products",
      installationGeneration: "stale",
    },
  ])(
    "rejects legacy, insufficient scope and stale generation",
    async (credential) => {
      vi.mocked(readShopifyCredentialSource).mockResolvedValue(
        credential as Awaited<ReturnType<typeof readShopifyCredentialSource>>,
      );
      await expect(capture()).rejects.toThrow();
      expect(shopifyAdminGraphql).not.toHaveBeenCalled();
    },
  );

  it.each([
    [product.id, product.id],
    ["gid://shopify/Customer/1"],
    Array.from({ length: 251 }, (_, n) => `gid://shopify/Product/${n}`),
  ])("rejects invalid requests before credentials are read", async (...ids) => {
    await expect(capture(ids)).rejects.toThrow();
    expect(readShopifyCredentialSource).not.toHaveBeenCalled();
  });

  it("makes no credential or network request for an untargeted coupon", async () => {
    expect(await capture([])).toEqual([]);
    expect(readShopifyCredentialSource).not.toHaveBeenCalled();
  });

  it("does not expose raw upstream errors", async () => {
    vi.mocked(shopifyAdminGraphql).mockRejectedValue(
      new Error("private upstream material"),
    );
    await expect(capture()).rejects.toThrow(
      /^Verified coupon catalog labels are unavailable$/,
    );
  });
});
