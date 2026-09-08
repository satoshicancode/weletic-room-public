import { hasShopifyCustomerPrivacyTombstone } from "@/lib/weletic/shopify/privacy-identity";
import { Prisma } from "@prisma/client";
import { hasUnrefundedReviewQuantity, ReviewError } from "./contracts";

export const reviewRequestInclude = {
  order: {
    select: {
      id: true,
      externalId: true,
      storeId: true,
      shopperId: true,
      status: true,
    },
  },
  product: {
    select: {
      id: true,
      storeId: true,
      externalId: true,
      title: true,
      handle: true,
    },
  },
  shopper: { include: { privacyTombstones: { select: { id: true } } } },
  lines: { include: { orderLine: { include: { refundLines: true } } } },
} satisfies Prisma.WeleticReviewRequestInclude;

export type ReviewRequestPurchase = Prisma.WeleticReviewRequestGetPayload<{
  include: typeof reviewRequestInclude;
}>;

/** Identity tombstones may exist without owner links. A linked relation alone
 * is not sufficient suppression evidence for validating or issuing an award.
 */
export async function assertReviewPurchaseNotSuppressed(
  tx: Prisma.TransactionClient,
  request: ReviewRequestPurchase,
) {
  if (
    await hasShopifyCustomerPrivacyTombstone({
      tx,
      storeId: request.storeId,
      shopifyCustomerId: request.shopper.shopifyCustomerId,
      email: request.shopper.email,
    })
  )
    throw new ReviewError("not_found", "Review request unavailable");
}

export function assertReviewPurchaseIdentity(
  request: ReviewRequestPurchase,
  generation: string | null,
) {
  if (
    request.installationGeneration !== generation ||
    request.order.storeId !== request.storeId ||
    request.product.storeId !== request.storeId ||
    request.shopper.storeId !== request.storeId ||
    request.order.shopperId !== request.shopperId ||
    request.shopper.privacyTombstones.length > 0 ||
    request.lines.length === 0 ||
    request.lines.some(
      ({ orderLine }) =>
        orderLine.orderId !== request.orderId ||
        orderLine.productId !== request.productId,
    )
  ) {
    throw new ReviewError("not_found", "Review request unavailable");
  }
}

export function assertReviewPurchase(
  request: ReviewRequestPurchase,
  generation: string | null,
) {
  assertReviewPurchaseIdentity(request, generation);
  if (
    !["paid", "partially_refunded"].includes(request.order.status) ||
    !hasUnrefundedReviewQuantity(request.lines)
  )
    throw new ReviewError("not_found", "Review request unavailable");
}
