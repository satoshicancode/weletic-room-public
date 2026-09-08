import {
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";
import { randomUUID } from "node:crypto";
import { authenticate } from "../shopify.server";
import {
  extensionCorsPreflight,
  privateCustomerJson,
  readGatewayJsonBody,
  WELETIC_REQUEST_ID_HEADER,
  weleticApiJson,
  weleticApiRequest,
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

const CUSTOMER_ACCOUNT_GET_PATHS = new Set([
  "customer",
  "customer/activity",
  "program",
]);
const CUSTOMER_ACCOUNT_ACTION_PATHS = new Set([
  "customer/redeem",
  "customer/referral/bind",
  "customer/birthday",
  "customer/activity/claim",
]);

function extractCustomerId(sub: string): string {
  const customerId = sub.replace(/^gid:\/\/shopify\/Customer\//, "");
  return /^\d+$/.test(customerId) ? customerId : "";
}

function extractShopDomain(dest: string): string {
  try {
    const url = new URL(dest.startsWith("http") ? dest : `https://${dest}`);
    const hostname = url.hostname.toLowerCase();
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(hostname)
      ? hostname
      : "";
  } catch {
    return "";
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const requestStartedAt = performance.now();
  const requestId = randomUUID();
  const responseHeaders = (upstreamTiming?: string) => {
    const headers = new Headers({ [WELETIC_REQUEST_ID_HEADER]: requestId });
    const gatewayTiming = `shopify_gateway;dur=${(
      performance.now() - requestStartedAt
    ).toFixed(1)}`;
    headers.set(
      "Server-Timing",
      upstreamTiming ? `${upstreamTiming}, ${gatewayTiming}` : gatewayTiming,
    );
    return headers;
  };
  const preflight = extensionCorsPreflight(request);
  if (preflight) return preflight;

  // 1. Authenticate Customer Account session token and obtain CORS wrapper
  const { sessionToken, cors } =
    await authenticate.public.customerAccount(request);

  // 2. Validate required `dest` and `sub` token claims
  if (!sessionToken?.dest || !sessionToken?.sub) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "unauthorized",
            message: "Invalid customer session claims: missing dest or sub",
          },
        },
        { status: 401 },
      ),
    );
  }

  const shop = extractShopDomain(sessionToken.dest);
  const customerId = extractCustomerId(sessionToken.sub);

  if (!shop || !customerId) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "unauthorized",
            message: "Unable to resolve shop or customer identity from token",
          },
        },
        { status: 401 },
      ),
    );
  }

  const subpath = normalizeSubpath(params["*"]);

  if (!CUSTOMER_ACCOUNT_GET_PATHS.has(subpath)) {
    return cors(
      privateCustomerJson(
        { error: { code: "not_found", message: "Unsupported loyalty route" } },
        { status: 404 },
      ),
    );
  }

  try {
    const url = new URL(request.url);
    const searchParams = new URLSearchParams();
    searchParams.set("shop", shop);
    searchParams.set("customerId", customerId);
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

    // 3. Forward to core using signed HMAC
    const upstream = await weleticApiRequest(internalPath, {
      method: "GET",
      signal: request.signal,
      headers: { [WELETIC_REQUEST_ID_HEADER]: requestId },
    });
    const result = await upstream.json();

    return cors(
      privateCustomerJson(result, {
        headers: responseHeaders(
          upstream.headers.get("Server-Timing") || undefined,
        ),
      }),
    );
  } catch (error: any) {
    console.error("[Customer Account API Loader Error]", { requestId, error });
    const status = error.status || 500;
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "customer_account_error",
            message:
              error.message || "Failed to process customer account request",
          },
        },
        { status, headers: responseHeaders() },
      ),
    );
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const preflight = extensionCorsPreflight(request);
  if (preflight) return preflight;

  // 1. Authenticate Customer Account session token and obtain CORS wrapper
  const { sessionToken, cors } =
    await authenticate.public.customerAccount(request);

  // 2. Validate required `dest` and `sub` token claims
  if (!sessionToken?.dest || !sessionToken?.sub) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "unauthorized",
            message: "Invalid customer session claims: missing dest or sub",
          },
        },
        { status: 401 },
      ),
    );
  }

  const shop = extractShopDomain(sessionToken.dest);
  const customerId = extractCustomerId(sessionToken.sub);

  if (!shop || !customerId) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "unauthorized",
            message: "Unable to resolve shop or customer identity from token",
          },
        },
        { status: 401 },
      ),
    );
  }

  const subpath = normalizeSubpath(params["*"]);

  if (!CUSTOMER_ACCOUNT_ACTION_PATHS.has(subpath)) {
    return cors(
      privateCustomerJson(
        { error: { code: "not_found", message: "Unsupported loyalty route" } },
        { status: 404 },
      ),
    );
  }

  try {
    const bodyObj = await readGatewayJsonBody(request);
    const untrustedPayload = { ...bodyObj };
    for (const reservedField of [
      "shop",
      "shopifyCustomerId",
      "redemptionChannel",
    ]) {
      delete untrustedPayload[reservedField];
    }

    const forwardPayload = {
      ...untrustedPayload,
      shop,
      shopifyCustomerId: customerId,
      ...(subpath === "customer/redeem"
        ? { redemptionChannel: "online_store" }
        : {}),
    };

    const internalPath = `/api/internal/shopify/loyalty/${subpath}?shop=${encodeURIComponent(shop)}`;

    // 3. Forward to core using signed HMAC
    const result = await weleticApiJson<any>(internalPath, {
      method: request.method || "POST",
      body: JSON.stringify(forwardPayload),
    });

    return cors(privateCustomerJson(result));
  } catch (error: any) {
    console.error("[Customer Account API Action Error]", error);
    const status = error.status || 500;
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "customer_account_action_error",
            message:
              error.message || "Failed to execute customer account action",
          },
        },
        { status },
      ),
    );
  }
}
