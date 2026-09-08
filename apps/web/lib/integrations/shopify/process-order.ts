import { createId } from "@/lib/api/create-id";
import { includeTags } from "@/lib/api/links/include-tags";
import { syncPartnerLinksStats } from "@/lib/api/partners/sync-partner-links-stats";
import { executeWorkflows } from "@/lib/api/workflows/execute-workflows";
import { generateRandomName } from "@/lib/names";
import { queuePartnerCommissionCreation } from "@/lib/partners/queue-partner-commission-creation";
import { sendPartnerPostback } from "@/lib/postback/send-partner-postback";
import { prisma } from "@/lib/prisma";
import { getLeadEvent, recordLead } from "@/lib/tinybird";
import { recordFakeClick } from "@/lib/tinybird/record-fake-click";
import { WorkspaceProps } from "@/lib/types";
import { sendWorkspaceWebhook } from "@/lib/webhook/publish";
import { transformLeadEventData } from "@/lib/webhook/transform";
import { isShopifyCustomerPrivacyTombstonedForWorkspace } from "@/lib/weletic/loyalty/shopper-privacy";
import {
  assertShopifySettlementLockContext,
  type ShopifySettlementLockContext,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { COUNTRIES_TO_CONTINENTS, nanoid } from "@dub/utils";
import { Link } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { createShopifyLead } from "./create-lead";
import { createShopifySale } from "./create-sale";
import { orderSchema } from "./schema";

// Process the order from Shopify webhook
export async function processOrder({
  event,
  workspaceId,
  customerId,
  clickId,
  settlementLockContext,
  expectedInstallationGeneration,
}: {
  event: unknown;
  workspaceId: string;
  customerId?: string; // ID of the customer in Dub
  clickId?: string; // ID of the click event from Shopify pixel
  settlementLockContext: ShopifySettlementLockContext;
  expectedInstallationGeneration?: string | null;
}) {
  const order = orderSchema.parse(event);
  const orderExternalId = String(order.id ?? order.confirmation_number);
  assertShopifySettlementLockContext({
    context: settlementLockContext,
    workspaceId,
    orderExternalId,
    shopifyCustomerId: order.customer?.id,
  });
  await assertShopifyStoreAcceptsOperationalWrites({
    workspaceId,
    action: "affiliate_order_processing",
    expectedInstallationGeneration,
  });

  if (
    order.customer?.id &&
    (await isShopifyCustomerPrivacyTombstonedForWorkspace({
      workspaceId,
      shopifyCustomerId: String(order.customer.id),
    }))
  ) {
    return { privacyTombstoned: true as const };
  }

  // for existing customer
  if (customerId) {
    const leadEvent = await getLeadEvent({ customerId });

    if (!leadEvent) {
      throw new Error(
        `[Shopify] Lead event with customer ID ${customerId} not found.`,
      );
    }

    await createShopifySale({
      leadData: leadEvent,
      event,
      workspaceId,
      customerId,
      settlementLockContext,
      expectedInstallationGeneration,
    });

    return { privacyTombstoned: false as const };
  }

  // for new customer
  if (clickId) {
    const leadData = await createShopifyLead({
      clickId,
      workspaceId,
      event,
    });

    const { customer_id: customerId } = leadData;

    await createShopifySale({
      leadData,
      event,
      workspaceId,
      customerId,
      settlementLockContext,
      expectedInstallationGeneration,
    });

    return { privacyTombstoned: false as const };
  }

  return { privacyTombstoned: false as const };
}

export async function attributeViaDiscountCode({
  event,
  workspace,
  link,
}: {
  event: unknown;
  workspace: Pick<WorkspaceProps, "id" | "defaultProgramId" | "webhookEnabled">;
  link: Link;
}) {
  const { customer: orderCustomer, billing_address: billingAddress } =
    orderSchema.parse(event);

  const billingAddressCountry = billingAddress?.country_code?.toUpperCase();
  // Record a fake click for this event
  const clickEvent = await recordFakeClick({
    link,
    customer: {
      continent: billingAddressCountry
        ? COUNTRIES_TO_CONTINENTS[billingAddressCountry] ?? "Unknown"
        : "Unknown",
      country: billingAddressCountry ?? "Unknown",
      region: billingAddress?.province ?? "Unknown",
    },
  });

  const customerId = createId({ prefix: "cus_" });

  const customer = await prisma.customer.create({
    data: {
      id: customerId,
      name: orderCustomer
        ? `${orderCustomer.first_name} ${orderCustomer.last_name}`.trim()
        : generateRandomName(),
      email: orderCustomer?.email,
      externalId: orderCustomer?.id?.toString() || customerId,
      linkId: clickEvent.link_id,
      clickId: clickEvent.click_id,
      clickedAt: new Date(clickEvent.timestamp + "Z"),
      country: billingAddress?.country_code,
      projectId: workspace.id,
      programId: link.programId,
      partnerId: link.partnerId,
    },
  });

  // Prepare the payload for the lead event
  const { timestamp, ...rest } = clickEvent;

  const leadEvent = {
    ...rest,
    workspace_id: clickEvent.workspace_id || customer.projectId, // in case for some reason the click event doesn't have workspace_id
    event_id: nanoid(16),
    event_name: "Checkout with discount code",
    customer_id: customer.id,
    metadata: "",
  };

  await recordLead(leadEvent);

  waitUntil(
    (async () => {
      const linkUpdated = await prisma.link.update({
        where: {
          id: link.id,
        },
        data: {
          leads: {
            increment: 1,
          },
          lastLeadAt: new Date(),
        },
        include: includeTags,
      });

      let result:
        | Awaited<ReturnType<typeof queuePartnerCommissionCreation>>
        | undefined = undefined;

      if (link.programId && link.partnerId) {
        result = await queuePartnerCommissionCreation({
          event: "lead",
          programId: link.programId,
          partnerId: link.partnerId,
          linkId: link.id,
          eventId: leadEvent.event_id,
          customerId: customer.id,
          quantity: 1,
          context: {
            customer: {
              country: customer.country,
            },
          },
        });

        await Promise.allSettled([
          executeWorkflows({
            event: "leadRecorded",
            identity: {
              workspaceId: workspace.id,
              programId: link.programId,
              partnerId: link.partnerId,
            },
            metrics: {
              current: {
                leads: 1,
              },
            },
          }),

          syncPartnerLinksStats({
            partnerId: link.partnerId,
            programId: link.programId,
            eventType: "lead",
          }),
        ]);
      }

      await Promise.allSettled([
        sendWorkspaceWebhook({
          trigger: "lead.created",
          workspace,
          data: transformLeadEventData({
            ...clickEvent,
            eventName: "Checkout with discount code",
            link: linkUpdated,
            customer,
            partner: result?.webhookPartner,
            metadata: null,
          }),
        }),

        ...(link.partnerId
          ? [
              sendPartnerPostback({
                partnerId: link.partnerId,
                event: "lead.created",
                data: {
                  ...leadEvent,
                  eventName: "Checkout with discount code",
                  link: linkUpdated,
                  customer,
                },
              }),
            ]
          : []),
      ]);
    })(),
  );

  return {
    customer,
    leadEvent,
  };
}
