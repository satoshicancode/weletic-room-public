import { prisma } from "@/lib/prisma";
import {
  classifyShopifyFlowDispatchError,
  dispatchShopifyFlowTrigger,
  ShopifyFlowDispatchError,
} from "@/lib/weletic/loyalty/flow-triggers";
import {
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { resolveShopifyOfflineCredentials } from "@/lib/weletic/loyalty/shopify-discounts";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { hasShopifyCustomerPrivacyTombstone } from "@/lib/weletic/shopify/privacy-identity";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  isShopifyStoreOperationalWritesBlocked,
} from "@/lib/weletic/shopify/store-compliance-state";
import {
  REVIEW_FLOW_HANDLES,
  ReviewFlowJobSchema,
  type ReviewFlowJob,
} from "./flow-contract";
import { ReviewFlowDeferredError } from "./flow-errors";

/** Reviews-only shoppers do not need a loyalty account. No enrollment or award
 * happens here. Queue/Shopify delivery remains at-least-once on ambiguous I/O.
 */
export async function handleReviewFlowTrigger(
  storeId: string,
  raw: ReviewFlowJob,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
) {
  const event = ReviewFlowJobSchema.parse(raw);
  const eligible = async () => {
    const settings = await prisma.weleticReviewSettings.findUnique({
      where: { storeId },
      select: { enabled: true },
    });
    if (!settings?.enabled) throw new ReviewFlowDeferredError();
    const review = await prisma.weleticProductReview.findFirst({
      where: {
        id: event.reviewId,
        storeId,
        status: { not: "redacted" },
        redactedAt: null,
      },
      select: {
        status: true,
        version: true,
        rating: true,
        verifiedPurchase: true,
        shopperId: true,
        productId: true,
        product: { select: { storeId: true } },
        store: { select: { projectId: true } },
        request: {
          select: {
            storeId: true,
            shopperId: true,
            productId: true,
            installationGeneration: true,
            order: { select: { storeId: true, shopperId: true } },
          },
        },
        shopper: {
          select: {
            storeId: true,
            shopifyCustomerId: true,
            email: true,
            privacyTombstones: { select: { id: true } },
          },
        },
      },
    });
    if (
      !review ||
      review.version < event.version ||
      review.rating !== event.rating ||
      review.verifiedPurchase !== event.verifiedPurchase ||
      review.request.storeId !== storeId ||
      review.shopper.storeId !== storeId ||
      review.product.storeId !== storeId ||
      review.request.order.storeId !== storeId ||
      review.request.order.shopperId !== review.shopperId ||
      review.request.shopperId !== review.shopperId ||
      review.request.productId !== review.productId ||
      (event.handle === REVIEW_FLOW_HANDLES.SUBMITTED &&
        review.request.installationGeneration !==
          event.installationGeneration) ||
      review.shopper.privacyTombstones.length ||
      !review.shopper.shopifyCustomerId ||
      (event.handle === REVIEW_FLOW_HANDLES.PUBLISHED &&
        review.status !== "published")
    )
      return null;
    if (
      await hasShopifyCustomerPrivacyTombstone({
        storeId,
        shopifyCustomerId: review.shopper.shopifyCustomerId,
        email: review.shopper.email,
      })
    )
      return null;
    return {
      workspaceId: review.store.projectId,
      customerGid: review.shopper.shopifyCustomerId,
    };
  };
  const assertCurrent = () =>
    assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "loyalty_outbox:FLOW_TRIGGER",
      expectedInstallationGeneration: event.installationGeneration,
      loyaltyMaintenancePermit,
    });
  try {
    await assertCurrent();
    const identity = await eligible();
    if (!identity)
      throw new ShopifyFlowDispatchError(
        "Review Flow owner is no longer eligible",
        false,
      );
    await withShopifyCustomerSettlementLocks({
      workspaceId: identity.workspaceId,
      storeId,
      shopifyCustomerId: identity.customerGid,
      onLocked: () => {
        throw new ReviewFlowDeferredError();
      },
      fn: async () => {
        await assertCurrent();
        const before = await eligible();
        if (
          !before ||
          before.customerGid !== identity.customerGid ||
          before.workspaceId !== identity.workspaceId
        )
          throw new ShopifyFlowDispatchError(
            "Review Flow owner changed before dispatch",
            false,
          );
        const credentials = await resolveShopifyOfflineCredentials({ storeId });
        await assertCurrent();
        const current = await eligible();
        if (
          !current ||
          current.customerGid !== identity.customerGid ||
          current.workspaceId !== identity.workspaceId
        )
          throw new ShopifyFlowDispatchError(
            "Review Flow owner changed before dispatch",
            false,
          );
        await dispatchShopifyFlowTrigger({
          storeId,
          shopDomain: credentials.shopDomain,
          offlineToken: credentials.accessToken,
          handle: event.handle,
          payload: { event, customerGid: current.customerGid },
        });
      },
    });
  } catch (error) {
    if (
      error instanceof ReviewFlowDeferredError ||
      isLoyaltyMaintenanceBlockedError(error)
    )
      throw error;
    if (isShopifyStoreOperationalWritesBlocked(error)) {
      if (
        [
          "suspended",
          "pending_approval",
          "frozen",
          "currency_unverified",
        ].includes(error.complianceState ?? "")
      )
        throw new ReviewFlowDeferredError();
      throw new ShopifyFlowDispatchError(
        "Review Flow installation is no longer available",
        false,
      );
    }
    throw classifyShopifyFlowDispatchError(error);
  }
}
