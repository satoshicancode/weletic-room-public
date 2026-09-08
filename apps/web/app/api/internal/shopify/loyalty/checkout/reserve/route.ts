import { prisma } from "@/lib/prisma";
import { reserveCheckoutPoints } from "@/lib/weletic/loyalty/checkout";
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

const schema = z.object({
  shop: z.string().min(1),
  shopifyCustomerId: z.string().min(1),
  rewardDefinitionId: z.string().min(1),
  pointsRequested: z.union([
    z.string().regex(/^\d+$/),
    z.number().int().positive(),
  ]),
  checkoutToken: z.string().min(8).max(512),
  orderSubtotalMinor: z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
    .optional(),
});

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

  let submitted: unknown;
  try {
    submitted = JSON.parse(bodyText);
  } catch {
    return loyaltyErrorResponse(
      "bad_request",
      "Invalid JSON request body",
      400,
    );
  }

  const parsed = schema.safeParse(submitted);
  if (!parsed.success) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Invalid checkout reservation payload",
      422,
      parsed.error.format(),
    );
  }

  const resolution = await resolveShopifyStoreByDomain(parsed.data.shop);
  const store = resolution?.storeId
    ? await prisma.weleticShopifyStore.findUnique({
        where: { id: resolution.storeId },
      })
    : null;
  if (!store) {
    return loyaltyErrorResponse(
      "store_not_found",
      "Shopify store not found",
      404,
    );
  }

  try {
    const reservation = await reserveCheckoutPoints({
      storeId: store.id,
      shopifyCustomerId: parsed.data.shopifyCustomerId,
      rewardDefinitionId: parsed.data.rewardDefinitionId,
      pointsRequested: BigInt(parsed.data.pointsRequested),
      checkoutToken: parsed.data.checkoutToken,
      orderSubtotalMinor:
        parsed.data.orderSubtotalMinor === undefined
          ? undefined
          : BigInt(parsed.data.orderSubtotalMinor),
    });
    return loyaltySuccessResponse(reservation);
  } catch (error) {
    return loyaltyErrorResponse(
      "checkout_reservation_failed",
      error instanceof Error ? error.message : "Unable to reserve points",
      400,
    );
  }
}
