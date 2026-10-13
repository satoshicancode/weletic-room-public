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
import {
  hasOpenReviewFlowOwnership,
  openReviewFlowSourceSelection,
} from "./flow-open-ownership";
import {
  lockReviewOwnerPrivacySource,
  ReviewOwnerPrivacySuppressedError,
} from "./privacy-owner-write";
import { withReviewMutation } from "./transaction";

/** Reviews-only shoppers do not need a loyalty account. No enrollment or award
 * happens here. Queue/Shopify delivery remains at-least-once on ambiguous I/O.
 */
export async function handleReviewFlowTrigger(
  storeId: string,
  raw: ReviewFlowJob,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
) {
  const event = ReviewFlowJobSchema.parse(raw);
  const eligible = () =>
    withReviewMutation(
      storeId,
      async (tx) => {
        const settings = await tx.weleticReviewSettings.findUnique({
          where: { storeId },
          select: { enabled: true },
        });
        if (!settings?.enabled) throw new ReviewFlowDeferredError();
        const review = await tx.weleticProductReview.findFirst({
          where: {
            id: event.reviewId,
            storeId,
            status: { not: "redacted" },
            redactedAt: null,
          },
          select: {
            id: true,
            requestId: true,
            source: true,
            incentivized: true,
            openSubmission: { select: openReviewFlowSourceSelection },
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
          !review.shopper ||
          !review.shopperId ||
          review.source === "merchant"
        )
          return null;
        const currentShopper = review.shopper;
        const currentShopperId = review.shopperId;
        const ownsSource = review.request
          ? !review.openSubmission &&
            review.request.storeId === storeId &&
            review.request.order.storeId === storeId &&
            review.request.order.shopperId === currentShopperId &&
            review.request.shopperId === currentShopperId &&
            review.request.productId === review.productId &&
            (event.handle !== REVIEW_FLOW_HANDLES.SUBMITTED ||
              review.request.installationGeneration ===
                event.installationGeneration)
          : hasOpenReviewFlowOwnership(
              storeId,
              { ...review, shopperId: currentShopperId },
              event.handle === REVIEW_FLOW_HANDLES.SUBMITTED
                ? event.installationGeneration
                : undefined,
            );
        if (
          !ownsSource ||
          review.version < event.version ||
          review.rating !== event.rating ||
          review.verifiedPurchase !== event.verifiedPurchase ||
          currentShopper.storeId !== storeId ||
          review.product.storeId !== storeId ||
          currentShopper.privacyTombstones.length ||
          !currentShopper.shopifyCustomerId ||
          (event.handle === REVIEW_FLOW_HANDLES.PUBLISHED &&
            review.status !== "published")
        )
          return null;
        try {
          await lockReviewOwnerPrivacySource({
            tx,
            storeId,
            shopperId: currentShopperId,
            installationGeneration: event.installationGeneration,
            loyaltyMaintenancePermit,
          });
        } catch (error) {
          if (error instanceof ReviewOwnerPrivacySuppressedError) return null;
          throw error;
        }
        if (
          await hasShopifyCustomerPrivacyTombstone({
            tx,
            storeId,
            shopifyCustomerId: currentShopper.shopifyCustomerId,
            email: currentShopper.email,
          })
        )
          return null;
        return {
          workspaceId: review.store.projectId,
          customerGid: currentShopper.shopifyCustomerId,
        };
      },
      event.installationGeneration,
      loyaltyMaintenancePermit,
    );
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
