import {
  getCustomerActivityPage,
  InvalidCustomerActivityCursorError,
  parseCustomerActivityType,
  parsePositiveInteger,
} from "@/lib/weletic/loyalty/customer-activity";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_REQUEST_ID_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

function readRequestId(request: Request) {
  const value = request.headers.get(WELETIC_SHOPIFY_REQUEST_ID_HEADER);
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : randomUUID();
}

export async function GET(request: Request) {
  const requestStartedAt = performance.now();
  const requestId = readRequestId(request);
  let storeResolutionDuration = 0;

  const timingHeaders = () => {
    const metrics = [
      `core_store_resolution;dur=${storeResolutionDuration.toFixed(1)}`,
      `core_total;dur=${(performance.now() - requestStartedAt).toFixed(1)}`,
    ];
    return {
      [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
      "Server-Timing": metrics.join(", "),
    };
  };

  // 1. Verify HMAC signature & clock skew
  const bodyText = (await readWeleticShopifyRequestBody(request)) ?? "";
  if (!verifyWeleticShopifyRequest({ request, body: bodyText })) {
    return loyaltyErrorResponse(
      "unauthorized",
      "Unauthorized service request",
      401,
      undefined,
      { headers: timingHeaders() },
    );
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId");

  if (!shop) {
    return loyaltyErrorResponse(
      "bad_request",
      "Missing required query parameter: 'shop'",
      400,
      undefined,
      { headers: timingHeaders() },
    );
  }

  if (!customerId) {
    return loyaltyErrorResponse(
      "bad_request",
      "Missing required query parameter: 'customerId'",
      400,
      undefined,
      { headers: timingHeaders() },
    );
  }

  // 2. Resolve store identity via canonical multi-domain resolver
  const storeResolutionStartedAt = performance.now();
  const resolution = await resolveShopifyStoreByDomain(shop);
  storeResolutionDuration = performance.now() - storeResolutionStartedAt;

  if (!resolution || !resolution.storeId) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store ${shop} is not connected in Weletic`,
      404,
      undefined,
      { headers: timingHeaders() },
    );
  }

  try {
    const type = parseCustomerActivityType(url.searchParams.get("type"));
    const page = parsePositiveInteger(url.searchParams.get("page"), 1);
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 20, 50);
    const cursor = url.searchParams.has("cursor")
      ? url.searchParams.get("cursor") ?? ""
      : undefined;

    const result = await getCustomerActivityPage({
      storeId: resolution.storeId,
      shopifyCustomerId: customerId,
      type,
      page,
      limit,
      cursor,
    });

    return loyaltySuccessResponse(result, {
      headers: timingHeaders(),
    });
  } catch (error) {
    if (error instanceof InvalidCustomerActivityCursorError) {
      return loyaltyErrorResponse(
        "bad_request",
        error.message,
        400,
        undefined,
        { headers: timingHeaders() },
      );
    }
    console.error("[Internal Loyalty Customer Activity Error]", {
      requestId,
      error,
    });
    return loyaltyErrorResponse(
      "internal_error",
      "Failed to retrieve customer loyalty activity",
      500,
      undefined,
      { headers: timingHeaders() },
    );
  }
}
