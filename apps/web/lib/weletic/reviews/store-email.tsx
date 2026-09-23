import { prisma } from "@/lib/prisma";
import { isLoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  readShopperCommunicationSettings,
  ShopperEmailPausedError,
} from "@/lib/weletic/merchant-settings/communications";
import {
  admitShopperDeliveryInTransaction,
  confirmShopperDeliveryInTransaction,
  shopperDeliveryContentDigest,
  type ShopperDeliveryIdentity,
} from "@/lib/weletic/merchant-settings/delivery-reservations";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { isShopifyStoreOperationalWritesBlocked } from "@/lib/weletic/shopify/store-compliance-state";
import { resend } from "@dub/email/resend";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewIncentiveDisclosure } from "./incentive-disclosure";
import {
  readReviewIncentivePolicySnapshot,
  reviewIncentivePolicyDigest,
} from "./incentive-policy";
import { reviewInvitationLocale } from "./invitation-email-content";
import {
  dispatchPreparedReviewEmail,
  prepareStoreReviewEmail,
  reviewTransportIdentity,
} from "./prepared-email";
import { assertReviewPurchaseNotSuppressed } from "./purchase";
import {
  openStoreReviewDeliverySnapshot,
  sealStoreReviewDeliverySnapshot,
  storeReviewDeliveryProviderKey,
} from "./store-delivery-snapshot";
import { storeReviewAccountEntryUrl } from "./store-invitation-email-content";
import {
  assertStoreReviewPurchase,
  assertStoreReviewRequestLineBindings,
  storeReviewRequestInclude,
} from "./store-purchase";
import { withReviewMutation } from "./transaction";

const inputSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    requestId: z.string().regex(/^wstorereq_[A-Za-z0-9_-]{1,191}$/),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();
const LEASE_MS = 120_000;

/** Internal worker entry point. No fulfillment webhook calls it until delivery,
 * recovery and installed account navigation have passed their release gates.
 */
export async function deliverStoreReviewRequest(
  input: z.infer<typeof inputSchema>,
) {
  const { storeId, requestId, installationGeneration } =
    inputSchema.parse(input);
  const identity = await prisma.weleticStoreReviewRequest.findFirst({
    where: { id: requestId, storeId, installationGeneration },
    select: {
      store: { select: { projectId: true } },
      shopper: { select: { shopifyCustomerId: true } },
    },
  });
  if (!identity?.shopper.shopifyCustomerId) return;
  return withShopifyCustomerSettlementLocks({
    workspaceId: identity.store.projectId,
    storeId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn: () => deliverLocked({ storeId, requestId, installationGeneration }),
  });
}

async function deliverLocked(input: z.infer<typeof inputSchema>) {
  const { storeId, requestId, installationGeneration } = input;
  const leaseToken = randomUUID();
  const claimed = await withReviewMutation(
    storeId,
    async (tx, generation) => {
      const now = new Date();
      if (!generation || generation !== installationGeneration)
        throw new ReviewError("conflict", "Installation changed");
      const [parent, settings, communications] = await Promise.all([
        tx.weleticReviewSettings.findUnique({ where: { storeId } }),
        tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
        readShopperCommunicationSettings({ storeId, tx }),
      ]);
      if (
        !parent?.enabled ||
        !parent.requestEmailEnabled ||
        !parent.activatedAt ||
        !settings?.enabled ||
        !settings.requestEmailEnabled ||
        !settings.activatedAt
      )
        return null;
      if (communications.paused) throw new ShopperEmailPausedError();
      const request = await tx.weleticStoreReviewRequest.findFirst({
        where: { id: requestId, storeId, installationGeneration },
        include: storeReviewRequestInclude,
      });
      if (
        !request ||
        ["sent", "submitted", "cancelled", "expired"].includes(request.status)
      )
        return null;
      if (
        request.fulfilledAt < parent.activatedAt ||
        request.fulfilledAt < settings.activatedAt
      ) {
        await tx.weleticStoreReviewRequest.updateMany({
          where: { id: requestId, storeId, installationGeneration },
          data: {
            status: "cancelled",
            cancellationReason: "settings_reactivated",
            cancelledAt: now,
            encryptedDeliverySnapshot: null,
            deliveryToken: null,
            deliveryLeaseExpiresAt: null,
          },
        });
        return null;
      }
      if (request.sendAt > now)
        throw new ReviewError("unavailable", "Store review request is not due");
      if (request.expiresAt <= now) {
        await tx.weleticStoreReviewRequest.updateMany({
          where: { id: requestId, storeId, installationGeneration },
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
        assertStoreReviewRequestLineBindings(request);
        assertStoreReviewPurchase(request, generation);
        await assertReviewPurchaseNotSuppressed(tx, {
          storeId,
          shopper: request.shopper,
        });
        if (
          await tx.weleticReviewOrderCancellation.findUnique({
            where: {
              storeId_orderExternalId: {
                storeId,
                orderExternalId: request.order.externalId,
              },
            },
          })
        )
          throw new ReviewError("not_found", "Order cancelled");
      } catch (error) {
        if (!(error instanceof ReviewError)) throw error;
        await tx.weleticStoreReviewRequest.updateMany({
          where: { id: requestId, storeId, installationGeneration },
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
      if (request.deliveryAttempts > 0 && !request.encryptedDeliverySnapshot)
        throw new ReviewError(
          "unavailable",
          "Store review delivery reconciliation required",
        );
      const provider = resend ? "resend" : "smtp";
      const context = {
        storeId,
        requestId,
        installationGeneration,
        policyDigest: policy ? reviewIncentivePolicyDigest(policy) : null,
        recipient: request.shopper.email,
        transportIdentity: reviewTransportIdentity(provider),
      };
      let ciphertext = request.encryptedDeliverySnapshot;
      let prepared;
      let retryUntil = new Date(now.getTime() + 23 * 60 * 60_000);
      if (ciphertext) {
        const reopened = openStoreReviewDeliverySnapshot({
          ciphertext,
          context,
          provider,
          now,
          retry: request.deliveryAttempts > 0,
        });
        retryUntil = reopened.retryUntil;
        prepared = {
          provider,
          content: reopened.content,
          transportIdentity: context.transportIdentity,
        };
      } else {
        const store = await tx.weleticShopifyStore.findUniqueOrThrow({
          where: { id: storeId },
          select: { shopDomain: true },
        });
        const branding = await tx.weleticLoyaltyProgram.findUnique({
          where: { storeId },
          select: { name: true },
        });
        const language = reviewInvitationLocale(request.shopper.locale);
        prepared = await prepareStoreReviewEmail({
          email: request.shopper.email,
          language,
          brandName:
            communications.configuredBrandName ?? branding?.name ?? "Weletic",
          logoUrl: communications.logoUrl,
          accentColor: communications.accentColor,
          disclosure: reviewIncentiveDisclosure(policy)?.[language] ?? [],
          url: storeReviewAccountEntryUrl(store.shopDomain),
        });
        if (
          prepared.provider !== provider ||
          prepared.transportIdentity !== context.transportIdentity
        )
          throw new ReviewError(
            "unavailable",
            "Store review delivery configuration changed",
          );
        ciphertext = sealStoreReviewDeliverySnapshot({
          context,
          provider,
          content: prepared.content,
          now,
        });
      }
      const reserved = await tx.weleticStoreReviewRequest.updateMany({
        where: {
          id: requestId,
          storeId,
          installationGeneration,
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
          encryptedDeliverySnapshot: ciphertext,
          lastError: null,
        },
      });
      if (reserved.count !== 1)
        throw new ReviewError(
          "conflict",
          "Store review request already reserved",
        );
      const deliveryIdentity: ShopperDeliveryIdentity = {
        storeId,
        installationGeneration,
        producer: "store_review_invitation",
        sourceKey: storeReviewDeliveryProviderKey(requestId),
        provider,
        contentDigest: shopperDeliveryContentDigest({
          content: prepared.content,
          transportIdentity: prepared.transportIdentity,
        }),
        email: request.shopper.email,
        shopifyCustomerId: request.shopper.shopifyCustomerId,
        expiresAt: request.expiresAt,
        retryUntil,
      };
      const admission = await admitShopperDeliveryInTransaction({
        tx,
        input: deliveryIdentity,
        priorAttempt: request.deliveryAttempts > 0,
      });
      return {
        ...prepared,
        providerKey: storeReviewDeliveryProviderKey(requestId),
        deliveryIdentity,
        alreadySent: admission.status === "sent",
      };
    },
    installationGeneration,
  );
  if (!claimed) return;

  let renewal: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = prisma.weleticStoreReviewRequest
      .updateMany({
        where: {
          id: requestId,
          storeId,
          installationGeneration,
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
    // The provider is external, so this fence is the last transactional
    // authority check before dispatch, matching reminder delivery semantics.
    const authorized = await storeReviewDeliveryAuthorized({
      storeId,
      requestId,
      installationGeneration,
      leaseToken,
    });
    if (!authorized)
      throw new ReviewError("conflict", "Store review delivery lease lost");
    if (!claimed.alreadySent) await dispatchPreparedReviewEmail(claimed);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
      const currentStore = await tx.weleticShopifyStore.findUnique({
        where: { id: storeId },
        select: { installationGeneration: true },
      });
      if (currentStore?.installationGeneration !== installationGeneration)
        throw new ReviewError("conflict", "Installation changed");
      const finalized = await tx.weleticStoreReviewRequest.updateMany({
        where: {
          id: requestId,
          storeId,
          installationGeneration,
          status: "sending",
          deliveryToken: leaseToken,
        },
        data: {
          status: "sent",
          sentAt: new Date(),
          deliveryToken: null,
          deliveryLeaseExpiresAt: null,
          encryptedDeliverySnapshot: null,
          lastError: null,
        },
      });
      if (finalized.count !== 1)
        throw new ReviewError(
          "conflict",
          "Store review delivery lease lost before finalization",
        );
      await confirmShopperDeliveryInTransaction(tx, claimed.deliveryIdentity);
    });
  } catch (error) {
    await prisma.weleticStoreReviewRequest.updateMany({
      where: {
        id: requestId,
        storeId,
        installationGeneration,
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
    if (
      isLoyaltyMaintenanceBlockedError(error) ||
      isShopifyStoreOperationalWritesBlocked(error) ||
      error instanceof ShopperEmailPausedError
    )
      throw error;
    throw new ReviewError(
      "unavailable",
      error instanceof ReviewError
        ? error.message
        : "Store review email delivery failed",
    );
  } finally {
    clearInterval(heartbeat);
    if (renewal) await renewal;
  }
}

/** The final provider gate is separately callable for real-SQL race tests. */
export function storeReviewDeliveryAuthorized({
  storeId,
  requestId,
  installationGeneration,
  leaseToken,
}: {
  storeId: string;
  requestId: string;
  installationGeneration: string;
  leaseToken: string;
}) {
  return withReviewMutation(
    storeId,
    async (tx) => {
      const request = await tx.weleticStoreReviewRequest.findFirst({
        where: {
          id: requestId,
          storeId,
          installationGeneration,
          status: "sending",
          deliveryToken: leaseToken,
          deliveryLeaseExpiresAt: { gt: new Date() },
          expiresAt: { gt: new Date() },
        },
        include: storeReviewRequestInclude,
      });
      if (!request) return false;
        const [parent, settings, communications] = await Promise.all([
        tx.weleticReviewSettings.findUnique({ where: { storeId } }),
        tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
        readShopperCommunicationSettings({ storeId, tx }),
        ]);
        if (communications.paused) throw new ShopperEmailPausedError();
        if (
        !parent?.enabled ||
        !parent.requestEmailEnabled ||
        !parent.activatedAt ||
        !settings?.enabled ||
        !settings.requestEmailEnabled ||
        !settings.activatedAt ||
        request.fulfilledAt < parent.activatedAt ||
        request.fulfilledAt < settings.activatedAt
      )
        return false;
      try {
        assertStoreReviewRequestLineBindings(request);
        assertStoreReviewPurchase(request, installationGeneration);
        await assertReviewPurchaseNotSuppressed(tx, {
          storeId,
          shopper: request.shopper,
        });
        if (
          await tx.weleticReviewOrderCancellation.findUnique({
            where: {
              storeId_orderExternalId: {
                storeId,
                orderExternalId: request.order.externalId,
              },
            },
          })
        )
          return false;
      } catch (error) {
        if (error instanceof ReviewError) return false;
        throw error;
      }
      return true;
    },
    installationGeneration,
  );
}
