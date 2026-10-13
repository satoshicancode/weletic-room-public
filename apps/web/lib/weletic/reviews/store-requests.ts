import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import { isCoreLaunch } from "../core-launch-policy";
import { ReviewError } from "./contracts";
import { reviewPolicyAtOrderTime } from "./incentive-activation-history";
import { readReviewIncentivePolicySnapshot } from "./incentive-policy";
import { assertReviewPurchaseNotSuppressed } from "./purchase";
import {
  assertStoreReviewPurchase,
  storeReviewRequestInclude,
} from "./store-purchase";
import { withReviewMutation } from "./transaction";

/** Creates durable evidence and source-only outbox work atomically. The
 * fulfillment webhook remains disconnected until installed delivery acceptance.
 */
export function createProspectiveStoreReviewRequest({
  storeId,
  orderExternalId,
  fulfilledAt,
  expectedInstallationGeneration,
}: {
  storeId: string;
  orderExternalId: string;
  fulfilledAt: Date;
  expectedInstallationGeneration: string;
}) {
  if (isCoreLaunch()) return Promise.resolve(null);
  if (!Number.isFinite(fulfilledAt.getTime()))
    throw new ReviewError("bad_request", "Invalid fulfillment time");
  return withReviewMutation(
    storeId,
    async (tx, generation) => {
      const [parent, settings] = await Promise.all([
        tx.weleticReviewSettings.findUnique({ where: { storeId } }),
        tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
      ]);
      if (
        !generation ||
        generation !== expectedInstallationGeneration ||
        !parent?.enabled ||
        !parent.requestEmailEnabled ||
        !parent.activatedAt ||
        !settings?.enabled ||
        !settings.requestEmailEnabled ||
        !settings.activatedAt ||
        fulfilledAt < parent.activatedAt ||
        fulfilledAt < settings.activatedAt
      )
        return null;
      if (
        await tx.weleticReviewOrderCancellation.findUnique({
          where: { storeId_orderExternalId: { storeId, orderExternalId } },
        })
      )
        return null;
      const order = await tx.weleticCommerceOrder.findUnique({
        where: { storeId_externalId: { storeId, externalId: orderExternalId } },
        include: {
          lines: { include: { refundLines: true } },
          shopper: { include: { privacyTombstones: { select: { id: true } } } },
        },
      });
      if (!order)
        throw new ReviewError("unavailable", "Paid order projection not ready");
      if (
        order.storeId !== storeId ||
        !order.shopper ||
        order.shopper.storeId !== storeId ||
        order.shopper.privacyTombstones.length ||
        !order.shopper.email ||
        !["paid", "partially_refunded"].includes(order.status) ||
        order.lines.length === 0
      )
        return null;
      await assertReviewPurchaseNotSuppressed(tx, {
        storeId,
        shopper: order.shopper,
      });
      const existing = await tx.weleticStoreReviewRequest.findUnique({
        where: { storeId_orderId: { storeId, orderId: order.id } },
      });
      if (existing) {
        if (existing.installationGeneration !== generation)
          throw new ReviewError("conflict", "Installation changed");
        return existing.id;
      }
      const productRequests = await tx.weleticReviewRequest.findMany({
        where: { storeId, orderId: order.id },
        select: { incentivePolicyId: true },
      });
      const productPolicies = new Set(
        productRequests.map((request) => request.incentivePolicyId),
      );
      if (productPolicies.size > 1)
        throw new ReviewError(
          "unavailable",
          "Order review policies require reconciliation",
        );
      const incentivePolicyId = productRequests.length
        ? productRequests[0].incentivePolicyId
        : await reviewPolicyAtOrderTime(
            tx,
            storeId,
            order.occurredAt,
            parent.activeIncentivePolicyId ?? null,
          );
      await readReviewIncentivePolicySnapshot(tx, storeId, incentivePolicyId);
      const sendAt = new Date(
        fulfilledAt.getTime() + settings.sendAfterDays * 86_400_000,
      );
      const expiresAt = new Date(
        sendAt.getTime() + settings.expiresAfterDays * 86_400_000,
      );
      if (!Number.isFinite(expiresAt.getTime()))
        throw new ReviewError(
          "unavailable",
          "Review invitation dates unavailable",
        );
      const request = await tx.weleticStoreReviewRequest.create({
        data: {
          id: createWeleticId("wstorereq_"),
          store: { connect: { id: storeId } },
          order: { connect: { id: order.id } },
          shopper: {
            connect: { storeId_id: { storeId, id: order.shopper.id } },
          },
          incentivePolicy: incentivePolicyId
            ? {
                connect: {
                  storeId_id: { storeId, id: incentivePolicyId },
                },
              }
            : undefined,
          installationGeneration: generation,
          settingsRevision: settings.revision,
          fulfilledAt,
          sendAt,
          expiresAt,
          lines: {
            create: order.lines.map((line) => ({
              id: createWeleticId("wstoreline_"),
              orderLine: { connect: { id: line.id } },
              purchasedQuantity: line.quantity,
            })),
          },
        },
        include: storeReviewRequestInclude,
      });
      assertStoreReviewPurchase(request, generation);
      await enqueueOutboxJobFromProgramTransaction({
        tx,
        storeId,
        jobType: "REVIEW_REQUEST_EMAIL",
        payload: {
          storeRequestId: request.id,
          installationGeneration: generation,
        },
        idempotencyKey: `store_review_request_email:${request.id}`,
        scheduledFor: sendAt,
      });
      return request.id;
    },
    expectedInstallationGeneration,
  );
}
