import { prisma } from "@/lib/prisma";
import { ratelimit } from "@/lib/upstash";
import { claimReferralFriendReward } from "@/lib/weletic/loyalty/referral-friend-claim";
import { hashAbuseSignal } from "@/lib/weletic/loyalty/referrals";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { z } from "zod";

export const dynamic = "force-dynamic";

const friendClaimSchema = z.object({
  shop: z.string().min(1).max(255),
  referralCode: z.string().trim().min(1).max(64).toUpperCase(),
  email: z.string().trim().email().max(320),
  clientIp: z.string().trim().min(1).max(128).optional(),
  userAgent: z.string().trim().max(1024).optional(),
});

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
  const validation = friendClaimSchema.safeParse(parsed);
  if (!validation.success) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Invalid referral friend claim",
      422,
      validation.error.format(),
    );
  }

  const resolution = await resolveShopifyStoreByDomain(validation.data.shop);
  const store = resolution?.storeId
    ? await prisma.weleticShopifyStore.findUnique({
        where: { id: resolution.storeId },
      })
    : null;
  if (!store) {
    return loyaltyErrorResponse("store_not_found", "Store not found", 404);
  }

  const rateIdentity = hashAbuseSignal({
    storeId: store.id,
    kind: "ip",
    signal: validation.data.clientIp || "missing-ip",
  });
  try {
    const limit = await ratelimit(10, "1 h").limit(
      `loyalty:referral-friend-claim:${store.id}:${rateIdentity}`,
    );
    if (!limit.success) {
      return loyaltyErrorResponse(
        "rate_limited",
        "Too many referral claim attempts. Please try again later.",
        429,
      );
    }
  } catch (error) {
    console.error("[Referral Friend Claim Rate Limit Error]", {
      errorType: safeErrorType(error),
    });
    return loyaltyErrorResponse(
      "service_unavailable",
      "Referral claims are temporarily unavailable.",
      503,
    );
  }

  try {
    const result = await claimReferralFriendReward({
      storeId: store.id,
      referralCode: validation.data.referralCode,
      friendEmail: validation.data.email,
      clientIp: validation.data.clientIp,
      userAgent: validation.data.userAgent,
    });
    return loyaltySuccessResponse(result);
  } catch (error) {
    console.error("[Internal Referral Friend Claim Error]", {
      errorType: safeErrorType(error),
    });
    return loyaltyErrorResponse(
      "referral_claim_failed",
      "Unable to claim this referral reward. Check the invitation and eligibility, then try again.",
      400,
    );
  }
}
