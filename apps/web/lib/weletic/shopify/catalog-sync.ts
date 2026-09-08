import {
  SHOPIFY_ADMIN_API_VERSION,
  shopifyAdminGraphql,
} from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { getAccountingFxQuote } from "@/lib/weletic/fx";
import { createWeleticId } from "@/lib/weletic/ids";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import {
  convertMoney,
  decimalToMinorUnits,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import {
  Prisma,
  WeleticProductStatus,
  WeleticSyncStatus,
} from "@prisma/client";
import { getWeleticShopifyInstallation } from "./get-installation";
import { ensureShopifyWebhooksRegistered } from "./provision-webhooks";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

const SHOP_QUERY = `#graphql
  query WeleticShopAndMarkets($after: String) {
    shop {
      currencyCode
    }
    markets(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        handle
        status
        primary
        currencySettings {
          baseCurrency { currencyCode }
          localCurrencies
        }
        regions(first: 250) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on MarketRegionCountry { code }
          }
        }
        webPresence {
          rootUrls { locale url }
        }
        catalogs(first: 1) { nodes { id } }
      }
    }
  }
`;

const MARKET_REGIONS_QUERY = `#graphql
  query WeleticMarketRegions($marketId: ID!, $after: String) {
    market(id: $marketId) {
      regions(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on MarketRegionCountry { code }
        }
      }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query WeleticProducts($after: String) {
    products(first: 50, after: $after, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        descriptionHtml
        productType
        vendor
        tags
        collections(first: 250) {
          pageInfo { hasNextPage endCursor }
          nodes { id }
        }
        status
        publishedAt
        featuredMedia { preview { image { url } } }
        vi: translations(locale: "vi") { key value }
        ja: translations(locale: "ja") { key value }
        variants(first: 250) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
            selectedOptions { name value }
            image { url }
          }
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query WeleticProductVariants($productId: ID!, $after: String) {
    product(id: $productId) {
      variants(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          availableForSale
          selectedOptions { name value }
          image { url }
        }
      }
    }
  }
`;

const PRODUCT_COLLECTIONS_QUERY = `#graphql
  query WeleticProductCollections($productId: ID!, $after: String) {
    product(id: $productId) {
      collections(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const MARKET_PRICES_QUERY = `#graphql
  query WeleticMarketPrices($after: String, $country: CountryCode!) {
    productVariants(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        contextualPricing(context: { country: $country }) {
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
        }
      }
    }
  }
`;

interface ShopifyMarketNode {
  id: string;
  name: string;
  handle: string;
  status: string;
  primary?: boolean | null;
  currencySettings?: {
    baseCurrency: { currencyCode: string };
    localCurrencies: boolean;
  } | null;
  regions: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    nodes: Array<{ code?: string }>;
  };
  webPresence?: {
    rootUrls: Array<{ locale: string; url: string }>;
  } | null;
  catalogs: { nodes: Array<{ id: string }> };
}

interface ShopifyVariantNode {
  id: string;
  title: string;
  sku?: string | null;
  barcode?: string | null;
  price: string;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  availableForSale: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
  image?: { url: string } | null;
}

interface ShopifyProductNode {
  id: string;
  handle: string;
  title: string;
  descriptionHtml?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags: string[];
  collections: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    nodes: Array<{ id: string }>;
  };
  status: string;
  publishedAt?: string | null;
  featuredMedia?: {
    preview?: { image?: { url: string } | null } | null;
  } | null;
  vi: ShopifyTranslation[];
  ja: ShopifyTranslation[];
  variants: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    nodes: ShopifyVariantNode[];
  };
}

interface ShopifyTranslation {
  key: string;
  value: string;
  marketId?: string | null;
}

const productStatus = (status: string): WeleticProductStatus => {
  const normalized = status.toLowerCase();
  return normalized === "draft" || normalized === "archived"
    ? normalized
    : "active";
};

const translationValue = (translations: ShopifyTranslation[], key: string) =>
  translations.find((translation) => translation.key === key)?.value;

async function upsertTranslations({
  storeId,
  productId,
  locale,
  translations,
  marketIds,
  expectedCurrencyGeneration,
  expectedInstallationGeneration,
}: {
  storeId: string;
  productId: string;
  locale: "vi" | "ja";
  translations: ShopifyTranslation[];
  marketIds: Map<string, string>;
  expectedCurrencyGeneration: Date | null;
  expectedInstallationGeneration: string | null;
}) {
  const scopes = [
    { marketKey: "*", marketId: null, externalMarketId: null },
    ...[
      ...new Set(translations.map(({ marketId }) => marketId).filter(Boolean)),
    ]
      .map((externalMarketId) => ({
        marketKey: externalMarketId!,
        marketId: marketIds.get(externalMarketId!),
        externalMarketId,
      }))
      .filter(
        (
          scope,
        ): scope is {
          marketKey: string;
          marketId: string;
          externalMarketId: string;
        } => Boolean(scope.marketId),
      ),
  ];

  const writes = scopes.flatMap((scope) => {
    const scoped = translations.filter(({ marketId }) =>
      scope.externalMarketId
        ? marketId === scope.externalMarketId
        : marketId == null,
    );
    const title = translationValue(scoped, "title");
    return title
      ? [
          {
            marketKey: scope.marketKey,
            marketId: scope.marketId,
            title,
            descriptionHtml: translationValue(scoped, "body_html"),
          },
        ]
      : [];
  });

  for (let offset = 0; offset < writes.length; offset += 20) {
    const chunk = writes.slice(offset, offset + 20);
    await withCatalogWriteFence({
      storeId,
      action: "catalog_sync_translations",
      expectedCurrencyGeneration,
      expectedInstallationGeneration,
      operation: async (tx) => {
        for (const write of chunk) {
          await tx.weleticShopifyTranslation.upsert({
            where: {
              productId_locale_marketKey: {
                productId,
                locale,
                marketKey: write.marketKey,
              },
            },
            create: {
              id: createWeleticId("wtrans_"),
              productId,
              marketId: write.marketId,
              locale,
              marketKey: write.marketKey,
              title: write.title,
              descriptionHtml: write.descriptionHtml,
            },
            update: {
              marketId: write.marketId,
              title: write.title,
              descriptionHtml: write.descriptionHtml,
            },
          });
        }
      },
    });
  }
}

async function withCatalogWriteFence<T>({
  storeId,
  action,
  operation,
  lockCurrencyGeneration = false,
  expectedCurrencyGeneration,
  expectedInstallationGeneration,
}: {
  storeId: string;
  action: string;
  operation: (
    tx: Prisma.TransactionClient,
    store: Awaited<
      ReturnType<typeof assertShopifyStoreAcceptsOperationalWrites>
    >,
  ) => Promise<T>;
  lockCurrencyGeneration?: boolean;
  expectedCurrencyGeneration?: Date | null;
  expectedInstallationGeneration?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const store = await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action,
      expectedCurrencyGeneration,
      expectedInstallationGeneration,
      tx,
    });
    if (lockCurrencyGeneration) {
      await lockLoyaltyProgramRowIfPresent({ tx, storeId });
    }
    return operation(tx, store);
  });
}

async function performWeleticShopifyCatalogSync({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const installation = await getWeleticShopifyInstallation(workspaceId);
  const credentialInstallationGeneration =
    installation.installationGeneration ?? null;
  const run = await prisma.$transaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      workspaceId,
      action: "catalog_sync_start",
      allowMissing: true,
      expectedInstallationGeneration: credentialInstallationGeneration,
      tx,
    });
    const createdRun = await tx.weleticShopifySyncRun.create({
      data: {
        id: createWeleticId("wsync_"),
        store: {
          connectOrCreate: {
            where: { projectId: workspaceId },
            create: {
              id: createWeleticId("wstore_"),
              projectId: workspaceId,
              programId: installation.programId,
              shopDomain: installation.shopDomain,
              shopCurrency: "USD",
              installationGeneration: credentialInstallationGeneration,
              apiVersion: SHOPIFY_ADMIN_API_VERSION,
            },
          },
        },
        kind: "full_catalog",
        status: WeleticSyncStatus.running,
        startedAt: new Date(),
      },
      include: { store: true },
    });
    if (
      (createdRun.store.installationGeneration ?? null) !==
      credentialInstallationGeneration
    ) {
      throw new Error(
        "Shopify installation credentials changed before catalog sync started.",
      );
    }
    return createdRun;
  });

  const stats = { products: 0, variants: 0, markets: 0, marketPrices: 0 };
  const syncStartedAt = run.startedAt ?? run.createdAt;
  // Bind the authoritative Shopify read below to the generation that started
  // this run. A callback may verify a newer installation/currency while the
  // network request is in flight; that newer publication must win.
  const catalogReadGeneration = run.store.currencyVerifiedAt ?? null;
  const catalogInstallationGeneration =
    run.store.installationGeneration ?? null;
  let catalogPersistedCurrencyGeneration = catalogReadGeneration;

  try {
    if (credentialInstallationGeneration !== catalogInstallationGeneration) {
      throw new Error(
        "Shopify installation credentials changed before catalog sync started.",
      );
    }
    // Ensure all 12 canonical webhooks are actively registered for this store
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId: run.storeId,
      action: "catalog_sync_webhook_provision_start",
      expectedCurrencyGeneration: catalogReadGeneration,
      expectedInstallationGeneration: catalogInstallationGeneration,
    });
    try {
      await ensureShopifyWebhooksRegistered({
        shopDomain: installation.shopDomain,
        accessToken: installation.accessToken,
      });
    } catch {}
    // Never hold the store row lock across Shopify network I/O: compliance
    // ingress must be able to freeze inside Shopify's acknowledgement budget.
    // A post-I/O check stops this run if freeze landed while registration was
    // in flight; operational webhook handlers independently reject frozen
    // stores, while mandatory privacy topics remain intentionally reachable.
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId: run.storeId,
      action: "catalog_sync_webhook_provision_complete",
      expectedCurrencyGeneration: catalogReadGeneration,
      expectedInstallationGeneration: catalogInstallationGeneration,
    });

    let marketCursor: string | null = null;
    let hasMoreMarkets = true;
    let shopCurrency = "USD";
    let defaultLocale = "en";
    const allMarketNodes: ShopifyMarketNode[] = [];

    while (hasMoreMarkets) {
      const shopData = await shopifyAdminGraphql<{
        shop: { currencyCode: string };
        markets: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ShopifyMarketNode[];
        };
      }>({
        shopifyStoreId: installation.shopDomain,
        accessToken: installation.accessToken,
        query: SHOP_QUERY,
        variables: { after: marketCursor },
      });

      shopCurrency = normalizeCurrency(shopData.shop.currencyCode);
      defaultLocale = "en";
      allMarketNodes.push(...shopData.markets.nodes);
      marketCursor = shopData.markets.pageInfo.endCursor;
      hasMoreMarkets = shopData.markets.pageInfo.hasNextPage;
    }

    const catalogCurrencyVerifiedAt = new Date();
    catalogPersistedCurrencyGeneration = await withCatalogWriteFence({
      storeId: run.storeId,
      action: "catalog_sync_store_metadata",
      lockCurrencyGeneration: true,
      expectedCurrencyGeneration: catalogReadGeneration,
      expectedInstallationGeneration: catalogInstallationGeneration,
      operation: async (tx, lockedStore) => {
        const currencyVerificationRequired =
          !lockedStore?.currencyVerifiedAt ||
          lockedStore.shopCurrency?.trim().toUpperCase() !== shopCurrency;
        await tx.weleticShopifyStore.update({
          where: { id: run.storeId },
          data: {
            programId: installation.programId,
            shopDomain: installation.shopDomain,
            shopCurrency,
            ...(currencyVerificationRequired
              ? { currencyVerifiedAt: catalogCurrencyVerifiedAt }
              : {}),
            defaultLocale,
            apiVersion: SHOPIFY_ADMIN_API_VERSION,
            syncStatus: WeleticSyncStatus.running,
            lastSyncError: null,
          },
        });
        return currencyVerificationRequired
          ? catalogCurrencyVerifiedAt
          : lockedStore?.currencyVerifiedAt ?? null;
      },
    });

    const withCurrentCatalogWriteFence = async <T>({
      action,
      operation,
    }: {
      action: string;
      operation: (
        tx: Prisma.TransactionClient,
        store: Awaited<
          ReturnType<typeof assertShopifyStoreAcceptsOperationalWrites>
        >,
      ) => Promise<T>;
    }) =>
      withCatalogWriteFence({
        storeId: run.storeId,
        action,
        expectedCurrencyGeneration: catalogPersistedCurrencyGeneration,
        expectedInstallationGeneration: catalogInstallationGeneration,
        operation,
      });

    const marketCountries = [] as Array<{
      id: string;
      countryCode: string;
    }>;
    const marketIds = new Map<string, string>();
    const marketCurrencies = new Map<string, string>();
    const countryCodesByMarket = new Map<string, string[]>();

    for (const market of allMarketNodes) {
      const countryCodes = market.regions.nodes
        .map(({ code }) => code)
        .filter((code): code is string => Boolean(code));

      // Paginate additional regions if market has > 250 regions
      let regionCursor = market.regions.pageInfo.endCursor;
      let hasMoreRegions = market.regions.pageInfo.hasNextPage;
      while (hasMoreRegions && regionCursor) {
        const regionData = await shopifyAdminGraphql<{
          market: {
            regions: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{ code?: string }>;
            };
          };
        }>({
          shopifyStoreId: installation.shopDomain,
          accessToken: installation.accessToken,
          query: MARKET_REGIONS_QUERY,
          variables: { marketId: market.id, after: regionCursor },
        });
        if (regionData.market?.regions?.nodes) {
          countryCodes.push(
            ...regionData.market.regions.nodes
              .map(({ code }) => code)
              .filter((code): code is string => Boolean(code)),
          );
          regionCursor = regionData.market.regions.pageInfo.endCursor;
          hasMoreRegions = regionData.market.regions.pageInfo.hasNextPage;
        } else {
          hasMoreRegions = false;
        }
      }

      const rootUrls = market.webPresence?.rootUrls ?? [];
      const rootUrl =
        rootUrls.find(({ locale }) => locale === defaultLocale)?.url ??
        rootUrls[0]?.url;
      const baseCurrency = normalizeCurrency(
        market.currencySettings?.baseCurrency.currencyCode ?? shopCurrency,
      );

      // Resolve primary market explicitly from Shopify metadata
      const isPrimary = Boolean(market.primary);

      const saved = await withCurrentCatalogWriteFence({
        action: "catalog_sync_market",
        operation: (tx) =>
          tx.weleticShopifyMarket.upsert({
            where: {
              storeId_externalId: {
                storeId: run.storeId,
                externalId: market.id,
              },
            },
            create: {
              id: createWeleticId("wmarket_"),
              storeId: run.storeId,
              externalId: market.id,
              name: market.name,
              handle: market.handle,
              catalogExternalId: market.catalogs.nodes[0]?.id,
              countryCodes,
              currencyCodes: [baseCurrency],
              rootUrls,
              webPresenceUrl: rootUrl,
              defaultLocale: rootUrls[0]?.locale,
              primary: isPrimary,
              enabled: market.status === "ACTIVE",
            },
            update: {
              name: market.name,
              handle: market.handle,
              catalogExternalId: market.catalogs.nodes[0]?.id,
              countryCodes,
              currencyCodes: [baseCurrency],
              rootUrls,
              webPresenceUrl: rootUrl,
              defaultLocale: rootUrls[0]?.locale,
              primary: isPrimary,
              enabled: market.status === "ACTIVE",
            },
          }),
      });
      marketCountries.push(
        ...countryCodes.map((countryCode) => ({
          id: saved.id,
          countryCode,
        })),
      );
      marketIds.set(market.id, saved.id);
      marketCurrencies.set(saved.id, baseCurrency);
      countryCodesByMarket.set(saved.id, countryCodes);
      stats.markets += 1;
    }

    let cursor: string | null = null;
    let hasNextPage = true;
    const seenProductIds: string[] = [];

    while (hasNextPage) {
      const productData = await shopifyAdminGraphql<{
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ShopifyProductNode[];
        };
      }>({
        shopifyStoreId: installation.shopDomain,
        accessToken: installation.accessToken,
        query: PRODUCTS_QUERY,
        variables: { after: cursor },
      });

      for (const product of productData.products.nodes) {
        const variantsList: ShopifyVariantNode[] = [...product.variants.nodes];
        let variantCursor = product.variants.pageInfo.endCursor;
        let hasMoreVariants = product.variants.pageInfo.hasNextPage;

        while (hasMoreVariants && variantCursor) {
          const variantData = await shopifyAdminGraphql<{
            product: {
              variants: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: ShopifyVariantNode[];
              };
            };
          }>({
            shopifyStoreId: installation.shopDomain,
            accessToken: installation.accessToken,
            query: PRODUCT_VARIANTS_QUERY,
            variables: { productId: product.id, after: variantCursor },
          });
          if (variantData.product?.variants?.nodes) {
            variantsList.push(...variantData.product.variants.nodes);
            variantCursor = variantData.product.variants.pageInfo.endCursor;
            hasMoreVariants = variantData.product.variants.pageInfo.hasNextPage;
          } else {
            hasMoreVariants = false;
          }
        }

        const collectionsList: Array<{ id: string }> = [
          ...product.collections.nodes,
        ];
        let collectionCursor = product.collections.pageInfo.endCursor;
        let hasMoreCollections = product.collections.pageInfo.hasNextPage;

        while (hasMoreCollections && collectionCursor) {
          const collData = await shopifyAdminGraphql<{
            product: {
              collections: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: Array<{ id: string }>;
              };
            };
          }>({
            shopifyStoreId: installation.shopDomain,
            accessToken: installation.accessToken,
            query: PRODUCT_COLLECTIONS_QUERY,
            variables: { productId: product.id, after: collectionCursor },
          });
          if (collData.product?.collections?.nodes) {
            collectionsList.push(...collData.product.collections.nodes);
            collectionCursor = collData.product.collections.pageInfo.endCursor;
            hasMoreCollections =
              collData.product.collections.pageInfo.hasNextPage;
          } else {
            hasMoreCollections = false;
          }
        }

        const savedProduct = await withCurrentCatalogWriteFence({
          action: "catalog_sync_product",
          operation: (tx) =>
            tx.weleticShopifyProduct.upsert({
              where: {
                storeId_externalId: {
                  storeId: run.storeId,
                  externalId: product.id,
                },
              },
              create: {
                id: createWeleticId("wprod_"),
                storeId: run.storeId,
                programId: installation.programId,
                externalId: product.id,
                handle: product.handle,
                title: product.title,
                descriptionHtml: product.descriptionHtml,
                productType: product.productType,
                vendor: product.vendor,
                tags: product.tags,
                collectionExternalIds: collectionsList.map(({ id }) => id),
                featuredImageUrl: product.featuredMedia?.preview?.image?.url,
                status: productStatus(product.status),
                availableForSale:
                  product.status === "ACTIVE" &&
                  variantsList.some(({ availableForSale }) => availableForSale),
                publishedAt: product.publishedAt
                  ? new Date(product.publishedAt)
                  : null,
              },
              update: {
                programId: installation.programId,
                handle: product.handle,
                title: product.title,
                descriptionHtml: product.descriptionHtml,
                productType: product.productType,
                vendor: product.vendor,
                tags: product.tags,
                collectionExternalIds: collectionsList.map(({ id }) => id),
                featuredImageUrl: product.featuredMedia?.preview?.image?.url,
                status: productStatus(product.status),
                availableForSale:
                  product.status === "ACTIVE" &&
                  variantsList.some(({ availableForSale }) => availableForSale),
                publishedAt: product.publishedAt
                  ? new Date(product.publishedAt)
                  : null,
              },
            }),
        });

        for (let offset = 0; offset < variantsList.length; offset += 20) {
          const variants = variantsList.slice(offset, offset + 20);
          await withCurrentCatalogWriteFence({
            action: "catalog_sync_variants",
            operation: async (tx) => {
              for (const variant of variants) {
                await tx.weleticShopifyVariant.upsert({
                  where: {
                    productId_externalId: {
                      productId: savedProduct.id,
                      externalId: variant.id,
                    },
                  },
                  create: {
                    id: createWeleticId("wvar_"),
                    productId: savedProduct.id,
                    externalId: variant.id,
                    title: variant.title,
                    sku: variant.sku,
                    barcode: variant.barcode,
                    options: variant.selectedOptions,
                    imageUrl: variant.image?.url,
                    availableForSale: variant.availableForSale,
                    inventoryQuantity: variant.inventoryQuantity,
                    shopPrice: decimalToMinorUnits(variant.price, shopCurrency),
                    shopCompareAtPrice: variant.compareAtPrice
                      ? decimalToMinorUnits(
                          variant.compareAtPrice,
                          shopCurrency,
                        )
                      : null,
                    shopCurrency,
                  },
                  update: {
                    productId: savedProduct.id,
                    title: variant.title,
                    sku: variant.sku,
                    barcode: variant.barcode,
                    options: variant.selectedOptions,
                    imageUrl: variant.image?.url,
                    availableForSale: variant.availableForSale,
                    inventoryQuantity: variant.inventoryQuantity,
                    shopPrice: decimalToMinorUnits(variant.price, shopCurrency),
                    shopCompareAtPrice: variant.compareAtPrice
                      ? decimalToMinorUnits(
                          variant.compareAtPrice,
                          shopCurrency,
                        )
                      : null,
                    shopCurrency,
                  },
                });
              }
            },
          });
        }

        await upsertTranslations({
          storeId: run.storeId,
          productId: savedProduct.id,
          locale: "vi",
          translations: product.vi,
          marketIds,
          expectedCurrencyGeneration: catalogPersistedCurrencyGeneration,
          expectedInstallationGeneration: catalogInstallationGeneration,
        });
        await upsertTranslations({
          storeId: run.storeId,
          productId: savedProduct.id,
          locale: "ja",
          translations: product.ja,
          marketIds,
          expectedCurrencyGeneration: catalogPersistedCurrencyGeneration,
          expectedInstallationGeneration: catalogInstallationGeneration,
        });
        seenProductIds.push(savedProduct.id);
        stats.products += 1;
        stats.variants += variantsList.length;
      }

      cursor = productData.products.pageInfo.endCursor;
      hasNextPage = productData.products.pageInfo.hasNextPage;
      await withCurrentCatalogWriteFence({
        action: "catalog_sync_cursor",
        operation: (tx) =>
          tx.weleticShopifySyncRun.update({
            where: { id: run.id },
            data: { cursor, stats },
          }),
      });
    }

    for (const market of marketCountries) {
      let priceCursor: string | null = null;
      let hasMorePrices = true;
      while (hasMorePrices) {
        const priceData = await shopifyAdminGraphql<{
          productVariants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              contextualPricing: {
                price: { amount: string; currencyCode: string };
                compareAtPrice?: {
                  amount: string;
                  currencyCode: string;
                } | null;
              };
            }>;
          };
        }>({
          shopifyStoreId: installation.shopDomain,
          accessToken: installation.accessToken,
          query: MARKET_PRICES_QUERY,
          variables: { after: priceCursor, country: market.countryCode },
        });

        const variantMap = new Map(
          (
            await prisma.weleticShopifyVariant.findMany({
              where: {
                externalId: {
                  in: priceData.productVariants.nodes.map(({ id }) => id),
                },
                product: { storeId: run.storeId },
              },
              select: { id: true, externalId: true },
            })
          ).map((variant) => [variant.externalId, variant.id]),
        );

        const targetMarketCurrency = normalizeCurrency(
          marketCurrencies.get(market.id) || shopCurrency,
        );
        const marketPriceWrites: Array<{
          variantId: string;
          amount: bigint;
          compareAtAmount: bigint | null;
          currency: string;
        }> = [];

        for (const variant of priceData.productVariants.nodes) {
          const variantId = variantMap.get(variant.id);
          if (!variantId) continue;
          const price = variant.contextualPricing.price;
          const returnedCurrency = normalizeCurrency(price.currencyCode);

          let finalCurrency = returnedCurrency;
          let finalAmount = decimalToMinorUnits(price.amount, returnedCurrency);
          let finalCompareAtAmount = variant.contextualPricing.compareAtPrice
            ? decimalToMinorUnits(
                variant.contextualPricing.compareAtPrice.amount,
                returnedCurrency,
              )
            : null;

          if (
            returnedCurrency !== targetMarketCurrency &&
            targetMarketCurrency !== shopCurrency
          ) {
            try {
              const fx = await getAccountingFxQuote({
                base: returnedCurrency,
                quote: targetMarketCurrency,
              });
              const convertedPrice = convertMoney(
                { amount: finalAmount, currency: returnedCurrency as any },
                fx,
              );
              finalAmount = convertedPrice.amount;
              finalCurrency = targetMarketCurrency;

              if (finalCompareAtAmount !== null) {
                const convertedCompare = convertMoney(
                  {
                    amount: finalCompareAtAmount,
                    currency: returnedCurrency as any,
                  },
                  fx,
                );
                finalCompareAtAmount = convertedCompare.amount;
              }
            } catch {
              // Fallback to returned currency if FX conversion is unavailable
            }
          }

          marketPriceWrites.push({
            variantId,
            amount: finalAmount,
            compareAtAmount: finalCompareAtAmount,
            currency: finalCurrency,
          });
        }

        if (marketPriceWrites.length > 0) {
          for (
            let offset = 0;
            offset < marketPriceWrites.length;
            offset += 20
          ) {
            const prices = marketPriceWrites.slice(offset, offset + 20);
            await withCurrentCatalogWriteFence({
              action: "catalog_sync_market_prices",
              operation: async (tx) => {
                for (const price of prices) {
                  await tx.weleticShopifyMarketPrice.upsert({
                    where: {
                      variantId_marketId_countryCode: {
                        variantId: price.variantId,
                        marketId: market.id,
                        countryCode: market.countryCode,
                      },
                    },
                    create: {
                      id: createWeleticId("wprice_"),
                      variantId: price.variantId,
                      marketId: market.id,
                      countryCode: market.countryCode,
                      amount: price.amount,
                      compareAtAmount: price.compareAtAmount,
                      currency: price.currency,
                      available: true,
                    },
                    update: {
                      amount: price.amount,
                      compareAtAmount: price.compareAtAmount,
                      currency: price.currency,
                      available: true,
                    },
                  });
                }
              },
            });
          }
          stats.marketPrices += marketPriceWrites.length;
        }

        priceCursor = priceData.productVariants.pageInfo.endCursor;
        hasMorePrices = priceData.productVariants.pageInfo.hasNextPage;
      }
    }

    // Retirement / cleanup happens strictly after all remote pages and market
    // prices complete successfully. Keep each transaction bounded so a
    // compliance freeze is never delayed behind the full catalog size.
    await withCurrentCatalogWriteFence({
      action: "catalog_sync_retire_roots",
      operation: async (tx) => {
        await tx.weleticShopifyMarket.updateMany({
          where: {
            storeId: run.storeId,
            updatedAt: { lt: syncStartedAt },
          },
          data: { enabled: false, primary: false },
        });
        await tx.weleticShopifyProduct.updateMany({
          where: {
            storeId: run.storeId,
            updatedAt: { lt: syncStartedAt },
          },
          data: { availableForSale: false, status: "archived" },
        });
      },
    });

    for (let offset = 0; offset < seenProductIds.length; offset += 50) {
      const productIds = seenProductIds.slice(offset, offset + 50);
      await withCurrentCatalogWriteFence({
        action: "catalog_sync_retire_product_children",
        operation: async (tx) => {
          for (const productId of productIds) {
            await tx.weleticShopifyVariant.updateMany({
              where: {
                productId,
                updatedAt: { lt: syncStartedAt },
              },
              data: { availableForSale: false },
            });
            await tx.weleticShopifyTranslation.deleteMany({
              where: {
                productId,
                updatedAt: { lt: syncStartedAt },
              },
            });
          }
        },
      });
    }

    for (let offset = 0; offset < marketCountries.length; offset += 50) {
      const markets = marketCountries.slice(offset, offset + 50);
      await withCurrentCatalogWriteFence({
        action: "catalog_sync_retire_market_prices",
        operation: async (tx) => {
          for (const market of markets) {
            await tx.weleticShopifyMarketPrice.updateMany({
              where: {
                marketId: market.id,
                countryCode: market.countryCode,
                updatedAt: { lt: syncStartedAt },
              },
              data: { available: false },
            });
          }
        },
      });
    }

    const countryCodeScopes = [...countryCodesByMarket];
    for (let offset = 0; offset < countryCodeScopes.length; offset += 50) {
      const scopes = countryCodeScopes.slice(offset, offset + 50);
      await withCurrentCatalogWriteFence({
        action: "catalog_sync_retire_market_scopes",
        operation: async (tx) => {
          for (const [marketId, countryCodes] of scopes) {
            await tx.weleticShopifyMarketPrice.updateMany({
              where: {
                marketId,
                ...(countryCodes.length
                  ? { countryCode: { notIn: countryCodes } }
                  : {}),
              },
              data: { available: false },
            });
          }
        },
      });
    }

    const completedAt = new Date();
    await withCurrentCatalogWriteFence({
      action: "catalog_sync_complete",
      operation: async (tx) => {
        await tx.weleticShopifySyncRun.update({
          where: { id: run.id },
          data: {
            status: WeleticSyncStatus.succeeded,
            stats,
            cursor: null,
            completedAt,
          },
        });
        await tx.weleticShopifyStore.update({
          where: { id: run.storeId },
          data: {
            syncStatus: WeleticSyncStatus.succeeded,
            lastFullSyncAt: completedAt,
            lastSyncError: null,
          },
        });
      },
    });

    return { runId: run.id, stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await prisma.weleticShopifySyncRun.updateMany({
        where: {
          id: run.id,
          status: WeleticSyncStatus.running,
        },
        data: {
          status: WeleticSyncStatus.failed,
          error: message,
          stats,
          completedAt: new Date(),
        },
      });
    } catch {
      // Failure bookkeeping is best effort and must not replace the original
      // catalog error. A compliance drain may already have removed the run.
    }
    try {
      await withCatalogWriteFence({
        storeId: run.storeId,
        action: "catalog_sync_failed",
        expectedCurrencyGeneration: catalogPersistedCurrencyGeneration,
        expectedInstallationGeneration: catalogInstallationGeneration,
        operation: async (tx) => {
          await tx.weleticShopifyStore.update({
            where: { id: run.storeId },
            data: {
              syncStatus: WeleticSyncStatus.failed,
              lastSyncError: message,
            },
          });
        },
      });
    } catch {
      // A newer install/currency generation or a compliance freeze owns the
      // store now. The run has its own terminal record, but this stale run must
      // not publish failure metadata onto the current store generation.
    }
    throw error;
  }
}

export async function syncWeleticShopifyCatalog({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const lockKey = `weletic:catalog-sync:${workspaceId}`;
  return await withDistributedLock({
    key: lockKey,
    ttlSeconds: 30 * 60,
    onLocked: () => {
      throw new Error("A Shopify catalog sync is already running.");
    },
    fn: async () => {
      await assertShopifyStoreAcceptsOperationalWrites({
        workspaceId,
        action: "catalog_sync",
        allowMissing: true,
      });
      return await performWeleticShopifyCatalogSync({ workspaceId });
    },
  });
}
