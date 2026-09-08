import {
  json,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";
import { reviewProxyResponse } from "../reviews-gateway.server";
import { authenticate } from "../shopify.server";
import {
  privateCustomerJson,
  readGatewayJsonBody,
  weleticApiJson,
} from "../weletic-api.server";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function normalizeSubpath(splat: string | undefined): string {
  if (!splat) return "";
  let clean = splat.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.startsWith("loyalty/")) {
    clean = clean.replace(/^loyalty\//, "");
  }
  return clean;
}

const APP_PROXY_GET_PATHS = new Set([
  "program",
  "customer",
  "customer/activity",
]);
const APP_PROXY_ACTION_PATHS = new Set([
  "customer/redeem",
  "customer/referral/bind",
  "customer/activity/claim",
  "referral/claim",
]);
const CUSTOMER_AUTH_ACTION_PATHS = new Set([
  "customer/redeem",
  "customer/referral/bind",
  "customer/activity/claim",
]);

function getForwardedClientIp(request: Request) {
  const candidate =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0];
  return candidate?.trim().slice(0, 128) || undefined;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  // 1. Terminate Shopify App Proxy traffic and verify Shopify HMAC signature
  const { session } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || session?.shop;
  if (!shop) {
    return json(
      { error: { code: "bad_request", message: "Missing shop parameter" } },
      { status: 400 },
    );
  }

  const customerId = url.searchParams.get("logged_in_customer_id") || undefined;
  const subpath = normalizeSubpath(params["*"]);

  if (subpath.startsWith("reviews/"))
    return reviewProxyResponse(request, shop, subpath);

  if (!APP_PROXY_GET_PATHS.has(subpath)) {
    return json(
      { error: { code: "not_found", message: "Unsupported loyalty route" } },
      { status: 404 },
    );
  }

  try {
    // 2. Build internal API target path
    const searchParams = new URLSearchParams();
    searchParams.set("shop", shop);
    if (customerId) {
      searchParams.set("customerId", customerId);
    }
    if (subpath === "customer") {
      searchParams.set("redemptionChannel", "online_store");
    }
    const forwardableKeys = ["type", "page", "limit", "redemptionChannel"];
    for (const key of forwardableKeys) {
      const val = url.searchParams.get(key);
      if (val !== null && val !== "") {
        searchParams.set(key, val);
      }
    }

    const internalPath = `/api/internal/shopify/loyalty/${subpath}?${searchParams.toString()}`;

    // 3. Forward identity and query with internal signed HMAC
    const result = await weleticApiJson<any>(internalPath, {
      method: "GET",
    });

    const isPrivateCustomerPath =
      subpath === "customer" || subpath === "customer/activity";
    return isPrivateCustomerPath
      ? privateCustomerJson(result, {}, "Cookie")
      : json(result);
  } catch (error: any) {
    console.error("[Shopify App Proxy Loader Error]", error);
    const status = error.status || 500;
    const isPrivateCustomerPath =
      subpath === "customer" || subpath === "customer/activity";
    return isPrivateCustomerPath
      ? privateCustomerJson(
          {
            error: {
              code: "proxy_error",
              message: error.message || "Failed to process app proxy request",
            },
          },
          { status },
          "Cookie",
        )
      : json(
          {
            error: {
              code: "proxy_error",
              message: error.message || "Failed to process app proxy request",
            },
          },
          { status },
        );
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  // 1. Terminate Shopify App Proxy traffic and verify Shopify HMAC signature
  const { session } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || session?.shop;
  if (!shop) {
    return privateCustomerJson(
      { error: { code: "bad_request", message: "Missing shop parameter" } },
      { status: 400 },
      "Cookie",
    );
  }

  const customerId = url.searchParams.get("logged_in_customer_id") || undefined;
  const subpath = normalizeSubpath(params["*"]);

  if (subpath.startsWith("reviews/"))
    return reviewProxyResponse(request, shop, subpath);

  if (!APP_PROXY_ACTION_PATHS.has(subpath)) {
    return json(
      { error: { code: "not_found", message: "Unsupported loyalty route" } },
      { status: 404 },
    );
  }

  // Protected customer actions require logged-in customer context
  if (CUSTOMER_AUTH_ACTION_PATHS.has(subpath) && !customerId) {
    return privateCustomerJson(
      {
        error: {
          code: "unauthorized",
          message: "Customer authentication required for this action",
        },
      },
      { status: 401 },
      "Cookie",
    );
  }

  try {
    const bodyObj = await readGatewayJsonBody(request);
    const clientIp = getForwardedClientIp(request);
    const untrustedPayload = { ...bodyObj };
    for (const reservedField of [
      "shop",
      "shopifyCustomerId",
      "clientIp",
      "userAgent",
      "redemptionChannel",
    ]) {
      delete untrustedPayload[reservedField];
    }

    // Attach verified customer ID and shop to request body
    const attachAnonymousAbuseSignals = subpath === "referral/claim";
    const forwardPayload = {
      ...untrustedPayload,
      shop,
      ...(attachAnonymousAbuseSignals && clientIp ? { clientIp } : {}),
      ...(attachAnonymousAbuseSignals && request.headers.get("user-agent")
        ? { userAgent: request.headers.get("user-agent")!.slice(0, 1024) }
        : {}),
      ...(customerId ? { shopifyCustomerId: customerId } : {}),
      ...(subpath === "customer/redeem"
        ? { redemptionChannel: "online_store" }
        : {}),
    };

    const internalPath = `/api/internal/shopify/loyalty/${subpath}?shop=${encodeURIComponent(shop)}`;

    // Forward to core using signed HMAC
    const result = await weleticApiJson<any>(internalPath, {
      method: request.method || "POST",
      body: JSON.stringify(forwardPayload),
    });

    return privateCustomerJson(result, {}, "Cookie");
  } catch (error: any) {
    console.error("[Shopify App Proxy Action Error]", error);
    const status = error.status || 500;
    return privateCustomerJson(
      {
        error: {
          code: "proxy_action_error",
          message: error.message || "Failed to execute app proxy action",
        },
      },
      { status },
      "Cookie",
    );
  }
}
