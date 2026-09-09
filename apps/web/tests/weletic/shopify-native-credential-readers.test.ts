import { beforeEach, describe, expect, it, vi } from "vitest";
import { shopifyDiscountProvider } from "../../lib/discounts/discount-provider-shopify";
import { resolveShopifyOfflineCredentials } from "../../lib/weletic/loyalty/shopify-discounts";
import { ShopifyCredentialUnavailableError } from "../../lib/weletic/shopify/credential-errors";
import { getWeleticShopifyInstallation } from "../../lib/weletic/shopify/get-installation";
import { resolveShopifyStoreByDomain } from "../../lib/weletic/shopify/store-resolver";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  project: vi.fn(),
  legacy: vi.fn(),
  store: vi.fn(),
  graphql: vi.fn(),
  lockedStore: vi.fn(),
}));
vi.mock("@/lib/integrations/shopify/admin-graphql", async (original) => ({
  ...(await original<
    typeof import("@/lib/integrations/shopify/admin-graphql")
  >()),
  shopifyAdminGraphql: mocks.graphql,
}));
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: mocks.source,
}));
vi.mock("@/lib/weletic/shopify/token-authority", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/shopify/token-authority")>()),
  isShopifyTokenAuthorityConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (callback: (tx: object) => unknown) =>
      callback({ $queryRaw: mocks.lockedStore }),
    project: { findUnique: mocks.project, findUniqueOrThrow: mocks.project },
    installedIntegration: { findFirst: mocks.legacy },
    weleticShopifyStore: { findUnique: mocks.store },
  },
}));
const shop = "company.myshopify.com";
const store = {
  id: "store",
  projectId: "workspace",
  shopDomain: shop,
  installationGeneration: "generation",
};
const scope =
  "read_products,read_markets,read_orders,read_translations,read_customers,write_discounts";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.source.mockResolvedValue({
    source: "native",
    revision: 3,
    accessToken: "synthetic-native-token",
    scope,
    installationGeneration: "generation",
  });
  mocks.project.mockResolvedValue({
    id: "workspace",
    defaultProgramId: "program",
    shopifyStoreId: null,
    installedIntegrations: [],
    weleticShopifyStore: store,
  });
  mocks.store.mockResolvedValue(store);
  mocks.lockedStore.mockResolvedValue([
    { ...store, complianceState: "active", storeAccessState: "active" },
  ]);
  mocks.legacy.mockRejectedValue(
    new Error("Legacy authority must not be consulted"),
  );
});
describe("native credential reader cutover", () => {
  it("rechecks company approval before a collision retry", async () => {
    mocks.graphql.mockImplementationOnce(async () => {
      mocks.lockedStore.mockResolvedValue([
        { ...store, complianceState: "active", storeAccessState: "suspended" },
      ]);
      return {
        discountCodeBasicCreate: {
          codeDiscountNode: null,
          userErrors: [
            {
              code: "TAKEN",
              message: "Synthetic code collision",
              field: ["code"],
            },
          ],
        },
      };
    });
    await expect(
      shopifyDiscountProvider.createDiscountCode({
        workspace: { id: "workspace", shopifyStoreId: null },
        discount: {
          id: "synthetic-discount",
          amount: 20,
          type: "percentage",
          maxDuration: null,
        },
        code: "NATIVE20",
      }),
    ).rejects.toMatchObject({ providerCode: "PERMISSIONS_REQUIRED" });
    expect(mocks.graphql).toHaveBeenCalledOnce();
    expect(mocks.lockedStore).toHaveBeenCalledTimes(2);
  });
  it.each([
    { storeAccessState: "pending_approval" },
    { storeAccessState: "suspended" },
    { complianceState: "frozen" },
    { installationGeneration: "new-generation" },
    { projectId: "foreign-workspace" },
  ])(
    "blocks native provider creation after authority changes %j",
    async (change) => {
      mocks.lockedStore.mockResolvedValue([
        {
          ...store,
          complianceState: "active",
          storeAccessState: "active",
          ...change,
        },
      ]);
      await expect(
        shopifyDiscountProvider.createDiscountCode({
          workspace: { id: "workspace", shopifyStoreId: null },
          discount: {
            id: "synthetic-discount",
            amount: 20,
            type: "percentage",
            maxDuration: null,
          },
          code: "NATIVE20",
        }),
      ).rejects.toMatchObject({ providerCode: "PERMISSIONS_REQUIRED" });
      expect(mocks.graphql).not.toHaveBeenCalled();
      expect(mocks.legacy).not.toHaveBeenCalled();
    },
  );
  const providerWorkspace = {
    id: "workspace",
    shopifyStoreId: null,
    stripeConnectId: null,
  };
  it("creates a provider discount using native canonical credentials without an installer or Project alias", async () => {
    mocks.graphql.mockResolvedValue({
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: "gid://shopify/DiscountCodeNode/123",
          codeDiscount: { codes: { nodes: [{ code: "NATIVE20" }] } },
        },
        userErrors: [],
      },
    });
    const result = await shopifyDiscountProvider.createDiscountCode({
      workspace: providerWorkspace,
      discount: {
        id: "synthetic-discount",
        amount: 20,
        type: "percentage",
        maxDuration: null,
      },
      code: "NATIVE20",
    });
    expect(result.code).toBe("NATIVE20");
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.objectContaining({
        shopifyStoreId: shop,
        accessToken: "synthetic-native-token",
        allowSdkFallback: false,
      }),
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("keeps generic provider native scope and auth failures typed before GraphQL", async () => {
    mocks.source.mockResolvedValue({
      source: "native",
      accessToken: "synthetic-token",
      scope: "read_orders",
    });
    await expect(
      shopifyDiscountProvider.assertDiscountIntegration({
        workspace: providerWorkspace,
      }),
    ).rejects.toMatchObject({ providerCode: "PERMISSIONS_REQUIRED" });
    mocks.source.mockRejectedValue(
      new ShopifyCredentialUnavailableError("internal mismatch"),
    );
    await expect(
      shopifyDiscountProvider.assertDiscountIntegration({
        workspace: providerWorkspace,
      }),
    ).rejects.toMatchObject({ providerCode: "AUTH_EXPIRED" });
    const outage = new Error("synthetic storage outage");
    mocks.source.mockRejectedValue(outage);
    await expect(
      shopifyDiscountProvider.assertDiscountIntegration({
        workspace: providerWorkspace,
      }),
    ).rejects.toBe(outage);
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it.each(["workspace", "discount"])(
    "maps native %s authentication failure without misclassifying storage failure",
    async (reader) => {
      const read = () =>
        reader === "workspace"
          ? getWeleticShopifyInstallation("workspace")
          : resolveShopifyOfflineCredentials({ storeId: "store" });
      mocks.source.mockRejectedValue(
        new ShopifyCredentialUnavailableError("Internal credential mismatch"),
      );
      await expect(read()).rejects.toMatchObject({
        code: reader === "workspace" ? "bad_request" : "AUTH_EXPIRED",
        message: "Reconnect the Shopify app before accessing this store.",
      });
      const outage = new Error("synthetic storage outage");
      mocks.source.mockRejectedValue(outage);
      await expect(read()).rejects.toBe(outage);
      expect(mocks.legacy).not.toHaveBeenCalled();
    },
  );
  it("loads workspace installation without an installer account or project shop alias", async () => {
    expect(await getWeleticShopifyInstallation("workspace")).toEqual({
      workspaceId: "workspace",
      programId: "program",
      shopDomain: shop,
      accessToken: "synthetic-native-token",
      installationGeneration: "generation",
    });
    expect(mocks.source).toHaveBeenCalledWith({
      storeId: "store",
      workspaceId: "workspace",
      shop,
      installationGeneration: "generation",
    });
  });
  it("resolves only the native canonical shop without legacy token probes", async () => {
    expect(await resolveShopifyStoreByDomain(shop)).toMatchObject({
      storeId: "store",
      workspaceId: "workspace",
      myshopifyDomain: shop,
      allDomains: [shop],
      accessToken: "synthetic-native-token",
    });
    expect(
      await resolveShopifyStoreByDomain("foreign.myshopify.com"),
    ).toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("loads native local discount credentials without generic integration ownership", async () => {
    expect(
      await resolveShopifyOfflineCredentials({
        storeId: "store",
        workspaceId: "workspace",
      }),
    ).toMatchObject({
      source: "store_owned",
      shopDomain: shop,
      accessToken: "synthetic-native-token",
      scope,
    });
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it.each(["workspace", "domain", "discount"])(
    "does not fall back after a native %s failure",
    async (reader) => {
      mocks.source.mockRejectedValue(new Error("Native credential invalid"));
      const operation =
        reader === "workspace"
          ? getWeleticShopifyInstallation("workspace")
          : reader === "domain"
            ? resolveShopifyStoreByDomain(shop)
            : resolveShopifyOfflineCredentials({ storeId: "store" });
      await expect(operation).rejects.toThrow("Native credential invalid");
      expect(mocks.legacy).not.toHaveBeenCalled();
    },
  );
  it("keeps required Shopify scopes enforced for native workspace reads", async () => {
    mocks.source.mockResolvedValue({
      source: "native",
      accessToken: "synthetic-token",
      scope: "read_orders",
      installationGeneration: "generation",
    });
    await expect(
      getWeleticShopifyInstallation("workspace"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
