import {
  type CustomerLoyaltySummaryTimings,
  getCustomerLoyaltySummary,
} from "@/lib/weletic/loyalty/customer";
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
  const timingHeaders = (summary?: CustomerLoyaltySummaryTimings) => {
    const metrics = [
      `core_store_resolution;dur=${storeResolutionDuration.toFixed(1)}`,
      ...(summary
        ? [
            `summary_store;dur=${summary.resolveStore.toFixed(1)}`,
            `summary_shopper;dur=${summary.loadShopper.toFixed(1)}`,
            `summary_parallel;dur=${summary.loadSummary.toFixed(1)}`,
            `summary_legacy;dur=${summary.loadLegacyMetadata.toFixed(1)}`,
          ]
        : []),
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
    );
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId");
  const requestedRedemptionChannel = url.searchParams.get("redemptionChannel");

  if (!shop) {
    return loyaltyErrorResponse(
      "bad_request",
      "Missing required query parameter: 'shop'",
      400,
    );
  }
  if (
    requestedRedemptionChannel !== null &&
    requestedRedemptionChannel !== "online_store" &&
    requestedRedemptionChannel !== "pos"
  ) {
    return loyaltyErrorResponse(
      "bad_request",
      "Invalid redemptionChannel query parameter",
      400,
    );
  }
  const redemptionChannel = requestedRedemptionChannel ?? "online_store";

  // 2. Resolve store identity via canonical multi-domain resolver
  const storeResolutionStartedAt = performance.now();
  const resolution = await resolveShopifyStoreByDomain(shop);
  storeResolutionDuration = performance.now() - storeResolutionStartedAt;
  if (!resolution) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store ${shop} is not connected in Weletic`,
      404,
    );
  }

  if (!resolution.storeId) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store record not found for workspace`,
      404,
    );
  }

  try {
    // 3. Return summary
    if (!customerId) {
      return loyaltySuccessResponse(
        {
          isEnrolled: false,
          storeId: resolution.storeId,
          shopDomain: resolution.myshopifyDomain,
          pointsBalance: "0",
          pendingPoints: "0",
          lifetimePointsEarned: "0",
          tier: null,
          referral: null,
          rewards: [],
          rewardWallet: [],
          recentActivity: [],
        },
        { headers: timingHeaders() },
      );
    }

    let summaryTimings: CustomerLoyaltySummaryTimings | undefined;
    const summary = await getCustomerLoyaltySummary({
      storeId: resolution.storeId,
      shopDomain: resolution.myshopifyDomain,
      shopifyCustomerId: String(customerId),
      redemptionChannel,
      onTiming: (timings) => {
        summaryTimings = timings;
      },
    });

    return loyaltySuccessResponse(summary, {
      headers: timingHeaders(summaryTimings),
    });
  } catch (error: any) {
    console.error("[Internal Loyalty Customer Error]", { requestId, error });
    return loyaltyErrorResponse(
      "internal_error",
      "Failed to retrieve customer loyalty summary",
      500,
      undefined,
      { headers: timingHeaders() },
    );
  }
}
