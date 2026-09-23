import type { Prisma } from "@prisma/client";
import { hasUnrefundedReviewQuantity, ReviewError } from "./contracts";
import {
  assertReviewPurchaseNotSuppressed,
  type ReviewRequestPurchase,
} from "./purchase";

export const storeReviewRequestInclude = {
  order: {
    select: {
      id: true,
      externalId: true,
      storeId: true,
      shopperId: true,
      status: true,
    },
  },
  shopper: { include: { privacyTombstones: { select: { id: true } } } },
  lines: { include: { orderLine: { include: { refundLines: true } } } },
} satisfies Prisma.WeleticStoreReviewRequestInclude;

export function assertStoreReviewRequestLineBindings(
  request: Prisma.WeleticStoreReviewRequestGetPayload<{
    include: typeof storeReviewRequestInclude;
  }>,
) {
  if (
    request.lines.some(
      (line) =>
        line.storeId !== request.storeId ||
        line.requestId !== request.id ||
        line.orderLineId !== line.orderLine.id,
    )
  )
    throw new ReviewError("not_found", "Review request unavailable");
}

/** Persisted order evidence, loaded inside the store-first mutation fence.
 * No product surrogate: store feedback belongs to the purchased order itself.
 * Privacy identity tombstone checks remain mandatory at the transactional caller.
 */
export type StoreReviewPurchase = {
  storeId: string;
  orderId: string;
  shopperId: string;
  installationGeneration: string;
  order: ReviewRequestPurchase["order"];
  shopper: Pick<
    ReviewRequestPurchase["shopper"],
    "id" | "storeId" | "privacyTombstones" | "shopifyCustomerId" | "email"
  >;
  lines: Array<{
    purchasedQuantity: number;
    orderLine: {
      id: string;
      orderId: string;
      quantity: number;
      shopNet: bigint;
      refundLines: Array<{ quantity: number; shopAmount: bigint }>;
    };
  }>;
};

/** Identity is separate from current refund eligibility: an ordinary later
 * refund must not by itself turn accepted participation into confirmed fraud.
 */
export function assertStoreReviewPurchaseIdentity(
  request: StoreReviewPurchase,
  generation: string | null,
) {
  const ids = new Set<string>();
  if (
    !generation ||
    request.installationGeneration !== generation ||
    !request.storeId ||
    !request.orderId ||
    !request.shopperId ||
    request.order.id !== request.orderId ||
    request.order.storeId !== request.storeId ||
    request.shopper.id !== request.shopperId ||
    request.shopper.storeId !== request.storeId ||
    request.order.shopperId !== request.shopperId ||
    request.shopper.privacyTombstones.length > 0 ||
    request.lines.length === 0 ||
    request.lines.some(({ purchasedQuantity, orderLine }) => {
      const duplicate = ids.has(orderLine.id);
      ids.add(orderLine.id);
      return (
        !orderLine.id ||
        duplicate ||
        orderLine.orderId !== request.orderId ||
        !Number.isSafeInteger(purchasedQuantity) ||
        purchasedQuantity <= 0 ||
        !Number.isSafeInteger(orderLine.quantity) ||
        orderLine.quantity <= 0 ||
        purchasedQuantity > orderLine.quantity ||
        orderLine.shopNet < BigInt(0) ||
        orderLine.refundLines.some(
          (refund) =>
            !Number.isSafeInteger(refund.quantity) ||
            refund.quantity < 0 ||
            refund.shopAmount < BigInt(0),
        )
      );
    })
  )
    throw new ReviewError("not_found", "Review request unavailable");
}

/** Initial invitation/participation qualification only. This is not a fraud or
 * clawback decision and does not reserve a claim, issue a reward or enroll anyone.
 */
export function assertStoreReviewPurchase(
  request: StoreReviewPurchase,
  generation: string | null,
) {
  assertStoreReviewPurchaseIdentity(request, generation);
  if (
    !["paid", "partially_refunded"].includes(request.order.status) ||
    !hasUnrefundedReviewQuantity(request.lines)
  )
    throw new ReviewError("not_found", "Review request unavailable");
}

/** Caller holds the authenticated store's active-installation transaction lock
 * and loads evidence through persisted relations. Unlinked privacy tombstones
 * are mandatory checks, not inferred from the shopper's linked tombstones.
 */
export async function assertStoreReviewSubmissionPurchase({
  tx,
  storeId,
  generation,
  request,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  generation: string;
  request: StoreReviewPurchase;
}) {
  if (request.storeId !== storeId)
    throw new ReviewError("not_found", "Review request unavailable");
  assertStoreReviewPurchase(request, generation);
  await assertReviewPurchaseNotSuppressed(tx, request);
}
