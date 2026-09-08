import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    weleticShopifySyncRun: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyStore: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyMarket: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyProduct: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyVariant: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyTranslation: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    weleticShopifyMarketPrice: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    graphql: vi.fn(),
    guard: vi.fn(),
    ensureWebhooks: vi.fn(),
    getInstallation: vi.fn(),
    withLock: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ...mocks.tx,
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  SHOPIFY_ADMIN_API_VERSION: "2026-07",
  shopifyAdminGraphql: mocks.graphql,
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.withLock,
}));

vi.mock("@/lib/weletic/shopify/get-installation", () => ({
  getWeleticShopifyInstallation: mocks.getInstallation,
}));

vi.mock("@/lib/weletic/shopify/provision-webhooks", () => ({
  ensureShopifyWebhooksRegistered: mocks.ensureWebhooks,
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
}));

vi.mock("@/lib/weletic/fx", () => ({
  getAccountingFxQuote: vi.fn(),
}));

import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";

const workspaceId = "workspace_catalog_fence";
const storeId = "store_catalog_fence";
const currencyGeneration = new Date("2026-08-28T00:00:00.000Z");
const installationGeneration = "sgen_catalog_fence";

function productWithVariants(count: number) {
  return {
    id: "gid://shopify/Product/1",
    handle: "fenced-product",
    title: "Fenced product",
    descriptionHtml: "",
    productType: "",
    vendor: "Weletic",
    tags: [],
    collections: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    },
    status: "ACTIVE",
    publishedAt: "2026-08-29T00:00:00.000Z",
    featuredMedia: null,
    vi: [],
    ja: [],
    variants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `gid://shopify/ProductVariant/${index + 1}`,
        title: `Variant ${index + 1}`,
        sku: `SKU-${index + 1}`,
        barcode: null,
        selectedOptions: [],
        image: null,
        availableForSale: true,
        inventoryQuantity: 10,
        price: "1000",
        compareAtPrice: null,
      })),
    },
  };
}

function freezeAtAction(action: string, occurrence = 1) {
  let seen = 0;
  mocks.guard.mockImplementation(async (input: { action: string }) => {
    if (input.action === action && ++seen === occurrence) {
      throw new Error(`frozen:${action}:${occurrence}`);
    }
    return {
      id: storeId,
      complianceState: "active",
      shopCurrency: "JPY",
      currencyVerifiedAt: currencyGeneration,
      installationGeneration,
    };
  });
}

describe("Shopify catalog compliance write fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.transaction.mockImplementation(async (operation: unknown) => {
      if (typeof operation !== "function") {
        throw new Error("Catalog writes must use an interactive transaction.");
      }
      return (operation as (tx: typeof mocks.tx) => Promise<unknown>)(mocks.tx);
    });
    mocks.withLock.mockImplementation(async ({ fn }: { fn: () => unknown }) =>
      fn(),
    );
    mocks.guard.mockResolvedValue({
      id: storeId,
      complianceState: "active",
      shopCurrency: "JPY",
      currencyVerifiedAt: currencyGeneration,
      installationGeneration,
    });
    mocks.getInstallation.mockResolvedValue({
      workspaceId,
      programId: "program_catalog_fence",
      shopDomain: "catalog-fence.myshopify.com",
      accessToken: "test-token",
      installationGeneration,
    });
    mocks.tx.weleticShopifySyncRun.create.mockResolvedValue({
      id: "sync_catalog_fence",
      storeId,
      startedAt: new Date("2026-08-29T00:00:00.000Z"),
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
      store: {
        id: storeId,
        currencyVerifiedAt: currencyGeneration,
        installationGeneration,
      },
    });
    mocks.tx.weleticShopifySyncRun.update.mockResolvedValue({});
    mocks.tx.weleticShopifySyncRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.weleticShopifyStore.update.mockResolvedValue({});
    mocks.tx.weleticShopifyStore.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.weleticShopifyMarket.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.weleticShopifyMarket.upsert.mockResolvedValue({
      id: "market_catalog_fence",
    });
    mocks.tx.weleticShopifyProduct.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.weleticShopifyProduct.upsert.mockResolvedValue({
      id: "product_catalog_fence",
    });
    mocks.tx.weleticShopifyVariant.upsert.mockResolvedValue({});
    mocks.tx.weleticShopifyVariant.findMany.mockResolvedValue([]);
    mocks.tx.weleticShopifyMarketPrice.upsert.mockResolvedValue({});
    mocks.graphql.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("WeleticShopAndMarkets")) {
        return {
          shop: { currencyCode: "JPY" },
          markets: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      if (query.includes("WeleticProducts")) {
        return {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      throw new Error(
        "Unexpected Shopify GraphQL query in catalog fence test.",
      );
    });
  });

  it.each([
    "catalog_sync_store_metadata",
    "catalog_sync_cursor",
    "catalog_sync_complete",
  ])(
    "cannot write a successful store state after freeze wins at %s",
    async (action) => {
      freezeAtAction(action);

      await expect(syncWeleticShopifyCatalog({ workspaceId })).rejects.toThrow(
        `frozen:${action}:1`,
      );

      expect(mocks.tx.weleticShopifyStore.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ syncStatus: "succeeded" }),
        }),
      );
      expect(mocks.tx.weleticShopifyStore.update).toHaveBeenCalledWith({
        where: { id: storeId },
        data: {
          syncStatus: "failed",
          lastSyncError: `frozen:${action}:1`,
        },
      });
    },
  );

  it("lets freeze acquire the store row between bounded variant batches", async () => {
    mocks.graphql.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("WeleticShopAndMarkets")) {
        return {
          shop: { currencyCode: "JPY" },
          markets: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      if (query.includes("WeleticProducts")) {
        return {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [productWithVariants(41)],
          },
        };
      }
      throw new Error(
        "Unexpected Shopify GraphQL query in catalog fence test.",
      );
    });
    freezeAtAction("catalog_sync_variants", 2);

    await expect(syncWeleticShopifyCatalog({ workspaceId })).rejects.toThrow(
      "frozen:catalog_sync_variants:2",
    );

    expect(mocks.tx.weleticShopifyVariant.upsert).toHaveBeenCalledTimes(20);
    expect(mocks.guard).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        action: "catalog_sync_variants",
        tx: mocks.tx,
      }),
    );
    expect(mocks.tx.weleticShopifySyncRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("does not publish an old Shopify currency read after callback verifies a newer generation", async () => {
    const generationOne = new Date("2026-08-28T00:00:00.000Z");
    const generationTwo = new Date("2026-08-29T00:00:00.000Z");
    let currentGeneration = generationOne;
    mocks.guard.mockImplementation(
      async ({
        action,
        expectedCurrencyGeneration,
        expectedInstallationGeneration,
      }: {
        action: string;
        expectedCurrencyGeneration?: Date | null;
        expectedInstallationGeneration?: string | null;
      }) => {
        if (action === "catalog_sync_store_metadata") {
          expect(expectedCurrencyGeneration).toEqual(generationOne);
          expect(expectedInstallationGeneration).toBe(installationGeneration);
          if (
            expectedCurrencyGeneration?.getTime() !==
            currentGeneration.getTime()
          ) {
            throw new Error("stale_currency_generation");
          }
        }
        return {
          id: storeId,
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: currentGeneration,
          installationGeneration,
        };
      },
    );
    mocks.graphql.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("WeleticShopAndMarkets")) {
        // Callback publishes generation two while the catalog request is in
        // flight, before this older USD snapshot can enter its write fence.
        currentGeneration = generationTwo;
        return {
          shop: { currencyCode: "USD" },
          markets: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      if (query.includes("WeleticProducts")) {
        return {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      throw new Error("Unexpected Shopify GraphQL query.");
    });

    await expect(syncWeleticShopifyCatalog({ workspaceId })).rejects.toThrow(
      "stale_currency_generation",
    );
    expect(mocks.tx.weleticShopifyStore.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shopCurrency: "USD" }),
      }),
    );
  });

  it("persists an authoritative currency generation for a fresh same-currency store", async () => {
    mocks.tx.weleticShopifySyncRun.create.mockResolvedValueOnce({
      id: "sync_fresh_usd",
      storeId,
      startedAt: new Date("2026-08-29T00:00:00.000Z"),
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
      store: {
        id: storeId,
        shopCurrency: "USD",
        currencyVerifiedAt: null,
        installationGeneration,
      },
    });
    mocks.guard.mockResolvedValue({
      id: storeId,
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: null,
      installationGeneration,
    });
    mocks.graphql.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("WeleticShopAndMarkets")) {
        return {
          shop: { currencyCode: "USD" },
          markets: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      if (query.includes("WeleticProducts")) {
        return {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      }
      throw new Error("Unexpected Shopify GraphQL query.");
    });

    await syncWeleticShopifyCatalog({ workspaceId });

    const metadataWrite = mocks.tx.weleticShopifyStore.update.mock.calls.find(
      ([args]) => args.data.syncStatus === "running",
    )?.[0];
    expect(metadataWrite).toMatchObject({
      data: {
        shopCurrency: "USD",
        currencyVerifiedAt: expect.any(Date),
      },
    });
    expect(mocks.guard).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_sync_cursor",
        expectedCurrencyGeneration: metadataWrite?.data.currencyVerifiedAt,
        expectedInstallationGeneration: installationGeneration,
      }),
    );
  });

  it("binds every post-metadata publication to the exact persisted currency and installation generation", async () => {
    mocks.tx.weleticShopifyVariant.findMany.mockResolvedValue([
      {
        id: "variant_catalog_fence",
        externalId: "gid://shopify/ProductVariant/1",
      },
    ]);
    mocks.graphql.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("WeleticShopAndMarkets")) {
        return {
          shop: { currencyCode: "JPY" },
          markets: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Market/1",
                name: "Japan",
                handle: "jp",
                status: "ACTIVE",
                primary: true,
                currencySettings: {
                  baseCurrency: { currencyCode: "JPY" },
                  localCurrencies: false,
                },
                regions: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ code: "JP" }],
                },
                webPresence: null,
                catalogs: { nodes: [] },
              },
            ],
          },
        };
      }
      if (query.includes("WeleticProducts")) {
        return {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                ...productWithVariants(1),
                vi: [{ key: "title", value: "Sản phẩm" }],
              },
            ],
          },
        };
      }
      if (query.includes("WeleticMarketPrices")) {
        return {
          productVariants: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/ProductVariant/1",
                contextualPricing: {
                  price: { amount: "1000", currencyCode: "JPY" },
                  compareAtPrice: null,
                },
              },
            ],
          },
        };
      }
      throw new Error("Unexpected Shopify GraphQL query.");
    });

    await syncWeleticShopifyCatalog({ workspaceId });

    for (const action of [
      "catalog_sync_market",
      "catalog_sync_product",
      "catalog_sync_variants",
      "catalog_sync_translations",
      "catalog_sync_cursor",
      "catalog_sync_market_prices",
      "catalog_sync_retire_roots",
      "catalog_sync_retire_product_children",
      "catalog_sync_retire_market_prices",
      "catalog_sync_retire_market_scopes",
      "catalog_sync_complete",
    ]) {
      expect(mocks.guard).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          storeId,
          expectedCurrencyGeneration: currencyGeneration,
          expectedInstallationGeneration: installationGeneration,
          tx: mocks.tx,
        }),
      );
    }
  });

  it("rejects the remainder of an old catalog run after callback refreshes its generations", async () => {
    const nextCurrencyGeneration = new Date("2026-08-29T00:00:00.000Z");
    const nextInstallationGeneration = "sgen_catalog_fence_next";
    let currentCurrencyGeneration = currencyGeneration;
    let currentInstallationGeneration = installationGeneration;

    mocks.guard.mockImplementation(
      async ({
        action,
        expectedCurrencyGeneration,
        expectedInstallationGeneration,
      }: {
        action: string;
        expectedCurrencyGeneration?: Date | null;
        expectedInstallationGeneration?: string | null;
      }) => {
        if (action === "catalog_sync_market") {
          currentCurrencyGeneration = nextCurrencyGeneration;
          currentInstallationGeneration = nextInstallationGeneration;
        }
        if (
          expectedCurrencyGeneration !== undefined &&
          expectedCurrencyGeneration?.getTime() !==
            currentCurrencyGeneration.getTime()
        ) {
          throw new Error("stale_currency_generation");
        }
        if (
          expectedInstallationGeneration !== undefined &&
          expectedInstallationGeneration !== currentInstallationGeneration
        ) {
          throw new Error("stale_installation_generation");
        }
        return {
          id: storeId,
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: currentCurrencyGeneration,
          installationGeneration: currentInstallationGeneration,
        };
      },
    );
    mocks.graphql.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("WeleticShopAndMarkets")) {
        return {
          shop: { currencyCode: "JPY" },
          markets: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Market/1",
                name: "Japan",
                handle: "jp",
                status: "ACTIVE",
                primary: true,
                currencySettings: {
                  baseCurrency: { currencyCode: "JPY" },
                  localCurrencies: false,
                },
                regions: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ code: "JP" }],
                },
                webPresence: null,
                catalogs: { nodes: [] },
              },
            ],
          },
        };
      }
      throw new Error("No later Shopify reads should occur after stale fence.");
    });

    await expect(syncWeleticShopifyCatalog({ workspaceId })).rejects.toThrow(
      "stale_currency_generation",
    );

    expect(mocks.guard).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_sync_market",
        expectedCurrencyGeneration: currencyGeneration,
        expectedInstallationGeneration: installationGeneration,
      }),
    );
    expect(mocks.tx.weleticShopifyMarket.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifyProduct.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifySyncRun.update).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifySyncRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "sync_catalog_fence",
          status: "running",
        },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mocks.tx.weleticShopifyStore.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ syncStatus: "failed" }),
      }),
    );
  });

  it("rolls back run attachment when connectOrCreate observes a newer installation generation", async () => {
    mocks.tx.weleticShopifySyncRun.create.mockResolvedValueOnce({
      id: "sync_mismatched_attachment",
      storeId,
      startedAt: new Date("2026-08-29T00:00:00.000Z"),
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
      store: {
        id: storeId,
        currencyVerifiedAt: currencyGeneration,
        installationGeneration: "sgen_callback_won",
      },
    });

    await expect(syncWeleticShopifyCatalog({ workspaceId })).rejects.toThrow(
      "credentials changed before catalog sync started",
    );

    expect(mocks.guard).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_sync_start",
        expectedInstallationGeneration: installationGeneration,
        tx: mocks.tx,
      }),
    );
    expect(mocks.tx.weleticShopifySyncRun.create).toHaveBeenCalledOnce();
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifySyncRun.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifyStore.update).not.toHaveBeenCalled();
  });

  it("rejects credentials captured before the store installation generation", async () => {
    mocks.getInstallation.mockResolvedValueOnce({
      workspaceId,
      programId: "program_catalog_fence",
      shopDomain: "catalog-fence.myshopify.com",
      accessToken: "stale-token",
      installationGeneration: "sgen_stale_credentials",
    });
    mocks.guard.mockImplementation(
      async ({
        action,
        expectedInstallationGeneration,
      }: {
        action: string;
        expectedInstallationGeneration?: string | null;
      }) => {
        if (action === "catalog_sync_start") {
          expect(expectedInstallationGeneration).toBe("sgen_stale_credentials");
          throw new Error("stale_installation_generation");
        }
        return {
          id: storeId,
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: currencyGeneration,
          installationGeneration,
        };
      },
    );

    await expect(syncWeleticShopifyCatalog({ workspaceId })).rejects.toThrow(
      "stale_installation_generation",
    );

    expect(mocks.guard).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        action: "catalog_sync_start",
        expectedInstallationGeneration: "sgen_stale_credentials",
        tx: mocks.tx,
      }),
    );
    expect(mocks.tx.weleticShopifySyncRun.create).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifyMarket.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifyProduct.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifyStore.update).not.toHaveBeenCalled();
    expect(mocks.tx.weleticShopifySyncRun.updateMany).not.toHaveBeenCalled();
  });
});
