import { prisma } from "@/lib/prisma";
import { releaseCheckoutPoints } from "@/lib/weletic/loyalty/checkout";
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
  reservationId: z.string().min(1),
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
      "Invalid checkout release payload",
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
    const release = await releaseCheckoutPoints({
      storeId: store.id,
      shopifyCustomerId: parsed.data.shopifyCustomerId,
      reservationId: parsed.data.reservationId,
    });
    return loyaltySuccessResponse(release);
  } catch (error) {
    return loyaltyErrorResponse(
      "checkout_release_failed",
      error instanceof Error ? error.message : "Unable to release points",
      400,
    );
  }
}
