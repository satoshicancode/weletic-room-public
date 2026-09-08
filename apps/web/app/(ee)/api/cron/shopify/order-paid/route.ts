import { DubApiError, handleAndReturnErrorResponse } from "@/lib/api/errors";
import { verifyQstashSignature } from "@/lib/cron/verify-qstash";
import { processOrder } from "@/lib/integrations/shopify/process-order";
import { orderSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { withShopifySettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  deleteShopifyCheckoutCache,
  expireShopifyCheckoutCache,
  readShopifyCheckoutCacheField,
} from "@/lib/weletic/shopify/privacy-cache";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string(),
  checkoutToken: z.string(),
  storeId: z.string().optional(),
  storeInstallationGeneration: z.string().nullable().optional(),
});

// POST /api/cron/shopify/order-paid
export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    await verifyQstashSignature({ req, rawBody });

    const {
      workspaceId,
      checkoutToken,
      storeId: claimedStoreId,
      storeInstallationGeneration,
    } = schema.parse(JSON.parse(rawBody));
    const expectedInstallationGeneration = storeInstallationGeneration;

    // Find Shopify order
    const event = await readShopifyCheckoutCacheField({
      checkoutToken,
      field: "order",
    });

    if (!event) {
      return new Response(
        "[Shopify] Cached checkout order was not found. Skipping...",
      );
    }

    const clickId = await readShopifyCheckoutCacheField<string>({
      checkoutToken,
      field: "clickId",
    });

    // clickId is empty, order is not from a Dub link
    if (clickId === "") {
      // set key to expire in 24 hours
      await expireShopifyCheckoutCache({
        checkoutToken,
        ttlSeconds: 60 * 60 * 24,
      });

      return new Response(
        `[Shopify] Order is not from a Dub link. Skipping...`,
      );
    }

    // clickId is found, process the order for the new customer
    else if (clickId) {
      const order = orderSchema.parse(event);
      const store =
        order.customer?.id && !claimedStoreId
          ? await prisma.weleticShopifyStore.findUnique({
              where: { projectId: workspaceId },
              select: { id: true },
            })
          : null;
      const storeId = claimedStoreId ?? store?.id;
      if (order.customer?.id && !storeId) {
        throw new Error(
          `Cannot acquire Shopify customer settlement lock: store is missing for workspace ${workspaceId}.`,
        );
      }
      const result = await withShopifySettlementLocks({
        workspaceId,
        storeId,
        orderExternalId: String(order.id ?? order.confirmation_number),
        shopifyCustomerId: order.customer?.id,
        fn: (settlementLockContext) =>
          processOrder({
            event: order,
            workspaceId,
            clickId,
            settlementLockContext,
            expectedInstallationGeneration,
          }),
      });
      if (result.privacyTombstoned) {
        await deleteShopifyCheckoutCache(checkoutToken);
        return new Response(
          "[Shopify] Delayed affiliate processing skipped for a redacted customer.",
        );
      }

      return new Response("[Shopify] Order event processed successfully.");
    }

    // Wait for the click event to come from Shopify pixel
    else {
      throw new DubApiError({
        code: "bad_request",
        message:
          "[Shopify] Click event not found. Waiting for Shopify pixel event...",
      });
    }
  } catch (error) {
    return handleAndReturnErrorResponse(error);
  }
}
