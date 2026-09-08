import { prisma } from "@/lib/prisma";
import { bindCustomerReferral } from "@/lib/weletic/loyalty/customer";
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

const bindReferralSchema = z.object({
  shop: z.string().min(1),
  shopifyCustomerId: z.string().min(1),
  referralCode: z.string().trim().min(1).toUpperCase(),
});

export async function POST(request: Request) {
  // 1. Verify HMAC signature
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

  let parsedBody: any;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return loyaltyErrorResponse(
      "bad_request",
      "Invalid JSON request body",
      400,
    );
  }

  const validation = bindReferralSchema.safeParse(parsedBody);
  if (!validation.success) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Invalid referral bind payload",
      422,
      validation.error.format(),
    );
  }

  const { shop, shopifyCustomerId, referralCode } = validation.data;

  // 2. Resolve store identity
  const resolution = await resolveShopifyStoreByDomain(shop);
  if (!resolution) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store ${shop} not found`,
      404,
    );
  }

  const store = resolution.storeId
    ? await prisma.weleticShopifyStore.findUnique({
        where: { id: resolution.storeId },
      })
    : null;

  if (!store) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store record not found`,
      404,
    );
  }

  try {
    // 3. Execute referral binding
    const result = await bindCustomerReferral({
      storeId: store.id,
      shopDomain: store.shopDomain,
      shopifyCustomerId,
      referralCode,
    });

    return loyaltySuccessResponse(result);
  } catch (error: any) {
    console.error("[Internal Loyalty Referral Bind Error]", error);
    return loyaltyErrorResponse(
      "referral_bind_failed",
      error.message || "Failed to bind customer referral",
      400,
    );
  }
}
