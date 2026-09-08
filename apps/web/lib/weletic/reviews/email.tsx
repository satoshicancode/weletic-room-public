import { decrypt, encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import {
  readShopperCommunicationSettings,
  ShopperEmailPausedError,
} from "@/lib/weletic/merchant-settings/communications";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { getWeleticTransactionalEmailOptions } from "@/lib/weletic/transactional-email";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { sendBatchEmail } from "../../../../../packages/email/src";
import { generateReviewToken, hashReviewToken, ReviewError } from "./contracts";
import { assertReviewPurchase, reviewRequestInclude } from "./purchase";
import { withReviewMutation } from "./transaction";

const LEASE_MS = 120_000;

export async function deliverReviewRequest(
  storeId: string,
  requestId: string,
  expectedGeneration: string | null,
) {
  const identity = await prisma.weleticReviewRequest.findFirst({
    where: { id: requestId, storeId },
    select: {
      store: { select: { projectId: true } },
      shopper: { select: { shopifyCustomerId: true } },
    },
  });
  if (!identity?.shopper.shopifyCustomerId) return;
  // Same customer lock as refunds and privacy redaction; reread all eligibility
  // inside the lock before claiming and hold it through transport/finalization.
  return withShopifyCustomerSettlementLocks({
    workspaceId: identity.store.projectId,
    storeId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn: () =>
      deliverReviewRequestLocked(storeId, requestId, expectedGeneration),
  });
}

async function deliverReviewRequestLocked(
  storeId: string,
  requestId: string,
  expectedGeneration: string | null,
) {
  const leaseToken = randomUUID();
  const claimed = await withReviewMutation(
    storeId,
    async (tx, generation) => {
      const now = new Date();
      const settings = await tx.weleticReviewSettings.findUnique({
        where: { storeId },
      });
      if (!settings?.enabled || !settings.requestEmailEnabled) return null;
      const communications = await readShopperCommunicationSettings({
        storeId,
        tx,
      });
      if (communications.paused) throw new ShopperEmailPausedError();
      const request = await tx.weleticReviewRequest.findFirst({
        where: { id: requestId, storeId },
        include: reviewRequestInclude,
      });
      if (
        !request ||
        ["sent", "submitted", "cancelled", "expired"].includes(request.status)
      )
        return null;
      if (request.sendAt > now)
        throw new ReviewError("unavailable", "Review request is not due");
      if (request.expiresAt <= now) {
        await tx.weleticReviewRequest.update({
          where: { id: requestId },
          data: {
            status: "expired",
            tokenHash: null,
            encryptedDeliveryToken: null,
            deliveryToken: null,
            deliveryLeaseExpiresAt: null,
          },
        });
        return null;
      }
      try {
        assertReviewPurchase(request, generation);
      } catch (error) {
        if (!(error instanceof ReviewError)) throw error;
        await tx.weleticReviewRequest.update({
          where: { id: requestId },
          data: {
            status: "cancelled",
            tokenHash: null,
            encryptedDeliveryToken: null,
            deliveryToken: null,
            deliveryLeaseExpiresAt: null,
            cancellationReason: "purchase_ineligible",
            cancelledAt: now,
          },
        });
        return null;
      }
      if (!request.shopper.email)
        throw new ReviewError("unavailable", "Review recipient unavailable");
      const token = request.encryptedDeliveryToken
        ? decrypt(request.encryptedDeliveryToken)
        : generateReviewToken();
      const reserved = await tx.weleticReviewRequest.updateMany({
        where: {
          id: requestId,
          storeId,
          status: { in: ["queued", "failed", "sending"] },
          OR: [
            { deliveryLeaseExpiresAt: null },
            { deliveryLeaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          status: "sending",
          deliveryToken: leaseToken,
          deliveryReservedAt: now,
          deliveryLeaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          deliveryAttempts: { increment: 1 },
          tokenHash: hashReviewToken(token),
          encryptedDeliveryToken: encrypt(token),
          lastError: null,
        },
      });
      if (reserved.count !== 1)
        throw new ReviewError("conflict", "Review request already reserved");
      const store = await tx.weleticShopifyStore.findUniqueOrThrow({
        where: { id: storeId },
        select: { shopDomain: true },
      });
      if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.shopDomain))
        throw new ReviewError("unavailable", "Invalid storefront domain");
      const branding = await tx.weleticLoyaltyProgram.findUnique({
        where: { storeId },
        select: { name: true },
      });
      return {
        email: request.shopper.email,
        productTitle: request.product.title,
        brandName:
          communications.configuredBrandName ?? branding?.name ?? "Weletic",
        logoUrl: communications.logoUrl,
        accentColor: communications.accentColor,
        url: `https://${store.shopDomain}/apps/weletic/reviews/write#token=${token}`,
      };
    },
    expectedGeneration,
  );
  if (!claimed) return;

  let renewal: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = prisma.weleticReviewRequest
      .updateMany({
        where: {
          id: requestId,
          storeId,
          status: "sending",
          deliveryToken: leaseToken,
        },
        data: { deliveryLeaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      })
      .then((result) => {
        if (result.count !== 1) clearInterval(heartbeat);
      })
      .catch(() => {
        /* Finalization still requires the exact winning token. */
      })
      .finally(() => {
        renewal = null;
      });
  }, 20_000);
  try {
    // A cancelled or superseded reservation has no send authority.
    const authorized = await prisma.weleticReviewRequest.count({
      where: {
        id: requestId,
        storeId,
        status: "sending",
        deliveryToken: leaseToken,
        deliveryLeaseExpiresAt: { gt: new Date() },
      },
    });
    if (authorized !== 1)
      throw new ReviewError("conflict", "Review delivery lease lost");
    const result = await sendBatchEmail(
      [
        {
          ...getWeleticTransactionalEmailOptions(),
          to: claimed.email,
          subject: `How was ${claimed.productTitle}?`,
          text: `${claimed.brandName}\nShare your honest review of ${claimed.productTitle}: ${claimed.url}\nAny available loyalty reward is independent of your rating.`,
          react: createElement(
            "div",
            {
              style: {
                borderTop: claimed.accentColor
                  ? `4px solid ${claimed.accentColor}`
                  : undefined,
              },
            },
            claimed.logoUrl
              ? createElement("img", {
                  src: claimed.logoUrl,
                  alt: claimed.brandName,
                  width: 160,
                })
              : null,
            createElement("h1", null, claimed.brandName),
            createElement("p", null, `How was ${claimed.productTitle}?`),
            createElement(
              "p",
              null,
              "Share an honest review to help other shoppers. Any available loyalty reward is independent of your rating.",
            ),
            createElement("a", { href: claimed.url }, "Write a review"),
          ),
        },
      ],
      { idempotencyKey: `native-review-request:${requestId}` },
    );
    if (result.error || !result.data)
      throw new ReviewError("unavailable", "Review email transport failed");
    const finalized = await prisma.weleticReviewRequest.updateMany({
      where: {
        id: requestId,
        storeId,
        status: "sending",
        deliveryToken: leaseToken,
      },
      data: {
        status: "sent",
        sentAt: new Date(),
        deliveryToken: null,
        deliveryLeaseExpiresAt: null,
        encryptedDeliveryToken: null,
        lastError: null,
      },
    });
    if (finalized.count !== 1)
      throw new ReviewError(
        "conflict",
        "Review delivery lease lost before finalization",
      );
  } catch (error) {
    await prisma.weleticReviewRequest.updateMany({
      where: {
        id: requestId,
        storeId,
        status: "sending",
        deliveryToken: leaseToken,
      },
      data: {
        status: "failed",
        deliveryToken: null,
        deliveryLeaseExpiresAt: null,
        lastError: "email_delivery_failed",
      },
    });
    // Provider errors can contain recipient addresses or tokens. Keep retry logs generic.
    throw new ReviewError(
      "unavailable",
      error instanceof ReviewError
        ? error.message
        : "Review email delivery failed",
    );
  } finally {
    clearInterval(heartbeat);
    if (renewal) await renewal;
  }
}
