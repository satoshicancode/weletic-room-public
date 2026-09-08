import { decryptOrPassthrough } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { decimalToMinorUnits, minorUnitsToDecimal } from "@/lib/weletic/money";
import {
  resolveShopifyStoreByDomain,
  verifyAndBindShopifyIntegrationCredential,
} from "@/lib/weletic/shopify/store-resolver";
import {
  fetchShopifyTokenAuthorityCredential,
  isShopifyTokenAuthorityConfigured,
  ShopifyTokenAuthorityError,
} from "@/lib/weletic/shopify/token-authority";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";

export const SHOPIFY_DISCOUNT_API_VERSION =
  process.env.SHOPIFY_ADMIN_API_VERSION || "2026-07";
export const SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS = 15_000;
export const WELETIC_FREE_PRODUCT_FUNCTION_HANDLE = "weletic-free-product";
export const WELETIC_FREE_PRODUCT_METAFIELD_NAMESPACE = "weletic";
export const WELETIC_FREE_PRODUCT_METAFIELD_KEY = "free-product-config";
const TRUSTED_RESOLVED_SHOPIFY_CREDENTIALS = Symbol(
  "trusted-resolved-shopify-credentials",
);

type TrustedResolvedShopifyCredentials = ResolvedShopifyCredentials & {
  readonly [TRUSTED_RESOLVED_SHOPIFY_CREDENTIALS]: true;
};

export class ShopifyDiscountError extends Error {
  constructor(
    public code:
      | "THROTTLED"
      | "AUTH_EXPIRED"
      | "MISSING_STORE_DOMAIN"
      | "INVALID_REQUEST"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "GRAPHQL_USER_ERROR"
      | "REMOTE_OUTCOME_UNKNOWN"
      | "NETWORK_ERROR",
    message: string,
    public userErrors?: Array<{
      field?: string[] | string;
      message: string;
      code?: string;
    }>,
  ) {
    super(message);
    this.name = "ShopifyDiscountError";
  }
}

export interface ResolvedShopifyCredentials {
  shopDomain: string;
  accessToken: string;
  scope?: string;
  source:
    | "env_override"
    | "token_authority"
    | "app_session"
    | "installed_integration"
    | "store_resolver";
  readonly [TRUSTED_RESOLVED_SHOPIFY_CREDENTIALS]?: true;
}

function trustedResolvedShopifyCredentials(
  credentials: Omit<
    ResolvedShopifyCredentials,
    typeof TRUSTED_RESOLVED_SHOPIFY_CREDENTIALS
  >,
): TrustedResolvedShopifyCredentials {
  return {
    ...credentials,
    [TRUSTED_RESOLVED_SHOPIFY_CREDENTIALS]: true,
  };
}

function canonicalShopDomain(value: string) {
  const cleanDomain = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const baseDomain = cleanDomain.replace(/\.myshopify\.com$/, "");
  return `${baseDomain}.myshopify.com`;
}

/**
 * Resolves Shopify offline access credentials through an exact tenant binding.
 * Production uses the standalone Shopify app as the refreshable token authority;
 * copied session and integration records remain non-production fallbacks only.
 */
export async function resolveShopifyOfflineCredentials(params: {
  storeId?: string;
  shopDomain?: string;
  workspaceId?: string;
  customFetch?: typeof fetch;
  tokenAuthorityFetch?: typeof fetch;
}): Promise<ResolvedShopifyCredentials> {
  const { storeId, shopDomain, workspaceId, customFetch, tokenAuthorityFetch } =
    params;

  // 1. A single environment token is safe only for non-production validation
  // against an explicitly named shop. Production always resolves the exact
  // tenant's persisted offline session.
  const envToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  if (envToken && shopDomain && process.env.NODE_ENV !== "production") {
    return trustedResolvedShopifyCredentials({
      shopDomain: canonicalShopDomain(shopDomain),
      accessToken: envToken,
      scope: "read_discounts,write_discounts,read_customers,write_customers",
      source: "env_override",
    });
  }

  // 2. Resolve only through unique tenant keys. A store ID is never treated as
  // a workspace ID (or rewritten) because that creates ambiguous cross-tenant
  // credential resolution.
  let resolvedDomain = shopDomain;
  let resolvedProjectId = workspaceId;
  let exactStore:
    | {
        id: string;
        shopDomain: string;
        projectId: string;
        installationGeneration: string | null;
      }
    | null
    | undefined;

  if (storeId) {
    exactStore = await prisma.weleticShopifyStore.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        shopDomain: true,
        projectId: true,
        installationGeneration: true,
      },
    });
  } else if (workspaceId) {
    exactStore = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspaceId },
      select: {
        id: true,
        shopDomain: true,
        projectId: true,
        installationGeneration: true,
      },
    });
  }

  if ((storeId || workspaceId) && !exactStore) {
    throw new ShopifyDiscountError(
      "NOT_FOUND",
      "The requested Shopify store is not connected.",
    );
  }

  if (exactStore) {
    if (workspaceId && exactStore.projectId !== workspaceId) {
      throw new ShopifyDiscountError(
        "UNAUTHORIZED",
        "The Shopify store does not belong to the requested workspace.",
      );
    }
    if (
      shopDomain &&
      canonicalShopDomain(shopDomain) !==
        canonicalShopDomain(exactStore.shopDomain)
    ) {
      throw new ShopifyDiscountError(
        "UNAUTHORIZED",
        "The Shopify domain does not match the requested store.",
      );
    }

    resolvedDomain = exactStore.shopDomain;
    resolvedProjectId = exactStore.projectId;
  }

  if (!resolvedDomain) {
    throw new ShopifyDiscountError(
      "MISSING_STORE_DOMAIN",
      "Unable to resolve Shopify store domain for discount operation.",
    );
  }

  const fullDomain = canonicalShopDomain(resolvedDomain);

  if (envToken && process.env.NODE_ENV !== "production") {
    return trustedResolvedShopifyCredentials({
      shopDomain: fullDomain,
      accessToken: envToken,
      scope: "read_discounts,write_discounts,read_customers,write_customers",
      source: "env_override",
    });
  }

  // 3. The standalone Shopify app is the production token authority. Its
  // official Shopify library refreshes expiring offline sessions and returns
  // only the current access token over the signed internal channel.
  let tokenAuthorityConfigured = false;
  try {
    tokenAuthorityConfigured = isShopifyTokenAuthorityConfigured();
  } catch (error) {
    if (error instanceof ShopifyTokenAuthorityError) {
      throw new ShopifyDiscountError(error.code, error.message);
    }
    throw new ShopifyDiscountError(
      "NETWORK_ERROR",
      "Shopify token authority is unavailable.",
    );
  }
  if (tokenAuthorityConfigured) {
    try {
      const credential = await fetchShopifyTokenAuthorityCredential({
        shopDomain: fullDomain,
        customFetch: tokenAuthorityFetch,
      });
      return trustedResolvedShopifyCredentials({
        shopDomain: credential.shopDomain,
        accessToken: credential.accessToken,
        scope: credential.scope,
        source: "token_authority",
      });
    } catch (error) {
      if (error instanceof ShopifyTokenAuthorityError) {
        throw new ShopifyDiscountError(error.code, error.message);
      }
      throw new ShopifyDiscountError(
        "NETWORK_ERROR",
        "Shopify token authority is unavailable.",
      );
    }
  }

  // 4. InstalledIntegration is the only local versioned credential authority.
  // Session refresh publishes its token into this row under the exact prior
  // token hash; reading the app-session payload directly could reuse a stale
  // same-generation token from another process.
  if (resolvedProjectId) {
    const installation = await prisma.installedIntegration.findFirst({
      where: {
        projectId: resolvedProjectId,
        integrationId: SHOPIFY_INTEGRATION_ID,
      },
    });

    if (installation?.credentials) {
      const boundCredentials = await verifyAndBindShopifyIntegrationCredential({
        installation,
        expectedStore: {
          id: exactStore!.id,
          installationGeneration: exactStore!.installationGeneration,
        },
        expectedShopDomain: fullDomain,
        customFetch,
      });
      const rawCreds = (boundCredentials || {}) as Record<string, any>;
      const token = rawCreds.accessToken
        ? decryptOrPassthrough(rawCreds.accessToken)
        : null;
      const credentialDomain =
        typeof rawCreds.shop === "string" && rawCreds.shop.trim()
          ? canonicalShopDomain(rawCreds.shop)
          : null;

      if (token && credentialDomain === fullDomain) {
        return trustedResolvedShopifyCredentials({
          shopDomain: fullDomain,
          accessToken: token,
          scope: String(rawCreds.scope || "write_discounts"),
          source: "installed_integration",
        });
      }
    }
  }

  // 5. Fallback to canonical store resolver. It also re-reads and validates the
  // current InstalledIntegration credential on every invocation.
  const storeResolved = await resolveShopifyStoreByDomain(fullDomain);
  if (storeResolved?.accessToken) {
    return trustedResolvedShopifyCredentials({
      shopDomain: storeResolved.myshopifyDomain || fullDomain,
      accessToken: storeResolved.accessToken,
      source: "store_resolver",
    });
  }

  throw new ShopifyDiscountError(
    "AUTH_EXPIRED",
    `No active Shopify offline access token found for store ${fullDomain}. Please re-authenticate the Shopify app.`,
  );
}

/**
 * Executes a pure Shopify Admin GraphQL query with rate limiting and exponential backoff retry.
 */
export async function shopifyAdminGraphqlRequest<T = any>(params: {
  shopDomain: string;
  accessToken: string;
  query: string;
  variables?: Record<string, any>;
  customFetch?: typeof fetch;
  maxRetries?: number;
  requestTimeoutMs?: number;
  /** A mutation may have committed even when Shopify returns an unusable
   * GraphQL envelope. Callers must reconcile its deterministic identity
   * instead of treating that response as proof that no remote object exists. */
  postDispatchOutcomeUnknown?: boolean;
}): Promise<T> {
  const {
    shopDomain,
    accessToken,
    query,
    variables,
    customFetch,
    maxRetries = 3,
    requestTimeoutMs = SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS,
    postDispatchOutcomeUnknown = false,
  } = params;

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Shopify GraphQL request timeout must be a positive number.",
    );
  }

  const cleanDomain = shopDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const endpoint = `https://${cleanDomain}/admin/api/${SHOPIFY_DISCOUNT_API_VERSION}/graphql.json`;
  const fetchFn = customFetch || (typeof fetch !== "undefined" ? fetch : null);

  if (!fetchFn) {
    throw new ShopifyDiscountError(
      "NETWORK_ERROR",
      "No fetch implementation available for GraphQL request.",
    );
  }

  const abortController = new AbortController();
  const timeoutError = () =>
    new ShopifyDiscountError(
      "NETWORK_ERROR",
      `Shopify Admin GraphQL request timed out after ${requestTimeoutMs}ms.`,
    );
  const abortableDelay = (delayMs: number) =>
    new Promise<void>((resolve, reject) => {
      if (abortController.signal.aborted) {
        reject(timeoutError());
        return;
      }
      const timer = setTimeout(() => {
        abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(timeoutError());
      };
      abortController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });

  const executeRequest = async () => {
    let attempt = 0;
    while (attempt <= maxRetries) {
      attempt++;
      try {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: abortController.signal,
        });

        // 429 Too Many Requests
        if (res.status === 429) {
          if (attempt <= maxRetries) {
            const retryAfterSec = parseFloat(
              res.headers?.get("Retry-After") || "2",
            );
            const backoffMs =
              Math.max(1000, retryAfterSec * 1000) + Math.random() * 500;
            await abortableDelay(backoffMs);
            continue;
          }
          throw new ShopifyDiscountError(
            "THROTTLED",
            `Shopify GraphQL rate limit exceeded (HTTP 429) after ${maxRetries} attempts.`,
          );
        }

        if (res.status === 401 || res.status === 403) {
          throw new ShopifyDiscountError(
            "UNAUTHORIZED",
            `Shopify Admin API returned HTTP ${res.status}: Access token invalid or expired.`,
          );
        }

        if (!res.ok) {
          throw new ShopifyDiscountError(
            "NETWORK_ERROR",
            `Shopify Admin GraphQL request failed with HTTP status ${res.status} ${res.statusText}.`,
          );
        }

        const json = await res.json();

        // Check extensions cost throttle
        const throttleStatus = json?.extensions?.cost?.throttleStatus;
        if (
          throttleStatus &&
          throttleStatus.currentlyAvailable < 0 &&
          attempt <= maxRetries
        ) {
          const restoreRate = throttleStatus.restoreRate || 50;
          const required = Math.abs(throttleStatus.currentlyAvailable);
          const waitMs = Math.ceil((required / restoreRate) * 1000) + 200;
          await abortableDelay(waitMs);
          continue;
        }

        if (json.errors && json.errors.length > 0) {
          const isThrottled = json.errors.some(
            (e: any) =>
              e.extensions?.code === "THROTTLED" ||
              e.message?.toLowerCase().includes("throttled"),
          );
          if (isThrottled && attempt <= maxRetries) {
            const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            await abortableDelay(backoffMs);
            continue;
          }

          throw new ShopifyDiscountError(
            isThrottled
              ? "THROTTLED"
              : postDispatchOutcomeUnknown
                ? "REMOTE_OUTCOME_UNKNOWN"
                : "GRAPHQL_USER_ERROR",
            json.errors.map((e: any) => e.message).join("; "),
            json.errors,
          );
        }

        return json.data as T;
      } catch (err: any) {
        if (abortController.signal.aborted) {
          throw timeoutError();
        }
        if (err instanceof ShopifyDiscountError) {
          throw err;
        }
        if (attempt > maxRetries) {
          throw new ShopifyDiscountError(
            "NETWORK_ERROR",
            `Network error contacting Shopify GraphQL Admin API: ${err?.message || String(err)}`,
          );
        }
        const backoffMs = Math.pow(2, attempt) * 500 + Math.random() * 200;
        await abortableDelay(backoffMs);
      }
    }

    throw new ShopifyDiscountError(
      "NETWORK_ERROR",
      "Shopify GraphQL request exhausted maximum retries.",
    );
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const requestDeadline = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      reject(timeoutError());
    }, requestTimeoutMs);
  });

  try {
    return await Promise.race([executeRequest(), requestDeadline]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

// ============================================================================
// GraphQL Mutations & Queries
// ============================================================================

export const DISCOUNT_CODE_BASIC_CREATE_MUTATION = `
mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          summary
          status
          startsAt
          endsAt
          codes(first: 10) {
            nodes {
              id
              code
              asyncUsageCount
            }
          }
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

export const DISCOUNT_CODE_FREE_SHIPPING_CREATE_MUTATION = `
mutation DiscountCodeFreeShippingCreate($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
  discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeFreeShipping {
          title
          summary
          status
          startsAt
          endsAt
          codes(first: 10) {
            nodes {
              id
              code
              asyncUsageCount
            }
          }
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

export const DISCOUNT_CODE_BXGY_CREATE_MUTATION = `
mutation DiscountCodeBxgyCreate($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
  discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBxgy {
          title
          summary
          status
          startsAt
          endsAt
          codes(first: 10) {
            nodes {
              id
              code
              asyncUsageCount
            }
          }
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

export const DISCOUNT_CODE_APP_CREATE_MUTATION = `
mutation DiscountCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
  discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
    codeAppDiscount {
      discountId
      title
      status
      codes(first: 10) {
        nodes {
          code
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

export const CODE_DISCOUNT_NODE_BY_CODE_QUERY = `
query CodeDiscountNodeByCode($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      ... on DiscountCodeBasic {
        __typename
        title
        status
        startsAt
        endsAt
        usageLimit
        appliesOncePerCustomer
        recurringCycleLimit
        combinesWith {
          orderDiscounts
          productDiscounts
          shippingDiscounts
        }
        customerSelection {
          __typename
          ... on DiscountCustomerAll {
            allCustomers
          }
          ... on DiscountCustomers {
            customers {
              id
            }
          }
        }
        minimumRequirement {
          __typename
          ... on DiscountMinimumSubtotal {
            greaterThanOrEqualToSubtotal {
              amount
              currencyCode
            }
          }
          ... on DiscountMinimumQuantity {
            greaterThanOrEqualToQuantity
          }
        }
        customerGets {
          appliesOnOneTimePurchase
          appliesOnSubscription
          value {
            __typename
            ... on DiscountAmount {
              amount {
                amount
                currencyCode
              }
              appliesOnEachItem
            }
            ... on DiscountPercentage {
              percentage
            }
          }
          items {
            __typename
            ... on AllDiscountItems {
              allItems
            }
            ... on DiscountProducts {
              products(first: 250) {
                nodes { id }
                pageInfo { hasNextPage }
              }
              productVariants(first: 250) {
                nodes { id }
                pageInfo { hasNextPage }
              }
            }
            ... on DiscountCollections {
              collections(first: 250) {
                nodes { id }
                pageInfo { hasNextPage }
              }
            }
          }
        }
        codes(first: 10) {
          nodes {
            id
            code
            asyncUsageCount
          }
        }
      }
      ... on DiscountCodeBxgy {
        title
        status
        codes(first: 10) {
          nodes {
            id
            code
            asyncUsageCount
          }
        }
      }
      ... on DiscountCodeFreeShipping {
        __typename
        title
        status
        startsAt
        endsAt
        usageLimit
        appliesOncePerCustomer
        appliesOnOneTimePurchase
        appliesOnSubscription
        recurringCycleLimit
        maximumShippingPrice {
          amount
          currencyCode
        }
        combinesWith {
          orderDiscounts
          productDiscounts
          shippingDiscounts
        }
        customerSelection {
          __typename
          ... on DiscountCustomerAll {
            allCustomers
          }
          ... on DiscountCustomers {
            customers {
              id
            }
          }
        }
        minimumRequirement {
          __typename
          ... on DiscountMinimumSubtotal {
            greaterThanOrEqualToSubtotal {
              amount
              currencyCode
            }
          }
          ... on DiscountMinimumQuantity {
            greaterThanOrEqualToQuantity
          }
        }
        destinationSelection {
          __typename
          ... on DiscountCountryAll {
            allCountries
          }
          ... on DiscountCountries {
            countries
            includeRestOfWorld
          }
        }
        codes(first: 10) {
          nodes {
            id
            code
            asyncUsageCount
          }
        }
      }
      ... on DiscountCodeApp {
        title
        status
        codes(first: 10) {
          nodes {
            id
            code
            asyncUsageCount
          }
        }
      }
    }
  }
}
`;

export const DISCOUNT_CODE_DEACTIVATE_MUTATION = `
mutation DiscountCodeDeactivate($id: ID!) {
  discountCodeDeactivate(id: $id) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          status
        }
        ... on DiscountCodeBxgy {
          status
        }
        ... on DiscountCodeFreeShipping {
          status
        }
        ... on DiscountCodeApp {
          status
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

export const CODE_DISCOUNT_NODE_STATUS_QUERY = `
query CodeDiscountNodeStatus($id: ID!) {
  codeDiscountNode(id: $id) {
    id
    codeDiscount {
      ... on DiscountCodeBasic {
        status
      }
      ... on DiscountCodeBxgy {
        status
      }
      ... on DiscountCodeFreeShipping {
        status
      }
      ... on DiscountCodeApp {
        status
      }
    }
  }
}
`;

export const DISCOUNT_CODE_DELETE_MUTATION = `
mutation DiscountCodeDelete($id: ID!) {
  discountCodeDelete(id: $id) {
    deletedCodeDiscountId
    userErrors {
      field
      message
      code
    }
  }
}
`;

// ============================================================================
// Input & Result Interfaces
// ============================================================================

export interface ShopifyDiscountCombinesWith {
  orderDiscounts?: boolean;
  productDiscounts?: boolean;
  shippingDiscounts?: boolean;
}

export interface ShopifyDiscountCustomerSelection {
  all?: boolean;
  customerIds?: string[];
}

export interface ShopifyDiscountMinimumRequirement {
  subtotalAmount?: number | string;
  quantity?: number;
}

export interface CreateBasicDiscountInput {
  shopDomain: string;
  accessToken: string;
  code: string;
  title: string;
  valueType: "percentage" | "fixed_amount";
  value: number | string; // e.g. 20 for 20% or a currency-precision decimal string
  startsAt?: Date | string;
  endsAt?: Date | string | null;
  productGids?: string[];
  variantGids?: string[];
  collectionGids?: string[];
  customerSelection?: ShopifyDiscountCustomerSelection;
  minimumRequirement?: ShopifyDiscountMinimumRequirement;
  combinesWith?: ShopifyDiscountCombinesWith;
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  recurringCycleLimit?: number | null;
  customFetch?: typeof fetch;
}

export interface CreateFreeShippingDiscountInput {
  shopDomain: string;
  accessToken: string;
  code: string;
  title: string;
  startsAt?: Date | string;
  endsAt?: Date | string | null;
  destinationCountries?: string[];
  maximumShippingPrice?: number | string | null;
  customerSelection?: ShopifyDiscountCustomerSelection;
  minimumRequirement?: ShopifyDiscountMinimumRequirement;
  combinesWith?: ShopifyDiscountCombinesWith;
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  recurringCycleLimit?: number | null;
  customFetch?: typeof fetch;
}

export interface CreateBxgyDiscountInput {
  shopDomain: string;
  accessToken: string;
  code: string;
  title: string;
  startsAt?: Date | string;
  endsAt?: Date | string | null;
  buyQuantity?: number;
  buyProductGids?: string[];
  buyCollectionGids?: string[];
  getQuantity?: number;
  getProductGids?: string[];
  getCollectionGids?: string[];
  discountEffectType?: "percentage" | "fixed_amount";
  discountEffectValue?: number | string; // 100 for 100% or a currency-precision decimal string
  usesPerOrderLimit?: number;
  customerSelection?: ShopifyDiscountCustomerSelection;
  combinesWith?: ShopifyDiscountCombinesWith;
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  customFetch?: typeof fetch;
}

export interface CreateFreeProductDiscountInput {
  shopDomain: string;
  accessToken: string;
  code: string;
  title: string;
  productGids?: string[];
  variantGids?: string[];
  quantity?: number;
  minimumSubtotal?: number | string | null;
  startsAt?: Date | string;
  endsAt?: Date | string | null;
  customerSelection?: ShopifyDiscountCustomerSelection;
  combinesWith?: ShopifyDiscountCombinesWith;
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  customFetch?: typeof fetch;
}

export interface ShopifyDiscountResult {
  id: string; // e.g. "gid://shopify/DiscountCodeNode/12345678"
  code: string;
  title: string;
  status: string; // "ACTIVE" | "EXPIRED" | "SCHEDULED"
  /** Shopify's eventually-consistent usage counter for the exact code. */
  asyncUsageCount?: number;
  createdAt?: string;
  configuration?: ShopifyDiscountConfiguration;
}

export interface ShopifyDiscountConfiguration {
  kind: "basic" | "free_shipping";
  startsAt: string;
  endsAt: string | null;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  appliesOnOneTimePurchase: boolean;
  appliesOnSubscription: boolean;
  recurringCycleLimit: number | null;
  combinesWith: Required<ShopifyDiscountCombinesWith>;
  customerSelection:
    | { kind: "all" }
    | { kind: "customers"; customerIds: string[] }
    | { kind: "unsupported" };
  minimumRequirement:
    | null
    | { kind: "subtotal"; amount: string; currencyCode: string }
    | { kind: "quantity"; quantity: string }
    | { kind: "unsupported" };
  basicValue?:
    | {
        kind: "amount";
        amount: string;
        currencyCode: string;
        appliesOnEachItem: boolean;
      }
    | { kind: "percentage"; percentage: number }
    | { kind: "unsupported" };
  basicItems?:
    | { kind: "all" }
    | {
        kind: "products";
        productIds: string[];
        variantIds: string[];
        truncated: boolean;
      }
    | {
        kind: "collections";
        collectionIds: string[];
        truncated: boolean;
      }
    | { kind: "unsupported" };
  maximumShippingPrice?: { amount: string; currencyCode: string } | null;
  shippingDestination?:
    | { kind: "all" }
    | {
        kind: "countries";
        countries: string[];
        includeRestOfWorld: boolean;
      }
    | { kind: "unsupported" };
}

export function formatShopifyGid(
  type:
    | "Product"
    | "ProductVariant"
    | "Collection"
    | "Customer"
    | "GiftCard"
    | "StoreCreditAccount"
    | "DiscountCodeNode",
  id: string,
): string {
  if (!id) return "";
  if (id.startsWith(`gid://shopify/${type}/`)) return id;
  const cleanId = id.replace(new RegExp(`^${type}/`), "").replace(/\D+/g, "");
  return `gid://shopify/${type}/${cleanId || id}`;
}

function formatPositiveShopifyDecimal(
  value: number | string,
  fieldName: string,
) {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || Number(normalized) <= 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `${fieldName} must be a positive decimal amount.`,
    );
  }
  if (typeof value === "string") return normalized;
  return Number.isInteger(value) ? value.toFixed(2) : normalized;
}

function canonicalShopifyPercentageFraction(value: number | string) {
  const numericValue = Number(value);
  if (
    !Number.isFinite(numericValue) ||
    numericValue < 1 ||
    numericValue > 100
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Percentage discounts must be between 1 and 100.",
    );
  }
  return Number((numericValue / 100).toFixed(4));
}

// ============================================================================
// Core Pure GraphQL Discount Adapters
// ============================================================================

/**
 * 1. Creates Amount Off or Percentage Off Discount via `discountCodeBasicCreate`
 */
export async function createBasicDiscount(
  input: CreateBasicDiscountInput,
): Promise<ShopifyDiscountResult> {
  const {
    shopDomain,
    accessToken,
    code,
    title,
    valueType,
    value,
    startsAt = new Date(),
    endsAt = null,
    productGids = [],
    variantGids = [],
    collectionGids = [],
    customerSelection = { all: true },
    minimumRequirement,
    combinesWith = {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    usageLimit = 1,
    appliesOncePerCustomer = true,
    recurringCycleLimit,
    customFetch,
  } = input;
  const normalizeScopedIds = (
    type: "Product" | "ProductVariant" | "Collection",
    ids: string[],
  ) => [...new Set(ids.map((id) => formatShopifyGid(type, id)))].sort();
  const normalizedProductGids = normalizeScopedIds("Product", productGids);
  const normalizedVariantGids = normalizeScopedIds(
    "ProductVariant",
    variantGids,
  );
  const normalizedCollectionGids = normalizeScopedIds(
    "Collection",
    collectionGids,
  );

  // Build customerGets value & items
  const isPercentage = valueType === "percentage";
  const percentageFraction = isPercentage
    ? canonicalShopifyPercentageFraction(value)
    : null;
  const fixedAmount = isPercentage
    ? null
    : formatPositiveShopifyDecimal(value, "Fixed discount amount");
  if (
    (normalizedProductGids.length > 0 || normalizedVariantGids.length > 0) &&
    normalizedCollectionGids.length > 0
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Discount item scope must contain products/variants or collections, not both.",
    );
  }
  const customerGetsValue = isPercentage
    ? {
        percentage: percentageFraction,
      }
    : {
        discountAmount: {
          amount: fixedAmount,
          appliesOnEachItem: false,
        },
      };

  let customerGetsItems: any = { all: true };
  if (normalizedProductGids.length > 0 || normalizedVariantGids.length > 0) {
    customerGetsItems = {
      products: {
        ...(normalizedProductGids.length > 0
          ? {
              productsToAdd: normalizedProductGids,
            }
          : {}),
        ...(normalizedVariantGids.length > 0
          ? {
              productVariantsToAdd: normalizedVariantGids,
            }
          : {}),
      },
    };
  } else if (normalizedCollectionGids.length > 0) {
    customerGetsItems = {
      collections: {
        collectionsToAdd: normalizedCollectionGids,
      },
    };
  }

  // Build customerSelection
  let customerSelectionInput: any = { all: true };
  if (
    customerSelection.customerIds &&
    customerSelection.customerIds.length > 0
  ) {
    customerSelectionInput = {
      customers: {
        add: customerSelection.customerIds.map((c) =>
          formatShopifyGid("Customer", c),
        ),
      },
    };
  }

  // Build minimumRequirement
  let minimumRequirementInput: any = null;
  if (
    minimumRequirement?.subtotalAmount &&
    Number(minimumRequirement.subtotalAmount) > 0
  ) {
    minimumRequirementInput = {
      subtotal: {
        greaterThanOrEqualToSubtotal: formatPositiveShopifyDecimal(
          minimumRequirement.subtotalAmount,
          "Minimum subtotal",
        ),
      },
    };
  } else if (
    minimumRequirement?.quantity &&
    Number(minimumRequirement.quantity) > 0
  ) {
    minimumRequirementInput = {
      quantity: {
        greaterThanOrEqualToQuantity: String(
          Number(minimumRequirement.quantity),
        ),
      },
    };
  }

  // Shopify rejects these fields entirely when the shop has no subscription
  // selling plans. Omission gives the native one-time-purchase defaults; only
  // an explicitly recurring reward opts into subscription semantics.
  const subscriptionFields =
    recurringCycleLimit !== undefined && recurringCycleLimit !== null
      ? {
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: true,
        }
      : {};

  const basicCodeDiscount = {
    title,
    code: code.trim().toUpperCase(),
    startsAt:
      startsAt instanceof Date
        ? startsAt.toISOString()
        : new Date(startsAt).toISOString(),
    endsAt: endsAt
      ? endsAt instanceof Date
        ? endsAt.toISOString()
        : new Date(endsAt).toISOString()
      : null,
    customerGets: {
      value: customerGetsValue,
      items: customerGetsItems,
      ...subscriptionFields,
    },
    customerSelection: customerSelectionInput,
    ...(minimumRequirementInput
      ? { minimumRequirement: minimumRequirementInput }
      : {}),
    combinesWith: {
      orderDiscounts: Boolean(combinesWith.orderDiscounts),
      productDiscounts: Boolean(combinesWith.productDiscounts),
      shippingDiscounts: Boolean(combinesWith.shippingDiscounts),
    },
    ...(usageLimit ? { usageLimit: Number(usageLimit) } : {}),
    appliesOncePerCustomer: Boolean(appliesOncePerCustomer),
    ...(recurringCycleLimit !== undefined && recurringCycleLimit !== null
      ? { recurringCycleLimit: Number(recurringCycleLimit) }
      : {}),
  };

  const response = await shopifyAdminGraphqlRequest<{
    discountCodeBasicCreate: {
      codeDiscountNode?: {
        id: string;
        codeDiscount: {
          title: string;
          status: string;
          codes: { nodes: Array<{ id: string; code: string }> };
        };
      } | null;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: DISCOUNT_CODE_BASIC_CREATE_MUTATION,
    variables: { basicCodeDiscount },
    customFetch,
    postDispatchOutcomeUnknown: true,
  });

  const payload = response?.discountCodeBasicCreate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      payload.userErrors.map((e) => e.message).join("; "),
      payload.userErrors,
    );
  }

  const node = payload?.codeDiscountNode;
  if (!node?.id) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      "Shopify did not return a valid DiscountCodeNode ID for basic discount.",
    );
  }

  return {
    id: node.id,
    code: node.codeDiscount?.codes?.nodes?.[0]?.code || code,
    title: node.codeDiscount?.title || title,
    status: node.codeDiscount?.status || "ACTIVE",
  };
}

/**
 * 2. Creates Free Shipping Discount via `discountCodeFreeShippingCreate`
 */
export async function createFreeShippingDiscount(
  input: CreateFreeShippingDiscountInput,
): Promise<ShopifyDiscountResult> {
  const {
    shopDomain,
    accessToken,
    code,
    title,
    startsAt = new Date(),
    endsAt = null,
    destinationCountries = [],
    maximumShippingPrice = null,
    customerSelection = { all: true },
    minimumRequirement,
    combinesWith = {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    usageLimit = 1,
    appliesOncePerCustomer = true,
    recurringCycleLimit,
    customFetch,
  } = input;

  let destinationInput: any = { all: true };
  if (destinationCountries && destinationCountries.length > 0) {
    destinationInput = {
      countries: {
        add: destinationCountries,
        includeRestOfWorld: false,
      },
    };
  }

  let customerSelectionInput: any = { all: true };
  if (
    customerSelection.customerIds &&
    customerSelection.customerIds.length > 0
  ) {
    customerSelectionInput = {
      customers: {
        add: customerSelection.customerIds.map((c) =>
          formatShopifyGid("Customer", c),
        ),
      },
    };
  }

  let minimumRequirementInput: any = null;
  if (
    minimumRequirement?.subtotalAmount &&
    Number(minimumRequirement.subtotalAmount) > 0
  ) {
    minimumRequirementInput = {
      subtotal: {
        greaterThanOrEqualToSubtotal: formatPositiveShopifyDecimal(
          minimumRequirement.subtotalAmount,
          "Minimum subtotal",
        ),
      },
    };
  } else if (
    minimumRequirement?.quantity &&
    Number(minimumRequirement.quantity) > 0
  ) {
    minimumRequirementInput = {
      quantity: {
        greaterThanOrEqualToQuantity: String(
          Number(minimumRequirement.quantity),
        ),
      },
    };
  }

  // Keep Shopify Basic/non-subscription stores on native one-time defaults.
  // Supplying explicit false/true flags is not accepted until the shop uses
  // subscriptions, so only recurring rewards include this input surface.
  const subscriptionFields =
    recurringCycleLimit !== undefined && recurringCycleLimit !== null
      ? {
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: true,
        }
      : {};

  const freeShippingCodeDiscount = {
    title,
    code: code.trim().toUpperCase(),
    startsAt:
      startsAt instanceof Date
        ? startsAt.toISOString()
        : new Date(startsAt).toISOString(),
    endsAt: endsAt
      ? endsAt instanceof Date
        ? endsAt.toISOString()
        : new Date(endsAt).toISOString()
      : null,
    destination: destinationInput,
    ...(maximumShippingPrice !== null &&
    maximumShippingPrice !== undefined &&
    Number(maximumShippingPrice) > 0
      ? {
          maximumShippingPrice: formatPositiveShopifyDecimal(
            maximumShippingPrice,
            "Maximum shipping price",
          ),
        }
      : {}),
    customerSelection: customerSelectionInput,
    ...(minimumRequirementInput
      ? { minimumRequirement: minimumRequirementInput }
      : {}),
    combinesWith: {
      orderDiscounts: Boolean(combinesWith.orderDiscounts),
      productDiscounts: Boolean(combinesWith.productDiscounts),
      shippingDiscounts: Boolean(combinesWith.shippingDiscounts),
    },
    ...(usageLimit ? { usageLimit: Number(usageLimit) } : {}),
    appliesOncePerCustomer: Boolean(appliesOncePerCustomer),
    ...subscriptionFields,
    ...(recurringCycleLimit !== undefined && recurringCycleLimit !== null
      ? { recurringCycleLimit: Number(recurringCycleLimit) }
      : {}),
  };

  const response = await shopifyAdminGraphqlRequest<{
    discountCodeFreeShippingCreate: {
      codeDiscountNode?: {
        id: string;
        codeDiscount: {
          title: string;
          status: string;
          codes: { nodes: Array<{ id: string; code: string }> };
        };
      } | null;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: DISCOUNT_CODE_FREE_SHIPPING_CREATE_MUTATION,
    variables: { freeShippingCodeDiscount },
    customFetch,
    postDispatchOutcomeUnknown: true,
  });

  const payload = response?.discountCodeFreeShippingCreate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      payload.userErrors.map((e) => e.message).join("; "),
      payload.userErrors,
    );
  }

  const node = payload?.codeDiscountNode;
  if (!node?.id) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      "Shopify did not return a valid DiscountCodeNode ID for free shipping discount.",
    );
  }

  return {
    id: node.id,
    code: node.codeDiscount?.codes?.nodes?.[0]?.code || code,
    title: node.codeDiscount?.title || title,
    status: node.codeDiscount?.status || "ACTIVE",
  };
}

/**
 * 3. Creates BXGY (Buy X Get Y / Free Gift) Discount via `discountCodeBxgyCreate`
 */
export async function createBxgyDiscount(
  input: CreateBxgyDiscountInput,
): Promise<ShopifyDiscountResult> {
  const {
    shopDomain,
    accessToken,
    code,
    title,
    startsAt = new Date(),
    endsAt = null,
    buyQuantity = 1,
    buyProductGids = [],
    buyCollectionGids = [],
    getQuantity = 1,
    getProductGids = [],
    getCollectionGids = [],
    discountEffectType = "percentage",
    discountEffectValue = 100, // default 100% free gift
    usesPerOrderLimit = 1,
    customerSelection = { all: true },
    combinesWith = {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    usageLimit = 1,
    appliesOncePerCustomer = true,
    customFetch,
  } = input;

  if (buyProductGids.length === 0 && buyCollectionGids.length === 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Buy X Get Y discounts require at least one buy product or collection.",
    );
  }
  if (getProductGids.length === 0 && getCollectionGids.length === 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Buy X Get Y discounts require at least one reward product or collection.",
    );
  }
  if (buyProductGids.length > 0 && buyCollectionGids.length > 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Buy X Get Y prerequisite scope must contain products or collections, not both.",
    );
  }
  if (getProductGids.length > 0 && getCollectionGids.length > 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Buy X Get Y reward scope must contain products or collections, not both.",
    );
  }

  const customerBuysItems =
    buyProductGids.length > 0
      ? {
          products: {
            productsToAdd: buyProductGids.map((g) =>
              formatShopifyGid("Product", g),
            ),
          },
        }
      : {
          collections: {
            collectionsToAdd: buyCollectionGids.map((g) =>
              formatShopifyGid("Collection", g),
            ),
          },
        };

  const customerGetsItems =
    getProductGids.length > 0
      ? {
          products: {
            productsToAdd: getProductGids.map((g) =>
              formatShopifyGid("Product", g),
            ),
          },
        }
      : {
          collections: {
            collectionsToAdd: getCollectionGids.map((g) =>
              formatShopifyGid("Collection", g),
            ),
          },
        };

  const isPercentage = discountEffectType === "percentage";
  if (
    isPercentage &&
    (!Number.isFinite(Number(discountEffectValue)) ||
      Number(discountEffectValue) < 1 ||
      Number(discountEffectValue) > 100)
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Buy X Get Y percentage effects must be between 1 and 100.",
    );
  }
  if (
    !isPercentage &&
    (!Number.isFinite(Number(discountEffectValue)) ||
      Number(discountEffectValue) <= 0)
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Buy X Get Y fixed amount effects must be greater than 0.",
    );
  }
  const effectValue = isPercentage
    ? {
        percentage: Number((Number(discountEffectValue) / 100).toFixed(4)),
      }
    : {
        amount: formatPositiveShopifyDecimal(
          discountEffectValue,
          "Buy X Get Y fixed amount",
        ),
      };

  let customerSelectionInput: any = { all: true };
  if (
    customerSelection.customerIds &&
    customerSelection.customerIds.length > 0
  ) {
    customerSelectionInput = {
      customers: {
        add: customerSelection.customerIds.map((c) =>
          formatShopifyGid("Customer", c),
        ),
      },
    };
  }

  const bxgyCodeDiscount = {
    title,
    code: code.trim().toUpperCase(),
    startsAt:
      startsAt instanceof Date
        ? startsAt.toISOString()
        : new Date(startsAt).toISOString(),
    endsAt: endsAt
      ? endsAt instanceof Date
        ? endsAt.toISOString()
        : new Date(endsAt).toISOString()
      : null,
    customerBuys: {
      value: {
        quantity: String(Number(buyQuantity)),
      },
      items: customerBuysItems,
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: String(Number(getQuantity)),
          effect: effectValue,
        },
      },
      items: customerGetsItems,
    },
    customerSelection: customerSelectionInput,
    usesPerOrderLimit: Number(usesPerOrderLimit),
    combinesWith: {
      orderDiscounts: Boolean(combinesWith.orderDiscounts),
      productDiscounts: Boolean(combinesWith.productDiscounts),
      shippingDiscounts: Boolean(combinesWith.shippingDiscounts),
    },
    ...(usageLimit ? { usageLimit: Number(usageLimit) } : {}),
    appliesOncePerCustomer: Boolean(appliesOncePerCustomer),
  };

  const response = await shopifyAdminGraphqlRequest<{
    discountCodeBxgyCreate: {
      codeDiscountNode?: {
        id: string;
        codeDiscount: {
          title: string;
          status: string;
          codes: { nodes: Array<{ id: string; code: string }> };
        };
      } | null;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: DISCOUNT_CODE_BXGY_CREATE_MUTATION,
    variables: { bxgyCodeDiscount },
    customFetch,
    postDispatchOutcomeUnknown: true,
  });

  const payload = response?.discountCodeBxgyCreate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      payload.userErrors.map((e) => e.message).join("; "),
      payload.userErrors,
    );
  }

  const node = payload?.codeDiscountNode;
  if (!node?.id) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      "Shopify did not return a valid DiscountCodeNode ID for BXGY discount.",
    );
  }

  return {
    id: node.id,
    code: node.codeDiscount?.codes?.nodes?.[0]?.code || code,
    title: node.codeDiscount?.title || title,
    status: node.codeDiscount?.status || "ACTIVE",
  };
}

/**
 * Creates a quantity-limited 100% product discount backed by the Weletic
 * Shopify Function. The Function reads this versioned metafield at checkout.
 */
export async function createFreeProductDiscount(
  input: CreateFreeProductDiscountInput,
): Promise<ShopifyDiscountResult> {
  const {
    shopDomain,
    accessToken,
    code,
    title,
    productGids = [],
    variantGids = [],
    quantity = 1,
    minimumSubtotal = null,
    startsAt = new Date(),
    endsAt = null,
    customerSelection = { all: true },
    combinesWith = {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    usageLimit = 1,
    appliesOncePerCustomer = true,
    customFetch,
  } = input;

  const normalizeEligibleIds = (
    type: "Product" | "ProductVariant",
    ids: string[],
  ) => {
    if (ids.length > 100) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Free product rewards support at most 100 eligible ${type === "Product" ? "products" : "variants"}.`,
      );
    }
    const gidPattern = new RegExp(`^gid://shopify/${type}/\\d+$`);
    const normalized = ids.map((id) => String(id).trim());
    if (normalized.some((id) => !/^\d+$/.test(id) && !gidPattern.test(id))) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Free product reward contains an invalid Shopify ${type} ID.`,
      );
    }
    return [...new Set(normalized.map((id) => formatShopifyGid(type, id)))];
  };
  const normalizedProductGids = normalizeEligibleIds("Product", productGids);
  const normalizedVariantGids = normalizeEligibleIds(
    "ProductVariant",
    variantGids,
  );
  if (normalizedProductGids.length + normalizedVariantGids.length === 0) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Free product rewards require at least one eligible Shopify product or variant.",
    );
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Free product reward quantity must be an integer between 1 and 100.",
    );
  }

  const minimumSubtotalDecimal =
    minimumSubtotal !== null && minimumSubtotal !== undefined
      ? formatPositiveShopifyDecimal(minimumSubtotal, "Minimum subtotal")
      : null;
  const context =
    customerSelection.customerIds && customerSelection.customerIds.length > 0
      ? {
          customers: {
            add: customerSelection.customerIds.map((id) =>
              formatShopifyGid("Customer", id),
            ),
          },
        }
      : { all: "ALL" };
  const normalizedCode = code.trim().toUpperCase();
  const config = {
    version: 1,
    productIds: normalizedProductGids,
    variantIds: normalizedVariantGids,
    quantity,
    message: title,
    minimumSubtotal: minimumSubtotalDecimal,
  };
  const codeAppDiscount = {
    title,
    code: normalizedCode,
    functionHandle: WELETIC_FREE_PRODUCT_FUNCTION_HANDLE,
    discountClasses: ["PRODUCT"],
    startsAt:
      startsAt instanceof Date
        ? startsAt.toISOString()
        : new Date(startsAt).toISOString(),
    endsAt: endsAt
      ? endsAt instanceof Date
        ? endsAt.toISOString()
        : new Date(endsAt).toISOString()
      : null,
    context,
    combinesWith: {
      orderDiscounts: Boolean(combinesWith.orderDiscounts),
      productDiscounts: Boolean(combinesWith.productDiscounts),
      shippingDiscounts: Boolean(combinesWith.shippingDiscounts),
    },
    ...(usageLimit ? { usageLimit: Number(usageLimit) } : {}),
    appliesOncePerCustomer: Boolean(appliesOncePerCustomer),
    metafields: [
      {
        namespace: WELETIC_FREE_PRODUCT_METAFIELD_NAMESPACE,
        key: WELETIC_FREE_PRODUCT_METAFIELD_KEY,
        type: "json",
        value: JSON.stringify(config),
      },
    ],
  };

  const response = await shopifyAdminGraphqlRequest<{
    discountCodeAppCreate?: {
      codeAppDiscount?: {
        discountId: string;
        title: string;
        status: string;
        codes: { nodes: Array<{ code: string }> };
      } | null;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: DISCOUNT_CODE_APP_CREATE_MUTATION,
    variables: { codeAppDiscount },
    customFetch,
    postDispatchOutcomeUnknown: true,
  });

  const payload = response?.discountCodeAppCreate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      payload.userErrors.map((error) => error.message).join("; "),
      payload.userErrors,
    );
  }
  const discount = payload?.codeAppDiscount;
  if (!discount?.discountId) {
    throw new ShopifyDiscountError(
      "REMOTE_OUTCOME_UNKNOWN",
      "Shopify did not return a valid DiscountCodeNode ID for the free product discount.",
    );
  }

  return {
    id: discount.discountId,
    code: discount.codes?.nodes?.[0]?.code || normalizedCode,
    title: discount.title || title,
    status: discount.status || "ACTIVE",
  };
}

/**
 * 4. Look up existing discount node in Shopify GraphQL by exact code string.
 */
function readRemoteCustomerSelection(value: any) {
  if (value?.__typename === "DiscountCustomerAll" && value.allCustomers) {
    return { kind: "all" as const };
  }
  if (
    value?.__typename === "DiscountCustomers" &&
    Array.isArray(value.customers)
  ) {
    return {
      kind: "customers" as const,
      customerIds: value.customers
        .map((customer: any) => customer?.id)
        .filter((id: unknown): id is string => typeof id === "string"),
    };
  }
  return { kind: "unsupported" as const };
}

function readRemoteMinimumRequirement(value: any) {
  if (value == null) return null;
  if (
    value.__typename === "DiscountMinimumSubtotal" &&
    typeof value.greaterThanOrEqualToSubtotal?.amount === "string" &&
    typeof value.greaterThanOrEqualToSubtotal?.currencyCode === "string"
  ) {
    return {
      kind: "subtotal" as const,
      amount: value.greaterThanOrEqualToSubtotal.amount,
      currencyCode: value.greaterThanOrEqualToSubtotal.currencyCode,
    };
  }
  if (
    value.__typename === "DiscountMinimumQuantity" &&
    value.greaterThanOrEqualToQuantity != null
  ) {
    return {
      kind: "quantity" as const,
      quantity: String(value.greaterThanOrEqualToQuantity),
    };
  }
  return { kind: "unsupported" as const };
}

function readRemoteBasicValue(value: any) {
  if (
    value?.__typename === "DiscountAmount" &&
    typeof value.amount?.amount === "string" &&
    typeof value.amount?.currencyCode === "string" &&
    typeof value.appliesOnEachItem === "boolean"
  ) {
    return {
      kind: "amount" as const,
      amount: value.amount.amount,
      currencyCode: value.amount.currencyCode,
      appliesOnEachItem: value.appliesOnEachItem,
    };
  }
  if (
    value?.__typename === "DiscountPercentage" &&
    typeof value.percentage === "number"
  ) {
    return {
      kind: "percentage" as const,
      percentage: value.percentage,
    };
  }
  return { kind: "unsupported" as const };
}

function readRemoteBasicItems(value: any) {
  if (value?.__typename === "AllDiscountItems" && value.allItems) {
    return { kind: "all" as const };
  }
  if (value?.__typename === "DiscountProducts") {
    return {
      kind: "products" as const,
      productIds: Array.isArray(value.products?.nodes)
        ? value.products.nodes
            .map((node: any) => node?.id)
            .filter((id: unknown): id is string => typeof id === "string")
        : [],
      variantIds: Array.isArray(value.productVariants?.nodes)
        ? value.productVariants.nodes
            .map((node: any) => node?.id)
            .filter((id: unknown): id is string => typeof id === "string")
        : [],
      truncated:
        value.products?.pageInfo?.hasNextPage !== false ||
        value.productVariants?.pageInfo?.hasNextPage !== false,
    };
  }
  if (value?.__typename === "DiscountCollections") {
    return {
      kind: "collections" as const,
      collectionIds: Array.isArray(value.collections?.nodes)
        ? value.collections.nodes
            .map((node: any) => node?.id)
            .filter((id: unknown): id is string => typeof id === "string")
        : [],
      truncated: value.collections?.pageInfo?.hasNextPage !== false,
    };
  }
  return { kind: "unsupported" as const };
}

function readRemoteShippingDestination(value: any) {
  if (value?.__typename === "DiscountCountryAll" && value.allCountries) {
    return { kind: "all" as const };
  }
  if (
    value?.__typename === "DiscountCountries" &&
    Array.isArray(value.countries) &&
    typeof value.includeRestOfWorld === "boolean"
  ) {
    return {
      kind: "countries" as const,
      countries: value.countries.filter(
        (country: unknown): country is string => typeof country === "string",
      ),
      includeRestOfWorld: value.includeRestOfWorld,
    };
  }
  return { kind: "unsupported" as const };
}

function readRemoteDiscountConfiguration(
  discount: any,
): ShopifyDiscountConfiguration | undefined {
  if (
    typeof discount?.startsAt !== "string" ||
    (discount.endsAt !== null && typeof discount.endsAt !== "string") ||
    (discount.usageLimit !== null && !Number.isInteger(discount.usageLimit)) ||
    typeof discount.appliesOncePerCustomer !== "boolean" ||
    (discount.recurringCycleLimit !== null &&
      !Number.isInteger(discount.recurringCycleLimit)) ||
    typeof discount.combinesWith?.orderDiscounts !== "boolean" ||
    typeof discount.combinesWith?.productDiscounts !== "boolean" ||
    typeof discount.combinesWith?.shippingDiscounts !== "boolean"
  ) {
    return undefined;
  }

  const common = {
    startsAt: discount.startsAt,
    endsAt: discount.endsAt,
    usageLimit: discount.usageLimit,
    appliesOncePerCustomer: discount.appliesOncePerCustomer,
    recurringCycleLimit: discount.recurringCycleLimit,
    combinesWith: {
      orderDiscounts: discount.combinesWith.orderDiscounts,
      productDiscounts: discount.combinesWith.productDiscounts,
      shippingDiscounts: discount.combinesWith.shippingDiscounts,
    },
    customerSelection: readRemoteCustomerSelection(discount.customerSelection),
    minimumRequirement: readRemoteMinimumRequirement(
      discount.minimumRequirement,
    ),
  };

  if (discount.__typename === "DiscountCodeBasic") {
    if (
      typeof discount.customerGets?.appliesOnOneTimePurchase !== "boolean" ||
      typeof discount.customerGets?.appliesOnSubscription !== "boolean"
    ) {
      return undefined;
    }
    return {
      kind: "basic",
      ...common,
      appliesOnOneTimePurchase: discount.customerGets.appliesOnOneTimePurchase,
      appliesOnSubscription: discount.customerGets.appliesOnSubscription,
      basicValue: readRemoteBasicValue(discount.customerGets?.value),
      basicItems: readRemoteBasicItems(discount.customerGets?.items),
    };
  }
  if (discount.__typename === "DiscountCodeFreeShipping") {
    if (
      typeof discount.appliesOnOneTimePurchase !== "boolean" ||
      typeof discount.appliesOnSubscription !== "boolean"
    ) {
      return undefined;
    }
    const maximumShippingPrice = discount.maximumShippingPrice;
    if (
      maximumShippingPrice != null &&
      (typeof maximumShippingPrice.amount !== "string" ||
        typeof maximumShippingPrice.currencyCode !== "string")
    ) {
      return undefined;
    }
    return {
      kind: "free_shipping",
      ...common,
      appliesOnOneTimePurchase: discount.appliesOnOneTimePurchase,
      appliesOnSubscription: discount.appliesOnSubscription,
      maximumShippingPrice,
      shippingDestination: readRemoteShippingDestination(
        discount.destinationSelection,
      ),
    };
  }
  return undefined;
}

export async function lookupDiscountByCode(
  shopDomain: string,
  accessToken: string,
  code: string,
  customFetch?: typeof fetch,
): Promise<ShopifyDiscountResult | null> {
  const cleanCode = code.trim().toUpperCase();
  const response = await shopifyAdminGraphqlRequest<{
    codeDiscountNodeByCode?: {
      id: string;
      codeDiscount: {
        title: string;
        status: string;
        codes: {
          nodes: Array<{
            id: string;
            code: string;
            asyncUsageCount?: number | null;
          }>;
        };
      };
    } | null;
  }>({
    shopDomain,
    accessToken,
    query: CODE_DISCOUNT_NODE_BY_CODE_QUERY,
    variables: { code: cleanCode },
    customFetch,
  });

  const node = response?.codeDiscountNodeByCode;
  if (!node?.id) return null;
  const codes = node.codeDiscount?.codes?.nodes || [];
  const matchedCode = codes.find(
    (candidate) => candidate.code.trim().toUpperCase() === cleanCode,
  );

  return {
    id: node.id,
    code: matchedCode?.code || codes[0]?.code || cleanCode,
    title: node.codeDiscount?.title || "",
    status: node.codeDiscount?.status || "ACTIVE",
    ...(Number.isInteger(matchedCode?.asyncUsageCount) &&
    Number(matchedCode?.asyncUsageCount) >= 0
      ? { asyncUsageCount: Number(matchedCode?.asyncUsageCount) }
      : {}),
    configuration: readRemoteDiscountConfiguration(node.codeDiscount),
  };
}

async function lookupDiscountStatusById(
  shopDomain: string,
  accessToken: string,
  discountNodeId: string,
  customFetch?: typeof fetch,
): Promise<{ id: string; status: string | null } | null> {
  const response = await shopifyAdminGraphqlRequest<{
    codeDiscountNode?: {
      id: string;
      codeDiscount?: { status?: string | null } | null;
    } | null;
  }>({
    shopDomain,
    accessToken,
    query: CODE_DISCOUNT_NODE_STATUS_QUERY,
    variables: { id: discountNodeId },
    customFetch,
  });
  const node = response?.codeDiscountNode;
  if (!node?.id) return null;
  return {
    id: node.id,
    status: node.codeDiscount?.status || null,
  };
}

export function isInactiveShopifyDiscountStatus(
  status: string | null | undefined,
) {
  return status === "EXPIRED" || status === "INACTIVE";
}

/**
 * 5. Deactivate a discount code node in Shopify.
 */
export async function deactivateDiscount(
  shopDomain: string,
  accessToken: string,
  discountNodeId: string,
  customFetch?: typeof fetch,
): Promise<boolean> {
  const formattedId = formatShopifyGid("DiscountCodeNode", discountNodeId);
  let requestError: ShopifyDiscountError | null = null;
  let response:
    | {
        discountCodeDeactivate?: {
          codeDiscountNode?: {
            id: string;
            codeDiscount?: { status?: string | null } | null;
          } | null;
          userErrors?: Array<{
            field?: string[];
            message: string;
            code?: string;
          }>;
        };
      }
    | undefined;
  try {
    response = await shopifyAdminGraphqlRequest({
      shopDomain,
      accessToken,
      query: DISCOUNT_CODE_DEACTIVATE_MUTATION,
      variables: { id: formattedId },
      customFetch,
    });
  } catch (error) {
    if (!(error instanceof ShopifyDiscountError)) throw error;
    if (
      error.code === "NETWORK_ERROR" ||
      error.code === "THROTTLED" ||
      error.code === "UNAUTHORIZED" ||
      error.code === "AUTH_EXPIRED"
    ) {
      throw error;
    }
    requestError = error;
  }

  const payload = response?.discountCodeDeactivate;
  if (payload?.codeDiscountNode?.id) {
    return true;
  }

  // Shopify can reject a repeated deactivation or return a null mutation node
  // after the discount was removed elsewhere. Verify the current remote state
  // instead of relying on unstable user-error wording.
  const currentState = await lookupDiscountStatusById(
    shopDomain,
    accessToken,
    formattedId,
    customFetch,
  );
  if (!currentState || isInactiveShopifyDiscountStatus(currentState.status)) {
    return true;
  }

  if (requestError) throw requestError;

  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyDiscountError(
      "GRAPHQL_USER_ERROR",
      payload.userErrors.map((error) => error.message).join("; "),
      payload.userErrors,
    );
  }
  return false;
}

/**
 * 6. Delete a discount code node in Shopify.
 */
export async function deleteDiscount(
  shopDomain: string,
  accessToken: string,
  discountNodeId: string,
  customFetch?: typeof fetch,
): Promise<boolean> {
  const formattedId = formatShopifyGid("DiscountCodeNode", discountNodeId);
  const response = await shopifyAdminGraphqlRequest<{
    discountCodeDelete?: {
      deletedCodeDiscountId?: string | null;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: DISCOUNT_CODE_DELETE_MUTATION,
    variables: { id: formattedId },
    customFetch,
  });

  const payload = response?.discountCodeDelete;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyDiscountError(
      "GRAPHQL_USER_ERROR",
      payload.userErrors.map((error) => error.message).join("; "),
      payload.userErrors,
    );
  }
  return Boolean(payload?.deletedCodeDiscountId);
}

export interface ProvisionLoyaltyRewardDiscountParams {
  storeId: string;
  /** Test-only credential override; ignored outside NODE_ENV=test. */
  shopDomain?: string;
  /** Test-only credential override; ignored outside NODE_ENV=test. */
  accessToken?: string;
  /** Resolver-produced credentials; the runtime brand prevents caller input
   * from bypassing tenant resolution while a program-row transaction is open. */
  resolvedCredentials?: ResolvedShopifyCredentials;
  rewardDefinition: {
    id: string;
    name: string;
    rewardType:
      | "amount_off"
      | "percentage_off"
      | "free_shipping"
      | "free_product"
      | any;
    discountValue?: number | string | any;
    maxDiscountValue?: number | string | any;
    minOrderAmount?: number | string | any;
    appliesToResource?: string | null;
    entitledProductIds?: string[] | any;
    entitledVariantIds?: string[] | any;
    entitledCollectionIds?: string[] | any;
    combinesWithOrderDiscounts?: boolean;
    combinesWithProductDiscounts?: boolean;
    combinesWithShippingDiscounts?: boolean;
    usageLimit?: number | null;
    usageLimitPerCustomer?: number | null;
    expiresInDays?: number | null;
  };
  discountCode: string;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  expectedShopCurrency?: string;
  /** Authoritative store currency already read by the caller's durable fence. */
  currentShopCurrency?: string;
  shopifyCustomerId?: string | null;
  customFetch?: typeof fetch;
}

function sameInstant(left: string | null, right: Date | null | undefined) {
  if (left === null || right == null) return left === null && right == null;
  const leftMs = new Date(left).getTime();
  // Shopify serializes persisted discount timestamps at whole-second
  // precision. Require that canonical remote shape before comparing it with
  // the expected instant rounded down to the same precision. A non-canonical
  // remote millisecond value is ambiguous and must fail closed.
  return (
    Number.isFinite(leftMs) &&
    leftMs % 1_000 === 0 &&
    leftMs === Math.trunc(right.getTime() / 1_000) * 1_000
  );
}

function sameStringSet(left: string[], right: string[]) {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  if (sortedLeft.length !== sortedRight.length) return false;
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function remoteMoneyMatchesMinorUnits({
  amount,
  currencyCode,
  expectedMinorUnits,
  expectedCurrency,
}: {
  amount: string;
  currencyCode: string;
  expectedMinorUnits: unknown;
  expectedCurrency: string;
}) {
  if (currencyCode.trim().toUpperCase() !== expectedCurrency) return false;
  try {
    return (
      decimalToMinorUnits(amount, expectedCurrency) ===
      BigInt(String(expectedMinorUnits))
    );
  } catch {
    return false;
  }
}

/**
 * Verifies every Shopify-controlled field that Weletic writes for a native
 * loyalty voucher before an ambiguous create is adopted. Ownership markers
 * alone are insufficient because a merchant can edit a voucher in Shopify
 * while leaving its code/title intact.
 */
export function matchesLoyaltyRewardDiscountConfiguration({
  remote,
  rewardDefinition,
  startsAt,
  expiresAt,
  expectedShopCurrency,
  shopifyCustomerId,
}: {
  remote: ShopifyDiscountResult;
  rewardDefinition: ProvisionLoyaltyRewardDiscountParams["rewardDefinition"];
  startsAt: Date;
  expiresAt: Date | null;
  expectedShopCurrency: string;
  shopifyCustomerId?: string | null;
}) {
  const configuration = remote.configuration;
  if (!configuration) return false;

  const currency = expectedShopCurrency.trim().toUpperCase();
  if (
    !sameInstant(configuration.startsAt, startsAt) ||
    !sameInstant(configuration.endsAt, expiresAt) ||
    configuration.usageLimit !== (rewardDefinition.usageLimit || 1) ||
    configuration.appliesOncePerCustomer !==
      (rewardDefinition.usageLimitPerCustomer === 1) ||
    !configuration.appliesOnOneTimePurchase ||
    configuration.appliesOnSubscription ||
    // Shopify canonicalizes one-time-only discounts to a recurring-cycle
    // limit of 1, even when the create input omits the subscription fields.
    // Requiring that normalized value keeps ambiguous-create adoption strict
    // without rejecting the discount Shopify actually persisted.
    configuration.recurringCycleLimit !== 1 ||
    configuration.combinesWith.orderDiscounts !==
      Boolean(rewardDefinition.combinesWithOrderDiscounts) ||
    configuration.combinesWith.productDiscounts !==
      Boolean(rewardDefinition.combinesWithProductDiscounts) ||
    configuration.combinesWith.shippingDiscounts !==
      Boolean(rewardDefinition.combinesWithShippingDiscounts)
  ) {
    return false;
  }

  const expectedCustomerIds = shopifyCustomerId
    ? [formatShopifyGid("Customer", shopifyCustomerId)]
    : [];
  if (
    expectedCustomerIds.length > 0
      ? configuration.customerSelection.kind !== "customers" ||
        !sameStringSet(
          configuration.customerSelection.customerIds,
          expectedCustomerIds,
        )
      : configuration.customerSelection.kind !== "all"
  ) {
    return false;
  }

  const expectedMinimum = rewardDefinition.minOrderAmount;
  if (expectedMinimum != null && Number(expectedMinimum) > 0) {
    if (
      configuration.minimumRequirement?.kind !== "subtotal" ||
      !remoteMoneyMatchesMinorUnits({
        amount: configuration.minimumRequirement.amount,
        currencyCode: configuration.minimumRequirement.currencyCode,
        expectedMinorUnits: expectedMinimum,
        expectedCurrency: currency,
      })
    ) {
      return false;
    }
  } else if (configuration.minimumRequirement !== null) {
    return false;
  }

  if (rewardDefinition.rewardType === "free_shipping") {
    return (
      configuration.kind === "free_shipping" &&
      configuration.maximumShippingPrice === null &&
      configuration.shippingDestination?.kind === "all"
    );
  }
  if (configuration.kind !== "basic") return false;

  if (rewardDefinition.rewardType === "percentage_off") {
    let expectedPercentage: number;
    try {
      expectedPercentage = canonicalShopifyPercentageFraction(
        rewardDefinition.discountValue || 0,
      );
    } catch {
      return false;
    }
    if (
      configuration.basicValue?.kind !== "percentage" ||
      Math.abs(configuration.basicValue.percentage - expectedPercentage) > 1e-9
    ) {
      return false;
    }
  } else {
    const expectedAmount =
      rewardDefinition.rewardType === "free_product"
        ? rewardDefinition.maxDiscountValue
        : rewardDefinition.discountValue;
    if (
      expectedAmount == null ||
      configuration.basicValue?.kind !== "amount" ||
      configuration.basicValue.appliesOnEachItem ||
      !remoteMoneyMatchesMinorUnits({
        amount: configuration.basicValue.amount,
        currencyCode: configuration.basicValue.currencyCode,
        expectedMinorUnits: expectedAmount,
        expectedCurrency: currency,
      })
    ) {
      return false;
    }
  }

  const appliesToEntireOrder =
    rewardDefinition.appliesToResource === "entire_order";
  const productIds = appliesToEntireOrder
    ? []
    : Array.isArray(rewardDefinition.entitledProductIds)
      ? rewardDefinition.entitledProductIds.map((id) =>
          formatShopifyGid("Product", id),
        )
      : [];
  const variantIds = appliesToEntireOrder
    ? []
    : Array.isArray(rewardDefinition.entitledVariantIds)
      ? rewardDefinition.entitledVariantIds.map((id) =>
          formatShopifyGid("ProductVariant", id),
        )
      : [];
  const collectionIds = appliesToEntireOrder
    ? []
    : Array.isArray(rewardDefinition.entitledCollectionIds)
      ? rewardDefinition.entitledCollectionIds.map((id) =>
          formatShopifyGid("Collection", id),
        )
      : [];

  if (
    collectionIds.length > 0 &&
    (productIds.length > 0 || variantIds.length > 0)
  ) {
    return false;
  }
  if (collectionIds.length > 0) {
    return (
      configuration.basicItems?.kind === "collections" &&
      !configuration.basicItems.truncated &&
      sameStringSet(configuration.basicItems.collectionIds, collectionIds)
    );
  }
  if (productIds.length > 0 || variantIds.length > 0) {
    return (
      configuration.basicItems?.kind === "products" &&
      !configuration.basicItems.truncated &&
      sameStringSet(configuration.basicItems.productIds, productIds) &&
      sameStringSet(configuration.basicItems.variantIds, variantIds)
    );
  }
  return configuration.basicItems?.kind === "all";
}

/**
 * High-level pure GraphQL dispatcher that provisions a loyalty reward voucher in Shopify.
 */
export async function provisionLoyaltyRewardDiscount(
  params: ProvisionLoyaltyRewardDiscountParams,
): Promise<ShopifyDiscountResult> {
  const {
    storeId,
    rewardDefinition,
    discountCode,
    startsAt: requestedStartsAt,
    expiresAt,
    shopifyCustomerId,
    customFetch,
  } = params;

  const endsAt = expiresAt || null;
  const startsAt = requestedStartsAt || new Date();

  const allowTestCredentialOverride = process.env.NODE_ENV === "test";
  let domain = allowTestCredentialOverride ? params.shopDomain : undefined;
  let token = allowTestCredentialOverride ? params.accessToken : undefined;

  if (
    params.resolvedCredentials?.[TRUSTED_RESOLVED_SHOPIFY_CREDENTIALS] === true
  ) {
    domain = params.resolvedCredentials.shopDomain;
    token = params.resolvedCredentials.accessToken;
  }

  if (!domain || !token) {
    const creds = await resolveShopifyOfflineCredentials({
      storeId,
    });
    domain = creds.shopDomain;
    token = creds.accessToken;
  }

  let currentShopCurrency = params.currentShopCurrency?.trim().toUpperCase();
  if (!currentShopCurrency) {
    const storeCurrencyRecord = await prisma.weleticShopifyStore.findUnique({
      where: { id: storeId },
      select: { shopCurrency: true },
    });
    currentShopCurrency = storeCurrencyRecord?.shopCurrency
      ?.trim()
      .toUpperCase();
  }
  if (!currentShopCurrency) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Shopify store currency is unavailable for loyalty reward provisioning.",
    );
  }
  const expectedShopCurrency = params.expectedShopCurrency
    ?.trim()
    .toUpperCase();
  if (expectedShopCurrency && expectedShopCurrency !== currentShopCurrency) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Shopify store currency changed from ${expectedShopCurrency} to ${currentShopCurrency}; the reserved loyalty reward cannot be reinterpreted.`,
    );
  }
  const shopCurrency = expectedShopCurrency || currentShopCurrency;
  const rewardMinorUnitsToDecimal = (
    value: number | string | any,
    fieldName: string,
  ) => {
    const normalized = String(value ?? "").trim();
    if (!/^-?\d+(?:\.0+)?$/.test(normalized)) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `${fieldName} must be an integer number of minor currency units.`,
      );
    }
    return minorUnitsToDecimal(BigInt(normalized.split(".")[0]), shopCurrency);
  };

  const title = `${rewardDefinition.name} (${discountCode})`;
  const combinesWith: ShopifyDiscountCombinesWith = {
    orderDiscounts: Boolean(rewardDefinition.combinesWithOrderDiscounts),
    productDiscounts: Boolean(rewardDefinition.combinesWithProductDiscounts),
    shippingDiscounts: Boolean(rewardDefinition.combinesWithShippingDiscounts),
  };

  const customerSelection: ShopifyDiscountCustomerSelection = shopifyCustomerId
    ? { customerIds: [shopifyCustomerId] }
    : { all: true };

  const minRequirement: ShopifyDiscountMinimumRequirement | undefined =
    rewardDefinition.minOrderAmount != null &&
    Number(rewardDefinition.minOrderAmount) > 0
      ? {
          subtotalAmount: rewardMinorUnitsToDecimal(
            rewardDefinition.minOrderAmount,
            "Minimum order amount",
          ),
        }
      : undefined;

  // `entire_order` is an explicit immutable scope. Ignore any stale
  // entitlement IDs that may remain on a definition after the merchant
  // switches its scope; otherwise a replay could silently provision a
  // product-limited voucher from stale relational data.
  const appliesToEntireOrder =
    rewardDefinition.appliesToResource === "entire_order";
  const productGids =
    !appliesToEntireOrder && Array.isArray(rewardDefinition.entitledProductIds)
      ? rewardDefinition.entitledProductIds
      : [];
  const variantGids =
    !appliesToEntireOrder && Array.isArray(rewardDefinition.entitledVariantIds)
      ? rewardDefinition.entitledVariantIds
      : [];
  const collectionGids =
    !appliesToEntireOrder &&
    Array.isArray(rewardDefinition.entitledCollectionIds)
      ? rewardDefinition.entitledCollectionIds
      : [];

  const usageLimit = rewardDefinition.usageLimit || 1;
  if (
    rewardDefinition.usageLimitPerCustomer != null &&
    rewardDefinition.usageLimitPerCustomer !== 0 &&
    rewardDefinition.usageLimitPerCustomer !== 1
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Shopify native discounts support only unlimited or once-per-customer usage.",
    );
  }
  const appliesOncePerCustomer = rewardDefinition.usageLimitPerCustomer === 1;

  switch (rewardDefinition.rewardType) {
    case "amount_off":
      return await createBasicDiscount({
        shopDomain: domain,
        accessToken: token,
        code: discountCode,
        title,
        valueType: "fixed_amount",
        value: rewardMinorUnitsToDecimal(
          rewardDefinition.discountValue,
          "Discount value",
        ),
        startsAt,
        endsAt,
        productGids,
        variantGids,
        collectionGids,
        customerSelection,
        minimumRequirement: minRequirement,
        combinesWith,
        usageLimit,
        appliesOncePerCustomer,
        customFetch,
      });

    case "percentage_off":
      return await createBasicDiscount({
        shopDomain: domain,
        accessToken: token,
        code: discountCode,
        title,
        valueType: "percentage",
        value: Number(rewardDefinition.discountValue || 0),
        startsAt,
        endsAt,
        productGids,
        variantGids,
        collectionGids,
        customerSelection,
        minimumRequirement: minRequirement,
        combinesWith,
        usageLimit,
        appliesOncePerCustomer,
        customFetch,
      });

    case "free_shipping":
      return await createFreeShippingDiscount({
        shopDomain: domain,
        accessToken: token,
        code: discountCode,
        title,
        startsAt,
        endsAt,
        customerSelection,
        minimumRequirement: minRequirement,
        combinesWith,
        usageLimit,
        appliesOncePerCustomer,
        customFetch,
      });

    case "free_product":
      if (rewardDefinition.maxDiscountValue == null) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          "Free product rewards require a positive maximum discount value.",
        );
      }
      if (
        productGids.length + variantGids.length === 0 ||
        collectionGids.length > 0
      ) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          "Free product rewards require an eligible product or variant and cannot target collections.",
        );
      }
      return await createBasicDiscount({
        shopDomain: domain,
        accessToken: token,
        code: discountCode,
        title,
        valueType: "fixed_amount",
        value: rewardMinorUnitsToDecimal(
          rewardDefinition.maxDiscountValue,
          "Maximum discount value",
        ),
        productGids,
        variantGids,
        startsAt,
        endsAt,
        customerSelection,
        minimumRequirement: minRequirement,
        combinesWith,
        usageLimit,
        appliesOncePerCustomer,
        customFetch,
      });

    default:
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Unsupported rewardType '${rewardDefinition.rewardType}' for Shopify discount provisioning.`,
      );
  }
}
