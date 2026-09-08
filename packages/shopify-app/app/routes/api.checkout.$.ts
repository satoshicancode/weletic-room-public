import {
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";
import {
  extensionCorsPreflight,
  privateCustomerJson,
  readGatewayJsonBody,
  weleticApiJson,
} from "../weletic-api.server";

export const headers: HeadersFunction = (args) => boundary.headers(args);

function tokenIdentity(sessionToken: { dest?: string; sub?: string }) {
  if (!sessionToken.dest || !sessionToken.sub) return null;
  try {
    const shop = new URL(
      sessionToken.dest.startsWith("http")
        ? sessionToken.dest
        : `https://${sessionToken.dest}`,
    ).hostname.toLowerCase();
    const customerId = sessionToken.sub.replace(
      /^gid:\/\/shopify\/Customer\//,
      "",
    );
    const isShopifyDomain = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
    const isNumericCustomerId = /^\d+$/.test(customerId);
    return isShopifyDomain && isNumericCustomerId ? { shop, customerId } : null;
  } catch {
    return null;
  }
}

function subpath(params: Record<string, string | undefined>) {
  return (params["*"] || "").replace(/^\/+|\/+$/g, "");
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const preflight = extensionCorsPreflight(request);
  if (preflight) return preflight;

  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const identity = tokenIdentity(sessionToken);
  if (!identity) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "unauthorized",
            message: "Logged-in customer required",
          },
        },
        { status: 401 },
      ),
    );
  }
  if (subpath(params) !== "loyalty/customer") {
    return cors(
      privateCustomerJson({ error: { code: "not_found" } }, { status: 404 }),
    );
  }

  try {
    const query = new URLSearchParams({
      shop: identity.shop,
      customerId: identity.customerId,
    });
    const result = await weleticApiJson<any>(
      `/api/internal/shopify/loyalty/customer?${query.toString()}`,
      { method: "GET" },
    );
    return cors(privateCustomerJson(result));
  } catch (error: any) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "checkout_gateway_error",
            message: error?.message || "Unable to load loyalty account",
          },
        },
        { status: error?.status || 500 },
      ),
    );
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const preflight = extensionCorsPreflight(request);
  if (preflight) return preflight;

  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const identity = tokenIdentity(sessionToken);
  if (!identity) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "unauthorized",
            message: "Logged-in customer required",
          },
        },
        { status: 401 },
      ),
    );
  }

  const route = subpath(params);
  if (
    !["loyalty/checkout/reserve", "loyalty/checkout/release"].includes(route)
  ) {
    return cors(
      privateCustomerJson({ error: { code: "not_found" } }, { status: 404 }),
    );
  }

  try {
    const submitted = await readGatewayJsonBody(request);
    const payload = {
      ...(submitted && typeof submitted === "object" ? submitted : {}),
      shop: identity.shop,
      shopifyCustomerId: identity.customerId,
    };
    const target = route.endsWith("/reserve") ? "reserve" : "release";
    const result = await weleticApiJson<any>(
      `/api/internal/shopify/loyalty/checkout/${target}`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    return cors(privateCustomerJson(result));
  } catch (error: any) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "checkout_gateway_error",
            message: error?.message || "Unable to process loyalty request",
          },
        },
        { status: error?.status || 500 },
      ),
    );
  }
}
