import { withShopifySettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { z } from "zod";
import {
  createFulfilledReviewRequests,
  recordReviewOrderCancellation,
} from "./requests";

const identitySchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  admin_graphql_api_id: z.string().optional(),
});
const eventSchema = identitySchema.extend({
  customer: identitySchema.nullable().optional(),
  fulfillment_status: z.string().nullable().optional(),
  updated_at: z.string().datetime({ offset: true }),
  cancelled_at: z.string().datetime({ offset: true }).nullable().optional(),
});

function exactId(
  value: z.infer<typeof identitySchema>,
  resource: "Order" | "Customer",
) {
  const gid = value.admin_graphql_api_id?.match(
    new RegExp(`^gid://shopify/${resource}/([1-9][0-9]{0,19})$`),
  );
  if (gid) return gid[1];
  if (typeof value.id === "number" && !Number.isSafeInteger(value.id))
    throw new Error("Shopify identity is not exact");
  const id = String(value.id ?? "");
  if (!/^[1-9][0-9]{0,19}$/.test(id))
    throw new Error("Shopify identity is invalid");
  return id;
}

/** Dispatch only after Shopify webhook authentication and installation fencing. */
export async function processReviewOrderEvent({
  topic,
  event,
  storeId,
  workspaceId,
  expectedInstallationGeneration,
}: {
  topic: "orders/fulfilled" | "orders/cancelled";
  event: unknown;
  storeId: string;
  workspaceId: string;
  expectedInstallationGeneration: string | null;
}) {
  const input = eventSchema.parse(event);
  const orderExternalId = exactId(input, "Order");
  if (topic === "orders/fulfilled" && input.fulfillment_status !== "fulfilled")
    return;
  return withShopifySettlementLocks({
    workspaceId,
    storeId,
    orderExternalId,
    shopifyCustomerId: input.customer
      ? exactId(input.customer, "Customer")
      : null,
    fn: async () => {
      if (topic === "orders/cancelled" || input.cancelled_at) {
        await recordReviewOrderCancellation({
          storeId,
          orderExternalId,
          cancelledAt: new Date(input.cancelled_at ?? input.updated_at),
          expectedInstallationGeneration,
        });
      } else {
        await createFulfilledReviewRequests({
          storeId,
          orderExternalId,
          fulfilledAt: new Date(input.updated_at),
          expectedInstallationGeneration,
        });
      }
    },
  });
}
