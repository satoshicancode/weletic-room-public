import { qstash } from "@/lib/cron";
import { createShopifySale } from "@/lib/integrations/shopify/create-sale";
import {
  attributeViaDiscountCode,
  processOrder,
} from "@/lib/integrations/shopify/process-order";
import { orderSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { WorkspaceProps } from "@/lib/types";
import { recordWeleticOrder } from "@/lib/weletic/commerce/record-order";
import { selectShopifyCouponAllocationEvidence } from "@/lib/weletic/loyalty/coupon-use-amount";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { settleRewardRedemptionsUsedByOrder } from "@/lib/weletic/loyalty/redemption-settlement";
import {
  type ShopifySettlementLockContext,
  withShopifySettlementLocks,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  deleteShopifyCheckoutCache,
  readShopifyCheckoutCacheField,
  writeShopifyCheckoutCache,
} from "@/lib/weletic/shopify/privacy-cache";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
  isShopifyStoreOperationalWritesBlocked,
} from "@/lib/weletic/shopify/store-compliance-state";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";

export function extractOrderDiscountCodes(event: any): string[] {
  const discountCodes = Array.isArray(event?.discount_codes)
    ? event.discount_codes
    : [];
  const discountApplications = Array.isArray(event?.discount_applications)
    ? event.discount_applications
    : [];

  return Array.from(
    new Set(
      [...discountCodes, ...discountApplications]
        .map((discount: any) => {
          const candidate =
            discount?.code ||
            (discount?.type === "discount_code" ? discount?.title : "");
          return candidate ? String(candidate).trim().toUpperCase() : "";
        })
        .filter(Boolean),
    ),
  );
}

export async function ordersPaid({
  event,
  workspace,
  storeId,
  expectedInstallationGeneration,
  privacyMinimizedFinancialSettlement = false,
  loyaltyMaintenancePermit,
}: {
  event: any;
  workspace: Pick<WorkspaceProps, "id" | "defaultProgramId" | "webhookEnabled">;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
  privacyMinimizedFinancialSettlement?: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const order = orderSchema.parse(event);
  const orderExternalId = String(order.id ?? order.confirmation_number);
  return withShopifySettlementLocks({
    workspaceId: workspace.id,
    storeId,
    orderExternalId,
    shopifyCustomerId: order.customer?.id,
    fn: (settlementLockContext) =>
      ordersPaidUnlocked({
        event: order,
        workspace,
        storeId,
        settlementLockContext,
        expectedInstallationGeneration,
        privacyMinimizedFinancialSettlement,
        loyaltyMaintenancePermit,
      }),
  });
}

async function ordersPaidUnlocked({
  event,
  workspace,
  storeId,
  settlementLockContext,
  expectedInstallationGeneration,
  privacyMinimizedFinancialSettlement,
  loyaltyMaintenancePermit,
}: {
  event: any;
  workspace: Pick<WorkspaceProps, "id" | "defaultProgramId" | "webhookEnabled">;
  storeId?: string;
  settlementLockContext: ShopifySettlementLockContext;
  expectedInstallationGeneration?: string | null;
  privacyMinimizedFinancialSettlement: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  let operationalStore: { id: string };
  if (privacyMinimizedFinancialSettlement) {
    if (!storeId) {
      throw new Error(
        "Privacy-minimized Shopify order settlement requires a resolved store.",
      );
    }
    const financialStore =
      await assertShopifyStoreMatchesInstallationGeneration({
        storeId,
        action: "orders_paid_financial_settlement",
        expectedInstallationGeneration,
      });
    return settlePrivacyMinimizedOrder({
      event,
      storeId: financialStore!.id,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
  }
  try {
    const store = await assertShopifyStoreAcceptsOperationalWrites({
      ...(storeId ? { storeId } : { workspaceId: workspace.id }),
      action: "orders_paid",
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
    operationalStore = store!;
  } catch (error) {
    if (
      !isShopifyStoreOperationalWritesBlocked(error) ||
      (error.complianceState !== "frozen" &&
        error.complianceState !== "redacted") ||
      !error.storeId
    ) {
      throw error;
    }

    return settlePrivacyMinimizedOrder({
      event,
      storeId: error.storeId,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
  }

  // Stage 1: Unconditionally record the factual commerce order and store-scoped Shopper/Loyalty account
  const factualOrder = await recordWeleticOrder({
    event,
    workspaceId: workspace.id,
    storeId: operationalStore.id,
    programId: workspace.defaultProgramId,
    settlementLockContext,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  // Stage 1.5: Reconcile Weletic Loyalty Reward Redemptions (mark used discount codes)
  const orderDiscountCodes = extractOrderDiscountCodes(event);

  if (orderDiscountCodes.length > 0) {
    const parsedCreatedAt = Date.parse(String(event.created_at || ""));
    await settleRewardRedemptionsUsedByOrder({
      storeId: operationalStore.id,
      discountCodes: orderDiscountCodes,
      orderDiscountEvidence: selectShopifyCouponAllocationEvidence(event),
      shopifyCustomerId:
        event.customer?.id === null || event.customer?.id === undefined
          ? null
          : String(event.customer.id),
      usedAt: Number.isNaN(parsedCreatedAt)
        ? new Date()
        : new Date(parsedCreatedAt),
      orderId: String(
        event.id || event.admin_graphql_api_id || event.name || "unknown",
      ),
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      orderMetadata: {
        orderName: event.name || event.order_number,
        totalAmount: event.total_price,
        currency: event.currency,
      },
    });
  }

  // Redemption settlement is financial truth and remains privacy-aware: a
  // redacted owner is matched by retained Shopify identity, while settlement
  // suppresses order metadata and customer metafield jobs. Keep all affiliate,
  // referral, and new-earn processing below this durable tombstone boundary.
  if (factualOrder.customerPrivacyTombstoned) {
    return "[Shopify] Delayed order for redacted customer recorded and loyalty redemption settled without PII; downstream attribution skipped.";
  }

  const {
    customer: orderCustomer,
    checkout_token: checkoutToken,
    discount_codes: discountCodes,
  } = orderSchema.parse(event);

  // Stage 2: Optional affiliate attribution dispatch
  if (orderCustomer) {
    const { id: externalId } = orderCustomer;

    const customer = await prisma.customer.findUnique({
      where: {
        projectId_externalId: {
          projectId: workspace.id,
          externalId: externalId.toString(),
        },
      },
    });

    // customer is found, process the order right away
    if (customer) {
      await processOrder({
        event,
        workspaceId: workspace.id,
        customerId: customer.id,
        settlementLockContext,
        expectedInstallationGeneration,
      });

      return "[Shopify] Order event processed successfully with existing affiliate customer.";
    }
  }

  // Check if the order was created using a program discount code
  if (discountCodes && discountCodes.length > 0 && workspace.defaultProgramId) {
    const programDiscountCodes = await prisma.discountCode.findMany({
      where: {
        programId: workspace.defaultProgramId,
        code: {
          in: discountCodes.map(({ code }) => code),
        },
      },
      include: {
        link: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (programDiscountCodes.length > 0) {
      let link = programDiscountCodes[0].link;
      if (!link) {
        link = await prisma.link.findFirst({
          where: {
            programId: workspace.defaultProgramId,
            partnerId: programDiscountCodes[0].partnerId,
          },
          orderBy: { createdAt: "asc" },
        });
      }

      if (link) {
        const { customer, leadEvent: leadData } =
          await attributeViaDiscountCode({
            event,
            workspace,
            link,
          });

        await createShopifySale({
          leadData,
          event,
          workspaceId: workspace.id,
          customerId: customer.id,
          settlementLockContext,
          expectedInstallationGeneration,
        });

        return "[Shopify] Order event processed successfully with discount codes.";
      }
    }
  }

  // Check the cache to see the pixel event for this checkout token exist before publishing the event to the queue
  const clickId = await readShopifyCheckoutCacheField<string>({
    checkoutToken,
    field: "clickId",
  });

  // clickId is empty, order is not from a Dub link
  if (clickId === "") {
    await deleteShopifyCheckoutCache(checkoutToken);

    return "[Shopify] Factual order recorded. Order is not from a Dub affiliate link.";
  }

  // clickId is found, process the order for the new customer
  else if (clickId) {
    await processOrder({
      event,
      workspaceId: workspace.id,
      clickId,
      settlementLockContext,
      expectedInstallationGeneration,
    });

    return "[Shopify] Order event processed successfully with Dub affiliate link.";
  }

  // clickId is not found, wait for the pixel event to arrive
  else {
    await writeShopifyCheckoutCache({
      checkoutToken,
      fields: { order: event },
      ttlSeconds: 15 * 60,
      storeId: operationalStore.id,
      customerId: event.customer?.id,
    });

    await qstash.publishJSON({
      url: `${APP_DOMAIN_WITH_NGROK}/api/cron/shopify/order-paid`,
      body: {
        checkoutToken,
        workspaceId: workspace.id,
        storeId: operationalStore.id,
        storeInstallationGeneration: expectedInstallationGeneration ?? null,
      },
      retries: 5,
      delay: 3,
    });

    return "[Shopify] Factual order recorded. Waiting for pixel event for affiliate attribution...";
  }
}

async function settlePrivacyMinimizedOrder({
  event,
  storeId,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  event: any;
  storeId: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const discountCodes = extractOrderDiscountCodes(event);
  if (discountCodes.length === 0) {
    return "[Shopify] Frozen-store order acknowledged without operational writes or loyalty settlement.";
  }
  const parsedCreatedAt = Date.parse(String(event.created_at || ""));
  await settleRewardRedemptionsUsedByOrder({
    storeId,
    discountCodes,
    orderDiscountEvidence: selectShopifyCouponAllocationEvidence(event),
    shopifyCustomerId:
      event.customer?.id === null || event.customer?.id === undefined
        ? null
        : String(event.customer.id),
    usedAt: Number.isNaN(parsedCreatedAt)
      ? new Date()
      : new Date(parsedCreatedAt),
    orderId: String(
      event.id || event.admin_graphql_api_id || event.name || "unknown",
    ),
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    // Never persist order/customer metadata on the privacy-minimized path.
    // Its sole permitted effect is exact voucher-use financial settlement.
  });
  return "[Shopify] Frozen-store order processed through privacy-minimized voucher settlement only.";
}
