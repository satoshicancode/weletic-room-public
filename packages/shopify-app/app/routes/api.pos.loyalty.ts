import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";
import {
  createPosCustomerBindingToken,
  verifyPosCustomerBindingToken,
} from "../pos-binding.server";
import { authenticate } from "../shopify.server";
import {
  privateCustomerJson,
  readGatewayJsonBody,
  weleticApiJson,
  weleticApiRequest,
} from "../weletic-api.server";

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

function extractShopDomain(dest: unknown) {
  if (typeof dest !== "string") return "";
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

function normalizeCustomerId(value: unknown) {
  const customerId = String(value ?? "").replace(
    /^gid:\/\/shopify\/Customer\//,
    "",
  );
  return /^\d+$/.test(customerId) ? customerId : "";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { sessionToken, cors } = await authenticate.public.pos(request);
  const shop = extractShopDomain(sessionToken?.dest);
  const customerId = normalizeCustomerId(
    new URL(request.url).searchParams.get("customerId"),
  );

  if (!shop || !customerId) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "invalid_pos_context",
            message:
              "Select a Shopify customer before opening loyalty rewards.",
          },
        },
        { status: 422 },
      ),
    );
  }

  const customerBindingToken = createPosCustomerBindingToken(shop, customerId);

  try {
    const search = new URLSearchParams({
      shop,
      customerId,
      redemptionChannel: "pos",
    });
    const upstream = await weleticApiRequest(
      `/api/internal/shopify/loyalty/customer?${search.toString()}`,
      { method: "GET", signal: request.signal },
    );
    const payload = await upstream.json();
    let enrichedPayload = payload;
    if (payload && typeof payload === "object") {
      enrichedPayload = {
        ...payload,
        customerBindingToken,
        ...("data" in payload &&
        typeof (payload as any).data === "object" &&
        (payload as any).data !== null
          ? { data: { ...(payload as any).data, customerBindingToken } }
          : {}),
      };
    }
    return cors(
      privateCustomerJson(enrichedPayload, { status: upstream.status }),
    );
  } catch (error) {
    console.error("[POS Loyalty Loader Error]", error);
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "pos_loyalty_error",
            message: "Unable to load loyalty rewards.",
          },
        },
        { status: 502 },
      ),
    );
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { sessionToken, cors } = await authenticate.public.pos(request);
  const shop = extractShopDomain(sessionToken?.dest);
  let body: Record<string, unknown>;
  try {
    body = await readGatewayJsonBody(request);
  } catch {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "invalid_json",
            message: "Invalid POS loyalty request.",
          },
        },
        { status: 400 },
      ),
    );
  }
  const customerId = normalizeCustomerId(body.shopifyCustomerId);

  if (!shop || !customerId) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "invalid_pos_context",
            message: "Select a Shopify customer before redeeming points.",
          },
        },
        { status: 422 },
      ),
    );
  }

  const customerBindingToken = body.customerBindingToken;
  if (
    !customerBindingToken ||
    !verifyPosCustomerBindingToken(customerBindingToken, shop, customerId)
  ) {
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "invalid_customer_binding",
            message:
              "Invalid or expired customer session. Please reload customer rewards.",
          },
        },
        { status: 403 },
      ),
    );
  }

  try {
    const payload = await weleticApiJson<unknown>(
      `/api/internal/shopify/loyalty/customer/redeem?shop=${encodeURIComponent(shop)}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...body,
          shop,
          shopifyCustomerId: customerId,
          redemptionChannel: "pos",
        }),
      },
    );
    return cors(privateCustomerJson(payload));
  } catch (error: any) {
    console.error("[POS Loyalty Action Error]", error);
    return cors(
      privateCustomerJson(
        {
          error: {
            code: "pos_loyalty_redemption_error",
            message: error?.message || "Unable to redeem POS reward.",
          },
        },
        { status: Number(error?.status) || 502 },
      ),
    );
  }
}
