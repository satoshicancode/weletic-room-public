import { isFirstConversion } from "@/lib/analytics/is-first-conversion";
import { includeTags } from "@/lib/api/links/include-tags";
import { syncPartnerLinksStats } from "@/lib/api/partners/sync-partner-links-stats";
import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { executeWorkflows } from "@/lib/api/workflows/execute-workflows";
import { constructWebhookPartner } from "@/lib/partners/constuct-webhook-partner";
import { sendPartnerPostback } from "@/lib/postback/send-partner-postback";
import { prisma } from "@/lib/prisma";
import { recordSale } from "@/lib/tinybird";
import { LeadEventTB } from "@/lib/types";
import { redis } from "@/lib/upstash";
import { sendWorkspaceWebhook } from "@/lib/webhook/publish";
import { transformSaleEventData } from "@/lib/webhook/transform";
import { recordWeleticOrder } from "@/lib/weletic/commerce/record-order";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import {
  assertShopifySettlementLockContext,
  type ShopifySettlementLockContext,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import { deleteShopifyCheckoutCache } from "@/lib/weletic/shopify/privacy-cache";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { nanoid } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { orderSchema } from "./schema";

export async function createShopifySale({
  event,
  customerId,
  workspaceId,
  leadData,
  settlementLockContext,
  expectedInstallationGeneration,
}: {
  event: any;
  customerId: string;
  workspaceId: string;
  leadData: LeadEventTB;
  settlementLockContext: ShopifySettlementLockContext;
  expectedInstallationGeneration?: string | null;
}) {
  const order = orderSchema.parse(event);
  assertShopifySettlementLockContext({
    context: settlementLockContext,
    workspaceId,
    orderExternalId: String(order.id ?? order.confirmation_number),
    shopifyCustomerId: order.customer?.id,
  });
  await assertShopifyStoreAcceptsOperationalWrites({
    workspaceId,
    action: "shopify_sale_creation",
    expectedInstallationGeneration,
  });

  const {
    checkout_token: checkoutToken,
    confirmation_number: invoiceId,
    current_subtotal_price_set: { shop_money: shopMoney },
  } = order;

  let amount = Number(
    decimalToMinorUnits(shopMoney.amount, shopMoney.currency_code),
  );
  const { link_id: linkId } = leadData;
  let currency = shopMoney.currency_code.toLowerCase();

  // Skip if invoice id is already processed
  const idempotencyKey = `dub_sale_events:linkId:${linkId}:invoiceId:${invoiceId}`;
  const ok = await redis.set(idempotencyKey, 1, {
    ex: 45,
    nx: true,
  });

  if (!ok) {
    return new Response(
      `[Shopify] Order has been processed already. Skipping...`,
    );
  }

  try {
    const existingCustomer = await prisma.customer.findUniqueOrThrow({
      where: {
        id: customerId,
      },
    });
    const attributedLink = await prisma.link.findUniqueOrThrow({
      where: { id: linkId },
    });
    if (attributedLink.projectId !== workspaceId) {
      throw new Error(
        "Attributed link does not belong to the Shopify workspace.",
      );
    }
    let webhookPartner;
    let ledgerOrderId: string | undefined;
    let analyticsRecordedAt: Date | null = null;
    let dubStatsRecordedAt: Date | null = null;
    if (attributedLink.programId && attributedLink.partnerId) {
      const ledger = await recordWeleticOrder({
        event,
        workspaceId,
        programId: attributedLink.programId,
        partnerId: attributedLink.partnerId,
        linkId,
        customerId,
        settlementLockContext,
        expectedInstallationGeneration,
      });
      if (ledger.customerPrivacyTombstoned) {
        return new Response(
          "[Shopify] Delayed order for a redacted customer skipped.",
        );
      }
      ledgerOrderId = ledger.orderId;
      analyticsRecordedAt = ledger.analyticsRecordedAt;
      dubStatsRecordedAt = ledger.dubStatsRecordedAt;
      if (
        ledger.duplicate &&
        ledger.analyticsRecordedAt &&
        ledger.dubStatsRecordedAt
      ) {
        return new Response(
          "[Shopify] Order and attribution stats were already processed.",
        );
      }
      amount = Number(ledger.accountingNet);
      currency = ledger.accountingCurrency.toLowerCase();
      const enrollment = await getProgramEnrollmentOrThrow({
        partnerId: attributedLink.partnerId,
        programId: attributedLink.programId,
        include: { partner: true, links: true },
      });
      webhookPartner = constructWebhookPartner(enrollment);
    }

    const saleData = {
      ...leadData,
      workspace_id: leadData.workspace_id || workspaceId, // in case for some reason the lead event doesn't have workspace_id
      event_id: ledgerOrderId ?? nanoid(16),
      event_name: "Purchase",
      payment_processor: "shopify",
      amount,
      currency,
      invoice_id: invoiceId,
      metadata: JSON.stringify({
        shopifyOrderId: String(order.id ?? order.confirmation_number),
        orderName: order.name,
        ...(ledgerOrderId ? { ledgerOrderId } : {}),
      }),
    };

    const firstConversionFlag = isFirstConversion({
      customer: existingCustomer,
      linkId,
    });

    if (!analyticsRecordedAt) {
      await recordSale(saleData);
      if (ledgerOrderId) {
        await prisma.weleticCommerceOrder.update({
          where: { id: ledgerOrderId },
          data: { analyticsRecordedAt: new Date() },
        });
      }
    }

    const updateStats = async (
      tx: Prisma.TransactionClient | typeof prisma,
    ) => {
      const link = await tx.link.update({
        where: { id: linkId },
        data: {
          ...(firstConversionFlag && {
            conversions: { increment: 1 },
            lastConversionAt: new Date(),
          }),
          sales: { increment: 1 },
          saleAmount: { increment: amount },
        },
        include: includeTags,
      });
      const workspace = await tx.project.update({
        where: { id: workspaceId },
        data: { usage: { increment: 1 } },
      });
      const customer = await tx.customer.update({
        where: { id: existingCustomer.id },
        data: {
          sales: { increment: 1 },
          saleAmount: { increment: amount },
          firstSaleAt: existingCustomer.firstSaleAt ? undefined : new Date(),
        },
      });
      return { link, workspace, customer };
    };

    let link;
    let workspace;
    let customer;
    if (ledgerOrderId) {
      ({ link, workspace, customer } = await prisma.$transaction(async (tx) => {
        const claimed = await tx.weleticCommerceOrder.updateMany({
          where: { id: ledgerOrderId, dubStatsRecordedAt: null },
          data: { dubStatsRecordedAt: new Date() },
        });
        if (claimed.count === 1) return updateStats(tx);
        const [link, workspace, customer] = await Promise.all([
          tx.link.findUniqueOrThrow({
            where: { id: linkId },
            include: includeTags,
          }),
          tx.project.findUniqueOrThrow({ where: { id: workspaceId } }),
          tx.customer.findUniqueOrThrow({ where: { id: existingCustomer.id } }),
        ]);
        return { link, workspace, customer };
      }));
    } else {
      ({ link, workspace, customer } = await updateStats(prisma));
    }
    await deleteShopifyCheckoutCache(checkoutToken);

    if (link.programId && link.partnerId) {
      waitUntil(
        Promise.allSettled([
          executeWorkflows({
            event: "saleRecorded",
            identity: {
              workspaceId: workspaceId,
              programId: link.programId,
              partnerId: link.partnerId,
              customerId: customer.id,
              customerFirstSaleAt: customer.firstSaleAt ?? new Date(),
            },
            metrics: {
              current: {
                conversions: firstConversionFlag ? 1 : 0,
                saleAmount: saleData.amount,
              },
            },
          }),

          syncPartnerLinksStats({
            partnerId: link.partnerId,
            programId: link.programId,
            eventType: "sale",
          }),
        ]),
      );
    }

    waitUntil(
      Promise.allSettled([
        sendWorkspaceWebhook({
          trigger: "sale.created",
          workspace,
          data: transformSaleEventData({
            ...saleData,
            link,
            clickedAt: customer.clickedAt || customer.createdAt,
            customer,
            partner: webhookPartner,
            metadata: null,
          }),
        }),

        ...(link?.partnerId
          ? [
              sendPartnerPostback({
                partnerId: link.partnerId,
                event: "sale.created",
                data: {
                  ...saleData,
                  clickedAt: customer.clickedAt || customer.createdAt,
                  link,
                  customer,
                },
              }),
            ]
          : []),
      ]),
    );
  } catch (error) {
    await redis.del(idempotencyKey);
    throw error;
  }
}
