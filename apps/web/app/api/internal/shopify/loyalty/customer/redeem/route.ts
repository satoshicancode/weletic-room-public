import { prisma } from "@/lib/prisma";
import { redeemCustomerPoints } from "@/lib/weletic/loyalty/customer";
import { customerRedemptionPointsRequestedSchema } from "@/lib/weletic/loyalty/customer-redemption-request";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import { RedemptionProvisioningPendingError } from "@/lib/weletic/loyalty/rewards";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { z } from "zod";

export const dynamic = "force-dynamic";

const redeemPayloadSchema = z
  .object({
    shop: z.string().min(1),
    shopifyCustomerId: z.string().min(1),
    rewardDefinitionId: z.string().min(1),
    pointsRequested: customerRedemptionPointsRequestedSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    redemptionChannel: z.enum(["online_store", "pos"]).optional(),
  })
  .strict();

export async function POST(request: Request) {
  // 1. Verify HMAC signature & request body bounds
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

  const validation = redeemPayloadSchema.safeParse(parsedBody);
  if (!validation.success) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Invalid payload attributes",
      422,
      validation.error.format(),
    );
  }

  const {
    shop,
    shopifyCustomerId,
    rewardDefinitionId,
    pointsRequested,
    idempotencyKey,
    redemptionChannel,
  } = validation.data;

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
    // 3. Execute points redemption
    const result = await redeemCustomerPoints({
      storeId: store.id,
      shopDomain: store.shopDomain,
      shopifyCustomerId,
      rewardDefinitionId,
      pointsRequested,
      idempotencyKey,
      redemptionChannel,
    });

    return loyaltySuccessResponse(result);
  } catch (error: any) {
    if (error instanceof RedemptionProvisioningPendingError) {
      return loyaltyErrorResponse("redemption_pending", error.message, 409, {
        redemptionId: error.redemptionId,
        retryWithSameIdempotencyKey: true,
      });
    }
    // Financial artifacts can contain shopper-visible codes. Keep operational
    // logs diagnostic without serializing the error object or Shopify payload.
    console.error("[Internal Loyalty Redeem Error]", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return loyaltyErrorResponse(
      "redemption_failed",
      error.message || "Failed to redeem reward points",
      400,
    );
  }
}
