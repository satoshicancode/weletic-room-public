import { createWeleticId } from "@/lib/weletic/ids";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import { Prisma } from "@prisma/client";
import { hashReviewToken, ReviewError } from "./contracts";
import { reviewIncentivePolicyDigest } from "./incentive-policy";
import {
  assertReviewPurchase,
  assertReviewPurchaseNotSuppressed,
  reviewRequestInclude,
} from "./purchase";
import { withReviewMutation } from "./transaction";

/** Called only with an authenticated orders/fulfilled event. Missing paid-order
 * projections throw so the durable Shopify event can retry out-of-order delivery. */
export async function createFulfilledReviewRequests({
  storeId,
  orderExternalId,
  fulfilledAt,
  expectedInstallationGeneration,
}: {
  storeId: string;
  orderExternalId: string;
  fulfilledAt: Date;
  expectedInstallationGeneration?: string | null;
}) {
  if (!Number.isFinite(fulfilledAt.getTime()))
    throw new ReviewError("bad_request", "Invalid fulfillment time");
  return withReviewMutation(
    storeId,
    async (tx, generation) => {
      const settings = await tx.weleticReviewSettings.findUnique({
        where: { storeId },
      });
      if (!settings?.enabled || !settings.requestEmailEnabled) return [];
      // Never backfill review email sends merely by enabling the module.
      if (!settings.activatedAt || fulfilledAt < settings.activatedAt)
        return [];
      if (
        await tx.weleticReviewOrderCancellation.findUnique({
          where: { storeId_orderExternalId: { storeId, orderExternalId } },
        })
      )
        return [];
      const order = await tx.weleticCommerceOrder.findUnique({
        where: { storeId_externalId: { storeId, externalId: orderExternalId } },
        include: {
          lines: { include: { product: true, refundLines: true } },
          shopper: { include: { privacyTombstones: { select: { id: true } } } },
        },
      });
      if (!order)
        throw new ReviewError("unavailable", "Paid order projection not ready");
      if (
        !order.shopper ||
        order.shopper.storeId !== storeId ||
        order.shopper.privacyTombstones.length ||
        !order.shopper.email ||
        !["paid", "partially_refunded"].includes(order.status)
      )
        return [];
      const groups = new Map<string, typeof order.lines>();
      for (const line of order.lines) {
        if (
          !line.productId ||
          !line.product ||
          line.product.storeId !== storeId
        )
          continue;
        const lines = groups.get(line.productId) ?? [];
        lines.push(line);
        groups.set(line.productId, lines);
      }
      const results: string[] = [];
      // An order's first invitation fixes its policy for later product groups.
      // In particular, partially fulfilled legacy orders cannot cross cutover.
      const orderRequests = await tx.weleticReviewRequest.findMany({
        where: { storeId, orderId: order.id },
        select: { incentivePolicyId: true },
      });
      const orderPolicies = new Set(
        orderRequests.map((request) => request.incentivePolicyId),
      );
      if (orderPolicies.size > 1)
        throw new ReviewError(
          "unavailable",
          "Order review policies require reconciliation",
        );
      const incentivePolicyId = orderRequests.length
        ? orderRequests[0].incentivePolicyId
        : settings.activeIncentivePolicyId ?? null;
      if (incentivePolicyId) {
        const policy = await tx.weleticReviewIncentivePolicy.findUnique({
          where: { storeId_id: { storeId, id: incentivePolicyId } },
        });
        if (
          !policy ||
          policy.contentDigest !== reviewIncentivePolicyDigest(policy.snapshot)
        )
          throw new ReviewError(
            "unavailable",
            "Review incentive policy is unavailable",
          );
      }
      for (const [productId, lines] of groups) {
        const existing = await tx.weleticReviewRequest.findUnique({
          where: {
            storeId_orderId_productId: {
              storeId,
              orderId: order.id,
              productId,
            },
          },
        });
        if (existing) {
          results.push(existing.id);
          continue;
        }
        const sendAt = new Date(
          fulfilledAt.getTime() + settings.sendAfterDays * 86_400_000,
        );
        const expiresAt = new Date(
          sendAt.getTime() + settings.expiresAfterDays * 86_400_000,
        );
        const request = await tx.weleticReviewRequest.create({
          data: {
            id: createWeleticId("wrevreq_"),
            storeId,
            orderId: order.id,
            productId,
            shopperId: order.shopper.id,
            incentivePolicyId,
            installationGeneration: generation,
            fulfilledAt,
            sendAt,
            expiresAt,
            lines: {
              create: lines.map((line) => ({
                id: createWeleticId("wrevline_"),
                orderLineId: line.id,
                purchasedQuantity: line.quantity,
              })),
            },
          },
          include: reviewRequestInclude,
        });
        try {
          assertReviewPurchase(request, generation);
        } catch (error) {
          if (!(error instanceof ReviewError)) throw error;
          await tx.weleticReviewRequest.update({
            where: { id: request.id },
            data: {
              status: "cancelled",
              cancelledAt: new Date(),
              cancellationReason: "purchase_ineligible",
            },
          });
          continue;
        }
        await enqueueOutboxJobFromProgramTransaction({
          tx,
          storeId,
          jobType: "REVIEW_REQUEST_EMAIL",
          payload: { requestId: request.id },
          idempotencyKey: `review_request_email:${request.id}`,
          scheduledFor: sendAt,
        });
        results.push(request.id);
      }
      return results;
    },
    expectedInstallationGeneration,
  );
}

export async function readUsableReviewRequest(
  tx: Prisma.TransactionClient,
  storeId: string,
  token: string,
  generation: string | null,
  now = new Date(),
) {
  const request = await tx.weleticReviewRequest.findFirst({
    where: {
      storeId,
      tokenHash: hashReviewToken(token),
      status: "sent",
      expiresAt: { gt: now },
    },
    include: reviewRequestInclude,
  });
  if (!request)
    throw new ReviewError("not_found", "Review request unavailable");
  const settings = await tx.weleticReviewSettings.findUnique({
    where: { storeId },
  });
  if (!settings?.enabled)
    throw new ReviewError("disabled", "Reviews are unavailable");
  assertReviewPurchase(request, generation);
  await assertReviewPurchaseNotSuppressed(tx, request);
  return { request, settings };
}

export async function getReviewRequestPreview(storeId: string, token: string) {
  return withReviewMutation(storeId, async (tx, generation) => {
    const { request, settings } = await readUsableReviewRequest(
      tx,
      storeId,
      token,
      generation,
    );
    return {
      productTitle: request.product.title,
      productHandle: request.product.handle,
      expiresAt: request.expiresAt,
      photoUploadsEnabled: settings.photoUploadsEnabled,
    };
  });
}

/** Refunding a purchase does not suppress a previously submitted genuine review.
 * It invalidates invitations and unfinished uploads before they can be used. */
export async function cancelIneligibleReviewRequests(
  storeId: string,
  orderId: string,
  cancelled = false,
  fence: {
    expectedInstallationGeneration?: string | null;
    loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  } = {},
) {
  return withReviewMutation(
    storeId,
    (tx, generation) =>
      cancelReviewRequestsInTransaction(
        tx,
        storeId,
        orderId,
        generation,
        cancelled,
      ),
    fence.expectedInstallationGeneration,
    fence.loyaltyMaintenancePermit,
  );
}

async function cancelReviewRequestsInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
  orderId: string,
  generation: string | null,
  cancelled: boolean,
) {
  const requests = await tx.weleticReviewRequest.findMany({
    where: {
      storeId,
      orderId,
      status: { in: ["queued", "sending", "sent", "failed"] },
    },
    include: reviewRequestInclude,
  });
  for (const request of requests) {
    let invalid = cancelled;
    try {
      assertReviewPurchase(request, generation);
    } catch (error) {
      if (!(error instanceof ReviewError)) throw error;
      invalid = true;
    }
    if (!invalid) continue;
    await tx.weleticReviewRequest.update({
      where: { id: request.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: cancelled ? "order_cancelled" : "purchase_refunded",
        tokenHash: null,
        encryptedDeliveryToken: null,
        deliveryToken: null,
        deliveryLeaseExpiresAt: null,
      },
    });
    await tx.weleticLoyaltyOutboxJob.updateMany({
      where: {
        storeId,
        jobType: "REVIEW_REQUEST_EMAIL",
        idempotencyKey: `review_request_email:${request.id}`,
        status: { in: ["pending", "processing", "failed"] },
      },
      data: { status: "cancelled", lockedAt: null, lockedBy: null },
    });
  }
}

export async function recordReviewOrderCancellation({
  storeId,
  orderExternalId,
  cancelledAt,
  expectedInstallationGeneration,
}: {
  storeId: string;
  orderExternalId: string;
  cancelledAt: Date;
  expectedInstallationGeneration?: string | null;
}) {
  return withReviewMutation(
    storeId,
    async (tx, generation) => {
      // Monotonic tombstone: duplicate or late events never clear cancellation.
      await tx.weleticReviewOrderCancellation.upsert({
        where: { storeId_orderExternalId: { storeId, orderExternalId } },
        create: { storeId, orderExternalId, cancelledAt },
        update: {},
      });
      const order = await tx.weleticCommerceOrder.findUnique({
        where: { storeId_externalId: { storeId, externalId: orderExternalId } },
        select: { id: true },
      });
      if (order)
        await cancelReviewRequestsInTransaction(
          tx,
          storeId,
          order.id,
          generation,
          true,
        );
    },
    expectedInstallationGeneration,
  );
}
