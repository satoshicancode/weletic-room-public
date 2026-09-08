const configuredApiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-07";
if (!/^\d{4}-(01|04|07|10)$/.test(configuredApiVersion)) {
  throw new Error("SHOPIFY_ADMIN_API_VERSION must be a stable YYYY-MM release");
}
export const SHOPIFY_ADMIN_API_VERSION = configuredApiVersion;

const shopDomainPattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export class ShopifyAdminGraphqlError extends Error {
  constructor(
    public code: string,
    message: string,
    public userErrors?: unknown,
  ) {
    super(message);
  }
}

export function getShopifyAdminGraphqlUrl(
  shopifyStoreId: string,
  apiVersion = SHOPIFY_ADMIN_API_VERSION,
) {
  if (!/^\d{4}-(01|04|07|10)$/.test(apiVersion)) {
    throw new Error("Shopify API version must be a stable YYYY-MM release");
  }
  const shopDomain = shopifyStoreId.trim().toLowerCase();
  if (!shopDomainPattern.test(shopDomain)) {
    throw new ShopifyAdminGraphqlError(
      "invalid_shop",
      "Shopify store domain must be a valid myshopify.com hostname.",
    );
  }

  const configuredProxy =
    process.env.NODE_ENV === "development"
      ? process.env.SHOPIFY_ADMIN_GRAPHQL_PROXY_URL?.trim()
      : undefined;
  if (configuredProxy) {
    const proxyUrl = new URL(configuredProxy);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error("SHOPIFY_ADMIN_GRAPHQL_PROXY_URL must use HTTP or HTTPS");
    }
    proxyUrl.searchParams.set("api_version", apiVersion);
    return proxyUrl.toString();
  }

  return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
}

export async function shopifyAdminGraphql<T>({
  shopifyStoreId,
  accessToken,
  apiVersion,
  query,
  variables,
  allowSdkFallback = true,
}: {
  shopifyStoreId: string;
  accessToken: string;
  apiVersion?: string;
  query: string;
  variables?: Record<string, unknown>;
  allowSdkFallback?: boolean;
}): Promise<T> {
  const shopDomain = shopifyStoreId.trim().toLowerCase();

  // 1. Try direct fetch first
  try {
    const url = getShopifyAdminGraphqlUrl(shopDomain, apiVersion);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      const json = await response.json();
      if (json.errors?.length) {
        throw new ShopifyAdminGraphqlError(
          "graphql_error",
          json.errors[0].message,
          json.errors,
        );
      }
      return json.data as T;
    }

    if (response.status !== 401) {
      throw new ShopifyAdminGraphqlError(
        "http_error",
        `Shopify Admin API error: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    if (!allowSdkFallback) throw error;
    if (
      error instanceof ShopifyAdminGraphqlError &&
      error.code !== "unauthorized"
    ) {
      throw error;
    }
  }

  if (!allowSdkFallback) {
    throw new ShopifyAdminGraphqlError(
      "unauthorized",
      "Shopify Admin API rejected the destructive direct request.",
    );
  }

  // 2. Auto-Heal: If direct fetch failed with 401, fallback to Shopify App SDK unauthenticated client
  try {
    const { unauthenticated } = await import(
      "../../../../../packages/shopify-app/app/shopify.server"
    );
    const { admin } = await unauthenticated.admin(shopDomain);
    const sdkResponse = await admin.graphql(query, {
      variables: variables as any,
    });
    const sdkJson = (await sdkResponse.json()) as any;

    if (sdkJson?.errors?.length) {
      throw new ShopifyAdminGraphqlError(
        "graphql_error",
        sdkJson.errors[0].message,
        sdkJson.errors,
      );
    }

    return sdkJson.data as T;
  } catch (sdkError) {
    if (sdkError instanceof ShopifyAdminGraphqlError) {
      throw sdkError;
    }
    console.error("[Shopify GraphQL Auto-Heal Error]", sdkError);
    throw new ShopifyAdminGraphqlError(
      "unauthorized",
      "Shopify Admin API error: 401 Unauthorized",
    );
  }

  throw new ShopifyAdminGraphqlError(
    "unauthorized",
    "Shopify Admin API error: 401 Unauthorized",
  );
}
