import { prisma } from "@/lib/prisma";
import { ratelimit } from "@/lib/upstash";
import {
  claimCustomerIntentActivity,
  CustomerActivityClaimError,
} from "@/lib/weletic/loyalty/earning-actions";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import { createShopifyDerivedPrivacyDigest } from "@/lib/weletic/shopify/privacy-identity";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { z } from "zod";

export const dynamic = "force-dynamic";

const activityClaimSchema = z
  .object({
    shop: z.string().trim().min(1).max(255),
    shopifyCustomerId: z.string().trim().min(1).max(128),
    ruleId: z.string().trim().min(1).max(128),
    claimKey: z
      .string()
      .trim()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

function safeErrorType(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

export async function POST(request: Request) {
  const bodyText = await readWeleticShopifyRequestBody(request);
  if (
    bodyText === null ||
    !verifyWeleticShopifyRequest({ request, body: bodyText })
  ) {
    return loyaltyErrorResponse(
      "unauthorized",
      "Unauthorized service request",
      401,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return loyaltyErrorResponse("bad_request", "Invalid JSON body", 400);
  }
  const validation = activityClaimSchema.safeParse(parsed);
  if (!validation.success) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Invalid customer earning action claim",
      422,
      validation.error.format(),
    );
  }

  const { shop, shopifyCustomerId, ruleId, claimKey } = validation.data;
  const resolution = await resolveShopifyStoreByDomain(shop);
  const store = resolution?.storeId
    ? await prisma.weleticShopifyStore.findUnique({
        where: { id: resolution.storeId },
        select: { id: true },
      })
    : null;
  if (!store) {
    return loyaltyErrorResponse("store_not_found", "Store not found", 404);
  }

  const rateIdentity = createShopifyDerivedPrivacyDigest({
    purpose: "customer_activity",
    values: [store.id, shopifyCustomerId],
  });
  try {
    const limit = await ratelimit(30, "1 h").limit(
      `loyalty:customer-activity:${rateIdentity}`,
    );
    if (!limit.success) {
      return loyaltyErrorResponse(
        "rate_limited",
        "Too many earning action attempts. Please try again later.",
        429,
      );
    }
  } catch (error) {
    console.error("[Customer Activity Rate Limit Error]", {
      errorType: safeErrorType(error),
    });
    return loyaltyErrorResponse(
      "service_unavailable",
      "Earning actions are temporarily unavailable.",
      503,
    );
  }

  try {
    return loyaltySuccessResponse(
      await claimCustomerIntentActivity({
        storeId: store.id,
        shopifyCustomerId,
        ruleId,
        claimKey,
      }),
    );
  } catch (error) {
    if (error instanceof CustomerActivityClaimError) {
      const status =
        error.code === "account_not_found" || error.code === "rule_not_found"
          ? 404
          : error.code === "claim_key_required"
            ? 422
            : 409;
      return loyaltyErrorResponse(error.code, error.message, status);
    }
    console.error("[Customer Activity Claim Error]", {
      errorType: safeErrorType(error),
    });
    return loyaltyErrorResponse(
      "activity_claim_failed",
      "Unable to complete this earning action.",
      400,
    );
  }
}
