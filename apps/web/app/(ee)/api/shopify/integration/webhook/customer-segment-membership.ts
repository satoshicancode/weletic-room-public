import { setShopifyCustomerSegmentMembership } from "@/lib/weletic/shopify/customer-segments";
import * as z from "zod/v4";

const customerSegmentMembershipSchema = z.object({
  customer_id: z.string(),
  segment_id: z.string(),
});

export async function customerSegmentMembershipChanged({
  event,
  workspaceId,
  member,
  storeId,
  expectedInstallationGeneration,
}: {
  event: unknown;
  workspaceId: string;
  member: boolean;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
}) {
  const { customer_id: customerId, segment_id: segmentId } =
    customerSegmentMembershipSchema.parse(event);
  await setShopifyCustomerSegmentMembership({
    workspaceId,
    customerId,
    segmentId,
    member,
    storeId,
    expectedInstallationGeneration,
  });
  return `[Shopify] Customer ${member ? "joined" : "left"} segment cache updated.`;
}
