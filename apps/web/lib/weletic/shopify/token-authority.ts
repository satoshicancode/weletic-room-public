import {
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
  signWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { readBoundedShopifyJson } from "./read-bounded-json";

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const DEFAULT_PRODUCTION_SHOPIFY_APP_URL = "https://shopify.weletic.com";
const MINIMUM_TOKEN_LIFETIME_MS = 60_000;

export class ShopifyTokenAuthorityError extends Error {
  constructor(
    public code: "AUTH_EXPIRED" | "UNAUTHORIZED" | "NETWORK_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "ShopifyTokenAuthorityError";
  }
}

export interface ShopifyTokenAuthorityCredential {
  shopDomain: string;
  accessToken: string;
  scope: string;
  expiresAt: Date | null;
}

function tokenAuthorityConfig() {
  const configuredUrl = process.env.SHOPIFY_APP_URL?.trim();
  const appUrl =
    configuredUrl ||
    (process.env.NODE_ENV === "production"
      ? DEFAULT_PRODUCTION_SHOPIFY_APP_URL
      : "");
  const secret = process.env.WELETIC_SHOPIFY_SERVICE_SECRET || "";

  if (!appUrl) return null;
  if (secret.length < 32) {
    throw new ShopifyTokenAuthorityError(
      "UNAUTHORIZED",
      "Shopify token authority is not configured securely.",
    );
  }

  let origin: URL;
  try {
    origin = new URL(appUrl);
  } catch {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority URL is invalid.",
    );
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    (process.env.NODE_ENV === "production" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password
  ) {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority URL is invalid.",
    );
  }
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return { origin, secret };
}

export function isShopifyTokenAuthorityConfigured() {
  return tokenAuthorityConfig() !== null;
}

export async function fetchShopifyTokenAuthorityCredential({
  shopDomain,
  customFetch,
  installationGeneration,
}: {
  shopDomain: string;
  customFetch?: typeof fetch;
  installationGeneration?: string;
}): Promise<ShopifyTokenAuthorityCredential> {
  const config = tokenAuthorityConfig();
  if (!config) {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority is not configured.",
    );
  }

  const canonicalShop = shopDomain.trim().toLowerCase();
  if (!SHOP_DOMAIN_PATTERN.test(canonicalShop)) {
    throw new ShopifyTokenAuthorityError(
      "UNAUTHORIZED",
      "Shopify store domain is invalid.",
    );
  }

  if (
    installationGeneration !== undefined &&
    !/^[A-Za-z0-9_-]{1,64}$/.test(installationGeneration)
  ) {
    throw new ShopifyTokenAuthorityError(
      "UNAUTHORIZED",
      "Shopify installation generation is invalid.",
    );
  }
  const url = new URL(
    installationGeneration === undefined
      ? "/api/internal/admin-session"
      : "/api/internal/installed-admin-session",
    config.origin,
  );
  url.searchParams.set("shop", canonicalShop);
  if (installationGeneration !== undefined)
    url.searchParams.set("generation", installationGeneration);
  const path = `${url.pathname}${url.search}`;
  const timestamp = String(Date.now());
  const signature = signWeleticShopifyRequest({
    timestamp,
    method: "GET",
    path,
    body: "",
    secret: config.secret,
  });
  const fetchFn = customFetch || fetch;
  const signal = AbortSignal.timeout(10_000);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
      },
      signal,
    });
  } catch {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority is unavailable.",
    );
  }

  if (!response.ok) {
    // Only the authority's explicit missing-session result proves a reconnect
    // condition. A proxy 404, lease conflict, throttle or service-auth failure
    // must never be presented as merchant credential expiry.
    let missing = false;
    if (response.status === 404) {
      try {
        const error = await readBoundedShopifyJson(response, signal);
        missing = Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "SESSION_MISSING" &&
            (installationGeneration === undefined ||
              ("shop" in error &&
                error.shop === canonicalShop &&
                "installationGeneration" in error &&
                error.installationGeneration === installationGeneration)),
        );
      } catch {
        /* Malformed/uncertain errors remain retryable. */
      }
    } else {
      void response.body?.cancel().catch(() => undefined);
    }
    const code = missing
      ? "AUTH_EXPIRED"
      : response.status === 401 || response.status === 403
        ? "UNAUTHORIZED"
        : "NETWORK_ERROR";
    throw new ShopifyTokenAuthorityError(
      code,
      missing
        ? `No active Shopify offline session found for ${canonicalShop}.`
        : "Shopify token authority rejected the credential request.",
    );
  }

  let payload: unknown;
  try {
    payload = await readBoundedShopifyJson(response, signal);
  } catch {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority returned an invalid response.",
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority returned an invalid response.",
    );
  }
  const value = payload as Record<string, unknown>;
  if (
    value.shop !== canonicalShop ||
    (installationGeneration !== undefined &&
      value.installationGeneration !== installationGeneration) ||
    typeof value.accessToken !== "string" ||
    value.accessToken.length < 1 ||
    value.accessToken.length > 8192 ||
    typeof value.scope !== "string" ||
    value.scope.length > 8192 ||
    !(
      value.expiresAt === null ||
      (typeof value.expiresAt === "string" && value.expiresAt.length <= 64)
    )
  ) {
    throw new ShopifyTokenAuthorityError(
      "UNAUTHORIZED",
      "Shopify token authority returned mismatched credentials.",
    );
  }

  const expiresAt =
    typeof value.expiresAt === "string" ? new Date(value.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new ShopifyTokenAuthorityError(
      "UNAUTHORIZED",
      "Shopify token authority returned invalid expiry metadata.",
    );
  }
  if (
    expiresAt &&
    expiresAt.getTime() <= Date.now() + MINIMUM_TOKEN_LIFETIME_MS
  ) {
    throw new ShopifyTokenAuthorityError(
      "NETWORK_ERROR",
      "Shopify token authority returned a credential without sufficient lifetime.",
    );
  }

  return {
    shopDomain: canonicalShop,
    accessToken: value.accessToken,
    scope: value.scope,
    expiresAt,
  };
}
