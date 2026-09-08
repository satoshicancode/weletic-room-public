import { withCron } from "@/lib/cron/with-cron";
import { prisma } from "@/lib/prisma";
import { reconcileWeleticShopifyOrders } from "@/lib/weletic/commerce/reconcile-shopify";
import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";
import * as z from "zod/v4";

const schema = z.object({
  workspaceId: z.string().optional(),
  autoHeal: z.boolean().optional().default(true),
  type: z.enum(["orders", "discounts", "all"]).optional().default("all"),
});

export const GET = withCron(async ({ rawBody }) => {
  const { workspaceId, autoHeal, type } = schema.parse(
    rawBody ? JSON.parse(rawBody) : {},
  );

  const stores = await prisma.weleticShopifyStore.findMany({
    where: {
      ...(workspaceId && { projectId: workspaceId }),
      syncStatus: "succeeded",
    },
    select: { id: true, projectId: true, shopDomain: true },
  });

  const results: Array<{
    workspaceId: string;
    shopDomain: string;
    orders?: any;
    discounts?: any;
  }> = [];

  for (const store of stores) {
    const storeResult: {
      workspaceId: string;
      shopDomain: string;
      orders?: any;
      discounts?: any;
    } = {
      workspaceId: store.projectId,
      shopDomain: store.shopDomain,
    };

    if (type === "orders" || type === "all") {
      try {
        storeResult.orders = await reconcileWeleticShopifyOrders({
          workspaceId: store.projectId,
        });
      } catch (error: any) {
        storeResult.orders = { error: error?.message || String(error) };
      }
    }

    if (type === "discounts" || type === "all") {
      try {
        storeResult.discounts = await reconcileWeleticShopifyDiscounts({
          workspaceId: store.projectId,
          storeId: store.id,
          autoHeal: autoHeal ?? true,
        });
      } catch (error: any) {
        storeResult.discounts = { error: error?.message || String(error) };
      }
    }

    results.push(storeResult);
  }

  return Response.json({ stores: results });
});

export const POST = GET;
