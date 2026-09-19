import { decrypt, encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import {
  readShopperCommunicationSettings,
  ShopperEmailPausedError,
} from "@/lib/weletic/merchant-settings/communications";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { resend } from "@dub/email/resend";
import { randomUUID } from "node:crypto";
import { generateReviewToken, hashReviewToken, ReviewError } from "./contracts";
import {
  openReviewDeliverySnapshot,
  reviewDeliveryProviderKey,
  sealReviewDeliverySnapshot,
} from "./delivery-snapshot";
import { reviewIncentiveDisclosure } from "./incentive-disclosure";
import {
  readReviewIncentivePolicySnapshot,
  reviewIncentivePolicyDigest,
} from "./incentive-policy";
import { reviewInvitationLocale } from "./invitation-email-content";
import {
  dispatchPreparedReviewEmail,
  prepareReviewEmail,
  reviewTransportIdentity,
} from "./prepared-email";
import {
  assertReviewPurchase,
  assertReviewPurchaseNotSuppressed,
  reviewRequestInclude,
} from "./purchase";
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
            encryptedDeliverySnapshot: null,
            deliveryToken: null,
            deliveryLeaseExpiresAt: null,
          },
        });
        return null;
      }
      try {
        assertReviewPurchase(request, generation);
        await assertReviewPurchaseNotSuppressed(tx, request);
      } catch (error) {
        if (!(error instanceof ReviewError)) throw error;
        await tx.weleticReviewRequest.update({
          where: { id: requestId },
          data: {
            status: "cancelled",
            tokenHash: null,
            encryptedDeliveryToken: null,
            encryptedDeliverySnapshot: null,
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
      const policy = await readReviewIncentivePolicySnapshot(
        tx,
        storeId,
        request.incentivePolicyId,
      );
      // Old attempts have no immutable provider evidence. Their outcome cannot
      // safely be inferred from a token alone; never regenerate and resend them.
      if (request.deliveryAttempts > 0 && !request.encryptedDeliverySnapshot)
        throw new ReviewError(
          "unavailable",
          "Review delivery reconciliation required",
        );
      const token = request.encryptedDeliveryToken
        ? decrypt(request.encryptedDeliveryToken)
        : generateReviewToken();
      const provider = resend ? "resend" : "smtp";
      const context = {
        storeId,
        requestId,
        installationGeneration: generation,
        tokenHash: hashReviewToken(token),
        policyDigest: policy ? reviewIncentivePolicyDigest(policy) : null,
        recipient: request.shopper.email,
        transportIdentity: reviewTransportIdentity(provider),
      };
      let ciphertext = request.encryptedDeliverySnapshot;
      let prepared;
      if (ciphertext) {
        const reopened = openReviewDeliverySnapshot({
          ciphertext,
          context,
          provider,
          now,
          retry: true,
        });
        prepared = {
          provider,
          content: reopened.content,
          transportIdentity: context.transportIdentity,
        };
      } else {
        const disclosure = reviewIncentiveDisclosure(policy);
        const language = reviewInvitationLocale(request.shopper.locale);
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
        prepared = await prepareReviewEmail({
          email: request.shopper.email,
          language,
          productTitle: request.product.title,
          brandName:
            communications.configuredBrandName ?? branding?.name ?? "Weletic",
          logoUrl: communications.logoUrl,
          accentColor: communications.accentColor,
          disclosure: disclosure?.[language] ?? [],
          url: `https://${store.shopDomain}/apps/weletic/reviews/write?locale=${language}#token=${token}`,
        });
        if (
          prepared.provider !== provider ||
          prepared.transportIdentity !== context.transportIdentity
        )
          throw new ReviewError(
            "unavailable",
            "Review delivery configuration changed",
          );
        ciphertext = sealReviewDeliverySnapshot({
          context,
          provider,
          content: prepared.content,
          now,
        });
      }
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
          encryptedDeliverySnapshot: ciphertext,
          lastError: null,
        },
      });
      if (reserved.count !== 1)
        throw new ReviewError("conflict", "Review request already reserved");
      return { ...prepared, providerKey: reviewDeliveryProviderKey(requestId) };
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
    await dispatchPreparedReviewEmail(claimed);
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
        encryptedDeliverySnapshot: null,
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
